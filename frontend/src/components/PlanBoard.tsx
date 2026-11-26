// The live workflow a lead agent (e.g. the Manager) lays out with update_plan and keeps up to date while it delegates.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, type Edge, type NodeProps } from "@xyflow/react";
import { ChevronDown, ExternalLink, Save, Workflow as WorkflowIcon } from "lucide-react";
import { api, type Agent, type GraphEdge, type GraphNode, type RunEvent } from "../api";
import { AgentAvatar, StatusBadge, useToast } from "./ui";
import { nodeTypes as baseNodeTypes, type FlowNode } from "./FlowNodes";
import { edgeDefaults } from "../pages/WorkflowEditor";

export type PlanStep = { id: string; agent: string; task: string; after: string[]; status: "pending" | "running" | "done" | "failed"; result?: string | null };
export type Plan = { lead: string; steps: PlanStep[]; workflowId?: string };

/** The newest plan in these events (the top-most lead's, if leads are nested). */
export function latestPlan(events: RunEvent[], node?: string): Plan | null {
  let best: RunEvent | null = null;
  for (const e of events) {
    if (e.type !== "plan" || (node !== undefined && e.node !== node)) continue;
    if (!best || ((e.depth as number) ?? 0) <= ((best.depth as number) ?? 0)) best = e;
  }
  return best ? { lead: best.agent as string, steps: best.steps as PlanStep[], workflowId: best.workflow_id as string | undefined } : null;
}

const STATUS = { pending: "pending", running: "running", done: "done", failed: "error" } as const;
const COL = 280, ROW = 130;

/** Column = how many steps must happen before it; rows spread within a column. */
function layout(steps: PlanStep[]) {
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const level: Record<string, number> = {};
  const lvl = (s: PlanStep, seen = new Set<string>()): number => {
    if (level[s.id] !== undefined) return level[s.id];
    if (seen.has(s.id)) return 1; // cycle guard
    seen.add(s.id);
    const deps = s.after.map((a) => byId[a]).filter(Boolean);
    return (level[s.id] = deps.length ? 1 + Math.max(...deps.map((d) => lvl(d, seen))) : 1);
  };
  steps.forEach((s) => lvl(s));
  const cols: Record<number, string[]> = {};
  steps.forEach((s) => (cols[level[s.id]] ??= []).push(s.id));
  const maxCol = Math.max(1, ...Object.keys(cols).map(Number));
  const tallest = Math.max(1, ...Object.values(cols).map((c) => c.length));
  const pos: Record<string, { x: number; y: number }> = {};
  Object.entries(cols).forEach(([c, ids]) => ids.forEach((id, i) => {
    pos[id] = { x: Number(c) * COL, y: (i - (ids.length - 1) / 2) * ROW + ((tallest - 1) / 2) * ROW };
  }));
  const mid = ((tallest - 1) / 2) * ROW;
  return { pos, maxCol, mid, leaves: steps.filter((s) => !steps.some((x) => x.after.includes(s.id))).map((s) => s.id) };
}

function LeadNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className={`flex w-52 items-center gap-2.5 rounded-xl border bg-white px-3.5 py-3 dark:bg-zinc-900 ${data.status === "running" ? "border-indigo-400 ring-2 ring-indigo-500/40" : "border-zinc-200 dark:border-zinc-700"}`}>
      <AgentAvatar agent={data.agent} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{data.agent?.name ?? data.label}</div>
        <div className="text-[11px] text-zinc-500">Lead · plans & delegates</div>
      </div>
      {data.status && <StatusBadge status={data.status} compact />}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { ...baseNodeTypes, lead: LeadNode };

export function PlanBoard({ plan, agents, live, defaultModel, request }: {
  plan: Plan; agents: Agent[]; live: boolean; defaultModel?: string; request?: string;
}) {
  const [open, setOpen] = useState(true);
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
        <WorkflowIcon size={15} className="text-indigo-500" />
        <button className="flex flex-1 items-center gap-1.5 text-left text-sm font-medium" onClick={() => setOpen(!open)}>
          Workflow <span className="font-normal text-zinc-500">· {done}/{plan.steps.length} steps done</span>
          <ChevronDown size={14} className={`text-zinc-400 transition ${open ? "rotate-180" : ""}`} />
        </button>
        {plan.workflowId ? (
          <Link to={`/workflows/${plan.workflowId}`} className="btn-ghost px-2 py-1 text-xs" title="This plan is saved under Workflows"><ExternalLink size={13} /> Open in Workflows</Link>
        ) : !live && <SaveButton plan={plan} agents={agents} request={request} />}
      </div>
      {open && (
        <div className="h-72 border-t border-zinc-200 dark:border-zinc-800">
          <ReactFlowProvider><Canvas plan={plan} agents={agents} live={live} defaultModel={defaultModel} /></ReactFlowProvider>
        </div>
      )}
    </div>
  );
}

