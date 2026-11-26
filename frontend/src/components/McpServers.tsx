import { useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, KeyRound, Library, Loader2, LogIn, LogOut, Pencil, Plug, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { api, type BuiltinPolicy, type MCPServer, type RegistryInstall, type RegistryServer, type ToolPolicy } from "../api";
import { Modal, useToast } from "./ui";

type Field = { name: string; description: string; required: boolean; secret: boolean };
type Draft = {
  name: string; type: "stdio" | "http"; command: string; args: string; env: string; url: string; headers: string;
  description?: string; registry_name?: string; hint?: string; fields?: Field[]; link?: string;
};

const HUBS: Draft[] = [
  { name: "Zapier", type: "http", command: "", args: "", env: "", url: "", headers: "", link: "https://zapier.com/mcp",
    description: "8,000+ apps: Gmail, Slack, Sheets, Notion, HubSpot…",
    hint: "In Zapier, create an MCP server, pick the actions you want (e.g. Gmail: send email), and paste the server URL it gives you here." },
  { name: "Composio", type: "http", command: "", args: "", env: "", url: "", headers: "", link: "https://composio.dev",
    description: "Hundreds of apps behind one MCP endpoint",
    hint: "In Composio, connect your accounts and create an MCP server. Paste its URL here (and an API-key header if it shows one)." },
  { name: "Pipedream", type: "http", command: "", args: "", env: "", url: "", headers: "", link: "https://pipedream.com",
    description: "Thousands of APIs with built-in account connections",
    hint: "In Pipedream, set up MCP for the apps you want and paste the server URL here." },
];

const PRESETS: Draft[] = [
  { name: "Filesystem", type: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-filesystem /home/YOU/Documents", env: "", url: "", headers: "",
    hint: "Read & write files in the folders you list (replace the path).", description: "Files on this computer" },
  { name: "Memory", type: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-memory", env: "", url: "", headers: "",
    hint: "A knowledge graph agents can remember facts in, across runs.", description: "Long-term memory" },
  { name: "Browser (Playwright)", type: "stdio", command: "npx", args: "@playwright/mcp@latest", env: "", url: "", headers: "",
    hint: "Lets agents drive a real browser: click, type, screenshot.", description: "Browser automation" },
  { name: "GitHub", type: "http", command: "", args: "", env: "", url: "https://api.githubcopilot.com/mcp/", headers: "Authorization: Bearer YOUR_GITHUB_TOKEN",
    hint: "Issues, pull requests and code. Needs a GitHub personal access token.", description: "GitHub repos, issues, PRs" },
];

const EMPTY: Draft = { name: "", type: "stdio", command: "", args: "", env: "", url: "", headers: "" };

const toLines = (o?: Record<string, string>, sep = "=") => Object.entries(o ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");
const fromLines = (text: string, sep: string) =>
  Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l.includes(sep) && !l.startsWith("#")).map((l) => {
    const i = l.indexOf(sep);
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
const quoteArg = (a: string) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export const POLICY_INFO: Record<ToolPolicy, { label: string; cls: string; desc: string }> = {
  allow: { label: "Allow", cls: "text-emerald-700 dark:text-emerald-400", desc: "Runs without asking" },
  ai: { label: "AI check", cls: "text-indigo-700 dark:text-indigo-300", desc: "An AI checks each call; asks you only if it looks wrong" },
  ask: { label: "Ask me", cls: "text-amber-700 dark:text-amber-400", desc: "Pauses for your OK (in autonomous runs, the AI checks instead)" },
  block: { label: "Block", cls: "text-red-700 dark:text-red-400", desc: "Never allowed" },
};

export function PolicySelect({ value, def, onChange }: { value: ToolPolicy; def: ToolPolicy; onChange: (p: ToolPolicy | null) => void }) {
  return (
    <select
      title={POLICY_INFO[value].desc}
      className={`rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-900 ${POLICY_INFO[value].cls}`}
      value={value}
      onChange={(e) => onChange(e.target.value === def ? null : (e.target.value as ToolPolicy))}
    >
      {(Object.keys(POLICY_INFO) as ToolPolicy[]).map((p) => (
        <option key={p} value={p}>{POLICY_INFO[p].label}{p === def ? " (default)" : ""}</option>
      ))}
    </select>
  );
}

function fromRegistry(s: RegistryServer, inst: RegistryInstall): Draft {
  const base = { name: s.title, description: s.description.slice(0, 140), registry_name: s.name, link: s.website ?? undefined };
  if (inst.kind === "remote") {
    return {
      ...base, type: "http", command: "", args: "", env: "", url: inst.url,
      headers: inst.headers.map((h) => `${h.name}: ${h.value || `<${h.description || "value"}>`}`).join("\n"),
      fields: inst.headers.map((h) => ({ name: h.name, description: h.description, required: h.required, secret: h.secret })),
      hint: inst.headers.length ? "Fill in the header value(s) below, then save." : "If this server needs an account, you'll get a Log in button after saving.",
    };
  }
  return {
    ...base, type: "stdio", command: inst.command, args: inst.args.map(quoteArg).join(" "), url: "", headers: "",
    env: inst.env.map((e) => `${e.name}=${e.default ?? ""}`).join("\n"),
    fields: inst.env.map((e) => ({ name: e.name, description: e.description, required: e.required, secret: e.secret })),
    hint: `Installs from ${inst.kind === "oci" ? "Docker Hub" : inst.kind === "pypi" ? "PyPI (needs uv)" : "npm (needs Node.js)"} the first time it starts.`,
  };
}

export function McpServers() {
  const [servers, setServers] = useState<MCPServer[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toast = useToast();

  const load = () => api.mcpServers().then(setServers).catch(() => setServers([]));
  useEffect(() => { load(); }, []);
  // keep polling while a server waits for login or is connecting
  const pending = servers?.some((s) => s.status === "needs_login" || s.status === "connecting");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [pending]);

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    const body = {
      name: d.name, description: d.description, type: d.type, registry_name: d.registry_name,
      command: d.command, args: d.args as unknown as string[], env: fromLines(d.env, "="),
      url: d.url, headers: fromLines(d.headers, ":"),
    };
    setBusy("save");
    try {
      const s = editing.id ? await api.updateMcp(editing.id, body) : await api.createMcp(body);
      if (s.status === "needs_login") toast(`${s.name}: click "Log in" to connect your account`);
      else toast(s.status === "connected" ? `${s.name}: connected, ${s.tools?.length ?? 0} tools` : `${s.name} saved, but couldn't connect`, s.status === "connected" ? "ok" : "error");
      setEditing(null);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); } catch (e) { toast((e as Error).message, "error"); }
    setBusy(null);
    load();
  };

  const setPolicy = async (key: string, p: ToolPolicy | null) => {
    await api.setToolPolicies({ [key]: p });
    load();
  };

  const set = (patch: Partial<Draft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const missing = (d: Draft) => (d.fields ?? []).filter((f) => f.required).filter((f) => {
    const text = d.type === "http" ? d.headers : d.env;
    const sep = d.type === "http" ? ":" : "=";
    const v = fromLines(text, sep)[f.name];
    return !v || v.startsWith("<") || /YOUR_|\{[a-z_]+\}/i.test(v);
  });

  return (
    <div id="mcp" className="scroll-mt-6">
      <div className="mb-3 mt-10 flex items-end justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">Tool servers (MCP)</h2>
          <p className="text-sm text-zinc-500">Connect email, Slack, GitHub, databases and thousands more. Then switch them on per agent under <b>Agents → Tools</b>.</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button className="btn-primary" onClick={() => setCatalogOpen(true)}><Library size={15} /> Browse catalog</button>
          <button className="btn-secondary" onClick={() => setEditing({ draft: { ...EMPTY } })}><Plus size={15} /> Add manually</button>
        </div>
      </div>

      <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
        {servers?.length === 0 && (
          <div className="p-5 text-sm text-zinc-500">
            No tool servers yet. Click <b>Browse catalog</b> to find one, or use a hub like Zapier to connect thousands of apps at once.
          </div>
        )}
        {servers?.map((s) => {
          const ok = s.status === "connected";
          const login = s.status === "needs_login";
          const risky = s.tools?.filter((t) => t.policy !== "allow").length ?? 0;
          return (
            <div key={s.id} className="px-5 py-4">
              <div className="flex items-center gap-3">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ok ? "bg-emerald-500" : login ? "bg-amber-500" : s.status === "error" ? "bg-red-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {s.name}
                    <span className="rounded bg-zinc-100 px-1.5 text-[10px] font-semibold uppercase text-zinc-500 dark:bg-zinc-800">{s.type === "http" ? "remote" : "local"}</span>
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-500">{s.type === "http" ? s.url : [s.command, ...(s.args ?? [])].join(" ")}</div>
                </div>
                {login ? (
                  <a href={s.auth_url ?? "#"} target="_blank" rel="noreferrer" className="btn-primary bg-amber-600 px-3 py-1.5 hover:bg-amber-500">
                    <LogIn size={14} /> Log in
                  </a>
                ) : (
                  <span className={`text-xs ${ok ? "text-emerald-600" : s.status === "error" ? "text-red-600" : "text-zinc-500"}`}>
                    {ok ? `${s.tools?.length ?? 0} tools${risky ? ` · ${risky} guarded` : ""}` : s.status === "disabled" ? "disabled" : s.status === "error" ? "can't connect" : s.status === "connecting" ? "connecting…" : "not connected yet"}
                  </span>
                )}
                {s.logged_in && !login && (
                  <button className="btn-ghost p-1.5" title="Log out (forget the saved login)" onClick={() => confirm(`Log out of ${s.name}?`) && act(s.id, () => api.logoutMcp(s.id))}>
                    <LogOut size={14} />
                  </button>
                )}
                <button className="btn-ghost p-1.5" title="Reconnect" disabled={busy === s.id} onClick={() => act(s.id, () => api.reconnectMcp(s.id))}>
                  {busy === s.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                </button>
                <button className="btn-ghost p-1.5" title="Edit" onClick={() => setEditing({ id: s.id, draft: {
                  name: s.name, description: s.description, type: s.type, command: s.command ?? "", args: (s.args ?? []).map(quoteArg).join(" "),
                  env: toLines(s.env), url: s.url ?? "", headers: toLines(s.headers, ": "), registry_name: s.registry_name,
                } })}><Pencil size={14} /></button>
                <button className="btn-ghost p-1.5 hover:text-red-600" title="Remove"
                  onClick={() => confirm(`Remove "${s.name}"? Agents using it will lose these tools.`) && act(s.id, () => api.deleteMcp(s.id))}>
                  <Trash2 size={14} />
                </button>
              </div>
              {login && <p className="ml-5 mt-2 text-xs text-amber-700 dark:text-amber-400">This server needs you to sign in. Click <b>Log in</b>, approve access in the new tab, and it connects automatically.</p>}
              {s.error && s.status === "error" && <p className="ml-5 mt-2 break-all text-xs text-red-600">{s.error}</p>}
              {ok && !!s.tools?.length && (
                <div className="ml-5 mt-2">
                  <button className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => setExpanded((x) => ({ ...x, [s.id]: !x[s.id] }))}>
                    <ChevronRight size={12} className={`transition ${expanded[s.id] ? "rotate-90" : ""}`} /> Tools & safety rules
                  </button>
                  {expanded[s.id] && (
                    <ul className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                      {s.tools.map((t) => (
                        <li key={t.name} className="flex items-start gap-3 px-3 py-1.5 text-xs">
                          <div className="min-w-0 flex-1">
                            <code className="text-indigo-700 dark:text-indigo-300">{t.name}</code>{" "}
                            <span className="text-zinc-500">{t.description.split("\n")[0].slice(0, 120)}</span>
                          </div>
                          <PolicySelect value={t.policy} def={t.default_policy} onChange={(p) => setPolicy(`mcp:${s.id}:${t.name}`, p)} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <BuiltinSafety />

      <Catalog open={catalogOpen} onClose={() => setCatalogOpen(false)} onPick={(d) => { setCatalogOpen(false); setEditing({ draft: d }); }} />

      <Modal open={!!editing} onClose={() => setEditing(null)} wide
        title={<span className="flex items-center gap-2"><Plug size={16} /> {editing?.id ? "Edit tool server" : "Add a tool server"}</span>}
        footer={<>
          {editing && missing(editing.draft).length > 0 && (
            <span className="mr-auto self-center text-xs text-amber-700 dark:text-amber-400">Still needed: {missing(editing.draft).map((f) => f.name).join(", ")}</span>
          )}
          <button className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn-primary" disabled={busy === "save" || !editing?.draft.name.trim()} onClick={save}>
            {busy === "save" ? <><Loader2 size={14} className="animate-spin" /> Connecting…</> : "Save & connect"}
          </button>
        </>}>
        {editing && (
          <div className="space-y-4">
            {!editing.id && !editing.draft.registry_name && !editing.draft.link && (
              <div>
                <label className="label">Quick presets</label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button key={p.name} title={p.hint} onClick={() => setEditing({ draft: { ...p } })}
                      className={`rounded-full border px-2.5 py-1 text-xs ${editing.draft.name === p.name ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" : "border-zinc-300 dark:border-zinc-700"}`}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(editing.draft.hint || editing.draft.link) && (
              <div className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900 dark:bg-indigo-500/10 dark:text-indigo-200">
                {editing.draft.hint}
                {editing.draft.link && <> <a href={editing.draft.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline">Open <ExternalLink size={12} /></a></>}
              </div>
            )}
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div>
                <label className="label">Name</label>
                <input className="input" value={editing.draft.name} placeholder="e.g. Gmail" onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div>
                <label className="label">Connection</label>
                <div className="flex rounded-lg border border-zinc-300 p-0.5 dark:border-zinc-700">
                  {(["stdio", "http"] as const).map((t) => (
                    <button key={t} onClick={() => set({ type: t })}
                      className={`rounded-md px-3 py-1.5 text-sm ${editing.draft.type === t ? "bg-indigo-600 text-white" : "text-zinc-600 dark:text-zinc-300"}`}>
                      {t === "stdio" ? "Local command" : "Remote URL"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {editing.draft.type === "stdio" ? (
              <>
                <div className="grid grid-cols-[160px_1fr] gap-3">
                  <div>
                    <label className="label">Command</label>
                    <input className="input font-mono text-xs" value={editing.draft.command} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Arguments</label>
                    <input className="input font-mono text-xs" value={editing.draft.args} placeholder="-y @some/mcp-server --flag" onChange={(e) => set({ args: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="label">Environment variables</label>
                  <textarea className="input font-mono text-xs" rows={Math.max(3, (editing.draft.fields?.length ?? 0) + 1)} value={editing.draft.env}
                    placeholder={"API_TOKEN=abc123\nOTHER=value"} onChange={(e) => set({ env: e.target.value })} />
                  <FieldHelp fields={editing.draft.fields} />
                </div>
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  This command runs on your computer with your user's permissions, so only add servers you trust.
                </p>
              </>
            ) : (
              <>
                <div>
                  <label className="label">Server URL</label>
                  <input className="input font-mono text-xs" value={editing.draft.url} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
                </div>
                <div>
                  <label className="label">Headers (optional)</label>
                  <textarea className="input font-mono text-xs" rows={3} value={editing.draft.headers} placeholder="Authorization: Bearer YOUR_TOKEN" onChange={(e) => set({ headers: e.target.value })} />
                  <FieldHelp fields={editing.draft.fields} />
                  <p className="hint flex items-center gap-1"><KeyRound size={12} /> No token? Leave this empty. If the server needs an account, you'll get a <b>Log in</b> button after saving.</p>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function FieldHelp({ fields }: { fields?: Field[] }) {
  if (!fields?.length) return <p className="hint">One per line.</p>;
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-500">
      {fields.map((f) => (
        <li key={f.name}>
          <code className="text-zinc-700 dark:text-zinc-300">{f.name}</code>
          {f.required && <span className="ml-1 text-amber-600">required</span>}
          {f.secret && <span className="ml-1 text-zinc-400">secret</span>}
          {f.description && <span>: {f.description}</span>}
        </li>
      ))}
    </ul>
  );
}

function Catalog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (d: Draft) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RegistryServer[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const search = async (query: string, cursor?: string) => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.searchRegistry(query, cursor);
      if (my !== seq.current) return;
      setResults((prev) => (cursor && prev ? [...prev, ...r.servers] : r.servers));
      setNext(r.next ?? null);
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(q), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, open]);

  return (
    <Modal open={open} onClose={onClose} wide title={<span className="flex items-center gap-2"><Library size={16} /> Tool server catalog</span>}>
      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input autoFocus className="input pl-9" placeholder="Search: gmail, slack, notion, postgres, calendar…" value={q} onChange={(e) => setQ(e.target.value)} />
        {loading && <Loader2 size={15} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-zinc-400" />}
      </div>

      {!q && (
        <div className="mb-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Connect many apps at once</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {HUBS.map((h) => (
              <button key={h.name} onClick={() => onPick({ ...h })} className="rounded-lg border border-zinc-200 p-3 text-left transition hover:border-indigo-300 dark:border-zinc-700 dark:hover:border-indigo-700">
                <div className="text-sm font-semibold">{h.name}</div>
                <div className="text-xs text-zinc-500">{h.description}</div>
              </button>
            ))}
          </div>
          <div className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-zinc-500">From the official MCP registry</div>
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
      {results?.length === 0 && !loading && <p className="py-6 text-center text-sm text-zinc-500">Nothing found. Try another word, or use a hub like Zapier.</p>}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {results?.map((s) => (
          <div key={s.name} className="flex items-start gap-3 py-3">
            {s.icon ? <img src={s.icon} alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-md object-contain" />
              : <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-400 dark:bg-zinc-800"><Plug size={15} /></div>}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{s.title}</span>
                {s.website && <a href={s.website} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-700" title="Website / source"><ExternalLink size={12} /></a>}
              </div>
              <div className="line-clamp-2 text-xs text-zinc-500">{s.description}</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">{s.name}</div>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              {s.installs.map((inst, i) => (
                <button key={i} className="btn-secondary px-2.5 py-1 text-xs" onClick={() => onPick(fromRegistry(s, inst))}>
                  <Plus size={12} /> {inst.kind === "remote" ? "Remote" : inst.kind === "oci" ? "Docker" : inst.kind}
                  {(inst.kind === "remote" ? inst.headers.some((h) => h.required) : inst.env.some((e) => e.required)) && <KeyRound size={11} className="text-amber-600" />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {next && <button className="btn-ghost mt-2 w-full" disabled={loading} onClick={() => search(q, next)}>Load more</button>}
      <p className="mt-4 text-xs text-zinc-500">
        Servers in the registry are published by their authors and aren't reviewed by AgentUI. Prefer ones from the service's own company, and check the source link.
      </p>
    </Modal>
  );
}

function BuiltinSafety() {
  const [rows, setRows] = useState<BuiltinPolicy[] | null>(null);
  const load = () => api.toolPolicies().then((r) => setRows(r.filter((x) => !x.key.startsWith("mcp:"))));
  useEffect(() => { load(); }, []);
  return (
    <details className="card mt-3 px-5 py-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <ShieldCheck size={15} className="text-emerald-600" /> Safety rules for built-in tools
        <span className="ml-auto text-xs font-normal text-zinc-500">Allow · AI check · Ask me · Block</span>
      </summary>
      <p className="mt-2 text-xs text-zinc-500">
        Every tool call goes through its rule. <b>Ask me</b> pauses the run for your OK. In an <b>autonomous</b> run an AI checks it instead, and if the AI says no, the agent is told and carries on without it.
        MCP tools that send, create, delete or pay default to <b>Ask me</b>; change them under each server's "Tools & safety rules".
      </p>
      <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows?.map((r) => (
          <li key={r.key} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="w-36 shrink-0 font-medium">{r.label}</span>
            <span className="flex-1 truncate text-xs text-zinc-500">{r.description}</span>
            <PolicySelect value={r.policy} def={r.default_policy} onChange={async (p) => { await api.setToolPolicies({ [r.key]: p }); load(); }} />
          </li>
        ))}
      </ul>
    </details>
  );
}
