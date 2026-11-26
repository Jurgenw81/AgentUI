import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot, Brain, CheckCircle2, CircleDashed, Code, Database, FileText, Globe, Lightbulb, ListChecks, Loader2,
  Hand, MessageSquare, PenLine, Search, ShieldCheck, Sparkles, Users, X, XCircle, Zap, Ban, MinusCircle,
  type LucideIcon,
} from "lucide-react";
import { type Agent } from "../api";

export const AGENT_ICONS: Record<string, LucideIcon> = {
  bot: Bot, brain: Brain, code: Code, search: Search, "pen-line": PenLine, "shield-check": ShieldCheck,
  "list-checks": ListChecks, users: Users, sparkles: Sparkles, globe: Globe, database: Database,
  "file-text": FileText, lightbulb: Lightbulb, zap: Zap, "message-square": MessageSquare,
};

export const AGENT_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#10b981", "#0ea5e9", "#64748b"];

export function AgentAvatar({ agent, size = 36 }: { agent?: Partial<Agent> | null; size?: number }) {
  const Icon = AGENT_ICONS[agent?.icon ?? "bot"] ?? Bot;
  const color = agent?.color ?? "#6366f1";
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{ width: size, height: size, background: `${color}1f`, color }}
    >
      <Icon size={size * 0.52} strokeWidth={2} />
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string; Icon: LucideIcon; spin?: boolean }> = {
  queued: { label: "Queued", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300", Icon: CircleDashed },
  pending: { label: "Waiting", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400", Icon: CircleDashed },
  running: { label: "Running", cls: "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300", Icon: Loader2, spin: true },
  waiting: { label: "Needs you", cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300", Icon: Hand },
  done: { label: "Done", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", Icon: CheckCircle2 },
  error: { label: "Failed", cls: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300", Icon: XCircle },
  stopped: { label: "Stopped", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", Icon: Ban },
  skipped: { label: "Skipped", cls: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500", Icon: MinusCircle },
};

export function StatusBadge({ status, compact }: { status: string; compact?: boolean }) {
  const s = STATUS[status] ?? STATUS.pending;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      <s.Icon size={12} className={s.spin ? "animate-spin" : ""} />
      {!compact && s.label}
    </span>
  );
}

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div
      className={`prose prose-sm prose-zinc max-w-none dark:prose-invert prose-pre:bg-zinc-900 prose-pre:text-zinc-100
        prose-code:before:content-none prose-code:after:content-none prose-headings:font-semibold ${className}`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function Modal({
  open, onClose, title, children, footer, wide,
}: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className={`card flex max-h-[90vh] w-full flex-col ${wide ? "max-w-3xl" : "max-w-lg"}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-indigo-50 p-3 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
        <Icon size={22} />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 size={18} className={`animate-spin text-zinc-400 ${className}`} />;
}

/* ---------------- toasts ---------------- */

type Toast = { id: number; text: string; kind: "ok" | "error" };
const ToastCtx = createContext<(text: string, kind?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-sm shadow-lg ${
              t.kind === "error" ? "bg-red-600 text-white" : "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
