"""Agent runner + workflow orchestrator + live event hub."""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Awaitable, Callable

from . import cli_agent, db, llm, mcp_manager, policies, tools

Emit = Callable[[dict], Awaitable[None]]
# gate(tool, args_json, policy, agent_name, call_id) -> (allowed, note)
Gate = Callable[[str, str, str, str, str], Awaitable[tuple[bool, str]]]
MAX_DELEGATION_DEPTH = 2


class BudgetExceeded(Exception):
    pass


class RunRejected(Exception):
    pass


# =====================================================================
# Live event hub: persists events and fans them out to websocket clients
# =====================================================================

class Hub:
    def __init__(self) -> None:
        self.subs: dict[str, set[asyncio.Queue]] = {}
        self.partial: dict[str, dict[str, dict]] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        # run_id -> node_id -> future resolved by the user's decision
        self.approvals: dict[str, dict[str, asyncio.Future]] = {}

    def subscribe(self, run_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.subs.setdefault(run_id, set()).add(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue) -> None:
        self.subs.get(run_id, set()).discard(q)

    async def emit(self, run_id: str, event: dict) -> None:
        event = {"ts": time.time(), **event}
        key = f"{event.get('node', '')}|{event.get('scope', '')}"
        if event["type"] == "token":
            p = self.partial.setdefault(run_id, {}).setdefault(
                key, {"node": event.get("node"), "scope": event.get("scope"), "agent": event.get("agent"), "text": ""})
            p["text"] += event["text"]
        else:
            if event["type"] in ("message", "tool_call", "node_finished", "node_error"):
                self.partial.get(run_id, {}).pop(key, None)
            db.add_event(run_id, event)
        for q in list(self.subs.get(run_id, ())):
            q.put_nowait(event)


hub = Hub()


# =====================================================================
# Single agent loop (model <-> tools)
# =====================================================================

class Budget:
    def __init__(self, limit: float) -> None:
        self.limit = limit
        self.cost = 0.0
        self.tokens_in = 0
        self.tokens_out = 0

    def add(self, result: dict) -> None:
        self.cost += result["cost"]
        self.tokens_in += result["usage"]["input"]
        self.tokens_out += result["usage"]["output"]
        if self.limit and self.cost > self.limit:
            raise BudgetExceeded(f"Cost limit of ${self.limit:.2f} reached (spent ${self.cost:.4f}).")


def default_model() -> str:
    """The user's choice; otherwise prefer what works without an API key (subscription, then local)."""
    chosen = db.get_setting("default_model")
    if chosen:
        return chosen
    if cli_agent.claude_bin():
        return "claude-code/claude-sonnet-5-5"
    if llm.provider_config("anthropic").get("api_key"):
        return "anthropic/claude-sonnet-5-5"
    return llm.FIRST_OLLAMA.get("model") or "anthropic/claude-sonnet-5-5"


def system_prompt_for(agent: dict) -> str:
    parts = [agent.get("system_prompt") or f"You are {agent['name']}, a helpful AI agent."]
    enabled = set(agent.get("tools") or [])
    if enabled & {"list_files", "read_file", "write_file", "run_python", "run_shell"}:
        parts.append("You share a workspace folder with other agents. Use relative paths.")
    parts.append(f"Today's date is {time.strftime('%Y-%m-%d')}.")
    return "\n\n".join(parts)


async def run_agent(
    agent: dict,
    messages: list[dict],
    emit: Emit,
    budget: Budget,
    *,
    depth: int = 0,
    scope: str = "",
    gate: Gate | None = None,
) -> dict:
    """Run an agent until it gives a final answer. Returns {output, messages}.
    `gate` decides tool calls whose safety rule is "ask" or "ai" (see policies.py)."""
    model = agent.get("model") or default_model()
    enabled = [t for t in (agent.get("tools") or []) if t in tools.TOOLS]
    others = [a for a in db.list_docs("agent") if a["id"] != agent["id"]]
    if agent.get("team"):  # this agent may only hand work to its chosen team
        others = [a for a in others if a["id"] in agent["team"]]
    schemas = []
    for t in enabled:
        if t == "delegate":
            if others and depth < MAX_DELEGATION_DEPTH:
                schemas += tools.delegate_schemas(others)
        else:
            schemas.append(tools.TOOLS[t]["schema"])

    convo = [{"role": "system", "content": system_prompt_for(agent)}, *messages]
    max_steps = int(agent.get("max_steps") or 12)
    base = {"agent": agent["name"], "agent_id": agent["id"], "scope": scope, "depth": depth}

    scope_counts: dict[str, int] = {}

    async def delegate(name: str, task: str) -> str:
        target = next((a for a in others if a["name"].lower() == name.lower()), None)
        if not target:
            return f"No agent named {name!r}. Teammates: {', '.join(a['name'] for a in others)}."
        # unique scope per hand-off, so parallel tasks to the same teammate stream separately
        scope_counts[target["name"]] = n = scope_counts.get(target["name"], 0) + 1
        label = target["name"] if n == 1 else f"{target['name']} #{n}"
        sub_scope = f"{scope}>{label}" if scope else label
        await emit({**base, "type": "delegate", "to": target["name"], "task": task})
        result = await run_agent(target, [{"role": "user", "content": task}], emit, budget,
                                 depth=depth + 1, scope=sub_scope, gate=gate)
        return result["output"]

    # external MCP tool servers switched on for this agent
    mcp_schemas, mcp_routes, mcp_problems = await mcp_manager.agent_tool_schemas(agent.get("tools") or [])
    schemas += mcp_schemas
    for problem in mcp_problems:
        await emit({**base, "type": "notice", "text": problem})

    async def run_tool(name: str, args: str, call_id: str) -> str:
        await emit({**base, "type": "tool_call", "tool": name, "args": args, "call_id": call_id})
        started = time.time()
        # ---- safety rule for this tool ----
        if name in mcp_routes:
            sid, tool_name, annotations = mcp_routes[name]
            policy = policies.get(policies.mcp_key(sid, tool_name), annotations)
        else:
            policy = policies.get("delegate" if name == "delegate_parallel" else name)
        if policy == "block":
            output = "Blocked: the user's tool safety settings don't allow this tool. Continue without it."
            await emit({**base, "type": "tool_result", "tool": name, "call_id": call_id, "output": output, "duration": 0})
            return output
        if policy in ("ask", "ai"):
            if gate is None:
                allowed, note = False, "No one is available to approve this action here."
            else:
                allowed, note = await gate(name, args, policy, agent["name"], call_id)
            if not allowed:
                output = ("Not allowed: this action was declined" + (f" ({note})" if note else "") +
                          ". Do not try it again. Continue without it, or explain in your answer what the user "
                          "would need to do.")
                await emit({**base, "type": "tool_result", "tool": name, "call_id": call_id, "output": output,
                            "duration": round(time.time() - started, 2)})
                return output
        if name in mcp_routes:
            try:
                parsed = json.loads(args or "{}")
            except json.JSONDecodeError:
                parsed = None
            output = (await mcp_manager.call(mcp_routes[name], parsed)) if isinstance(parsed, dict) \
                else f"Invalid JSON arguments: {args[:200]}"
        else:
            output = await tools.call_tool(name, args, delegate=delegate)
        await emit({**base, "type": "tool_result", "tool": name, "call_id": call_id,
                    "output": output, "duration": round(time.time() - started, 2)})
        return output

    # ---- subscription models: the vendor's CLI runs the loop, our tools are bridged over MCP ----
    if llm.provider_of(model) in llm.CLI_RUNNERS:
        counter = {"n": 0}

        async def bridged(name: str, args: str) -> str:
            counter["n"] += 1
            return await run_tool(name, args, f"cc{counter['n']}-{time.time_ns()}")

        async def cc_emit(event: dict) -> None:
            await emit({**base, **event})

        runner = getattr(cli_agent, llm.CLI_RUNNERS[llm.provider_of(model)])
        result = await runner(
            model=model.split("/", 1)[1], system_prompt=convo[0]["content"], messages=messages,
            schemas=schemas, call_tool=bridged, emit=cc_emit, max_steps=max_steps,
        )
        budget.add({"cost": 0.0, "usage": result["usage"]})
        await emit({**base, "type": "usage", "model": model, "cost": 0.0, "subscription": True, **result["usage"]})
        await emit({**base, "type": "message", "content": result["output"]})
        return {"output": result["output"], "messages": [*messages, {"role": "assistant", "content": result["output"]}]}

    # ---- local models that can't call tools: run them without tools instead of failing ----
    if schemas and llm.provider_of(model) == "ollama" and not await llm.ollama_supports_tools(model):
        await emit({**base, "type": "notice",
                    "text": f"{model.split('/', 1)[1]} doesn't support tools, so this agent runs without them."})
        schemas = []

    for step in range(max_steps + 1):
        final_step = step == max_steps
        if final_step:
            convo.append({"role": "user", "content": "You have used all your steps. Give your best final answer now."})

        async def on_token(text: str) -> None:
            await emit({**base, "type": "token", "text": text})

        result = await llm.stream_chat(
            model, convo,
            tools=None if final_step else (schemas or None),
            temperature=agent.get("temperature"),
            on_token=on_token,
        )
        budget.add(result)
        await emit({**base, "type": "usage", "model": model, "cost": result["cost"], **result["usage"]})

        if result["tool_calls"] and not final_step:
            convo.append({"role": "assistant", "content": result["content"] or None, "tool_calls": result["tool_calls"]})
            if result["content"]:
                await emit({**base, "type": "message", "content": result["content"], "intermediate": True})
            # several tool calls in one turn run at the same time
            outputs = await asyncio.gather(*(run_tool(tc["function"]["name"], tc["function"]["arguments"], tc["id"])
                                             for tc in result["tool_calls"]))
            for tc, output in zip(result["tool_calls"], outputs):
                convo.append({"role": "tool", "tool_call_id": tc["id"], "content": output})
            continue

        await emit({**base, "type": "message", "content": result["content"]})
        convo.append({"role": "assistant", "content": result["content"]})
        return {"output": result["content"], "messages": convo[1:]}

    return {"output": "", "messages": convo[1:]}  # unreachable


# =====================================================================
# Workflow orchestration
# =====================================================================

def node_label(node: dict, agents: dict[str, dict]) -> str:
    d = node.get("data") or {}
    if d.get("label"):
        return d["label"]
    if node["type"] in ("agent", "router") and d.get("agentId") in agents:
        return agents[d["agentId"]]["name"]
    if node["type"] == "loop" and d.get("agentId") in agents:
        return f"{agents[d['agentId']]['name']} ⟲ review"
    return {"start": "Start", "output": "Output", "router": "Router", "loop": "Review loop",
            "approval": "Your approval"}.get(node["type"], node["id"])


def build_step_prompt(node: dict, run_input: str, upstream: list[tuple[str, str]]) -> str:
    instructions = ((node.get("data") or {}).get("instructions") or "").strip()
    parts = []
    if instructions:
        parts.append(f"## Your job in this step\n{instructions}")
    parts.append(f"## Original request\n{run_input}")
    if upstream:
        parts.append("## Input from previous steps\n" + "\n\n".join(f"### From {lbl}\n{out}" for lbl, out in upstream))
    return "\n\n".join(parts)


def parse_router_choice(text: str, n: int) -> tuple[int, str]:
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            data = json.loads(m.group(0))
            choice = int(data.get("choice"))
            if 1 <= choice <= n:
                return choice - 1, str(data.get("reason", ""))
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
    m = re.search(r"\b(\d+)\b", text)
    if m and 1 <= int(m.group(1)) <= n:
        return int(m.group(1)) - 1, text.strip()[:300]
    return 0, "Could not parse the router's answer; defaulted to the first option."


REVIEW_INSTRUCTIONS = (
    "## Your job\nReview the work below against the criteria. Be strict but fair: approve only if it fully "
    "meets them. If it doesn't, give specific, actionable feedback the author can apply.\n\n"
    "Reply with ONLY JSON: {\"approved\": true|false, \"feedback\": \"<what to fix, or why it passes>\"}"
)


def parse_review(text: str) -> tuple[bool, str]:
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            data = json.loads(m.group(0))
            approved = data.get("approved")
            if isinstance(approved, str):
                approved = approved.strip().lower() in ("true", "yes", "approved")
            return bool(approved), str(data.get("feedback", "")).strip()
        except (json.JSONDecodeError, AttributeError):
            pass
    low = text.lower()
    approved = ("approved" in low or "lgtm" in low) and not any(w in low for w in ("not approved", "needs", "revise", "fix"))
    return approved, text.strip()[:2000]


async def check_tool_call(tool: str, args: str, agent_name: str, run_input: str, emit: Emit,
                          budget: Budget) -> tuple[bool, str]:
    """AI safety check for a single tool call. Returns (ok, reason)."""
    checker = {"id": "tool-checker", "name": "Safety check", "model": default_model(), "tools": [],
               "system_prompt": "You are a careful safety reviewer for actions taken by AI agents on a user's behalf."}
    prompt = (
        "An AI agent wants to perform an action that can change things in the real world.\n\n"
        f"## The user's original request\n{run_input}\n\n## Agent\n{agent_name}\n\n"
        f"## Action\nTool: {tool}\nArguments: {args}\n\n"
        "Approve ONLY if this action is clearly within what the user asked for, is aimed at the right "
        "target/recipient, and has no obvious harmful or irreversible side effects the user didn't request.\n\n"
        'Reply with ONLY JSON: {"approved": true|false, "feedback": "<one sentence why>"}'
    )
    await emit({"type": "notice", "text": f"Safety check on {tool}…"})
    result = await run_agent(checker, [{"role": "user", "content": prompt}], emit, budget, scope="check")
    return parse_review(result["output"])


class WorkflowRun:
    def __init__(self, run: dict) -> None:
        self.run = run
        self.graph = run["graph"]
        self.nodes = {n["id"]: n for n in self.graph["nodes"]}
        self.edges = self.graph["edges"]
        self.agents = {a["id"]: a for a in db.list_docs("agent")}
        self.state: dict[str, str] = {nid: "pending" for nid in self.nodes}
        self.outputs: dict[str, str] = {}
        self.dead_edges: set[str] = set()
        self.budget = Budget(float(db.get_setting("max_cost_per_run", 2.0) or 0))

    async def emit(self, event: dict) -> None:
        await hub.emit(self.run["id"], event)

    def incoming(self, nid: str) -> list[dict]:
        return [e for e in self.edges if e["target"] == nid]

    def outgoing(self, nid: str) -> list[dict]:
        return [e for e in self.edges if e["source"] == nid]

    def save(self) -> None:
        self.run["cost"] = round(self.budget.cost, 6)
        self.run["tokens"] = {"input": self.budget.tokens_in, "output": self.budget.tokens_out}
        self.run["node_states"] = self.run.get("node_states", {})
        db.save_run(self.run)

    def set_node(self, nid: str, **fields: Any) -> None:
        self.run.setdefault("node_states", {}).setdefault(nid, {}).update(fields)

    async def run_node(self, nid: str) -> None:
        node = self.nodes[nid]
        label = node_label(node, self.agents)
        live = [e for e in self.incoming(nid)
                if e["id"] not in self.dead_edges and self.state[e["source"]] == "done"]
        upstream = [(node_label(self.nodes[e["source"]], self.agents), self.outputs[e["source"]])
                    for e in live if self.nodes[e["source"]]["type"] != "start"]
        run_input = self.run["input"]

        self.state[nid] = "running"
        self.set_node(nid, status="running", started_at=time.time())
        self.save()
        await self.emit({"type": "node_started", "node": nid, "label": label})
        cost_before = self.budget.cost

        if node["type"] == "start":
            output = run_input
        elif node["type"] == "output":
            ups = [out for _, out in upstream]
            output = ups[0] if len(ups) == 1 else "\n\n---\n\n".join(
                f"## {lbl}\n{out}" for lbl, out in upstream) if ups else run_input
        elif node["type"] == "approval":
            output = await self.run_approval(nid, node, upstream, run_input)
        elif node["type"] == "loop":
            output = await self.run_loop(nid, node, upstream, run_input)
        else:
            agent_id = (node.get("data") or {}).get("agentId")
            agent = self.agents.get(agent_id)
            if not agent:
                if node["type"] == "router":
                    agent = {"id": "router", "name": "Router", "model": default_model(), "tools": [],
                             "system_prompt": "You route tasks to the right specialist."}
                else:
                    raise RuntimeError(f"Step '{label}' has no agent selected.")
            prompt = build_step_prompt(node, run_input, upstream)

            if node["type"] == "router":
                options = self.outgoing(nid)
                if not options:
                    raise RuntimeError(f"Router '{label}' has no outgoing connections to choose from.")
                lines = []
                for i, e in enumerate(options, 1):
                    t = self.nodes[e["target"]]
                    desc = ((t.get("data") or {}).get("instructions") or "")
                    ag = self.agents.get((t.get("data") or {}).get("agentId") or "")
                    if not desc and ag:
                        desc = ag.get("description", "")
                    lines.append(f"{i}. {node_label(t, self.agents)}" + (f" — {desc}" if desc else ""))
                prompt += ("\n\n## Routing decision\nPick the ONE option best suited to handle this next:\n"
                           + "\n".join(lines)
                           + '\n\nReply with only JSON: {"choice": <option number>, "reason": "<one sentence>"}')
                result = await run_agent({**agent, "tools": []}, [{"role": "user", "content": prompt}],
                                         self._node_emit(nid), self.budget, gate=self.tool_gate(nid))
                idx, reason = parse_router_choice(result["output"], len(options))
                chosen = options[idx]
                for e in options:
                    if e["id"] != chosen["id"]:
                        self.dead_edges.add(e["id"])
                target_label = node_label(self.nodes[chosen["target"]], self.agents)
                await self.emit({"type": "router_decision", "node": nid, "target": chosen["target"],
                                 "target_label": target_label, "reason": reason})
                # Routers pass the incoming material through unchanged.
                output = "\n\n".join(out for _, out in upstream) if upstream else run_input
                self.set_node(nid, decision=target_label, reason=reason)
            else:
                result = await run_agent(agent, [{"role": "user", "content": prompt}],
                                         self._node_emit(nid), self.budget, gate=self.tool_gate(nid))
                output = result["output"]

        self.outputs[nid] = output
        self.state[nid] = "done"
        self.set_node(nid, status="done", output=output, finished_at=time.time(),
                      cost=round(self.budget.cost - cost_before, 6))
        self.save()
        await self.emit({"type": "node_finished", "node": nid, "label": label, "output": output})

    async def run_loop(self, nid: str, node: dict, upstream: list[tuple[str, str]], run_input: str) -> str:
        """Worker produces, reviewer approves or sends feedback; repeat up to maxRounds."""
        d = node.get("data") or {}
        worker = self.agents.get(d.get("agentId") or "")
        reviewer = self.agents.get(d.get("reviewerId") or "")
        if not worker or not reviewer:
            raise RuntimeError("A review loop needs both a worker agent and a reviewer agent.")
        max_rounds = max(1, min(int(d.get("maxRounds") or 3), 10))
        criteria = (d.get("criteria") or "").strip() or "High quality, correct, complete, and it does what the original request asks."
        node_emit = self._node_emit(nid)

        worker_msgs = [{"role": "user", "content": build_step_prompt(node, run_input, upstream)}]
        work, feedback = "", ""
        for rnd in range(1, max_rounds + 1):
            self.set_node(nid, round=rnd, max_rounds=max_rounds)
            await self.emit({"type": "loop_round", "node": nid, "round": rnd, "max_rounds": max_rounds})
            if rnd > 1:
                worker_msgs.append({"role": "user", "content":
                    f"The reviewer did not approve your work yet. Their feedback:\n\n{feedback}\n\n"
                    "Revise your work to address every point. Reply with the complete, improved version."})
            result = await run_agent(worker, worker_msgs, node_emit, self.budget, scope=f"round {rnd}", gate=self.tool_gate(nid))
            work = result["output"]
            worker_msgs = result["messages"]

            review_prompt = (f"{REVIEW_INSTRUCTIONS}\n\n## Criteria\n{criteria}\n\n"
                             f"## Original request\n{run_input}\n\n## Work to review (round {rnd})\n{work}")
            review = await run_agent({**reviewer, "tools": []}, [{"role": "user", "content": review_prompt}],
                                     node_emit, self.budget, scope=f"round {rnd}")
            approved, feedback = parse_review(review["output"])
            await self.emit({"type": "review", "node": nid, "round": rnd, "max_rounds": max_rounds,
                             "approved": approved, "feedback": feedback, "reviewer": reviewer["name"]})
            if approved:
                self.set_node(nid, decision=f"approved in round {rnd}")
                return work
        self.set_node(nid, decision=f"not approved after {max_rounds} rounds")
        await self.emit({"type": "notice", "node": nid,
                         "text": f"Still not approved after {max_rounds} rounds, so the last version is passed on."})
        return work

    async def ai_check(self, nid: str, node: dict, content: str, run_input: str) -> tuple[bool, str]:
        """Ask an AI checker whether the content is fine to continue with. Returns (ok, concerns)."""
        d = node.get("data") or {}
        checker = self.agents.get(d.get("checkerId") or "") or {
            "id": "checker", "name": "AI checker", "model": default_model(), "tools": [],
            "system_prompt": "You are a careful quality checker for an automated workflow."}
        what = (d.get("instructions") or "").strip() or "The content is correct, sensible and safe to continue with."
        prompt = (
            "## Your job\nYou check work in the middle of an automated workflow, on behalf of the user. "
            "Approve it unless there is a REAL problem: factual errors, missing required parts, something unsafe, "
            "or something that clearly contradicts the original request. Minor style issues are not a reason to stop.\n\n"
            f"## What to check\n{what}\n\n## Original request\n{run_input}\n\n## Content to check\n{content}\n\n"
            'Reply with ONLY JSON: {"approved": true|false, "feedback": "<one or two sentences: why it\'s fine, or the specific problems>"}'
        )
        await self.emit({"type": "notice", "node": nid, "text": f"{checker['name']} is checking this…"})
        result = await run_agent({**checker, "tools": []}, [{"role": "user", "content": prompt}],
                                 self._node_emit(nid), self.budget, scope="check")
        return parse_review(result["output"])

    async def run_approval(self, nid: str, node: dict, upstream: list[tuple[str, str]], run_input: str) -> str:
        """Approval checkpoint. Mode: ask (you), ai (AI checks, asks you only if needed), auto.
        In an autonomous run it never waits for you."""
        d = node.get("data") or {}
        mode = d.get("mode") or "ask"
        autonomous = bool(self.run.get("autonomous"))
        content = upstream[0][1] if len(upstream) == 1 else "\n\n---\n\n".join(
            f"## {lbl}\n{out}" for lbl, out in upstream) if upstream else run_input

        async def resolved(approved: bool, by: str, reason: str = "", note: str = "", edited: bool = False) -> None:
            await self.emit({"type": "approval_resolved", "node": nid, "approved": approved, "by": by,
                             "reason": reason, "note": note, "edited": edited})

        # 1) no human involved
        if mode == "auto":
            self.set_node(nid, decision="auto-approved")
            await resolved(True, "auto", "This step is set to auto-approve.")
            return content
        concerns = ""
        if mode == "ai":
            ok, feedback = await self.ai_check(nid, node, content, run_input)
            if ok:
                self.set_node(nid, decision="approved by AI check")
                await resolved(True, "ai", feedback)
                return content
            concerns = feedback
            if autonomous:
                self.set_node(nid, decision="AI flagged issues · continued (autonomous)")
                await resolved(True, "autonomous", f"The AI checker flagged problems, so they're passed on to the next steps: {feedback}")
                return content + f"\n\n## Issues flagged by the quality check (address these)\n{feedback}"
        elif autonomous:
            self.set_node(nid, decision="auto-approved (autonomous run)")
            await resolved(True, "autonomous", "Autonomous run, so this was approved without asking you.")
            return content

        # 2) ask the user (optionally with a timeout)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        hub.approvals.setdefault(self.run["id"], {})[nid] = fut
        message = (d.get("instructions") or "").strip()
        timeout_min = float(d.get("timeoutMinutes") or 0)
        timeout_action = d.get("timeoutAction") or "approve"
        deadline = time.time() + timeout_min * 60 if timeout_min > 0 else None
        self.state[nid] = "waiting"
        self.set_node(nid, status="waiting", content=content, concerns=concerns or None, deadline=deadline,
                      timeout_action=timeout_action if deadline else None)
        self.run["status"] = "waiting"
        self.save()
        await self.emit({"type": "approval_requested", "node": nid, "content": content, "message": message,
                         "concerns": concerns, "deadline": deadline, "timeout_action": timeout_action if deadline else None})
        try:
            decision = await (asyncio.wait_for(asyncio.shield(fut), timeout=timeout_min * 60) if deadline else fut)
            by = "you"
        except asyncio.TimeoutError:
            decision = {"approved": timeout_action == "approve", "note": "", "content": None}
            by = "timeout"
        finally:
            hub.approvals.get(self.run["id"], {}).pop(nid, None)
        self.state[nid] = "running"
        self.set_node(nid, status="running")
        if not hub.approvals.get(self.run["id"]):
            self.run["status"] = "running"
        edited = decision.get("content")
        was_edited = edited is not None and edited != content
        reason = f"No answer within {timeout_min:g} min, so it was {'approved' if decision['approved'] else 'rejected'} automatically." \
            if by == "timeout" else ""
        await resolved(decision["approved"], by, reason, decision.get("note", ""), was_edited)
        if not decision["approved"]:
            note = decision.get("note") or reason or "No reason given."
            self.set_node(nid, decision="rejected" + (" (timeout)" if by == "timeout" else ""))
            raise RunRejected(f"'{node_label(node, self.agents)}' was rejected: {note}")
        self.set_node(nid, decision=("approved (timeout)" if by == "timeout" else "approved") + (" with edits" if was_edited else ""))
        out = edited if edited is not None else content
        if decision.get("note"):
            out += f"\n\n## Note from the user\n{decision['note']}"
        return out

    def tool_gate(self, nid: str) -> Gate:
        """Approve risky tool calls inside a workflow step. Autonomous runs never wait: an AI checker decides."""
        async def gate(tool: str, args: str, policy: str, agent_name: str, call_id: str) -> tuple[bool, str]:
            autonomous = bool(self.run.get("autonomous"))
            request_id = f"{nid}~tool~{call_id}"
            concerns = ""
            if policy == "ai" or autonomous:
                ok, feedback = await check_tool_call(tool, args, agent_name, self.run["input"],
                                                     self._node_emit(nid), self.budget)
                if ok:
                    await self.emit({"type": "tool_approval_resolved", "node": nid, "request_id": request_id,
                                     "tool": tool, "approved": True, "by": "ai", "reason": feedback})
                    return True, ""
                if autonomous:
                    await self.emit({"type": "tool_approval_resolved", "node": nid, "request_id": request_id,
                                     "tool": tool, "approved": False, "by": "ai", "reason": feedback})
                    return False, f"an AI safety check said no: {feedback}"
                concerns = feedback
            # ask the user
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            hub.approvals.setdefault(self.run["id"], {})[request_id] = fut
            prev_state = self.state.get(nid)
            self.state[nid] = "waiting"
            self.set_node(nid, status="waiting")
            self.run["status"] = "waiting"
            self.save()
            await self.emit({"type": "tool_approval_requested", "node": nid, "request_id": request_id, "tool": tool,
                             "args": args, "agent": agent_name, "concerns": concerns})
            try:
                decision = await fut
            finally:
                hub.approvals.get(self.run["id"], {}).pop(request_id, None)
            self.state[nid] = prev_state or "running"
            self.set_node(nid, status="running")
            if not hub.approvals.get(self.run["id"]):
                self.run["status"] = "running"
            self.save()
            await self.emit({"type": "tool_approval_resolved", "node": nid, "request_id": request_id, "tool": tool,
                             "approved": decision["approved"], "by": "you", "note": decision.get("note", "")})
            return decision["approved"], decision.get("note", "")
        return gate

    def _node_emit(self, nid: str) -> Emit:
        async def emit(event: dict) -> None:
            await self.emit({**event, "node": nid})
        return emit

    def ready_nodes(self) -> tuple[list[str], list[str]]:
        """Return (nodes ready to run, nodes to skip)."""
        ready, skip = [], []
        for nid, st in self.state.items():
            if st != "pending":
                continue
            inc = self.incoming(nid)
            if any(self.state[e["source"]] in ("pending", "running", "waiting") for e in inc):
                continue
            if not inc:
                ready.append(nid)
                continue
            live = [e for e in inc if e["id"] not in self.dead_edges and self.state[e["source"]] == "done"]
            (ready if live else skip).append(nid)
        return ready, skip

    async def execute(self) -> None:
        run_id = self.run["id"]
        self.run["status"] = "running"
        self.save()
        await self.emit({"type": "run_started"})
        running: dict[asyncio.Task, str] = {}
        try:
            while True:
                ready, skip = self.ready_nodes()
                while skip:
                    for nid in skip:
                        self.state[nid] = "skipped"
                        self.set_node(nid, status="skipped")
                        await self.emit({"type": "node_skipped", "node": nid})
                    ready, skip = self.ready_nodes()
                for nid in ready:
                    self.state[nid] = "running"
                    running[asyncio.create_task(self.run_node(nid))] = nid
                if not running:
                    break
                done, _ = await asyncio.wait(running.keys(), return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    nid = running.pop(task)
                    exc = task.exception()
                    if isinstance(exc, RunRejected):
                        self.state[nid] = "stopped"
                        self.set_node(nid, status="stopped", finished_at=time.time())
                        raise exc
                    if exc:
                        self.state[nid] = "error"
                        self.set_node(nid, status="error", error=str(exc), finished_at=time.time())
                        await self.emit({"type": "node_error", "node": nid, "error": f"{type(exc).__name__}: {exc}"})
                        raise exc

            sinks = [nid for nid, n in self.nodes.items() if n["type"] == "output" and self.state[nid] == "done"]
            if not sinks:
                sinks = [nid for nid in self.nodes if self.state[nid] == "done" and not self.outgoing(nid)]
            outs = [self.outputs[n] for n in sinks]
            self.run["output"] = outs[0] if len(outs) == 1 else "\n\n---\n\n".join(outs)
            self.run["status"] = "done"
        except asyncio.CancelledError:
            self.run["status"] = "stopped"
            self.run["error"] = "Stopped by user."
        except RunRejected as e:
            self.run["status"] = "stopped"
            self.run["error"] = str(e)
        except Exception as e:  # noqa: BLE001
            self.run["status"] = "error"
            self.run["error"] = f"{type(e).__name__}: {e}"
        finally:
            for task in running:
                task.cancel()
            for nid, st in self.state.items():
                if st in ("running", "waiting"):
                    self.set_node(nid, status="stopped")
            for fut in hub.approvals.pop(run_id, {}).values():
                if not fut.done():
                    fut.cancel()
            self.run["finished_at"] = time.time()
            self.save()
            hub.partial.pop(run_id, None)
            hub.tasks.pop(run_id, None)
            run_copy = dict(self.run)
            run_copy.pop("graph", None)
            await self.emit({"type": "run_finished", "run": run_copy})


def single_agent_graph(agent: dict) -> dict:
    return {
        "nodes": [
            {"id": "start", "type": "start", "position": {"x": 0, "y": 120}, "data": {}},
            {"id": "agent", "type": "agent", "position": {"x": 280, "y": 100}, "data": {"agentId": agent["id"]}},
            {"id": "output", "type": "output", "position": {"x": 600, "y": 120}, "data": {}},
        ],
        "edges": [
            {"id": "e1", "source": "start", "target": "agent"},
            {"id": "e2", "source": "agent", "target": "output"},
        ],
    }


def start_run(*, input_text: str, graph: dict, workflow: dict | None = None, agent: dict | None = None,
              autonomous: bool = False) -> dict:
    run = {
        "id": db.new_id(),
        "title": (input_text.strip().splitlines() or ["(empty)"])[0][:100],
        "input": input_text,
        "workflow_id": workflow["id"] if workflow else None,
        "workflow_name": workflow["name"] if workflow else (agent["name"] if agent else None),
        "agent_id": agent["id"] if agent else None,
        "status": "queued",
        "autonomous": autonomous,
        "created_at": time.time(),
        "graph": graph,
        "node_states": {},
        "cost": 0.0,
        "tokens": {"input": 0, "output": 0},
    }
    db.save_run(run)
    hub.tasks[run["id"]] = asyncio.create_task(WorkflowRun(run).execute())
    return run


def validate_graph(graph: dict) -> str | None:
    nodes = {n["id"] for n in graph.get("nodes", [])}
    if not nodes:
        return "The workflow is empty. Add at least one agent."
    adj: dict[str, list[str]] = {n: [] for n in nodes}
    for e in graph.get("edges", []):
        if e["source"] not in nodes or e["target"] not in nodes:
            return "A connection points to a step that no longer exists."
        adj[e["source"]].append(e["target"])
    seen, stack = set(), set()

    def cyclic(n: str) -> bool:
        if n in stack:
            return True
        if n in seen:
            return False
        seen.add(n)
        stack.add(n)
        hit = any(cyclic(m) for m in adj[n])
        stack.discard(n)
        return hit

    if any(cyclic(n) for n in nodes):
        return "The workflow contains a loop. Steps must flow in one direction."
    return None
