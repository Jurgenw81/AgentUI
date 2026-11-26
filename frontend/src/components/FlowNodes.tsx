import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { AlertCircle, Flag, GitFork, Hand, PlayCircle, Repeat } from "lucide-react";
import { modelLabel, type Agent, type NodeData } from "../api";
import { AgentAvatar, StatusBadge } from "./ui";
import { ProviderDot } from "./ModelPicker";

export type FlowData = NodeData & {
  agent?: Agent;
  reviewer?: Agent;
  round?: number;
  status?: string;
  decision?: string;
  defaultModel?: string;
  [k: string]: unknown;
};
export type FlowNode = Node<FlowData>;

const ring: Record<string, string> = {
  running: "ring-2 ring-indigo-500 shadow-lg shadow-indigo-500/20",
  waiting: "ring-2 ring-amber-500 shadow-lg shadow-amber-500/30 animate-pulse",
  done: "ring-2 ring-emerald-500/70",
  error: "ring-2 ring-red-500",
  stopped: "ring-2 ring-amber-500",
  skipped: "opacity-45",
};

function Shell({ selected, status, children, className = "" }: { selected?: boolean; status?: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border bg-white transition dark:bg-zinc-900 ${
        selected ? "border-indigo-500 ring-2 ring-indigo-500/30" : "border-zinc-200 dark:border-zinc-700"
      } ${status ? ring[status] ?? "" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function StartNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Shell selected={selected} status={data.status} className="whitespace-nowrap px-4 py-3">
      <div className="flex items-center gap-2">
        <PlayCircle size={18} className="text-emerald-600" />
        <div>
          <div className="text-sm font-semibold">Start</div>
          <div className="text-[11px] text-zinc-500">Your task goes in here</div>
        </div>
        {data.status && data.status !== "pending" && <StatusBadge status={data.status} compact />}
      </div>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
}

export function OutputNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Shell selected={selected} status={data.status} className="whitespace-nowrap px-4 py-3">
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Flag size={18} className="text-indigo-600" />
        <div>
          <div className="text-sm font-semibold">{data.label || "Final output"}</div>
          <div className="text-[11px] text-zinc-500">The result of the run</div>
        </div>
        {data.status && data.status !== "pending" && <StatusBadge status={data.status} compact />}
      </div>
    </Shell>
  );
}

export function AgentNode({ data, selected }: NodeProps<FlowNode>) {
  const a = data.agent;
  return (
    <Shell selected={selected} status={data.status} className="w-60">
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        {a ? <AgentAvatar agent={a} size={34} /> : (
          <div className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-red-50 text-red-500 dark:bg-red-500/15"><AlertCircle size={18} /></div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{data.label || a?.name || "Choose an agent"}</div>
          <div className="flex items-center gap-1 truncate text-[11px] text-zinc-500">
            {a ? <><ProviderDot model={a.model || data.defaultModel} /> {modelLabel(a.model || data.defaultModel)}</> : "Click to configure"}
          </div>
        </div>
        {data.status && data.status !== "pending" && <StatusBadge status={data.status} compact />}
      </div>
      <div className="line-clamp-2 min-h-[2rem] px-3.5 pb-3 pt-2 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
        {data.instructions || a?.description || ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
}

export function RouterNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Shell selected={selected} status={data.status} className="w-56 border-amber-300 dark:border-amber-700/60">
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15">
          <GitFork size={18} className="rotate-90" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{data.label || "Router"}</div>
          <div className="truncate text-[11px] text-zinc-500">Picks one path · {data.agent?.name ?? "default model"}</div>
        </div>
        {data.status && data.status !== "pending" && <StatusBadge status={data.status} compact />}
      </div>
      <div className="line-clamp-2 min-h-[2rem] px-3.5 pb-3 pt-2 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
        {data.decision ? <span className="font-medium text-amber-700 dark:text-amber-400">→ chose {data.decision}</span> : data.instructions || "Decides which branch runs"}
      </div>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
}

export function LoopNode({ data, selected }: NodeProps<FlowNode>) {
  const w = data.agent, r = data.reviewer;
  const max = data.maxRounds ?? 3;
  return (
    <Shell selected={selected} status={data.status} className="w-64 border-violet-300 dark:border-violet-700/60">
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-violet-50 text-violet-600 dark:bg-violet-500/15">
          <Repeat size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{data.label || "Review loop"}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {data.status === "running" && data.round ? `round ${data.round} of ${max}` : `up to ${max} rounds`}
          </div>
        </div>
        {data.status && data.status !== "pending" && <StatusBadge status={data.status} compact />}
      </div>
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-2.5 text-[11px]">
        <Pill agent={w} fallback="worker?" />
        <span className="text-violet-500">⇄</span>
        <Pill agent={r} fallback="reviewer?" />
      </div>
      {data.decision && <div className="border-t border-zinc-100 px-3.5 py-1.5 text-[11px] font-medium text-violet-700 dark:border-zinc-800 dark:text-violet-300">{data.decision}</div>}
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
}

function Pill({ agent, fallback }: { agent?: Agent; fallback: string }) {
  return agent ? (
    <span className="flex min-w-0 items-center gap-1 rounded-md bg-zinc-100 py-0.5 pl-0.5 pr-1.5 dark:bg-zinc-800">
      <AgentAvatar agent={agent} size={18} /> <span className="truncate">{agent.name}</span>
    </span>
  ) : <span className="rounded-md bg-red-50 px-1.5 py-0.5 text-red-600 dark:bg-red-500/15">{fallback}</span>;
}

export function ApprovalNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <Shell selected={selected} status={data.status} className="w-52 border-amber-300 dark:border-amber-700/60">
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15">
          <Hand size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{data.label || "Your approval"}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {data.decision ?? (data.status === "waiting" ? "waiting for you…"
              : data.mode === "ai" ? "AI checks · asks you if needed" : data.mode === "auto" ? "auto-approves" : "asks you")}
            {!data.decision && data.status !== "waiting" && !!data.timeoutMinutes && ` · ${data.timeoutMinutes}m timeout`}
          </div>
        </div>
        {data.status && data.status !== "pending" && <StatusBadge status={data.status} compact />}
      </div>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
}

export const nodeTypes = { start: StartNode, output: OutputNode, agent: AgentNode, router: RouterNode, loop: LoopNode, approval: ApprovalNode };
