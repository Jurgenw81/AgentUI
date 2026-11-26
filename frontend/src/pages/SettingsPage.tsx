import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Container, KeyRound, Loader2, RefreshCw, ShieldAlert, Trash2, Zap } from "lucide-react";
import { api, modelLabel, type ProviderModels, type Settings } from "../api";
import { loadModels, ModelPicker, PROVIDER_COLORS } from "../components/ModelPicker";
import { PageHeader, Spinner, useToast } from "../components/ui";
import { McpServers } from "../components/McpServers";

const KEY_LINKS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
};

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<Record<string, ProviderModels>>({});
  const toast = useToast();

  const refreshModels = (): Promise<void> => loadModels(true).then((m) => setModels(m.providers)).catch(() => {});
  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth" }), 300);
    });
    refreshModels();
  }, []);

  const save = async (patch: Record<string, unknown>, msg = "Saved") => {
    const next = await api.saveSettings(patch);
    setS(next);
    toast(msg);
    return next;
  };

  if (!s) return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <PageHeader title="Settings" subtitle="Choose where your agents' models come from, and set safety limits. Everything stays on this machine." />

      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">No API key needed</h2>
      <p className="mb-3 text-sm text-zinc-500">
        Use the subscriptions you already pay for, or free local models. Agents run through each vendor's official command-line tool on this computer,
        so usage counts toward that plan's limits and there's no per-token bill.
      </p>
      <div className="space-y-3">
        {SUBS.map((sub) => (
          <SubscriptionCard key={sub.pid} sub={sub} models={models[sub.pid]} onRefresh={async () => { await api.refreshClaudeCode(); await refreshModels(); }} />
        ))}
        <OllamaCard p={s.providers.ollama} models={models.ollama}
          onSave={async (patch) => { await save({ providers: { ollama: patch } }, "Ollama saved"); refreshModels(); }} />
      </div>

      <h2 className="mb-1 mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-500">API keys (optional)</h2>
      <p className="mb-3 text-sm text-zinc-500">Pay-as-you-go access to more providers.</p>
      <div className="space-y-3">
        {Object.entries(s.providers).filter(([, p]) => p.kind === "api").map(([pid, p]) => (
          <ProviderCard key={pid} pid={pid} p={p} models={models[pid]}
            onSave={async (patch) => { await save({ providers: { [pid]: patch } }, `${p.label} saved`); refreshModels(); }} />
        ))}
      </div>

      <McpServers />

      <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-500">Defaults & limits</h2>
      <div className="card space-y-6 p-5">
        <div>
          <label className="label">Default model</label>
          <div className="max-w-md"><ModelPicker value={s.default_model} allowDefault={false} onChange={(m) => save({ default_model: m }, "Default model updated").then(() => loadModels(true))} /></div>
          <p className="hint">Used by any agent that doesn't pick its own model.</p>
        </div>
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <label className="label mb-0.5">Run workflows autonomously by default</label>
            <p className="text-xs text-zinc-500">
              When on, runs never stop to ask you: approval steps are approved automatically (AI-checked ones still run their check and pass any concerns on).
              Each workflow can override this, and you can switch it every time you click Run.
            </p>
          </div>
          <button role="switch" aria-checked={s.autonomous_default}
            onClick={() => save({ autonomous_default: !s.autonomous_default }, s.autonomous_default ? "Runs will ask you at approval steps" : "Runs are now autonomous by default")}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${s.autonomous_default ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${s.autonomous_default ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>
        <div>
          <label className="label">Cost limit per run (USD)</label>
          <div className="flex items-center gap-2">
            <input type="number" min={0} step={0.5} className="input w-32" defaultValue={s.max_cost_per_run}
              onBlur={(e) => Number(e.target.value) !== s.max_cost_per_run && save({ max_cost_per_run: Number(e.target.value) })} />
            <span className="text-sm text-zinc-500">0 = no limit</span>
          </div>
          <p className="hint">A run stops automatically if it spends more than this. Local models (Ollama) are free.</p>
        </div>
      </div>

      <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-500">Code execution</h2>
      <div className="card p-5">
        <div className="flex items-start gap-4">
          <div className="rounded-lg bg-amber-50 p-2.5 text-amber-600 dark:bg-amber-500/15"><Container size={20} /></div>
          <div className="flex-1">
            <div className="font-medium">Let agents run code in a Docker sandbox</div>
            <p className="mt-1 text-sm text-zinc-500">
              Agents with the <b>Run Python</b> or <b>Run shell</b> tools execute code inside a throwaway <code>python:3.12-slim</code> container:
              no internet, 512 MB RAM, 1 CPU, 60 s timeout. Only the workspace folder is shared.
            </p>
            <p className="mt-2 flex items-center gap-1 text-xs text-zinc-500"><ShieldAlert size={13} /> Workspace: <code className="text-[11px]">{s.workspace_dir}</code></p>
          </div>
          <button
            role="switch"
            aria-checked={s.allow_code_execution}
            onClick={() => save({ allow_code_execution: !s.allow_code_execution }, s.allow_code_execution ? "Code execution disabled" : "Code execution enabled")}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${s.allow_code_execution ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${s.allow_code_execution ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

function useModelTest() {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (model?: string) => {
    if (!model) return setTest({ ok: false, text: "No models found to test." });
    setTesting(true);
    setTest(null);
    const r = await api.testModel(model);
    setTest(r.ok ? { ok: true, text: `${modelLabel(model)} replied: “${r.reply}”` } : { ok: false, text: r.error ?? "Failed" });
    setTesting(false);
  };
  return { testing, test, run };
}

type SubInfo = { pid: string; title: string; plan: string; install: string; login: string; loginHint: string };

const SUBS: SubInfo[] = [
  { pid: "claude-code", title: "Claude subscription", plan: "Pro / Max, via Claude Code",
    install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude", loginHint: "choose “Claude account with subscription”" },
  { pid: "chatgpt", title: "ChatGPT subscription", plan: "Plus / Pro / Business, via Codex CLI",
    install: "npm install -g @openai/codex", login: "codex login", loginHint: "choose “Sign in with ChatGPT”" },
  { pid: "gemini-cli", title: "Gemini", plan: "free Google account or Google AI Pro / Ultra, via Gemini CLI",
    install: "npm install -g @google/gemini-cli", login: "gemini", loginHint: "choose “Login with Google”, then type /quit" },
];

function SubscriptionCard({ sub, models, onRefresh }: { sub: SubInfo; models?: ProviderModels; onRefresh: () => Promise<void> }) {
  const st = models?.status;
  const { testing, test, run } = useModelTest();
  const [checking, setChecking] = useState(false);
  const ready = !!(st?.installed && st.logged_in);
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ background: PROVIDER_COLORS[sub.pid] }} />
        <h3 className="flex-1 font-semibold">{sub.title} <span className="font-normal text-zinc-500">({sub.plan})</span></h3>
        {!models ? <Loader2 size={14} className="animate-spin text-zinc-400" /> : ready ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={14} /> Logged in{st?.method ? ` (${st.method})` : ""}</span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-600"><CircleAlert size={14} /> {st?.installed ? "Not logged in" : "Not installed"}</span>
        )}
      </div>
      {models && !ready && (
        <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/60">
          {st?.installed ? (
            <>Open a terminal, run <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">{sub.login}</code> and {sub.loginHint}. Then click <b>Check again</b>.</>
          ) : (
            <>Install it: <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">{sub.install}</code>, then run <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">{sub.login}</code> to log in.</>
          )}
        </div>
      )}
      {st?.detail && <p className="mt-2 flex items-start gap-1 text-xs text-amber-600"><CircleAlert size={13} className="mt-0.5 shrink-0" /> {st.detail}</p>}
      {ready && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {models?.models.map((m) => <span key={m} className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{modelLabel(m).replace(" · subscription", "")}</span>)}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button className="btn-secondary" disabled={checking} onClick={async () => { setChecking(true); await onRefresh(); setChecking(false); }}>
          <RefreshCw size={14} className={checking ? "animate-spin" : ""} /> Check again
        </button>
        <button className="btn-secondary" disabled={!ready || testing} onClick={() => run(models?.models.find((m) => /haiku|luna|flash/.test(m)) ?? models?.models[0])}>
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Test
        </button>
      </div>
      {test && <p className={`mt-3 break-all text-xs ${test.ok ? "text-emerald-600" : "text-red-600"}`}>{test.text}</p>}
    </div>
  );
}

function OllamaCard({ p, models, onSave }: { p: Settings["providers"][string]; models?: ProviderModels; onSave: (patch: Record<string, string>) => Promise<void> }) {
  const [url, setUrl] = useState(p.base_url);
  const { testing, test, run } = useModelTest();
  const installed = models?.installed ?? [];
  const chat = installed.filter((m) => m.chat);
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ background: PROVIDER_COLORS.ollama }} />
        <h3 className="flex-1 font-semibold">Ollama <span className="font-normal text-zinc-500">(local models, free)</span></h3>
        {!models ? <Loader2 size={14} className="animate-spin text-zinc-400" /> : chat.length ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={14} /> Running · {chat.length} chat model{chat.length === 1 ? "" : "s"}</span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-600"><CircleAlert size={14} /> {installed.length ? "No chat models" : "Not reachable"}</span>
        )}
      </div>

      {installed.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-800/60">
              <tr><th className="px-3 py-2 font-medium">Installed model</th><th className="px-3 py-2 font-medium">Size</th><th className="px-3 py-2 font-medium">Can do</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {installed.map((m) => (
                <tr key={m.name} className={m.chat ? "" : "opacity-50"}>
                  <td className="px-3 py-2 font-mono text-xs">{m.name.replace(/:latest$/, "")}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{[m.params, m.size].filter(Boolean).join(" · ")}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {!m.chat && <Tag>embeddings only, not usable for agents</Tag>}
                      {m.chat && <Tag ok>chat</Tag>}
                      {m.chat && (m.tools ? <Tag ok>tools</Tag> : <Tag warn>no tools</Tag>)}
                      {m.vision && <Tag ok>vision</Tag>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.chat && <button className="text-xs text-indigo-600 hover:underline dark:text-indigo-400" disabled={testing} onClick={() => run(`ollama/${m.name}`)}>Test</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {testing && <p className="mt-2 flex items-center gap-1 text-xs text-zinc-500"><Loader2 size={12} className="animate-spin" /> Testing… (the first call loads the model into memory)</p>}
      {test && <p className={`mt-2 break-all text-xs ${test.ok ? "text-emerald-600" : "text-red-600"}`}>{test.text}</p>}

      {models && !chat.length && (
        <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/60">
          {installed.length ? (
            <>Download a chat model: <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">ollama pull llama3.1</code></>
          ) : (
            <>{models.error}. Install Ollama from <a className="text-indigo-600 underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com</a>, then run <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-700">ollama pull llama3.1</code>.</>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Models marked <b>no tools</b> still work, but agents using them can't search the web, use files or run code.
        Get more models with <code>ollama pull &lt;name&gt;</code> (e.g. <code>qwen3</code>, <code>mistral-small</code>), then click refresh in any model picker.
      </p>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-zinc-500">Ollama address</summary>
        <div className="mt-2 flex gap-2">
          <input className="input font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn-primary" disabled={url === p.base_url} onClick={() => onSave({ base_url: url })}>Save</button>
        </div>
      </details>
    </div>
  );
}

function Tag({ children, ok, warn }: { children: React.ReactNode; ok?: boolean; warn?: boolean }) {
  const cls = ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
    : warn ? "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

function ProviderCard({ pid, p, models, onSave }: {
  pid: string; p: Settings["providers"][string]; models?: ProviderModels; onSave: (patch: Record<string, string | null>) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(p.base_url);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const hasKeyField = p.fields.includes("api_key");
  const hasUrlField = p.fields.includes("base_url");
  const connected = models?.live || (models?.configured && !models?.error && pid !== "custom");

  const runTest = async () => {
    const model = models?.models[0];
    if (!model) return setTest({ ok: false, text: "No models found to test." });
    setTesting(true);
    setTest(null);
    const r = await api.testModel(model);
    setTest(r.ok ? { ok: true, text: `${model} replied: “${r.reply}”` } : { ok: false, text: r.error ?? "Failed" });
    setTesting(false);
  };

  return (
    <div className="card p-5">
      <div className="flex items-center gap-3">
        <span className="h-3 w-3 rounded-full" style={{ background: PROVIDER_COLORS[pid] }} />
        <h3 className="flex-1 font-semibold">{p.label}</h3>
        {connected ? (
          <span className="flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={14} /> Connected{models?.live ? ` · ${models.models.length} models` : ""}</span>
        ) : models?.error && models.configured ? (
          <span className="flex items-center gap-1 text-xs font-medium text-red-600" title={models.error}><CircleAlert size={14} /> Can't reach</span>
        ) : (
          <span className="text-xs text-zinc-400">Not connected</span>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          {hasUrlField && (
            <input className="input font-mono text-xs" placeholder="Base URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          )}
          {hasKeyField && (
            <div className="relative">
              <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input type="password" className="input pl-9 font-mono text-xs" value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={p.api_key_set ? `Key saved (${p.api_key_hint}) — paste to replace` : p.env_key ? "Using key from environment variable" : `Paste your ${p.label.split(" ")[0]} API key${pid === "custom" ? " (optional)" : ""}`} />
            </div>
          )}
        </div>
        <div className="flex items-start gap-2">
          <button className="btn-primary" disabled={!key && url === p.base_url}
            onClick={async () => { await onSave({ ...(key ? { api_key: key } : {}), ...(hasUrlField ? { base_url: url } : {}) }); setKey(""); }}>
            Save
          </button>
          <button className="btn-secondary" disabled={testing || !connected} onClick={runTest} title="Send a tiny test message">
            {testing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Test
          </button>
          {p.api_key_set && (
            <button className="btn-ghost px-2 hover:text-red-600" title="Remove key" onClick={() => confirm("Remove this key?") && onSave({ api_key: null })}><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      {test && <p className={`mt-3 break-all text-xs ${test.ok ? "text-emerald-600" : "text-red-600"}`}>{test.text}</p>}
      {KEY_LINKS[pid] && !connected && (
        <a href={KEY_LINKS[pid]} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-indigo-600 hover:underline dark:text-indigo-400">
          {pid === "ollama" ? "Install Ollama →" : "Get an API key →"}
        </a>
      )}
    </div>
  );
}
