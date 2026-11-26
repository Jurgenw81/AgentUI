import { useState } from "react";
import { ArrowRightLeft, CheckCircle2, ShieldCheck, ChevronRight, GitFork, Hand, Loader2, MessageSquareWarning, Wrench, XCircle } from "lucide-react";
import { type RunEvent } from "../api";
import { Markdown } from "./ui";

export type Partial_ = { node?: string; scope?: string; agent?: string; text: string };

export type Item =
  | { kind: "text"; key: string; agent?: string; depth: number; content: string; streaming?: boolean; intermediate?: boolean }
  | { kind: "tool"; key: string; agent?: string; depth: number; tool: string; args: string; output?: string; duration?: number }
  | { kind: "delegate"; key: string; agent?: string; depth: number; to: string; task: string }
  | { kind: "router"; key: string; depth: number; target: string; reason: string }
  | { kind: "error"; key: string; depth: number; error: string }
  | { kind: "notice"; key: string; depth: number; text: string }
  | { kind: "round"; key: string; depth: number; round: number; max: number }
  | { kind: "review"; key: string; depth: number; round: number; approved: boolean; feedback: string; reviewer: string }
  | { kind: "decision"; key: string; depth: number; approved: boolean; edited: boolean; note: string; by: string; reason: string }
  | { kind: "toolgate"; key: string; depth: number; tool: string; approved: boolean; by: string; reason: string; note: string };

const TOOL_NAMES: Record<string, string> = {
  web_search: "Searched the web", fetch_url: "Read a web page", http_request: "Called an API", list_files: "Listed files",
  read_file: "Read a file", write_file: "Wrote a file", run_python: "Ran Python", run_shell: "Ran a shell command", delegate: "Asked a teammate", update_plan: "Updated the workflow plan", delegate_parallel: "Asked teammates (in parallel)", check_website: "Checked the website", codex_shell: "Codex looked around (read-only)",
};

export function buildItems(events: RunEvent[], partials: Partial_[], node?: string): Item[] {
  const items: Item[] = [];
  const tools: Record<string, Extract<Item, { kind: "tool" }>> = {};
  events.forEach((e, i) => {
    if (node !== undefined && e.node !== node) return;
    const depth = (e.depth as number) ?? 0; // scope like "round 2" (review loops) doesn't add depth
    const key = `${i}`;
    switch (e.type) {
      case "message":
        if (e.content) items.push({ kind: "text", key, agent: e.agent, depth, content: e.content as string, intermediate: !!e.intermediate });
        break;
      case "tool_call": {
        const t = { kind: "tool" as const, key, agent: e.agent, depth, tool: e.tool as string, args: e.args as string };
        tools[e.call_id as string] = t;
        if (e.tool !== "delegate") items.push(t);
        break;
      }
      case "tool_result": {
        const t = tools[e.call_id as string];
        if (t) { t.output = e.output as string; t.duration = e.duration as number; }
        break;
      }
      case "delegate":
        items.push({ kind: "delegate", key, agent: e.agent, depth, to: e.to as string, task: e.task as string });
        break;
      case "router_decision":
        items.push({ kind: "router", key, depth, target: e.target_label as string, reason: e.reason as string });
        break;
      case "loop_round":
        items.push({ kind: "round", key, depth: 0, round: e.round as number, max: e.max_rounds as number });
        break;
      case "review":
        items.push({ kind: "review", key, depth: 0, round: e.round as number, approved: !!e.approved,
          feedback: (e.feedback as string) ?? "", reviewer: (e.reviewer as string) ?? "Reviewer" });
        break;
      case "approval_resolved":
        items.push({ kind: "decision", key, depth: 0, approved: !!e.approved, edited: !!e.edited, note: (e.note as string) ?? "",
          by: (e.by as string) ?? "you", reason: (e.reason as string) ?? "" });
        break;
      case "tool_approval_resolved":
        items.push({ kind: "toolgate", key, depth, tool: e.tool as string, approved: !!e.approved, by: (e.by as string) ?? "you",
          reason: (e.reason as string) ?? "", note: (e.note as string) ?? "" });
        break;
      case "notice":
        items.push({ kind: "notice", key, depth, text: e.text as string });
        break;
      case "node_error":
        items.push({ kind: "error", key, depth, error: e.error as string });
        break;
    }
  });
  partials
    .filter((p) => node === undefined || p.node === node)
    .forEach((p, i) => p.text && items.push({ kind: "text", key: `p${i}`, agent: p.agent, depth: p.scope ? p.scope.split(">").length - (p.scope.startsWith("round ") ? 1 : 0) : 0, content: p.text, streaming: true }));
  return items;
}

export function ActivityList({ items, showAgent = true }: { items: Item[]; showAgent?: boolean }) {
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div key={it.key} style={{ marginLeft: it.depth * 18 }} className={it.depth ? "border-l-2 border-indigo-200 pl-3 dark:border-indigo-900" : ""}>
          <ItemView it={it} showAgent={showAgent || it.depth > 0} />
        </div>
      ))}
    </div>
  );
}

