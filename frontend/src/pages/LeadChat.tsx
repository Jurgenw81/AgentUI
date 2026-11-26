// Chat with a lead agent (one that delegates, e.g. the Manager). The conversation is a project: every message
// runs on the server in the background (it keeps going if you leave), continues the same project and workflow,
// and the live plan + the team's work show up right in the conversation.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUp, ChevronDown, ExternalLink, Plus, Square } from "lucide-react";
import { api, wsUrl, type Agent, type Run, type RunEvent } from "../api";
import { ActivityList, buildItems, type Partial_ } from "../components/Activity";
import { latestPlan, PlanBoard } from "../components/PlanBoard";
import { AgentAvatar, Markdown, useToast } from "../components/ui";
import { ProviderDot } from "../components/ModelPicker";
import { ToolApprovalPanel } from "./RunView";

const LIVE = new Set(["running", "waiting", "queued"]);

export default function LeadChat({ agent, agents, defaultModel, modelText }: {
  agent: Agent; agents: Agent[]; defaultModel?: string; modelText: string;
}) {
  const key = `agentui.project.${agent.id}`;
  const [runId, setRunId] = useState<string | null>(() => localStorage.getItem(key));
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, Partial_>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // load the current project message and follow it live
  useEffect(() => {
    setRun(null);
    setEvents([]);
    setPartials({});
    if (!runId) return;
    const ws = new WebSocket(wsUrl(`/ws/runs/${runId}`));
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data) as RunEvent;
      if (e.type === "snapshot") {
        setRun(e.run as Run);
        setEvents(e.events as RunEvent[]);
        const ps: Record<string, Partial_> = {};
        (e.partial as Partial_[]).forEach((p) => (ps[`${p.node}|${p.scope}`] = p));
        setPartials(ps);
        return;
      }
      if (e.type === "error") { // the project was deleted
        localStorage.removeItem(key);
        setRunId(null);
        return;
      }
      const k = `${e.node ?? ""}|${e.scope ?? ""}`;
      if (e.type === "token") {
        setPartials((ps) => ({ ...ps, [k]: { node: e.node, scope: e.scope, agent: e.agent, text: (ps[k]?.text ?? "") + (e.text as string) } }));
        return;
      }
      if (["message", "tool_call", "node_finished", "node_error"].includes(e.type)) {
        setPartials((ps) => { const n = { ...ps }; delete n[k]; return n; });
      }
      if (e.type === "run_finished") {
        setRun((r) => (r ? { ...r, ...(e.run as Run) } : r));
        setPartials({});
      }
      if (e.type === "tool_approval_requested") setRun((r) => (r ? { ...r, status: "waiting" } : r));
      if (e.type === "tool_approval_resolved") setRun((r) => (r && r.status === "waiting" ? { ...r, status: "running" } : r));
      setEvents((es) => [...es, e]);
    };
    return () => ws.close();
  }, [runId, key]);

  const live = !!run && LIVE.has(run.status);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [events.length, run?.id, run?.status]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending || live) return;
    setSending(true);
    try {
      const r = await api.startRun({ agent_id: agent.id, input: text, continue_run: run?.id });
      localStorage.setItem(key, r.id);
      setInput("");
      setRunId(r.id);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  };

  const newProject = () => {
    localStorage.removeItem(key);
    setRunId(null);
    setInput("");
  };

  const earlier = run?.history ?? [];
  const plan = latestPlan(events);
  const items = buildItems(events.filter((e) => !(e.type === "message" && !e.depth && !e.intermediate)), Object.values(partials));
  const resolved = new Set(events.filter((e) => e.type === "tool_approval_resolved").map((e) => e.request_id));
  const pending = live ? events.filter((e) => e.type === "tool_approval_requested" && !resolved.has(e.request_id)) : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <AgentAvatar agent={agent} size={34} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{run ? <>{agent.name} <span className="font-normal text-zinc-400">·</span> <span className="font-normal">{earlier.find((m) => m.role === "user")?.content.split("\n")[0] ?? run.title}</span></> : agent.name}</div>
          <div className="flex items-center gap-1.5 text-xs text-zinc-500"><ProviderDot model={agent.model || defaultModel} /> {modelText} · leads a team, keeps working in the background</div>
        </div>
        {run?.project_workflow_id && (
          <Link to={`/workflows/${run.project_workflow_id}`} className="btn-ghost px-2 py-1.5 text-xs"><ExternalLink size={14} /> Workflow</Link>
        )}
        {run && <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={newProject}><Plus size={14} /> New project</button>}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
          {!runId && (
            <div className="py-16 text-center">
              <div className="mx-auto w-fit"><AgentAvatar agent={agent} size={56} /></div>
              <h2 className="mt-4 text-lg font-semibold">What should {agent.name} and the team work on?</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
                {agent.name} plans the work, hands the parts to the team and reports back. Keep talking to change or extend it.
                Everything keeps running if you leave this page, and the project shows up under Workflows.
              </p>
            </div>
          )}

          {earlier.map((m, i) => <Bubble key={i} role={m.role} agent={agent}><Markdown>{m.content}</Markdown></Bubble>)}

          {run && (
            <>
              <Bubble role="user" agent={agent}><span className="whitespace-pre-wrap">{run.input}</span></Bubble>
              <Bubble role="assistant" agent={agent}>
                {plan && (
                  <div className={live ? "sticky top-2 z-10 mb-3 rounded-xl bg-white shadow-lg dark:bg-zinc-900" : "mb-3"}>
                    <PlanBoard plan={plan} agents={agents} live={live} defaultModel={defaultModel} request={run.input} />
                  </div>
                )}
                {live ? (
                  <>
                    <ActivityList items={items} showAgent={false} />
                    {pending.map((ev) => (
                      <ToolApprovalPanel key={ev.request_id as string} tool={ev.tool as string} args={ev.args as string}
                        agent={ev.agent as string} concerns={ev.concerns as string}
                        onDecide={(approved, note) => api.decideApproval(run.id, ev.request_id as string, { approved, note })} />
                    ))}
                    {!Object.keys(partials).length && <div className="mt-1 flex gap-1">{[0, 1, 2].map((d) => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: `${d * 0.15}s` }} />)}</div>}
                  </>
                ) : (
                  <>
                    {items.length > 0 && <TeamWork items={items} />}
                    {run.output && <Markdown>{run.output}</Markdown>}
                    {run.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{run.status === "stopped" ? "Stopped." : run.error}</div>}
                  </>
                )}
              </Bubble>
            </>
          )}
          {runId && !run && <div className="text-center text-sm text-zinc-500">Loading…</div>}
          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-zinc-300 bg-white p-2 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-950">
          <textarea
            rows={1}
            className="max-h-48 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
            placeholder={live ? `${agent.name} and the team are working… you can send your next message when they're done`
              : run ? `Reply to ${agent.name}: change something or ask for more…` : `Describe the task for ${agent.name} and the team…`}
            value={input}
            onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          {live ? (
            <button className="btn-secondary p-2" title="Stop" onClick={() => api.stopRun(run!.id)}><Square size={16} /></button>
          ) : (
            <button className="btn-primary p-2" disabled={!input.trim() || sending} onClick={send}><ArrowUp size={16} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, agent, children }: { role: string; agent: Agent; children: React.ReactNode }) {
  if (role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-sm text-white [&_*]:text-white">{children}</div>
      </div>
    );
  return (
    <div className="flex gap-3">
      <AgentAvatar agent={agent} size={30} />
      <div className="min-w-0 flex-1 space-y-2 pt-1">{children}</div>
    </div>
  );
}

function TeamWork({ items }: { items: ReturnType<typeof buildItems> }) {
  const [open, setOpen] = useState(false);
  const handoffs = items.filter((i) => i.kind === "delegate").length;
  return (
    <div>
      <button className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300" onClick={() => setOpen(!open)}>
        <ChevronDown size={13} className={`transition ${open ? "rotate-180" : ""}`} />
        {open ? "Hide" : "Show"} the team's work{handoffs ? ` (${handoffs} hand-off${handoffs === 1 ? "" : "s"})` : ""}
      </button>
      {open && <div className="mt-2"><ActivityList items={items} showAgent={false} /></div>}
    </div>
  );
}
