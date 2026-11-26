import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, KeyRound, RefreshCw, Search } from "lucide-react";
import { api, modelLabel, providerOf, type ProviderModels } from "../api";

let cache: Promise<{ providers: Record<string, ProviderModels>; default_model: string }> | null = null;
export function loadModels(force = false) {
  if (!cache || force) cache = api.models().catch((e) => { cache = null; throw e; });
  return cache;
}

export const PROVIDER_COLORS: Record<string, string> = {
  "claude-code": "#d97757", chatgpt: "#10a37f", "gemini-cli": "#4285f4", anthropic: "#c2410c", openai: "#10a37f", gemini: "#4285f4", openrouter: "#6366f1", ollama: "#71717a", custom: "#a855f7",
};

const KIND_BADGE: Record<string, { text: string; cls: string }> = {
  subscription: { text: "Subscription", cls: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300" },
  local: { text: "Local · free", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  api: { text: "API key", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
};

export function KindBadge({ kind }: { kind?: string }) {
  const b = KIND_BADGE[kind ?? "api"] ?? KIND_BADGE.api;
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${b.cls}`}>{b.text}</span>;
}

/** The model an agent will actually use, resolving "default". */
export function useDefaultModel() {
  const [m, setM] = useState("");
  useEffect(() => { loadModels().then((d) => setM(d.default_model)).catch(() => {}); }, []);
  return m;
}

export function ProviderDot({ model }: { model?: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: PROVIDER_COLORS[providerOf(model)] ?? "#a1a1aa" }} />;
}

export function ModelPicker({
  value, onChange, allowDefault = true,
}: { value?: string; onChange: (m: string) => void; allowDefault?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ providers: Record<string, ProviderModels>; default_model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = (force = false) => {
    setLoading(true);
    loadModels(force).then(setData).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.toLowerCase();
    return Object.entries(data.providers)
      .map(([pid, p]) => ({ pid, ...p, models: p.models.filter((m) => m.toLowerCase().includes(needle)) }))
      .filter((g) => !needle || g.models.length > 0)
      .sort((a, b) => Number(b.configured) - Number(a.configured));
  }, [data, q]);

  const custom = q.includes("/") && !groups.some((g) => g.models.includes(q)) ? q : null;
  const pick = (m: string) => { onChange(m); setOpen(false); setQ(""); };

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="input flex items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        {value ? <ProviderDot model={value} /> : null}
        <span className="flex-1 truncate">
          {value ? (
            <>
              {modelLabel(value)} <span className="text-zinc-400">· {data?.providers[providerOf(value)]?.label ?? providerOf(value)}</span>
            </>
          ) : (
            <span className="text-zinc-500">Default model{data ? ` (${modelLabel(data.default_model)})` : ""}</span>
          )}
        </span>
        <ChevronDown size={16} className="text-zinc-400" />
      </button>

      {open && (
        <div className="card absolute left-0 right-0 z-40 mt-1 overflow-hidden shadow-xl">
          <div className="flex items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
            <Search size={15} className="text-zinc-400" />
            <input
              autoFocus
              className="w-full bg-transparent py-2.5 text-sm outline-none"
              placeholder="Search models, or type provider/model-name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && custom && pick(custom)}
            />
            <button type="button" title="Refresh model lists" className="text-zinc-400 hover:text-zinc-700" onClick={() => refresh(true)}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto py-1 text-sm">
            {allowDefault && !q && (
              <Option active={!value} onClick={() => pick("")}>
                <span className="text-zinc-500">Use default model</span>
              </Option>
            )}
            {custom && (
              <Option onClick={() => pick(custom)}>
                Use <b>{custom}</b>
              </Option>
            )}
            {groups.map((g) => (
              <div key={g.pid}>
                <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  <span className="h-2 w-2 rounded-full" style={{ background: PROVIDER_COLORS[g.pid] }} />
                  {g.label}
                  <KindBadge kind={g.kind} />
                  {!g.configured && (
                    <Link to="/settings" className="ml-auto flex items-center gap-1 font-normal normal-case text-amber-600 hover:underline">
                      <KeyRound size={11} /> {g.kind === "api" ? "add key" : "set up"}
                    </Link>
                  )}
                </div>
                {g.models.length === 0 && !q && (
                  <div className="px-3 py-1.5 text-xs text-zinc-500">{g.error ?? "No models found."}</div>
                )}
                {g.models.slice(0, 60).map((m) => {
                  const info = g.info?.[m];
                  return (
                    <Option key={m} active={m === value} onClick={() => pick(m)} dim={!g.configured}>
                      <span>{modelLabel(m).replace(" · subscription", "")}</span>
                      {info?.detail && <span className="ml-2 text-xs text-zinc-400">{info.detail}</span>}
                      {info && info.tools === false && <span className="ml-2 rounded bg-amber-50 px-1 text-[10px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">no tools</span>}
                    </Option>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Option({ children, onClick, active, dim }: { children: React.ReactNode; onClick: () => void; active?: boolean; dim?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${dim ? "opacity-60" : ""}`}
    >
      <span className="flex-1 truncate">{children}</span>
      {active && <Check size={14} className="text-indigo-600" />}
    </button>
  );
}
