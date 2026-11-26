import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bot, Copy, MessageSquare, Play, Plus, Trash2, Wrench, X } from "lucide-react";
import { api, modelLabel, type Agent, type ToolInfo } from "../api";
import { AGENT_COLORS, AGENT_ICONS, AgentAvatar, EmptyState, PageHeader, useToast } from "../components/ui";
import { ModelPicker, ProviderDot, useDefaultModel } from "../components/ModelPicker";
import { RunDialog } from "../components/RunDialog";

const BLANK: Partial<Agent> = {
  name: "", description: "", system_prompt: "", model: "", tools: [], temperature: 0.5, color: "#6366f1", icon: "bot", max_steps: 12,
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);
  const [runTarget, setRunTarget] = useState<{ kind: "agent"; id: string; name: string } | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const defaultModel = useDefaultModel();

  const load = () => api.agents().then(setAgents);
  useEffect(() => {
    load();
    api.tools().then(setTools);
  }, []);

  const toolLabel = (id: string) => tools.find((t) => t.id === id)?.label ?? id;

  const remove = async (a: Agent) => {
    if (!confirm(`Delete agent "${a.name}"? Workflows that use it will need a new agent for that step.`)) return;
    await api.deleteAgent(a.id);
    toast(`Deleted ${a.name}`);
    load();
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <PageHeader
        title="Agents"
        subtitle="Each agent is a specialist: a role (instructions), a model, and the tools it may use."
        actions={<button className="btn-primary" onClick={() => setEditing({ ...BLANK })}><Plus size={16} /> New agent</button>}
      />

      {agents?.length === 0 && (
        <EmptyState icon={Bot} title="No agents yet" text="Create your first agent to get started."
          action={<button className="btn-primary" onClick={() => setEditing({ ...BLANK })}><Plus size={16} /> New agent</button>} />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {agents?.map((a) => (
          <div key={a.id} className="card group flex cursor-pointer flex-col p-5 transition hover:border-indigo-300 hover:shadow-md dark:hover:border-indigo-700"
            onClick={() => setEditing(a)}>
            <div className="flex items-start gap-3">
              <AgentAvatar agent={a} size={42} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-semibold">{a.name}</h3>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                  <ProviderDot model={a.model || defaultModel} /> {a.model ? modelLabel(a.model) : `${modelLabel(defaultModel)} (default)`}
                </div>
              </div>
            </div>
            <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-zinc-600 dark:text-zinc-400">{a.description || a.system_prompt}</p>
            <div className="mt-3 flex min-h-[1.5rem] flex-wrap gap-1.5">
              {a.tools.length === 0 && <span className="text-xs text-zinc-400">No tools</span>}
              {a.tools.map((t) => (
                <span key={t} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {toolLabel(t)}
                </span>
              ))}
            </div>
            <div className="mt-4 flex gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800" onClick={(e) => e.stopPropagation()}>
              <button className="btn-secondary flex-1 px-2 py-1.5" onClick={() => nav(`/chat/${a.id}`)}><MessageSquare size={14} /> Chat</button>
              <button className="btn-secondary flex-1 px-2 py-1.5" onClick={() => setRunTarget({ kind: "agent", id: a.id, name: a.name })}><Play size={14} /> Run task</button>
              <button className="btn-ghost px-2 py-1.5" title="Duplicate" onClick={async () => { await api.duplicateAgent(a.id); load(); }}><Copy size={14} /></button>
              <button className="btn-ghost px-2 py-1.5 hover:text-red-600" title="Delete" onClick={() => remove(a)}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <AgentEditor agent={editing} tools={tools} allAgents={agents ?? []} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      <RunDialog open={!!runTarget} onClose={() => setRunTarget(null)} target={runTarget} />
    </div>
  );
}

function AgentEditor({ agent, tools, allAgents, onClose, onSaved }: { agent: Partial<Agent>; tools: ToolInfo[]; allAgents: Agent[]; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<Partial<Agent>>(agent);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (patch: Partial<Agent>) => setA((x) => ({ ...x, ...patch }));
  const groups = [...new Set(tools.map((t) => t.group))];

  const toggleTool = (id: string) =>
    set({ tools: a.tools?.includes(id) ? a.tools.filter((t) => t !== id) : [...(a.tools ?? []), id] });

  const save = async () => {
    setBusy(true);
    try {
      if (a.id) await api.updateAgent(a.id, a);
      else await api.createAgent(a);
      toast(`Saved ${a.name}`);
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl dark:bg-zinc-900" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <AgentAvatar agent={a} size={36} />
          <h2 className="flex-1 text-lg font-semibold">{a.id ? `Edit ${agent.name}` : "New agent"}</h2>
          <button className="btn-ghost p-1.5" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-[1fr_auto] gap-4">
            <div>
              <label className="label">Name</label>
              <input className="input" autoFocus value={a.name} placeholder="e.g. Market Analyst" onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div>
              <label className="label">Look</label>
              <div className="flex gap-1">
                {AGENT_COLORS.map((c) => (
                  <button key={c} onClick={() => set({ color: c })} className={`h-[38px] w-5 rounded ${a.color === c ? "ring-2 ring-offset-2 ring-zinc-400 dark:ring-offset-zinc-900" : ""}`} style={{ background: c }} />
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(AGENT_ICONS).map(([k, Icon]) => (
              <button key={k} onClick={() => set({ icon: k })}
                className={`rounded-lg p-2 ${a.icon === k ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
                <Icon size={16} />
              </button>
            ))}
          </div>

          <div>
            <label className="label">Short description</label>
            <input className="input" value={a.description} placeholder="What is this agent good at? (helps routers & managers pick it)" onChange={(e) => set({ description: e.target.value })} />
          </div>

          <div>
            <label className="label">Model</label>
            <ModelPicker value={a.model} onChange={(m) => set({ model: m })} />
            <p className="hint">Mix and match — e.g. a cheap fast model for research, a strong model for review.</p>
          </div>

          <div>
            <label className="label">Role & instructions</label>
            <textarea className="input min-h-[140px] resize-y font-mono text-[13px]" value={a.system_prompt}
              placeholder="You are a … Your job is to … Always …" onChange={(e) => set({ system_prompt: e.target.value })} />
          </div>

          <div>
            <label className="label flex items-center gap-1.5"><Wrench size={14} /> Tools</label>
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g}>
                  <div className="mb-1.5 flex items-center text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {g}
                    {g === "MCP servers" && <a href="/settings#mcp" className="ml-auto font-normal normal-case text-indigo-600 hover:underline">manage</a>}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {tools.filter((t) => t.group === g).map((t) => {
                      const on = a.tools?.includes(t.id);
                      return (
                        <button key={t.id} onClick={() => toggleTool(t.id)}
                          className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition ${
                            on ? "border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-500/10" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700"}`}>
                          <input type="checkbox" readOnly checked={!!on} className="mt-0.5 accent-indigo-600" />
                          <div>
                            <div className="flex items-center gap-1 text-sm font-medium">
                              {t.label} {t.dangerous && <AlertTriangle size={12} className="text-amber-500" />}
                            </div>
                            <div className="text-xs text-zinc-500">{t.description}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {!groups.includes("MCP servers") && (
              <p className="hint">Want more tools (GitHub, browsers, databases…)? <a href="/settings#mcp" className="text-indigo-600 hover:underline">Add an MCP server in Settings</a>.</p>
            )}
            {a.tools?.some((t) => tools.find((x) => x.id === t)?.dangerous) && (
              <p className="hint flex items-center gap-1 text-amber-600"><AlertTriangle size={12} /> Code tools only work once you enable code execution in Settings.</p>
            )}
          </div>

          {a.tools?.includes("delegate") && (
            <div>
              <label className="label">Team: who can {a.name || "this agent"} hand work to?</label>
              <div className="flex flex-wrap gap-1.5">
                {allAgents.filter((x) => x.id !== a.id).map((x) => {
                  const on = a.team?.includes(x.id);
                  return (
                    <button key={x.id} onClick={() => set({ team: on ? a.team!.filter((t) => t !== x.id) : [...(a.team ?? []), x.id] })}
                      className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition ${
                        on ? "border-indigo-400 bg-indigo-50 text-indigo-800 dark:border-indigo-500 dark:bg-indigo-500/15 dark:text-indigo-200" : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"}`}>
                      <AgentAvatar agent={x} size={20} /> {x.name}
                    </button>
                  );
                })}
              </div>
              <p className="hint">{a.team?.length ? `Only these ${a.team.length} can get tasks. It can give them several tasks at once, which run in parallel.` : "None selected = it can ask any agent. Pick a team to keep it focused."}</p>
            </div>
          )}

          <details className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
            <div className="mt-4 space-y-4">
              <div>
                <label className="label">Creativity (temperature): {a.temperature ?? 0.5}</label>
                <input type="range" min={0} max={1} step={0.1} value={a.temperature ?? 0.5} className="w-full accent-indigo-600"
                  onChange={(e) => set({ temperature: Number(e.target.value) })} />
                <div className="flex justify-between text-xs text-zinc-500"><span>Precise</span><span>Creative</span></div>
              </div>
              <div>
                <label className="label">Max tool steps</label>
                <input type="number" min={1} max={50} className="input w-28" value={a.max_steps ?? 12}
                  onChange={(e) => set({ max_steps: Number(e.target.value) })} />
                <p className="hint">How many tool calls the agent may make before it must answer.</p>
              </div>
            </div>
          </details>
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!a.name?.trim() || busy} onClick={save}>{busy ? "Saving…" : "Save agent"}</button>
        </div>
      </div>
    </div>
  );
}
