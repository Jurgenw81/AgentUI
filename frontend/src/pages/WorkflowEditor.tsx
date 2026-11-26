import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  addEdge, Background, BackgroundVariant, Controls, MarkerType, ReactFlow, ReactFlowProvider, useEdgesState,
  useNodesState, useReactFlow, type Connection, type Edge,
} from "@xyflow/react";
import { ArrowLeft, Check, Flag, GitFork, Hand, Info, Loader2, Play, Plus, Repeat, Trash2 } from "lucide-react";
import { api, type Agent, type Graph, type GraphNode, type Workflow } from "../api";
import { nodeTypes, type FlowNode } from "../components/FlowNodes";
import { AgentAvatar, Spinner, useToast } from "../components/ui";
import { RunDialog } from "../components/RunDialog";
import { loadModels } from "../components/ModelPicker";

export const edgeDefaults = { markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 } };

export default function WorkflowEditor() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

function toFlow(g: Graph, agents: Record<string, Agent>, defaultModel: string): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: g.nodes.map((n) => ({ ...n, data: { ...n.data, agent: agents[n.data.agentId ?? ""], reviewer: agents[n.data.reviewerId ?? ""], defaultModel } })),
    edges: g.edges.map((e) => ({ ...e, ...edgeDefaults })),
  };
}

