import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowUp, Eraser, MessageSquare, Settings2, Square } from "lucide-react";
import { api, fmtCost, modelLabel, wsUrl, type Agent, type RunEvent } from "../api";
import { ActivityList, buildItems, type Partial_ } from "../components/Activity";
import { AgentAvatar, EmptyState, Markdown } from "../components/ui";
import { ProviderDot, useDefaultModel } from "../components/ModelPicker";
import { ToolApprovalPanel } from "./RunView";
import LeadChat from "./LeadChat";
import { latestPlan, PlanBoard } from "../components/PlanBoard";

type Msg = { role: "user" | "assistant"; content: string; events?: RunEvent[]; error?: string; cost?: number };

const storeKey = (id: string) => `agentui.chat.${id}`;

export default function ChatPage() {
  const { agentId } = useParams();
  const nav = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const [partials, setPartials] = useState<Record<string, Partial_>>({});
  const ws = useRef<WebSocket | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const liveRef = useRef<RunEvent[]>([]);
  const defaultModel = useDefaultModel();
  const modelOf = (a?: Agent) => (a?.model ? modelLabel(a.model) : `${modelLabel(defaultModel)} (default)`);

  useEffect(() => {
    api.agents().then((a) => {
      setAgents(a);
      if (!agentId && a[0]) nav(`/chat/${a[0].id}`, { replace: true });
    });
  }, [agentId, nav]);

  const agent = agents.find((a) => a.id === agentId);

  useEffect(() => {
    if (!agentId) return;
    try { setMsgs(JSON.parse(localStorage.getItem(storeKey(agentId)) || "[]")); } catch { setMsgs([]); }
  }, [agentId]);
  useEffect(() => {
    if (agentId) localStorage.setItem(storeKey(agentId), JSON.stringify(msgs.slice(-100)));
  }, [msgs, agentId]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, liveEvents, partials]);
  useEffect(() => () => ws.current?.close(), []);

  const finish = (patch: Partial<Msg>) => {
    const events = liveRef.current; // capture now: the ref is cleared below, before React runs the updater
    setMsgs((m) => [...m, { role: "assistant", content: "", events, ...patch }]);
    setLiveEvents([]);
    liveRef.current = [];
    setPartials({});
    setBusy(false);
  };

  const isLead = !!agent?.tools.includes("delegate");
  const send = () => {
    const text = input.trim();
    if (!text || busy || !agent) return;
    const history = [...msgs, { role: "user" as const, content: text }];
    setMsgs(history);
    setInput("");
    setBusy(true);
    liveRef.current = [];

    const socket = new WebSocket(wsUrl("/ws/chat"));
    ws.current = socket;
    socket.onopen = () =>
      socket.send(JSON.stringify({ agent_id: agent.id, messages: history.filter((m) => m.content).map(({ role, content }) => ({ role, content })) }));
    socket.onmessage = (m) => {
      const e = JSON.parse(m.data) as RunEvent;
      const key = `|${e.scope ?? ""}`;
      if (e.type === "token") {
        setPartials((ps) => ({ ...ps, [key]: { scope: e.scope, agent: e.agent, text: (ps[key]?.text ?? "") + (e.text as string) } }));
      } else if (e.type === "done") {
        // final message is shown as the bubble; keep only the work that led to it
        const evs = liveRef.current;
        const lastMsg = evs.map((x) => x.type === "message" && !x.depth).lastIndexOf(true);
        liveRef.current = evs.filter((_, i) => i !== lastMsg);
        finish({ content: e.output as string, cost: e.cost as number });
        socket.close();
      } else if (e.type === "error" || e.type === "stopped") {
        finish({ error: e.type === "stopped" ? "Stopped." : (e.error as string) });
        socket.close();
      } else {
        if (["message", "tool_call"].includes(e.type)) setPartials((ps) => { const n = { ...ps }; delete n[key]; return n; });
        liveRef.current = [...liveRef.current, e];
        setLiveEvents(liveRef.current);
      }
    };
    socket.onerror = () => finish({ error: "Lost connection to the server." });
  };

  if (agents.length === 0)
    return <div className="p-10"><EmptyState icon={MessageSquare} title="No agents" text="Create an agent first." action={<Link to="/agents" className="btn-primary">Agents</Link>} /></div>;

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Chat with</div>
        {agents.map((a) => (
          <Link key={a.id} to={`/chat/${a.id}`}
            className={`flex items-center gap-2.5 rounded-lg px-2 py-2 ${a.id === agentId ? "bg-indigo-50 dark:bg-indigo-500/15" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
            <AgentAvatar agent={a} size={30} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{a.name}</div>
              <div className="truncate text-[11px] text-zinc-500">{modelOf(a)}</div>
            </div>
          </Link>
        ))}
      </aside>

      {agent && isLead ? (
        <LeadChat key={agent.id} agent={agent} agents={agents} defaultModel={defaultModel} modelText={modelOf(agent)} />
      ) : (
      <div className="flex min-w-0 flex-1 flex-col">
        {agent && (
          <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <AgentAvatar agent={agent} size={34} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{agent.name}</div>
              <div className="flex items-center gap-1.5 text-xs text-zinc-500"><ProviderDot model={agent.model || defaultModel} /> {modelOf(agent)} · {agent.tools.length} tools</div>
            </div>
            <Link to="/agents" className="btn-ghost px-2 py-1.5 text-xs"><Settings2 size={14} /> Edit agent</Link>
            <button className="btn-ghost px-2 py-1.5 text-xs" disabled={busy || !msgs.length} onClick={() => setMsgs([])}><Eraser size={14} /> Clear</button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
            {msgs.length === 0 && !busy && agent && (
              <div className="py-16 text-center">
                <div className="mx-auto w-fit"><AgentAvatar agent={agent} size={56} /></div>
                <h2 className="mt-4 text-lg font-semibold">Chat with {agent.name}</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">{agent.description || "Ask anything."} {isLead
                  ? `Give ${agent.name} a task and it becomes a project: ${agent.name} plans it, hands the parts to the team, and you watch it live. It keeps running in the background and shows up under Workflows and Runs.`
                  : "Use chat to test an agent before you put it in a workflow."}</p>
              </div>
            )}
            {msgs.map((m, i) => (
              <MessageView key={i} m={m} agent={agent} agents={agents} defaultModel={defaultModel}
                request={msgs.slice(0, i).reverse().find((x) => x.role === "user")?.content} />
            ))}
            {busy && (
              <div className="flex gap-3">
                <AgentAvatar agent={agent} size={30} />
                <div className="min-w-0 flex-1 pt-1">
                  {(() => { const plan = latestPlan(liveEvents); return plan && <div className="sticky top-2 z-10 mb-3 rounded-xl bg-white shadow-lg dark:bg-zinc-900"><PlanBoard plan={plan} agents={agents} live defaultModel={defaultModel} /></div>; })()}
                  <ActivityList items={buildItems(liveEvents, Object.values(partials))} showAgent={false} />
                  {(() => {
                    const done = new Set(liveEvents.filter((e) => e.type === "tool_approval_resolved").map((e) => e.request_id));
                    return liveEvents.filter((e) => e.type === "tool_approval_requested" && !done.has(e.request_id)).map((ev) => (
                      <ToolApprovalPanel key={ev.request_id as string} tool={ev.tool as string} args={ev.args as string}
                        agent={ev.agent as string} concerns={ev.concerns as string}
                        onDecide={async (approved, note) => ws.current?.send(JSON.stringify({ type: "tool_decision", request_id: ev.request_id, approved, note }))} />
                    ));
                  })()}
                  {!Object.keys(partials).length && <div className="mt-1 flex gap-1">{[0, 1, 2].map((d) => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" style={{ animationDelay: `${d * 0.15}s` }} />)}</div>}
                </div>
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="border-t border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-zinc-300 bg-white p-2 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-zinc-700 dark:bg-zinc-950">
            <textarea
              rows={1}
              className="max-h-48 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
              placeholder={isLead ? `Describe the task for ${agent?.name} and its team…  (Enter to start)` : `Message ${agent?.name ?? ""}…  (Enter to send, Shift+Enter for new line)`}
              value={input}
              onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            {busy ? (
              <button className="btn-secondary p-2" title="Stop" onClick={() => ws.current?.send(JSON.stringify({ type: "stop" }))}><Square size={16} /></button>
            ) : (
              <button className="btn-primary p-2" disabled={!input.trim()} onClick={send}><ArrowUp size={16} /></button>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

function MessageView({ m, agent, agents, defaultModel, request }: { m: Msg; agent?: Agent; agents: Agent[]; defaultModel?: string; request?: string }) {
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-sm text-white">{m.content}</div>
      </div>
    );
  const items = buildItems(m.events ?? [], []);
  const plan = latestPlan(m.events ?? []);
  return (
    <div className="flex gap-3">
      <AgentAvatar agent={agent} size={30} />
      <div className="min-w-0 flex-1 space-y-2 pt-1">
        {plan && <PlanBoard plan={plan} agents={agents} live={false} defaultModel={defaultModel} request={request} />}
        {items.length > 0 && <ActivityList items={items} showAgent={false} />}
        {m.content && <Markdown>{m.content}</Markdown>}
        {m.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{m.error}</div>}
        {m.cost ? <div className="text-[11px] text-zinc-400">{fmtCost(m.cost)}</div> : null}
      </div>
    </div>
  );
}
