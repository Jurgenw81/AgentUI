import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Copy, Play, Plus, Trash2, Workflow as WfIcon } from "lucide-react";
import { api, timeAgo, type Agent, type Workflow } from "../api";
import { AgentAvatar, EmptyState, PageHeader, useToast } from "../components/ui";
import { RunDialog } from "../components/RunDialog";

export default function WorkflowsPage() {
  const [wfs, setWfs] = useState<Workflow[] | null>(null);
  const [agents, setAgents] = useState<Record<string, Agent>>({});
  const [runTarget, setRunTarget] = useState<{ kind: "workflow"; id: string; name: string } | null>(null);
  const nav = useNavigate();
  const toast = useToast();

  const load = () => api.workflows().then(setWfs);
  useEffect(() => {
    load();
    api.agents().then((a) => setAgents(Object.fromEntries(a.map((x) => [x.id, x]))));
  }, []);

  const create = async () => {
    const wf = await api.createWorkflow({ name: "Untitled workflow" });
    nav(`/workflows/${wf.id}`);
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <PageHeader
        title="Workflows"
        subtitle="A workflow connects agents so they work as a team. Draw arrows to pass work from one agent to the next."
        actions={<button className="btn-primary" onClick={create}><Plus size={16} /> New workflow</button>}
      />
      {wfs?.length === 0 && (
        <EmptyState icon={WfIcon} title="No workflows yet" text="Create a workflow and drag your agents onto the canvas."
          action={<button className="btn-primary" onClick={create}><Plus size={16} /> New workflow</button>} />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {wfs?.map((w) => {
          const steps = w.graph.nodes.filter((n) => n.type === "agent" || n.type === "router");
          return (
            <div key={w.id} className="card flex flex-col p-5">
              <Link to={`/workflows/${w.id}`} className="group">
                <h3 className="font-semibold group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{w.name}</h3>
                <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-zinc-500 dark:text-zinc-400">{w.description || "No description"}</p>
              </Link>
              <div className="mt-3 flex items-center gap-1">
                {steps.slice(0, 8).map((n) => (
                  <div key={n.id} title={agents[n.data.agentId ?? ""]?.name}><AgentAvatar agent={agents[n.data.agentId ?? ""]} size={28} /></div>
                ))}
                <span className="ml-2 text-xs text-zinc-500">{steps.length} step{steps.length === 1 ? "" : "s"}{w.updated_at ? ` · edited ${timeAgo(w.updated_at)}` : ""}</span>
              </div>
              <div className="mt-4 flex gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <Link to={`/workflows/${w.id}`} className="btn-secondary flex-1 px-2 py-1.5">Open editor</Link>
                <button className="btn-primary flex-1 px-2 py-1.5" onClick={() => setRunTarget({ kind: "workflow", id: w.id, name: w.name })}><Play size={14} /> Run</button>
                <button className="btn-ghost px-2 py-1.5" title="Duplicate" onClick={async () => { await api.duplicateWorkflow(w.id); load(); }}><Copy size={14} /></button>
                <button className="btn-ghost px-2 py-1.5 hover:text-red-600" title="Delete"
                  onClick={async () => { if (confirm(`Delete "${w.name}"?`)) { await api.deleteWorkflow(w.id); toast("Workflow deleted"); load(); } }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <RunDialog open={!!runTarget} onClose={() => setRunTarget(null)} target={runTarget} />
    </div>
  );
}
