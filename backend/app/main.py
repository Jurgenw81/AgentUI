"""AgentUI API server."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

import json

from . import cli_agent, db, engine, llm, mcp_manager, policies, seed, tools

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.mark_interrupted_runs()
    engine.sync_interrupted_projects()
    seed.seed()
    seed.seed_v2()
    seed.seed_v3()
    startup_connect = asyncio.create_task(mcp_manager.manager.connect_all())
    yield
    startup_connect.cancel()
    await mcp_manager.manager.shutdown()


app = FastAPI(title="AgentUI", lifespan=lifespan)


def _remember_port(port: int | None) -> None:
    if port:
        cli_agent.SERVER_URL["value"] = f"http://127.0.0.1:{port}"


def _same_origin(origin: str | None, host: str | None) -> bool:
    """True if a browser request comes from AgentUI's own pages (or isn't from a browser at all)."""
    if origin is None:
        return True  # scripts, curl, the MCP bridge: not a cross-site browser request
    from urllib.parse import urlparse
    o = urlparse(origin)
    if o.scheme not in ("http", "https") or not o.netloc:
        return False  # e.g. "null" from sandboxed previews / file:// pages
    norm = lambda h: (h or "").replace("127.0.0.1", "localhost").replace("[::1]", "localhost")  # noqa: E731
    return norm(o.netloc) == norm(host)


@app.middleware("http")
async def protect_and_remember(request: Request, call_next):
    _remember_port(request.url.port)
    # Block cross-site requests that change things (other websites you have open, or agent-built pages
    # in the preview, must not be able to add MCP servers, change settings, start runs...).
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.url.path.startswith("/api/") \
            and not _same_origin(request.headers.get("origin"), request.headers.get("host")):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "Cross-site request blocked."}, status_code=403)
    return await call_next(request)


async def _ws_allowed(ws: WebSocket) -> bool:
    if _same_origin(ws.headers.get("origin"), ws.headers.get("host")):
        return True
    await ws.close(code=1008)
    return False


# ---------------- internal: tool bridge for subscription (CLI) agents ----------------

def _local_ctx(request: Request, ctx_id: str) -> dict:
    if request.client and request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Local only")
    ctx = cli_agent.CONTEXTS.get(ctx_id)
    if not ctx:
        raise HTTPException(404, "Unknown or finished agent context")
    return ctx


@app.get("/api/internal/ctx/{ctx_id}/tools")
def bridge_tools(ctx_id: str, request: Request):
    return {"tools": _local_ctx(request, ctx_id)["tools"]}


@app.post("/api/internal/ctx/{ctx_id}/call")
async def bridge_call(ctx_id: str, request: Request, body: dict = Body(...)):
    ctx = _local_ctx(request, ctx_id)
    output = await ctx["call"](body.get("name", ""), json.dumps(body.get("arguments") or {}))
    return {"output": output}


def _404(what: str):
    raise HTTPException(404, f"{what} not found")


# ---------------- agents ----------------

AGENT_FIELDS = {"name", "description", "system_prompt", "model", "tools", "temperature", "color", "icon", "max_steps", "team"}


@app.get("/api/agents")
def list_agents():
    return db.list_docs("agent")


@app.post("/api/agents")
def create_agent(body: dict = Body(...)):
    data = {k: v for k, v in body.items() if k in AGENT_FIELDS}
    if not (data.get("name") or "").strip():
        raise HTTPException(400, "Give the agent a name.")
    return db.save_doc("agent", {"tools": [], "color": "#6366f1", **data})


@app.put("/api/agents/{agent_id}")
def update_agent(agent_id: str, body: dict = Body(...)):
    agent = db.get_doc("agent", agent_id) or _404("Agent")
    agent.update({k: v for k, v in body.items() if k in AGENT_FIELDS})
    return db.save_doc("agent", agent)


@app.post("/api/agents/{agent_id}/duplicate")
def duplicate_agent(agent_id: str):
    agent = db.get_doc("agent", agent_id) or _404("Agent")
    copy = {k: v for k, v in agent.items() if k in AGENT_FIELDS}
    copy["name"] = f"{agent['name']} (copy)"
    return db.save_doc("agent", copy)


@app.delete("/api/agents/{agent_id}")
def delete_agent(agent_id: str):
    db.delete_doc("agent", agent_id)
    return {"ok": True}


# ---------------- workflows ----------------

@app.get("/api/workflows")
def list_workflows():
    return db.list_docs("workflow")


@app.get("/api/workflows/{wf_id}")
def get_workflow(wf_id: str):
    return db.get_doc("workflow", wf_id) or _404("Workflow")


@app.post("/api/workflows")
def create_workflow(body: dict = Body(...)):
    return db.save_doc("workflow", {
        "name": body.get("name") or "Untitled workflow",
        "description": body.get("description", ""),
        "graph": body.get("graph") or {
            "nodes": [
                {"id": "start", "type": "start", "position": {"x": 0, "y": 150}, "data": {}},
                {"id": "output", "type": "output", "position": {"x": 600, "y": 150}, "data": {}},
            ],
            "edges": [],
        },
    })


@app.put("/api/workflows/{wf_id}")
def update_workflow(wf_id: str, body: dict = Body(...)):
    wf = db.get_doc("workflow", wf_id) or _404("Workflow")
    for k in ("name", "description", "graph", "autonomous"):
        if k in body:
            wf[k] = body[k]
    return db.save_doc("workflow", wf)


@app.post("/api/workflows/{wf_id}/duplicate")
def duplicate_workflow(wf_id: str):
    wf = db.get_doc("workflow", wf_id) or _404("Workflow")
    return db.save_doc("workflow", {"name": f"{wf['name']} (copy)", "description": wf.get("description", ""),
                                    "graph": wf["graph"]})


@app.delete("/api/workflows/{wf_id}")
def delete_workflow(wf_id: str):
    db.delete_doc("workflow", wf_id)
    return {"ok": True}


# ---------------- runs ----------------

@app.post("/api/runs")
async def create_run(body: dict = Body(...)):
    text = (body.get("input") or "").strip()
    if not text:
        raise HTTPException(400, "Describe the task first.")
    if body.get("agent_id"):
        agent = db.get_doc("agent", body["agent_id"]) or _404("Agent")
        # a lead agent (one that can delegate) gets a project: it runs in the background and its plan is kept as a workflow
        project = "delegate" in (agent.get("tools") or [])
        prev = db.get_run(body["continue_run"]) if project and body.get("continue_run") else None
        return engine.start_run(input_text=text, graph=engine.single_agent_graph(agent), agent=agent, follow_up_of=prev,
                                project=project, autonomous=bool(db.get_setting("autonomous_default", False)))
    wf = db.get_doc("workflow", body.get("workflow_id", "")) or _404("Workflow")
    graph = body.get("graph") or wf["graph"]
    if err := engine.validate_graph(graph):
        raise HTTPException(400, err)
    agents = {a["id"] for a in db.list_docs("agent")}
    for n in graph["nodes"]:
        d = n.get("data") or {}
        if n["type"] == "agent" and d.get("agentId") not in agents:
            raise HTTPException(400, "Every agent step needs an agent. Click the step and choose one.")
        if n["type"] == "loop" and (d.get("agentId") not in agents or d.get("reviewerId") not in agents):
            raise HTTPException(400, "Every review loop needs a worker and a reviewer. Click the loop and choose both.")
    autonomous = body.get("autonomous")
    if autonomous is None:  # run dialog didn't say: workflow default, then global default
        autonomous = wf.get("autonomous", db.get_setting("autonomous_default", False))
    return engine.start_run(input_text=text, graph=graph, workflow=wf, autonomous=bool(autonomous))


@app.post("/api/runs/{run_id}/approvals/{node_id}")
def decide_approval(run_id: str, node_id: str, body: dict = Body(...)):
    fut = engine.hub.approvals.get(run_id, {}).get(node_id)
    if not fut or fut.done():
        raise HTTPException(409, "This step isn't waiting for approval any more.")
    content = body.get("content")
    fut.set_result({"approved": bool(body.get("approved")), "note": (body.get("note") or "").strip(),
                    "content": content if isinstance(content, str) else None})
    return {"ok": True}


@app.get("/api/runs")
def list_runs():
    return db.list_runs()


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    run = db.get_run(run_id) or _404("Run")
    return {"run": run, "events": db.get_events(run_id)}


@app.post("/api/runs/{run_id}/stop")
def stop_run(run_id: str):
    task = engine.hub.tasks.get(run_id)
    if task:
        task.cancel()
    return {"ok": True}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str):
    if task := engine.hub.tasks.get(run_id):
        task.cancel()
    db.delete_run(run_id)
    return {"ok": True}


@app.websocket("/ws/runs/{run_id}")
async def ws_run(ws: WebSocket, run_id: str):
    if not await _ws_allowed(ws):
        return
    await ws.accept()
    q = engine.hub.subscribe(run_id)
    try:
        run = db.get_run(run_id)
        if not run:
            await ws.send_json({"type": "error", "error": "Run not found"})
            return
        await ws.send_json({
            "type": "snapshot", "run": run, "events": db.get_events(run_id),
            "partial": list(engine.hub.partial.get(run_id, {}).values()),
        })
        if run["status"] not in ("running", "queued", "waiting"):
            return
        while True:
            event = await q.get()
            await ws.send_json(event)
            if event["type"] == "run_finished":
                break
    except WebSocketDisconnect:
        pass
    finally:
        engine.hub.unsubscribe(run_id, q)
        try:
            await ws.close()
        except RuntimeError:
            pass


# ---------------- chat with a single agent ----------------

@app.websocket("/ws/chat")
async def ws_chat(ws: WebSocket):
    if not await _ws_allowed(ws):
        return
    await ws.accept()
    _remember_port(ws.url.port)
    current: asyncio.Task | None = None
    decisions: dict[str, asyncio.Future] = {}

    async def handle(msg: dict) -> None:
        agent = db.get_doc("agent", msg.get("agent_id", ""))
        if not agent:
            await ws.send_json({"type": "error", "error": "Agent not found"})
            return
        budget = engine.Budget(float(db.get_setting("max_cost_per_run", 2.0) or 0))

        async def emit(event: dict) -> None:
            await ws.send_json(event)

        last_user = next((m.get("content", "") for m in reversed(msg.get("messages", [])) if m.get("role") == "user"), "")

        async def gate(tool: str, args: str, policy: str, agent_name: str, call_id: str) -> tuple[bool, str]:
            concerns = ""
            if policy == "ai":
                ok, feedback = await engine.check_tool_call(tool, args, agent_name, last_user, emit, budget)
                if ok:
                    await emit({"type": "tool_approval_resolved", "request_id": call_id, "tool": tool,
                                "approved": True, "by": "ai", "reason": feedback})
                    return True, ""
                concerns = feedback
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            decisions[call_id] = fut
            await emit({"type": "tool_approval_requested", "request_id": call_id, "tool": tool, "args": args,
                        "agent": agent_name, "concerns": concerns})
            try:
                d = await fut
            finally:
                decisions.pop(call_id, None)
            await emit({"type": "tool_approval_resolved", "request_id": call_id, "tool": tool,
                        "approved": d["approved"], "by": "you", "note": d.get("note", "")})
            return d["approved"], d.get("note", "")

        # a lead agent's task is a project even when it arrives through chat: its plan shows up under Workflows
        project = None
        if "delegate" in (agent.get("tools") or []):
            project = {"id": None, "title": (last_user.strip().splitlines() or ["Project"])[0][:100],
                       "chat_agent_id": agent["id"], "status": "running"}
        try:
            result = await engine.run_agent(agent, msg.get("messages", []), emit, budget, gate=gate, project=project)
            if project:
                project["status"] = "done"
            await ws.send_json({"type": "done", "output": result["output"],
                                "cost": budget.cost, "tokens": {"input": budget.tokens_in, "output": budget.tokens_out}})
        except asyncio.CancelledError:
            if project:
                project["status"] = "stopped"
            await ws.send_json({"type": "stopped"})
            raise
        except Exception as e:  # noqa: BLE001
            if project:
                project["status"] = "error"
            await ws.send_json({"type": "error", "error": f"{type(e).__name__}: {e}"})
        finally:
            if project:
                engine.sync_project_status(project)

    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "tool_decision":
                fut = decisions.get(msg.get("request_id", ""))
                if fut and not fut.done():
                    fut.set_result({"approved": bool(msg.get("approved")), "note": msg.get("note", "")})
                continue
            if msg.get("type") == "stop":
                if current and not current.done():
                    current.cancel()
                continue
            if current and not current.done():
                continue
            current = asyncio.create_task(handle(msg))
    except WebSocketDisconnect:
        if current:
            current.cancel()


# ---------------- models, tools, settings ----------------

@app.post("/api/claude-code/refresh")
async def claude_code_refresh():
    await cli_agent.codex_status(force=True)
    await cli_agent.gemini_status(force=True)
    return await cli_agent.claude_status(force=True)


@app.get("/api/models")
async def models():
    return {"providers": await llm.list_models(), "default_model": engine.default_model()}


@app.get("/api/tools")
def list_tools():
    catalog = tools.tool_catalog()
    for srv in mcp_manager.servers_config():
        if not srv.get("enabled", True):
            continue
        conn = mcp_manager.manager.conns.get(srv["id"])
        names = [t["name"] for t in (conn.tools if conn else [])]
        desc = (f"{len(names)} tools: " + ", ".join(names[:6]) + ("…" if len(names) > 6 else "")) if names \
            else (srv.get("description") or "External MCP tool server")
        catalog.append({"id": f"mcp:{srv['id']}", "label": srv["name"], "group": "MCP servers",
                        "description": desc, "dangerous": False})
    return catalog


# ---------------- tool safety rules ----------------

@app.get("/api/tool-policies")
def get_tool_policies():
    return [{"key": t["id"], "label": t["label"], "group": t["group"], "description": t["description"],
             "policy": policies.get(t["id"]), "default_policy": policies.default_for(t["id"])}
            for t in tools.tool_catalog()]


@app.put("/api/tool-policies")
def put_tool_policies(body: dict = Body(...)):
    policies.set_many({k: v for k, v in body.items() if isinstance(k, str)})
    return {"ok": True}


# ---------------- MCP tool servers ----------------

MCP_FIELDS = {"name", "description", "type", "command", "args", "env", "cwd", "url", "headers", "enabled", "oauth", "registry_name"}


def _clean_mcp(body: dict) -> dict:
    cfg = {k: v for k, v in body.items() if k in MCP_FIELDS}
    cfg["type"] = "http" if cfg.get("type") == "http" else "stdio"
    if not (cfg.get("name") or "").strip():
        raise HTTPException(400, "Give the server a name.")
    if cfg["type"] == "stdio" and not (cfg.get("command") or "").strip():
        raise HTTPException(400, "Enter the command that starts the server (e.g. npx).")
    if cfg["type"] == "http" and not (cfg.get("url") or "").startswith(("http://", "https://")):
        raise HTTPException(400, "Enter the server's URL (http:// or https://).")
    if isinstance(cfg.get("args"), str):
        import shlex
        cfg["args"] = shlex.split(cfg["args"])
    cfg.setdefault("enabled", True)
    return cfg


@app.get("/api/mcp")
async def mcp_list():
    return await mcp_manager.manager.status()


@app.post("/api/mcp")
async def mcp_create(body: dict = Body(...)):
    cfg = {"id": db.new_id(), **_clean_mcp(body)}
    db.set_setting("mcp_servers", [*mcp_manager.servers_config(), cfg])
    await mcp_manager.manager.reconnect(cfg["id"])
    return next(s for s in await mcp_manager.manager.status() if s["id"] == cfg["id"])


@app.put("/api/mcp/{server_id}")
async def mcp_update(server_id: str, body: dict = Body(...)):
    servers = mcp_manager.servers_config()
    cur = next((s for s in servers if s["id"] == server_id), None) or _404("MCP server")
    merged = {**cur, **_clean_mcp({**cur, **body})}
    db.set_setting("mcp_servers", [merged if s["id"] == server_id else s for s in servers])
    await mcp_manager.manager.reconnect(server_id)
    return next(s for s in await mcp_manager.manager.status() if s["id"] == server_id)


@app.get("/api/mcp/oauth/callback")
def mcp_oauth_callback(code: str = "", state: str = "", error: str = "", error_description: str = "", iss: str | None = None):
    from mcp.shared.auth import AuthorizationCodeResult
    fut = mcp_manager.OAUTH_PENDING.get(state)
    if error:
        msg, ok = f"Login failed: {error_description or error}", False
        if fut and not fut.done():
            fut.set_exception(RuntimeError(msg))
    elif not fut or fut.done():
        msg, ok = "This login link has expired. Go back to AgentUI and click Log in again.", False
    else:
        fut.set_result(AuthorizationCodeResult(code=code, state=state, iss=iss))
        msg, ok = "You're logged in. You can close this tab and go back to AgentUI.", True
    color = "#059669" if ok else "#dc2626"
    return HTMLResponse(f"""<!doctype html><title>AgentUI login</title>
      <body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">
      <div style="text-align:center"><div style="font-size:48px">{'✅' if ok else '⚠️'}</div>
      <h2 style="color:{color}">{msg}</h2></div>
      <script>{'setTimeout(() => window.close(), 1500)' if ok else ''}</script></body>""")


@app.post("/api/mcp/{server_id}/logout")
async def mcp_logout(server_id: str):
    mcp_manager.forget_login(server_id)
    await mcp_manager.manager.reconnect(server_id)
    return next((s for s in await mcp_manager.manager.status() if s["id"] == server_id), None) or _404("MCP server")


REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers"


def _registry_entry(item: dict) -> dict:
    s = item.get("server", item)
    remotes = [r for r in (s.get("remotes") or []) if r.get("type") in ("streamable-http", "http")]
    pkgs = [p for p in (s.get("packages") or []) if p.get("registryType") in ("npm", "pypi", "oci")
            and (p.get("transport") or {}).get("type", "stdio") == "stdio"]
    installs = []
    for r in remotes[:1]:
        installs.append({
            "kind": "remote", "type": "http", "url": r["url"],
            "headers": [{"name": h["name"], "value": h.get("value") or "", "description": h.get("description", ""),
                         "required": bool(h.get("isRequired")), "secret": bool(h.get("isSecret"))}
                        for h in (r.get("headers") or [])],
        })
    for p in pkgs[:2]:
        ident, ver, kind = p["identifier"], p.get("version"), p["registryType"]
        env = [{"name": e["name"], "description": e.get("description", ""), "required": bool(e.get("isRequired")),
                "secret": bool(e.get("isSecret")), "default": e.get("default") or ""}
               for e in (p.get("environmentVariables") or [])]
        extra = []
        for a in p.get("packageArguments") or []:
            val = a.get("value") or a.get("default") or (f"<{a.get('valueHint') or a.get('name') or 'value'}>")
            extra += [a["name"], val] if a.get("type") == "named" and a.get("name") else [val]
        if kind == "npm":
            command, args = "npx", ["-y", f"{ident}@{ver}" if ver else ident, *extra]
        elif kind == "pypi":
            command, args = "uvx", [ident, *extra]
        else:
            command, args = "docker", ["run", "-i", "--rm", *[x for e in env for x in ("-e", e["name"])], ident, *extra]
        installs.append({"kind": kind, "type": "stdio", "command": command, "args": args, "env": env})
    title = s.get("title") or s["name"].split("/")[-1].replace("-", " ").replace("_", " ").title()
    return {
        "name": s["name"], "title": title, "description": s.get("description", ""), "version": s.get("version"),
        "website": s.get("websiteUrl") or (s.get("repository") or {}).get("url"),
        "icon": next((i["src"] for i in (s.get("icons") or []) if i.get("src", "").startswith("https://")), None),
        "installs": installs,
    }


@app.get("/api/mcp/registry")
async def mcp_registry(q: str = "", cursor: str = ""):
    import httpx
    params = {"limit": 40, "version": "latest"}
    if q.strip():
        params["search"] = q.strip()
    if cursor:
        params["cursor"] = cursor
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(REGISTRY, params=params, headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't reach the MCP registry: {type(e).__name__}")
    entries = [_registry_entry(i) for i in data.get("servers", [])]
    return {"servers": [e for e in entries if e["installs"]], "next": (data.get("metadata") or {}).get("nextCursor")}


@app.post("/api/mcp/{server_id}/reconnect")
async def mcp_reconnect(server_id: str):
    await mcp_manager.manager.reconnect(server_id)
    return next((s for s in await mcp_manager.manager.status() if s["id"] == server_id), None) or _404("MCP server")


@app.delete("/api/mcp/{server_id}")
async def mcp_delete(server_id: str):
    await mcp_manager.manager.remove(server_id)
    db.set_setting("mcp_servers", [s for s in mcp_manager.servers_config() if s["id"] != server_id])
    mcp_manager.forget_login(server_id)
    policies.set_many({k: None for k in policies.all_set() if k.startswith(f"mcp:{server_id}:")})
    for agent in db.list_docs("agent"):  # drop it from agents that used it
        if f"mcp:{server_id}" in (agent.get("tools") or []):
            agent["tools"] = [t for t in agent["tools"] if t != f"mcp:{server_id}"]
            db.save_doc("agent", agent)
    return {"ok": True}


def _settings_view() -> dict:
    saved = db.get_setting("providers", {}) or {}
    providers = {}
    for pid, info in llm.PROVIDERS.items():
        cfg = saved.get(pid, {})
        key = cfg.get("api_key") or ""
        providers[pid] = {
            "label": info["label"],
            "fields": info["fields"],
            "base_url": cfg.get("base_url") or info.get("defaults", {}).get("base_url", ""),
            "api_key_set": bool(key),
            "api_key_hint": f"…{key[-4:]}" if len(key) > 8 else ("set" if key else ""),
            "env_key": bool(os.environ.get(f"{pid.upper()}_API_KEY")),
            "kind": info.get("kind", "api"),
        }
    return {
        "providers": providers,
        "default_model": engine.default_model(),
        "max_cost_per_run": db.get_setting("max_cost_per_run", 2.0),
        "allow_code_execution": db.get_setting("allow_code_execution", False),
        "autonomous_default": db.get_setting("autonomous_default", False),
        "workspace_dir": str(db.WORKSPACE_DIR),
    }


@app.get("/api/settings")
def get_settings():
    return _settings_view()


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    if "providers" in body:
        saved = db.get_setting("providers", {}) or {}
        for pid, fields in (body["providers"] or {}).items():
            if pid not in llm.PROVIDERS:
                continue
            cur = saved.setdefault(pid, {})
            for k, v in (fields or {}).items():
                if k not in ("api_key", "base_url"):
                    continue
                if v is None:
                    cur.pop(k, None)
                elif v != "":
                    cur[k] = v.strip()
        db.set_setting("providers", saved)
    for k in ("default_model", "max_cost_per_run", "allow_code_execution", "autonomous_default"):
        if k in body:
            db.set_setting(k, body[k])
    return _settings_view()


@app.post("/api/test-model")
async def test_model(body: dict = Body(...)):
    try:
        reply = await asyncio.wait_for(llm.test_model(body["model"]), timeout=45)
        return {"ok": True, "reply": reply}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}


# ---------------- workspace files ----------------

@app.get("/api/workspace")
def workspace_files():
    root = db.WORKSPACE_DIR.resolve()
    files = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            st = p.stat()
            files.append({"path": str(p.relative_to(root)), "size": st.st_size, "modified": st.st_mtime})
    return files


@app.get("/api/workspace/file")
def workspace_file(path: str):
    p = tools._safe_path(path)
    if not p.is_file():
        _404("File")
    return FileResponse(p, filename=p.name)


PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads"


@app.get("/preview/{path:path}")
def preview(path: str = ""):
    """Serve workspace files for the website preview. The CSP sandbox gives the page its own isolated
    origin, even when opened in a new tab, so agent-written JavaScript can't talk to AgentUI."""
    p = tools._safe_path(path)
    if p.is_dir():
        p = p / "index.html"
    if not p.is_file():
        return HTMLResponse(f"<p style='font-family:sans-serif'>Not found: {path}</p>", status_code=404,
                            headers={"Content-Security-Policy": PREVIEW_CSP})
    return FileResponse(p, headers={"Content-Security-Policy": PREVIEW_CSP, "Cache-Control": "no-store",
                                    "X-Content-Type-Options": "nosniff"})


@app.delete("/api/workspace/file")
def workspace_delete(path: str):
    p = tools._safe_path(path)
    if p.is_file():
        p.unlink()
    return {"ok": True}


# ---------------- frontend ----------------

if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str) -> Any:
        f = FRONTEND_DIST / full_path
        if full_path and f.is_file() and FRONTEND_DIST in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(FRONTEND_DIST / "index.html")
