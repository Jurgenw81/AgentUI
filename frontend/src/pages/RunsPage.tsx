import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { History, Search, Trash2 } from "lucide-react";
import { api, fmtCost, fmtTokens, timeAgo, type Run } from "../api";
import { EmptyState, PageHeader, StatusBadge } from "../components/ui";

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");

  const load = () => api.runs().then(setRuns);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const shown = (runs ?? []).filter(
    (r) => (!status || r.status === status) && (!q || `${r.title} ${r.input} ${r.workflow_name}`.toLowerCase().includes(q.toLowerCase())),
  );
  const total = (runs ?? []).reduce((s, r) => s + (r.cost || 0), 0);

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <PageHeader title="Runs" subtitle={`Every task you've run, saved. Total spent: ${fmtCost(total)}`} />
      {runs?.length === 0 ? (
        <EmptyState icon={History} title="No runs yet" text="Run an agent or a workflow and it will show up here." action={<Link to="/workflows" className="btn-primary">Go to workflows</Link>} />
      ) : (
        <>
          <div className="mb-4 flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input className="input pl-9" placeholder="Search runs…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="waiting">Needs you</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="error">Failed</option>
              <option value="stopped">Stopped</option>
            </select>
          </div>
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Task</th>
                  <th className="px-4 py-2.5 font-semibold">Workflow / agent</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Tokens</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Cost</th>
                  <th className="px-4 py-2.5 text-right font-semibold">When</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {shown.map((r) => (
                  <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <td className="max-w-xs px-4 py-2.5"><Link to={`/runs/${r.id}`} className="block truncate font-medium hover:text-indigo-600">{r.title}</Link></td>
                    <td className="px-4 py-2.5 text-zinc-500">{r.workflow_name}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500">{fmtTokens(r.tokens.input + r.tokens.output)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-500">{fmtCost(r.cost)}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-500">{timeAgo(r.created_at)}</td>
                    <td className="px-2 py-2.5 text-right">
                      <button className="btn-ghost p-1.5 hover:text-red-600" title="Delete" onClick={async () => { if (confirm("Delete this run?")) { await api.deleteRun(r.id); load(); } }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">No runs match.</p>}
          </div>
        </>
      )}
    </div>
  );
}