/** Full-size live plan, for the project view. */
export function PlanCanvas(props: { plan: Plan; agents: Agent[]; live: boolean; defaultModel?: string }) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ plan, agents, live, defaultModel }: { plan: Plan; agents: Agent[]; live: boolean; defaultModel?: string }) {
  const byName = useMemo(() => Object.fromEntries(agents.map((a) => [a.name, a])), [agents]);
  const flow = useMemo(() => {
    const { pos, maxCol, mid, leaves } = layout(plan.steps);
    const st = Object.fromEntries(plan.steps.map((s) => [s.id, STATUS[s.status] ?? "pending"]));
    const allDone = plan.steps.every((s) => s.status === "done" || s.status === "failed");
    const endStatus = !live ? "done" : allDone ? "running" : "pending";
    const nodes: FlowNode[] = [
      { id: "__lead", type: "lead", position: { x: 0, y: mid }, data: { agent: byName[plan.lead], label: plan.lead, status: live ? "running" : "done" } },
      ...plan.steps.map((s): FlowNode => ({
        id: s.id, type: "agent", position: pos[s.id],
        data: { agent: byName[s.agent], instructions: s.task, status: st[s.id], defaultModel },
      })),
      { id: "__end", type: "output", position: { x: (maxCol + 1) * COL, y: mid + 8 }, data: { label: "Final answer", status: endStatus } },
    ];
    const cls = (src: string, tgt: string) => {
      const s = src === "__lead" ? "done" : st[src], t = tgt === "__end" ? endStatus : st[tgt];
      return s === "done" && t === "running" ? "edge-running" : s === "done" && t === "done" ? "edge-done" : "";
    };
    const edge = (source: string, target: string): Edge => ({ id: `${source}->${target}`, source, target, ...edgeDefaults, className: cls(source, target) });
    const edges = [
      ...plan.steps.filter((s) => !s.after.length).map((s) => edge("__lead", s.id)),
      ...plan.steps.flatMap((s) => s.after.map((a) => edge(a, s.id))),
      ...leaves.map((id) => edge(id, "__end")),
    ];
    return { nodes, edges };
  }, [plan, byName, live, defaultModel]);

  // React Flow needs onNodesChange to store node measurements, so keep nodes in local state
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  useEffect(() => {
    setNodes((prev) => flow.nodes.map((n) => {
      const old = prev.find((p) => p.id === n.id);
      return old ? { ...old, position: n.position, data: n.data } : n;
    }));
  }, [flow.nodes, setNodes]);
  // re-fit when steps are added or removed
  const { fitView } = useReactFlow();
  const shape = flow.nodes.map((n) => n.id).join(",");
  const measured = nodes.length > 0 && nodes.every((n) => n.measured?.width);
  useEffect(() => {
    if (!measured) return;
    const t = setTimeout(() => fitView({ padding: "4%", maxZoom: 1, duration: 250 }), 50);
    return () => clearTimeout(t);
  }, [shape, measured, fitView]);

  return nodes.length > 0 ? (
    <ReactFlow nodes={nodes} onNodesChange={onNodesChange} edges={flow.edges} nodeTypes={nodeTypes}
      fitView fitViewOptions={{ padding: "4%", maxZoom: 1 }} minZoom={0.15}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} className="!bg-zinc-50 dark:!bg-zinc-950" color="#a1a1aa55" />
    </ReactFlow>
  ) : null;
}

/** Turn the plan into a normal, editable workflow: Start → steps (by their order) → Output. */
function SaveButton({ plan, agents, request }: { plan: Plan; agents: Agent[]; request?: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    const { pos, maxCol, mid, leaves } = layout(plan.steps);
    const nid = (id: string) => `step_${id.replace(/[^\w-]/g, "_")}`;
    const nodes: GraphNode[] = [
      { id: "start", type: "start", position: { x: 0, y: mid }, data: {} },
      ...plan.steps.map((s): GraphNode => ({ id: nid(s.id), type: "agent", position: pos[s.id], data: { agentId: byName[s.agent]?.id, instructions: s.task } })),
      { id: "output", type: "output", position: { x: (maxCol + 1) * COL, y: mid }, data: {} },
    ];
    const e = (source: string, target: string): GraphEdge => ({ id: `e_${source}_${target}`, source, target });
    const edges: GraphEdge[] = [
      ...plan.steps.filter((s) => !s.after.length).map((s) => e("start", nid(s.id))),
      ...plan.steps.flatMap((s) => s.after.map((a) => e(nid(a), nid(s.id)))),
      ...leaves.map((id) => e(nid(id), "output")),
    ];
    setBusy(true);
    try {
      const title = (request ?? "").split("\n")[0].slice(0, 60).trim();
      const w = await api.createWorkflow({
        name: title ? `${plan.lead}: ${title}` : `${plan.lead}'s plan`,
        description: `Saved from ${plan.lead}'s plan.`,
        graph: { nodes, edges },
      });
      toast("Saved as a workflow");
      nav(`/workflows/${w.id}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={save} title="Save this plan as a workflow you can edit and run again">
      <Save size={13} /> Save as workflow
    </button>
  );
}