function toGraph(nodes: FlowNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id, type: n.type as GraphNode["type"], position: n.position,
      data: {
        label: n.data.label, agentId: n.data.agentId, instructions: n.data.instructions,
        reviewerId: n.data.reviewerId, criteria: n.data.criteria, maxRounds: n.data.maxRounds,
        mode: n.data.mode, checkerId: n.data.checkerId, timeoutMinutes: n.data.timeoutMinutes, timeoutAction: n.data.timeoutAction,
      },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

function Editor() {
  const { id } = useParams();
  const toast = useToast();
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const [wf, setWf] = useState<Workflow | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [runOpen, setRunOpen] = useState(false);
  const loaded = useRef(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);

  useEffect(() => {
    Promise.all([api.workflow(id!), api.agents(), loadModels().catch(() => null)]).then(([w, a, m]) => {
      const dm = m?.default_model ?? "";
      setDefaultModel(dm);
      setWf(w);
      setAgents(a);
      const f = toFlow(w.graph, Object.fromEntries(a.map((x) => [x.id, x])), dm);
      setNodes(f.nodes);
      setEdges(f.edges);
      setTimeout(() => (loaded.current = true), 50);
    });
  }, [id, setNodes, setEdges]);

  // ---- autosave ----
  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const graphKey = JSON.stringify(graph);
  const meta = wf ? `${wf.name}\u0000${wf.description}\u0000${wf.autonomous}` : "";
  useEffect(() => {
    if (!loaded.current || !wf) return;
    setSaveState("dirty");
    const t = setTimeout(async () => {
      setSaveState("saving");
      try {
        await api.updateWorkflow(wf.id, { name: wf.name, description: wf.description, autonomous: !!wf.autonomous, graph });
        setSaveState("saved");
      } catch (e) {
        toast(`Couldn't save: ${(e as Error).message}`, "error");
        setSaveState("dirty");
      }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey, meta]);

  // ---- graph editing ----
  const wouldCycle = useCallback(
    (c: Connection | Edge) => {
      if (c.source === c.target) return true;
      const stack = [c.target];
      const seen = new Set<string>();
      while (stack.length) {
        const n = stack.pop()!;
        if (n === c.source) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        edges.filter((e) => e.source === n).forEach((e) => stack.push(e.target));
      }
      return false;
    },
    [edges],
  );

  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, id: `${c.source}-${c.target}-${Date.now().toString(36)}`, ...edgeDefaults }, es)),
    [setEdges],
  );

  const addNode = (type: GraphNode["type"], agentId?: string, pos?: { x: number; y: number }) => {
    let position = pos;
    if (!position) {
      const rect = wrapper.current!.getBoundingClientRect();
      const vp = getViewport();
      position = {
        x: (rect.width / 2 - vp.x) / vp.zoom - 120 + (Math.random() * 60 - 30),
        y: (rect.height / 2 - vp.y) / vp.zoom - 40 + (Math.random() * 60 - 30),
      };
    }
    const nid = `${type}-${Date.now().toString(36)}`;
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { id: nid, type, position, selected: true, data: { agentId, agent: agentMap[agentId ?? ""], defaultModel, ...(type === "loop" ? { maxRounds: 3 } : {}) } },
    ]);
    setSelectedId(nid);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/agentui");
    if (!raw) return;
    const { type, agentId } = JSON.parse(raw);
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(type, agentId, { x: p.x - 120, y: p.y - 40 });
  };

  const updateNode = (nid: string, patch: Partial<FlowNode["data"]>) =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== nid) return n;
        const data = { ...n.data, ...patch };
        if ("agentId" in patch) data.agent = agentMap[patch.agentId ?? ""];
        if ("reviewerId" in patch) data.reviewer = agentMap[patch.reviewerId ?? ""];
        return { ...n, data };
      }),
    );

  const deleteNode = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    setSelectedId(null);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const flush = async () => {
    if (!wf) return;
    await api.updateWorkflow(wf.id, { name: wf.name, description: wf.description, graph });
    setSaveState("saved");
  };

  if (!wf) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  const problems: string[] = [];
  if (!nodes.some((n) => n.type === "agent" || n.type === "router" || n.type === "loop")) problems.push("Add at least one agent.");
  if (nodes.some((n) => n.type === "agent" && !n.data.agent)) problems.push("Some steps have no agent chosen.");
  if (nodes.some((n) => n.type === "loop" && (!n.data.agent || !n.data.reviewer))) problems.push("A review loop needs a worker and a reviewer.");
  const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
  if (nodes.length > 1 && nodes.some((n) => !connected.has(n.id))) problems.push("Some steps aren't connected.");

  return (
    <div className="flex h-full flex-col">
      {/* top bar */}
      <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <Link to="/workflows" className="btn-ghost p-1.5"><ArrowLeft size={18} /></Link>
        <input
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-lg font-semibold outline-none hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
          value={wf.name}
          onChange={(e) => setWf({ ...wf, name: e.target.value })}
        />
        <span className="flex items-center gap-1.5 text-xs text-zinc-500">
          {saveState === "saved" ? <><Check size={14} className="text-emerald-500" /> Saved</> : saveState === "saving" ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : "Unsaved changes"}
        </span>
        <button className="btn-primary" disabled={problems.length > 0} title={problems.join(" ")} onClick={async () => { await flush(); setRunOpen(true); }}>
          <Play size={15} /> Run workflow
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* palette */}
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Add to canvas</h3>
          <p className="mb-3 mt-1 text-xs text-zinc-500">Drag onto the canvas, or click to add.</p>
          <div className="space-y-1.5">
            {agents.map((a) => (
              <PaletteItem key={a.id} payload={{ type: "agent", agentId: a.id }} onClick={() => addNode("agent", a.id)}>
                <AgentAvatar agent={a} size={28} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className="truncate text-[11px] text-zinc-500">{a.description}</div>
                </div>
              </PaletteItem>
            ))}
            <Link to="/agents" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-indigo-600 hover:underline dark:text-indigo-400"><Plus size={13} /> Create new agent</Link>
          </div>
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Flow control</h3>
          <div className="space-y-1.5">
            <PaletteItem payload={{ type: "router" }} onClick={() => addNode("router")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15"><GitFork size={15} className="rotate-90" /></div>
              <div><div className="text-sm font-medium">Router</div><div className="text-[11px] text-zinc-500">AI picks one branch</div></div>
            </PaletteItem>
            <PaletteItem payload={{ type: "loop" }} onClick={() => addNode("loop")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-500/15"><Repeat size={15} /></div>
              <div><div className="text-sm font-medium">Review loop</div><div className="text-[11px] text-zinc-500">Redo until a reviewer approves</div></div>
            </PaletteItem>
            <PaletteItem payload={{ type: "approval" }} onClick={() => addNode("approval")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15"><Hand size={15} /></div>
              <div><div className="text-sm font-medium">Your approval</div><div className="text-[11px] text-zinc-500">Pause until you OK it</div></div>
            </PaletteItem>
            <PaletteItem payload={{ type: "output" }} onClick={() => addNode("output")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15"><Flag size={15} /></div>
              <div><div className="text-sm font-medium">Output</div><div className="text-[11px] text-zinc-500">Collects the final result</div></div>
            </PaletteItem>
          </div>

          <div className="mt-6 rounded-lg bg-zinc-50 p-3 text-xs leading-5 text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
            <div className="mb-1 flex items-center gap-1 font-semibold text-zinc-700 dark:text-zinc-300"><Info size={13} /> How it works</div>
            <ul className="list-disc space-y-1 pl-4">
              <li>Drag from a dot on the right of a step to the left of another to connect them.</li>
              <li>One step feeding <b>several</b> runs them <b>in parallel</b>.</li>
              <li>A step with several inputs <b>waits for all</b> of them.</li>
              <li>A <b>Router</b> sends work down only one branch.</li>
              <li>A <b>Review loop</b> repeats until the reviewer is happy.</li>
              <li><b>Your approval</b> pauses the run so you can check or edit.</li>
              <li>Select a step + press <kbd>Backspace</kbd> to delete.</li>
            </ul>
          </div>
        </aside>

        {/* canvas */}
        <div className="relative min-w-0 flex-1" ref={wrapper} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={(c) => !wouldCycle(c)}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            onNodesDelete={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: "4%", maxZoom: 1 }}
            minZoom={0.15}
            defaultEdgeOptions={edgeDefaults}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} className="!bg-zinc-50 dark:!bg-zinc-950" color="#a1a1aa55" />
            <Controls showInteractive={false} />
          </ReactFlow>
          {problems.length > 0 && (
            <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800 shadow-sm dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              {problems[0]}
            </div>
          )}
        </div>

        {/* inspector */}
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          {selected ? (
            <NodeInspector node={selected} agents={agents} onChange={(p) => updateNode(selected.id, p)} onDelete={() => deleteNode(selected.id)} />
          ) : (
            <div className="space-y-4">
              <h3 className="font-semibold">Workflow</h3>
              <div>
                <label className="label">Description</label>
                <textarea className="input resize-y" rows={3} value={wf.description ?? ""} placeholder="What does this team do?"
                  onChange={(e) => setWf({ ...wf, description: e.target.value })} />
              </div>
              <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium">Run autonomously by default</div>
                    <div className="text-xs text-zinc-500">Never stop to ask you: approval steps are approved automatically. You can still change this each time you click Run.</div>
                  </div>
                  <button role="switch" aria-checked={!!wf.autonomous} onClick={() => setWf({ ...wf, autonomous: !wf.autonomous })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${wf.autonomous ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"}`}>
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${wf.autonomous ? "left-[22px]" : "left-0.5"}`} />
                  </button>
                </div>
              </div>
              <p className="text-sm text-zinc-500">Click a step on the canvas to configure it.</p>
            </div>
          )}
        </aside>
      </div>
      <RunDialog open={runOpen} onClose={() => setRunOpen(false)} target={{ kind: "workflow", id: wf.id, name: wf.name }} />
    </div>
  );
}

function PaletteItem({ payload, onClick, children }: { payload: object; onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("application/agentui", JSON.stringify(payload)); e.dataTransfer.effectAllowed = "move"; }}
      onClick={onClick}
      className="flex cursor-grab items-center gap-2.5 rounded-lg border border-zinc-200 p-2 transition hover:border-indigo-300 hover:bg-indigo-50/50 active:cursor-grabbing dark:border-zinc-700 dark:hover:border-indigo-700 dark:hover:bg-indigo-500/5"
    >
      {children}
    </div>
  );
}

function NodeInspector({ node, agents, onChange, onDelete }: { node: FlowNode; agents: Agent[]; onChange: (p: Partial<FlowNode["data"]>) => void; onDelete: () => void }) {
  const kind = node.type;
  const title = { start: "Start", output: "Output", agent: "Agent step", router: "Router", loop: "Review loop", approval: "Your approval" }[kind as string];
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <button className="btn-ghost px-2 py-1 text-red-600" onClick={onDelete}><Trash2 size={14} /> Remove</button>
      </div>

      {kind === "start" && <p className="text-sm text-zinc-500">This is where the task you type in when you click <b>Run</b> enters the workflow. Connect it to your first agent(s).</p>}
      {kind === "output" && <p className="text-sm text-zinc-500">Everything connected into this step becomes the final result of the run.</p>}

      {kind === "approval" && (
        <>
          <div>
            <label className="label">Who approves?</label>
            <div className="space-y-1.5">
              {([
                ["ask", "Ask me", "The run pauses until you approve, edit or reject."],
                ["ai", "AI checks, asks me only if needed", "An AI checker reviews it. It continues if it's fine and only pauses for you if there's a real problem."],
                ["auto", "Auto-approve", "Never pauses. Useful to switch a checkpoint off without deleting it."],
              ] as const).map(([value, title, desc]) => (
                <button key={value} onClick={() => onChange({ mode: value })}
                  className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition ${
                    (node.data.mode ?? "ask") === value ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-500/10" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700"}`}>
                  <input type="radio" readOnly checked={(node.data.mode ?? "ask") === value} className="mt-1 accent-amber-600" />
                  <div><div className="text-sm font-medium">{title}</div><div className="text-xs text-zinc-500">{desc}</div></div>
                </button>
              ))}
            </div>
            <p className="hint">In an <b>autonomous</b> run this step never waits for you, whatever you pick here.</p>
          </div>
          {node.data.mode === "ai" && (
            <div>
              <label className="label">AI checker</label>
              <select className="input" value={node.data.checkerId ?? ""} onChange={(e) => onChange({ checkerId: e.target.value || undefined })}>
                <option value="">Default model</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <p className="hint">Use a strong model, since it decides whether to bother you.</p>
            </div>
          )}
          {(node.data.mode ?? "ask") !== "auto" && (
            <div>
              <label className="label">If I don't answer</label>
              <div className="flex items-center gap-2 text-sm">
                <span>after</span>
                <input type="number" min={0} step={1} className="input w-20" value={node.data.timeoutMinutes ?? 0}
                  onChange={(e) => onChange({ timeoutMinutes: Math.max(0, Number(e.target.value)) })} />
                <span>min</span>
                <select className="input w-32" value={node.data.timeoutAction ?? "approve"} disabled={!node.data.timeoutMinutes}
                  onChange={(e) => onChange({ timeoutAction: e.target.value as "approve" | "reject" })}>
                  <option value="approve">approve</option>
                  <option value="reject">reject</option>
                </select>
              </div>
              <p className="hint">0 = wait as long as it takes.</p>
            </div>
          )}
          <div>
            <label className="label">Step name (optional)</label>
            <input className="input" value={node.data.label ?? ""} placeholder="Your approval" onChange={(e) => onChange({ label: e.target.value || undefined })} />
          </div>
          <div>
            <label className="label">{node.data.mode === "ai" ? "What should be checked?" : "What should you check?"}</label>
            <textarea className="input resize-y" rows={4} value={node.data.instructions ?? ""}
              placeholder="e.g. Make sure the plan doesn't touch the production database." onChange={(e) => onChange({ instructions: e.target.value })} />
            <p className="hint">{node.data.mode === "ai" ? "The AI checker approves only if this is met. It's also shown to you if it asks." : "Shown to you as a reminder when the run pauses."}</p>
          </div>
        </>
      )}

      {kind === "loop" && (
        <>
          <p className="text-sm text-zinc-500">The <b>worker</b> does the job, the <b>reviewer</b> checks it against your criteria. If it's not good enough, the worker gets the feedback and tries again.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Worker</label>
              <select className="input" value={node.data.agentId ?? ""} onChange={(e) => onChange({ agentId: e.target.value || undefined })}>
                <option value="">— Choose —</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Reviewer</label>
              <select className="input" value={node.data.reviewerId ?? ""} onChange={(e) => onChange({ reviewerId: e.target.value || undefined })}>
                <option value="">— Choose —</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">What should the worker do?</label>
            <textarea className="input resize-y" rows={3} value={node.data.instructions ?? ""} placeholder="e.g. Write a blog post from the research."
              onChange={(e) => onChange({ instructions: e.target.value })} />
          </div>
          <div>
            <label className="label">When is it good enough?</label>
            <textarea className="input resize-y" rows={4} value={node.data.criteria ?? ""}
              placeholder="e.g. Under 800 words, every claim has a source, friendly tone, no typos."
              onChange={(e) => onChange({ criteria: e.target.value })} />
            <p className="hint">The reviewer approves only when all of this is met.</p>
          </div>
          <div>
            <label className="label">Max rounds: {node.data.maxRounds ?? 3}</label>
            <input type="range" min={1} max={8} value={node.data.maxRounds ?? 3} className="w-full accent-violet-600"
              onChange={(e) => onChange({ maxRounds: Number(e.target.value) })} />
            <p className="hint">If it's still not approved after this many tries, the last version is used. More rounds use more quota.</p>
          </div>
          <div>
            <label className="label">Step name (optional)</label>
            <input className="input" value={node.data.label ?? ""} placeholder="Review loop" onChange={(e) => onChange({ label: e.target.value || undefined })} />
          </div>
        </>
      )}

      {(kind === "agent" || kind === "router") && (
        <>
          <div>
            <label className="label">{kind === "router" ? "Agent that decides (optional)" : "Agent"}</label>
            <select className="input" value={node.data.agentId ?? ""} onChange={(e) => onChange({ agentId: e.target.value || undefined })}>
              <option value="">{kind === "router" ? "Default model" : "— Choose an agent —"}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {node.data.agent && (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
                <AgentAvatar agent={node.data.agent} size={24} /> {node.data.agent.description}
              </div>
            )}
          </div>
          <div>
            <label className="label">Step name (optional)</label>
            <input className="input" value={node.data.label ?? ""} placeholder={node.data.agent?.name ?? (kind === "router" ? "Router" : "")}
              onChange={(e) => onChange({ label: e.target.value || undefined })} />
          </div>
          <div>
            <label className="label">{kind === "router" ? "How should it decide?" : "What should this step do?"}</label>
            <textarea className="input resize-y" rows={6} value={node.data.instructions ?? ""}
              placeholder={kind === "router"
                ? "e.g. Send coding questions to the Coder, everything else to the Writer."
                : "e.g. Focus on pricing and competitors. Leave empty to just use the agent's normal role."}
              onChange={(e) => onChange({ instructions: e.target.value })} />
            <p className="hint">
              {kind === "router"
                ? "The router sees the task plus the names & descriptions of the steps it connects to, then picks one."
                : "The agent receives these instructions, the original task, and the output of every step connected into it."}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