function ItemView({ it, showAgent }: { it: Item; showAgent: boolean }) {
  if (it.kind === "text")
    return (
      <div>
        {showAgent && it.agent && <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{it.agent}{it.intermediate ? " · thinking" : ""}</div>}
        <div className={it.streaming ? "caret" : ""}>
          {it.streaming ? <div className="whitespace-pre-wrap text-sm">{it.content}</div> : <Markdown>{it.content}</Markdown>}
        </div>
      </div>
    );
  if (it.kind === "tool") return <ToolView it={it} />;
  if (it.kind === "delegate")
    return (
      <div className="flex items-start gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-500/10">
        <ArrowRightLeft size={15} className="mt-0.5 shrink-0 text-indigo-600" />
        <div><b>{it.agent}</b> asked <b>{it.to}</b>: <span className="text-zinc-600 dark:text-zinc-400">{it.task}</span></div>
      </div>
    );
  if (it.kind === "router")
    return (
      <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-500/10">
        <GitFork size={15} className="mt-0.5 shrink-0 rotate-90 text-amber-600" />
        <div>Routed to <b>{it.target}</b>{it.reason && <span className="text-zinc-600 dark:text-zinc-400"> — {it.reason}</span>}</div>
      </div>
    );
  if (it.kind === "round")
    return (
      <div className="flex items-center gap-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
        <span className="h-px flex-1 bg-violet-200 dark:bg-violet-900" /> Round {it.round} of {it.max} <span className="h-px flex-1 bg-violet-200 dark:bg-violet-900" />
      </div>
    );
  if (it.kind === "review")
    return (
      <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${it.approved ? "bg-emerald-50 dark:bg-emerald-500/10" : "bg-violet-50 dark:bg-violet-500/10"}`}>
        {it.approved ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" /> : <MessageSquareWarning size={15} className="mt-0.5 shrink-0 text-violet-600" />}
        <div><b>{it.reviewer}</b> {it.approved ? "approved it" : "asked for changes"}{it.feedback && <span className="text-zinc-600 dark:text-zinc-400"> — {it.feedback}</span>}</div>
      </div>
    );
  if (it.kind === "decision")
    return (
      <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${it.approved ? "bg-emerald-50 dark:bg-emerald-500/10" : "bg-red-50 dark:bg-red-500/10"}`}>
        <Hand size={15} className={`mt-0.5 shrink-0 ${it.approved ? "text-emerald-600" : "text-red-600"}`} />
        <div>
          {{ you: "You", ai: "AI check", auto: "Auto", autonomous: "Autonomous mode", timeout: "Timeout" }[it.by] ?? "You"}{" "}
          {it.approved ? (it.edited ? "approved it with edits" : "approved it") : "rejected it"}
          {it.note && <span className="text-zinc-600 dark:text-zinc-400"> — “{it.note}”</span>}
          {it.reason && <div className="text-xs text-zinc-600 dark:text-zinc-400">{it.reason}</div>}
        </div>
      </div>
    );
  if (it.kind === "toolgate")
    return (
      <div className={`flex items-start gap-2 rounded-lg px-3 py-1.5 text-xs ${it.approved ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200" : "bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200"}`}>
        <ShieldCheck size={14} className="mt-px shrink-0" />
        <div>
          <b>{it.by === "ai" ? "Safety check" : "You"}</b> {it.approved ? "allowed" : "declined"} <code>{prettyTool(it.tool)}</code>
          {(it.reason || it.note) && <span className="opacity-80">: {it.reason || it.note}</span>}
        </div>
      </div>
    );
  if (it.kind === "notice")
    return <div className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">ℹ {it.text}</div>;
  return (
    <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
      <XCircle size={15} className="mt-0.5 shrink-0" /> <span className="break-all">{it.error}</span>
    </div>
  );
}

export function prettyTool(tool: string) {
  return TOOL_NAMES[tool] ?? (tool.includes("__") ? tool.replace("__", ": ").replace(/_/g, " ") : tool);
}

function summarizeArgs(args: string): string {
  try {
    const a = JSON.parse(args || "{}");
    return a.query ?? a.url ?? a.path ?? a.command ?? (a.code ? String(a.code).split("\n")[0] : "") ?? "";
  } catch {
    return "";
  }
}

function ToolView({ it }: { it: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  let pretty = it.args;
  try { pretty = JSON.stringify(JSON.parse(it.args), null, 2); } catch { /* keep raw */ }
  return (
    <div className="rounded-lg border border-zinc-200 text-sm dark:border-zinc-700">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className={`shrink-0 text-zinc-400 transition ${open ? "rotate-90" : ""}`} />
        {it.output === undefined ? <Loader2 size={14} className="shrink-0 animate-spin text-indigo-500" /> : <Wrench size={14} className="shrink-0 text-zinc-500" />}
        <span className="shrink-0 font-medium">{prettyTool(it.tool)}</span>
        <span className="truncate font-mono text-xs text-zinc-500">{summarizeArgs(it.args)}</span>
        {it.duration !== undefined && <span className="ml-auto shrink-0 text-xs text-zinc-400">{it.duration}s</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-700">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">Input</div>
            <pre className="max-h-60 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-950">{pretty}</pre>
          </div>
          {it.output !== undefined && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase text-zinc-500">Result</div>
              <pre className="max-h-80 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-950">{it.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
