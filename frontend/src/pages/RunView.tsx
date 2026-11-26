import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useNodesState, type Edge } from "@xyflow/react";
import { ArrowLeft, Bot, Check, ChevronDown, Clock, Coins, Copy, Hand, Hash, Pencil, RotateCcw, Square, X } from "lucide-react";
import { api, fmtCost, fmtTokens, wsUrl, type Agent, type Run, type RunEvent } from "../api";
import { nodeTypes, type FlowNode } from "../components/FlowNodes";
import { ActivityList, buildItems, prettyTool, type Partial_ } from "../components/Activity";
import { Markdown, Spinner, StatusBadge, useToast } from "../components/ui";
import { edgeDefaults } from "./WorkflowEditor";
import { useDefaultModel } from "../components/ModelPicker";

const LIVE = new Set(["running", "queued", "waiting"]);

export default function RunView() {
  return (
    <ReactFlowProvider>
      <RunInner />
    </ReactFlowProvider>
  );
}

function RunInner() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, Partial_>>({});
  const [agents, setAgents] = useState<Record<string, Agent>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now() / 1000);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const defaultModel = useDefaultModel();

  useEffect(() => {
    api.agents().then((a) => setAgents(Object.fromEntries(a.map((x) => [x.id, x]))));
  }, []);

  // live connection
  useEffect(() => {
    setRun(null);
    setEvents([]);
    setPartials({});
    const ws = new WebSocket(wsUrl(`/ws/runs/${id}`));
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
      if (e.type === "error") return;
      const key = `${e.node ?? ""}|${e.scope ?? ""}`;
      if (e.type === "token") {
        setPartials((ps) => ({ ...ps, [key]: { node: e.node, scope: e.scope, agent: e.agent, text: (ps[key]?.text ?? "") + (e.text as string) } }));
        return;
      }
      if (["message", "tool_call", "node_finished", "node_error"].includes(e.type)) {
        setPartials((ps) => { const n = { ...ps }; delete n[key]; return n; });
      }
      setEvents((es) => [...es, e]);
      setRun((r) => {
        if (!r) return r;
        const ns = { ...r.node_states };
        const node = e.node as string;
        if (e.type === "node_started") ns[node] = { ...ns[node], status: "running", started_at: e.ts };
        if (e.type === "node_finished") ns[node] = { ...ns[node], status: "done", output: e.output as string, finished_at: e.ts };
        if (e.type === "node_skipped") ns[node] = { ...ns[node], status: "skipped" };
        if (e.type === "node_error") ns[node] = { ...ns[node], status: "error", error: e.error as string };
        if (e.type === "router_decision") ns[node] = { ...ns[node], decision: e.target_label as string, reason: e.reason as string };
        if (e.type === "loop_round") ns[node] = { ...ns[node], round: e.round as number, max_rounds: e.max_rounds as number };
        if (e.type === "approval_requested") ns[node] = {
          ...ns[node], status: "waiting", content: e.content as string, concerns: (e.concerns as string) || null,
          deadline: (e.deadline as number) ?? null, timeout_action: (e.timeout_action as "approve" | "reject") ?? null,
        };
        if (e.type === "approval_resolved") ns[node] = { ...ns[node], status: e.approved ? "running" : "stopped" };
        if (e.type === "tool_approval_requested") ns[node] = { ...ns[node], status: "waiting" };
        if (e.type === "tool_approval_resolved" && ns[node]?.status === "waiting") ns[node] = { ...ns[node], status: "running" };
        let { cost, tokens, status } = r;
        if (e.type === "usage") {
          cost += (e.cost as number) || 0;
          tokens = { input: tokens.input + ((e.input as number) || 0), output: tokens.output + ((e.output as number) || 0) };
        }
        if (e.type === "run_started") status = "running";
        if (e.type === "approval_requested" || e.type === "tool_approval_requested") status = "waiting";
        if (e.type === "tool_approval_resolved" && !Object.entries(ns).some(([, v]) => v.status === "waiting")) status = "running";
        if (e.type === "approval_resolved" && !Object.entries(ns).some(([k, v]) => k !== node && v.status === "waiting")) status = "running";
        if (e.type === "run_finished") return { ...r, ...(e.run as Run), graph: r.graph };
        return { ...r, node_states: ns, cost, tokens, status };
      });
    };
    return () => ws.close();
  }, [id]);

  const live = run ? LIVE.has(run.status) : false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => clearInterval(t);
  }, [live]);

  // follow along at the bottom while running
  useEffect(() => {
    const el = scroller.current;
    if (live && el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [events, partials, live]);

  const flow = useMemo(() => {
    if (!run?.graph) return { nodes: [] as FlowNode[], edges: [] as Edge[] };
    const st = run.node_states;
    const nodes: FlowNode[] = run.graph.nodes.map((n) => ({
      ...n, draggable: false, connectable: false,
      data: {
        ...n.data, agent: agents[n.data.agentId ?? ""], reviewer: agents[n.data.reviewerId ?? ""],
        status: st[n.id]?.status ?? "pending", decision: st[n.id]?.decision, round: st[n.id]?.round, defaultModel,
      },
    }));
    const edges: Edge[] = run.graph.edges.map((e) => {
      const s = st[e.source]?.status, t = st[e.target]?.status;
      const cls = s === "done" && (t === "running" || t === "waiting") ? "edge-running" : s === "done" && t === "done" ? "edge-done" : t === "skipped" || s === "skipped" ? "edge-dead" : "";
      return { ...e, ...edgeDefaults, className: cls, animated: false };
    });
    return { nodes, edges };
  }, [run, agents, defaultModel]);

  // React Flow needs onNodesChange to store node measurements, so keep nodes in local state
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<FlowNode>([]);
  useEffect(() => {
    setFlowNodes((prev) => flow.nodes.map((n) => {
      const old = prev.find((p) => p.id === n.id);
      return old ? { ...old, data: n.data } : n;
    }));
  }, [flow.nodes, setFlowNodes]);

  if (!run) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const labelOf = (nid: string) => {
    const n = run.graph?.nodes.find((x) => x.id === nid);
    if (!n) return nid;
    if (n.type === "router") return n.data.label || "Router";
    if (n.type === "approval") return n.data.label || "Your approval";
    if (n.type === "loop") {
      const w = agents[n.data.agentId ?? ""]?.name, r = agents[n.data.reviewerId ?? ""]?.name;
      return n.data.label || (w && r ? `${w} ⇄ ${r}` : "Review loop");
    }
    return n.data.label || agents[n.data.agentId ?? ""]?.name || { start: "Start", output: "Output", router: "Router", agent: "Agent" }[n.type as string];
  };

  // steps in the order they started
  const stepOrder = Object.entries(run.node_states)
    .filter(([nid, s]) => s.status !== "skipped" && !["start", "output"].includes(run.graph?.nodes.find((n) => n.id === nid)?.type ?? ""))
    .sort((a, b) => (a[1].started_at ?? Infinity) - (b[1].started_at ?? Infinity))
    .map(([nid]) => nid);

  const duration = (run.finished_at ?? now) - run.created_at;
  const isOpen = (nid: string) => open[nid] ?? (["running", "error", "waiting"].includes(run.node_states[nid]?.status) || stepOrder.length <= 2);
  const waitingNode = stepOrder.find((nid) => run.node_states[nid]?.status === "waiting");

  const rerun = async () => {
    try {
      const r = await api.startRun(run.agent_id ? { agent_id: run.agent_id, input: run.input }
        : { workflow_id: run.workflow_id!, input: run.input, autonomous: !!run.autonomous });
      nav(`/runs/${r.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <Link to="/runs" className="btn-ghost p-1.5"><ArrowLeft size={18} /></Link>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{run.title}</div>
          <div className="text-xs text-zinc-500">
            {run.workflow_id ? <Link className="hover:underline" to={`/workflows/${run.workflow_id}`}>{run.workflow_name}</Link> : run.workflow_name}
            {" · "}{new Date(run.created_at * 1000).toLocaleString()}
          </div>
        </div>
        <div className="hidden items-center gap-4 text-xs text-zinc-500 md:flex">
          <span className="flex items-center gap-1"><Clock size={13} /> {duration.toFixed(0)}s</span>
          <span className="flex items-center gap-1" title={`${run.tokens.input} in / ${run.tokens.output} out`}><Hash size={13} /> {fmtTokens(run.tokens.input + run.tokens.output)} tokens</span>
          <span className="flex items-center gap-1"><Coins size={13} /> {fmtCost(run.cost)}</span>
        </div>
        {run.autonomous && (
          <span title="This run never stops to ask you" className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Bot size={12} /> Autonomous
          </span>
        )}
        <StatusBadge status={run.status} />
        {live ? (
          <button className="btn-secondary" onClick={() => api.stopRun(run.id)}><Square size={14} /> Stop</button>
        ) : (
          <button className="btn-secondary" onClick={rerun}><RotateCcw size={14} /> Run again</button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative hidden min-w-0 flex-1 lg:block">
          {flowNodes.length > 0 && <ReactFlow
            nodes={flowNodes} onNodesChange={onNodesChange} edges={flow.edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => { setOpen((o) => ({ ...o, [n.id]: true })); sectionRefs.current[n.id]?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} className="!bg-zinc-50 dark:!bg-zinc-950" color="#a1a1aa55" />
            <Controls showInteractive={false} />
          </ReactFlow>}
        </div>

        <div ref={scroller} className="w-full overflow-y-auto border-l border-zinc-200 bg-white px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900 lg:w-[46%] lg:max-w-[720px]">
          <section className="mb-5">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Task</div>
            <div className="whitespace-pre-wrap rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/60">{run.input}</div>
          </section>

          {waitingNode && (
            <button onClick={() => sectionRefs.current[waitingNode]?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="mb-5 flex w-full items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-left text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
              <Hand size={16} className="shrink-0" /> <span className="flex-1"><b>This run is waiting for you.</b> Review “{labelOf(waitingNode)}” below.</span> <ChevronDown size={15} />
            </button>
          )}

          {run.error && (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-500/10 dark:text-red-300">
              <b>{run.status === "stopped" ? "Stopped" : "Run failed"}:</b> {run.error}
              {run.error.match(/auth|api.?key|401|credential/i) && <> — <Link to="/settings" className="underline">check your API keys in Settings</Link></>}
            </div>
          )}

          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Steps</div>
          {stepOrder.length === 0 && live && <div className="flex items-center gap-2 py-4 text-sm text-zinc-500"><Spinner /> Starting…</div>}
          <div className="space-y-2">
            {stepOrder.map((nid) => {
              const st = run.node_states[nid];
              const node = run.graph?.nodes.find((n) => n.id === nid);
              let items = buildItems(events, Object.values(partials), nid);
              if (node?.type === "router") items = items.filter((it) => it.kind !== "text" || st.status === "running");
              const reviewerName = agents[node?.data.reviewerId ?? ""]?.name;
              if (node?.type === "loop") items = items.filter((it) => !(it.kind === "text" && !it.streaming && it.agent === reviewerName));
              if (node?.type === "approval") items = items.filter((it) => it.kind !== "text" || it.streaming); // checker's raw JSON
              const agent = agents[node?.data.agentId ?? ""];
              return (
                <div key={nid} ref={(el) => { sectionRefs.current[nid] = el; }} className="scroll-mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800">
                  <button className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left" onClick={() => setOpen((o) => ({ ...o, [nid]: !isOpen(nid) }))}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: node?.type === "router" || node?.type === "approval" ? "#f59e0b" : node?.type === "loop" ? "#8b5cf6" : agent?.color ?? "#a1a1aa" }} />
                    <span className="flex-1 truncate text-sm font-medium">{labelOf(nid)}</span>
                    {node?.type === "loop" && st.round && st.status === "running" && <span className="text-xs text-violet-600">round {st.round}/{st.max_rounds}</span>}
                    {st.finished_at && st.started_at && <span className="text-xs text-zinc-400">{(st.finished_at - st.started_at).toFixed(1)}s</span>}
                    <StatusBadge status={st.status} />
                    <ChevronDown size={15} className={`text-zinc-400 transition ${isOpen(nid) ? "rotate-180" : ""}`} />
                  </button>
                  {isOpen(nid) && (
                    <div className="border-t border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
                      {items.length ? <ActivityList items={items} showAgent={node?.type === "loop"} /> : node?.type !== "approval" && <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Thinking…</div>}
                      {pendingToolApprovals(events, nid).map((ev) => (
                        <ToolApprovalPanel key={ev.request_id as string} onDecide={(approved, note) => api.decideApproval(run.id, ev.request_id as string, { approved, note })}
                          tool={ev.tool as string} args={ev.args as string} agent={ev.agent as string} concerns={ev.concerns as string} />
                      ))}
                      {node?.type === "approval" && st.status === "waiting" && (
                        <ApprovalPanel runId={run.id} nodeId={nid} content={st.content ?? ""} message={node.data.instructions}
                          concerns={st.concerns} deadline={st.deadline} timeoutAction={st.timeout_action} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {run.output && (
            <section className="mt-6">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Final result</span>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { navigator.clipboard.writeText(run.output!); toast("Copied"); }}><Copy size={13} /> Copy</button>
              </div>
              <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/40 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-500/5">
                <Markdown>{run.output}</Markdown>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalPanel({ runId, nodeId, content, message, concerns, deadline, timeoutAction }: {
  runId: string; nodeId: string; content: string; message?: string;
  concerns?: string | null; deadline?: number | null; timeoutAction?: "approve" | "reject" | null;
}) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [deadline]);
  const left = deadline ? Math.max(0, deadline - now) : null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await api.decideApproval(runId, nodeId, { approved, note, content: editing && text !== content ? text : undefined });
      toast(approved ? "Approved, so the run continues" : "Rejected, so the run stops");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 space-y-3 rounded-lg border-2 border-amber-300 bg-amber-50/50 p-3 dark:border-amber-700 dark:bg-amber-500/5">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200"><Hand size={15} /> Your approval is needed</div>
      {concerns && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-500/10 dark:text-red-300">
          <b>The AI checker found a problem:</b> {concerns}
        </div>
      )}
      {message && <p className="text-sm text-zinc-700 dark:text-zinc-300">{message}</p>}
      {left !== null && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          If you don't answer, it will be <b>{timeoutAction === "reject" ? "rejected" : "approved"}</b> automatically in{" "}
          {left >= 60 ? `${Math.floor(left / 60)}m ${Math.floor(left % 60)}s` : `${Math.floor(left)}s`}.
        </p>
      )}
      {editing ? (
        <textarea className="input min-h-[240px] resize-y font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"><Markdown>{content}</Markdown></div>
      )}
      <input className="input" placeholder="Optional note for the next steps (or the reason you're rejecting)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary bg-emerald-600 hover:bg-emerald-500" disabled={busy} onClick={() => decide(true)}>
          <Check size={15} /> {editing && text !== content ? "Approve my edited version" : "Approve & continue"}
        </button>
        <button className="btn-secondary" disabled={busy} onClick={() => setEditing(!editing)}><Pencil size={14} /> {editing ? "Stop editing" : "Edit first"}</button>
        <button className="btn-secondary text-red-600" disabled={busy} onClick={() => decide(false)}><X size={15} /> Reject & stop run</button>
      </div>
    </div>
  );
}

function pendingToolApprovals(events: RunEvent[], nid?: string) {
  const done = new Set(events.filter((e) => e.type === "tool_approval_resolved").map((e) => e.request_id));
  return events.filter((e) => e.type === "tool_approval_requested" && (nid === undefined || e.node === nid) && !done.has(e.request_id));
}

export function ToolApprovalPanel({ tool, args, agent, concerns, onDecide }: {
  tool: string; args: string; agent?: string; concerns?: string; onDecide: (approved: boolean, note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  let pretty = args;
  try { pretty = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep raw */ }
  const decide = async (approved: boolean) => {
    setBusy(true);
    try { await onDecide(approved, note); } catch (e) { toast((e as Error).message, "error"); setBusy(false); }
  };
  return (
    <div className="mt-2 space-y-2.5 rounded-lg border-2 border-amber-300 bg-amber-50/50 p-3 dark:border-amber-700 dark:bg-amber-500/5">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <Hand size={15} /> {agent ?? "An agent"} wants to use <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">{prettyTool(tool)}</code>
      </div>
      {concerns && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-500/10 dark:text-red-300">
          <b>The safety check is unsure:</b> {concerns}
        </div>
      )}
      <pre className="max-h-60 overflow-auto rounded-lg border border-zinc-200 bg-white p-2 font-mono text-xs whitespace-pre-wrap dark:border-zinc-700 dark:bg-zinc-900">{pretty}</pre>
      <input className="input" placeholder="Optional note for the agent (e.g. why you're declining)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-primary bg-emerald-600 hover:bg-emerald-500" disabled={busy} onClick={() => decide(true)}><Check size={15} /> Allow</button>
        <button className="btn-secondary text-red-600" disabled={busy} onClick={() => decide(false)}><X size={15} /> Decline</button>
      </div>
      <p className="text-[11px] text-zinc-500">Declining doesn't stop the run: the agent is told and continues without this action.</p>
    </div>
  );
}
