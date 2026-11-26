import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowRight, Bot, CheckCircle2, Circle, KeyRound, Play, Rocket, Workflow } from "lucide-react";
import { api, fmtCost, timeAgo, type Agent, type Run, type Workflow as Wf } from "../api";
import { loadModels } from "../components/ModelPicker";
import { AgentAvatar, StatusBadge, useToast } from "../components/ui";
import { RunDialog } from "../components/RunDialog";

export default function HomePage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<Wf[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [connected, setConnected] = useState<string[] | null>(null);
  const [runTarget, setRunTarget] = useState<{ kind: "agent" | "workflow"; id: string; name: string } | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const [task, setTask] = useState("");
  const [leadId, setLeadId] = useState("");
  const [starting, setStarting] = useState(false);
  const leads = agents.filter((a) => a.tools.includes("delegate"));
  const lead = leads.find((a) => a.id === leadId) ?? leads.find((a) => a.name === "Manager") ?? leads[0];

  const refresh = () => {
    api.workflows().then(setWorkflows);
    api.runs().then(setRuns);
  };
  const liveRuns = runs.filter((r) => ["running", "waiting", "queued"].includes(r.status));
  const liveChats = workflows.filter((w) => w.project?.status === "running" && !w.project.run_id);
  const busy = liveRuns.length + liveChats.length;
  // keep "Happening now" live
  useEffect(() => {
    const t = setInterval(refresh, busy ? 3000 : 15000);
    return () => clearInterval(t);
  }, [busy]);

  const startProject = async () => {
    if (!task.trim() || !lead) return;
    setStarting(true);
    try {
      const run = await api.startRun({ agent_id: lead.id, input: task.trim() });
      localStorage.setItem(`agentui.project.${lead.id}`, run.id); // follow-ups in Chat continue this project
      nav(`/runs/${run.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
      setStarting(false);
    }
  };

  useEffect(() => {
    api.agents().then(setAgents);
    api.workflows().then(setWorkflows);
    api.runs().then(setRuns);
    loadModels().then((m) => setConnected(Object.values(m.providers).filter((p) => p.live || (p.configured && !p.error)).map((p) => p.label)));
  }, []);

  const steps = [
    {
      done: !!connected?.length,
      title: "Connect your models",
      text: connected?.length ? `Connected: ${connected.join(", ")}` : "Use your Claude subscription, free local Ollama models, or an API key.",
      to: "/settings", cta: "Open settings", icon: KeyRound,
    },
    {
      done: agents.length > 0,
      title: "Set up your agents",
      text: `You have ${agents.length} agent${agents.length === 1 ? "" : "s"}. Each has a role, a model and tools.`,
      to: "/agents", cta: "View agents", icon: Bot,
    },
    {
      done: runs.length > 0,
      title: "Run a workflow",
      text: "Connect agents on a canvas so they work together — in sequence, in parallel, or via a router.",
      to: "/workflows", cta: "Open workflows", icon: Workflow,
    },
  ];

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Welcome to AgentUI</h1>
      <p className="mt-2 text-zinc-500 dark:text-zinc-400">
        Build a team of AI agents, give each a job, and orchestrate them together.
      </p>

      {lead && (
        <section className="card mt-8 p-5">
          <div className="flex items-center gap-2 font-semibold"><Rocket size={18} className="text-indigo-500" /> Start a project</div>
          <p className="mt-1 text-sm text-zinc-500">Describe what you want. {lead.name} plans it, hands the parts to the team, and you watch it live. It keeps running in the background and shows up under Workflows.</p>
          <textarea className="input mt-3 min-h-[80px]" placeholder="e.g. Build a one-page website for my bakery with a menu and opening hours"
            value={task} onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startProject(); }} />
          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm text-zinc-500">Lead:</span>
            {leads.map((a) => (
              <button key={a.id} onClick={() => setLeadId(a.id)}
                className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-sm ${a.id === lead.id ? "border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-500/15" : "border-zinc-200 dark:border-zinc-700"}`}>
                <AgentAvatar agent={a} size={20} /> {a.name}
              </button>
            ))}
            <button className="btn-primary ml-auto" disabled={!task.trim() || starting} onClick={startProject}><Play size={15} /> Start</button>
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500"><Activity size={15} /> Happening now</h2>
        {busy === 0 ? (
          <p className="card px-4 py-5 text-sm text-zinc-500">Nothing is running right now.</p>
        ) : (
          <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
            {liveChats.map((w) => (
              <Link key={w.id} to={`/chat/${w.project!.chat_agent_id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <StatusBadge status="running" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{w.name}</div>
                  <div className="text-xs text-zinc-500">{w.project!.lead} · {w.project!.steps_done}/{w.project!.steps_total} steps done · in chat</div>
                </div>
                <span className="text-sm text-indigo-600 dark:text-indigo-400">Watch</span>
              </Link>
            ))}
            {liveRuns.map((r) => {
              const p = workflows.find((w) => w.project?.run_id === r.id)?.project;
              return (
                <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <StatusBadge status={r.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.title}</div>
                    <div className="text-xs text-zinc-500">
                      {p ? `${p.lead} · ${p.steps_done}/${p.steps_total} steps done` : r.workflow_name} · started {timeAgo(r.created_at)}
                    </div>
                  </div>
                  {p && <div className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-zinc-200 sm:block dark:bg-zinc-700"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${(p.steps_done / Math.max(1, p.steps_total)) * 100}%` }} /></div>}
                  <span className="text-sm text-indigo-600 dark:text-indigo-400">Watch</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <div className="mt-8 grid gap-3 md:grid-cols-3">
        {steps.map((s, i) => (
          <Link key={i} to={s.to} className="card group p-5 transition hover:border-indigo-300 dark:hover:border-indigo-700">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {s.done ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Circle size={16} />}
              Step {i + 1}
            </div>
            <h3 className="mt-3 font-semibold">{s.title}</h3>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{s.text}</p>
            <div className="mt-4 flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400">
              {s.cta} <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Quick start</h2>
          <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
            {workflows.slice(0, 4).map((w) => (
              <div key={w.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
                  <Workflow size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{w.name}</div>
                  <div className="truncate text-xs text-zinc-500">{w.description}</div>
                </div>
                <button className="btn-secondary px-2.5 py-1.5" onClick={() => setRunTarget({ kind: "workflow", id: w.id, name: w.name })}>
                  <Play size={14} /> Run
                </button>
              </div>
            ))}
            {agents.slice(0, 3).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-3">
                <AgentAvatar agent={a} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">Chat with {a.name}</div>
                  <div className="truncate text-xs text-zinc-500">{a.description}</div>
                </div>
                <button className="btn-secondary px-2.5 py-1.5" onClick={() => nav(`/chat/${a.id}`)}>Chat</button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Recent runs</h2>
            <Link to="/runs" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">See all</Link>
          </div>
          <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
            {runs.length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-500">No runs yet — start one from Quick start.</p>}
            {runs.slice(0, 7).map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <StatusBadge status={r.status} compact />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.title}</div>
                  <div className="text-xs text-zinc-500">{r.workflow_name} · {timeAgo(r.created_at)}</div>
                </div>
                <span className="text-xs text-zinc-500">{fmtCost(r.cost)}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
      <RunDialog open={!!runTarget} onClose={() => setRunTarget(null)} target={runTarget} />
    </div>
  );
}
