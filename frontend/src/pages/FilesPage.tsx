import { useEffect, useState } from "react";
import { Download, ExternalLink, Eye, FileCode, FileText, FolderOpen, Globe, Monitor, RefreshCw, Smartphone, Tablet, Trash2, X } from "lucide-react";
import { api, timeAgo, type WorkspaceFile } from "../api";
import { EmptyState, Modal, PageHeader } from "../components/ui";

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const isHtml = (p: string) => /\.html?$/i.test(p);
const previewUrl = (path: string) => `/preview/${path.split("/").map(encodeURIComponent).join("/")}`;

export default function FilesPage() {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [text, setText] = useState<{ path: string; text: string } | null>(null);
  const [site, setSite] = useState<string | null>(null);
  const load = () => api.files().then(setFiles);
  useEffect(() => { load(); }, []);

  const open = async (path: string) => {
    if (isHtml(path)) return setSite(path);
    const res = await fetch(api.fileUrl(path));
    const t = await res.text();
    setText({ path, text: t.length > 200_000 ? t.slice(0, 200_000) + "\n…(truncated)" : t });
  };

  // websites = folders (or root) that contain an index.html
  const sites = (files ?? []).filter((f) => /(^|\/)index\.html?$/i.test(f.path)).map((f) => f.path);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader title="Files" subtitle="The shared workspace. Agents with file tools read and write here, and sandboxed code runs inside it."
        actions={<button className="btn-secondary" onClick={load}><RefreshCw size={15} /> Refresh</button>} />

      {sites.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Websites</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {sites.map((p) => {
              const folder = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "(workspace root)";
              const count = (files ?? []).filter((f) => (p.includes("/") ? f.path.startsWith(folder + "/") : !f.path.includes("/"))).length;
              return (
                <button key={p} onClick={() => setSite(p)} className="card flex items-center gap-3 p-4 text-left transition hover:border-indigo-300 dark:hover:border-indigo-700">
                  <div className="rounded-lg bg-indigo-50 p-2.5 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300"><Globe size={20} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{folder}/</div>
                    <div className="text-xs text-zinc-500">{count} files</div>
                  </div>
                  <span className="btn-primary px-3 py-1.5"><Eye size={14} /> Preview</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {files?.length === 0 ? (
        <EmptyState icon={FolderOpen} title="The workspace is empty" text="Give an agent the 'Write files' tool and ask it to create something, e.g. run the 🌐 Website team workflow." />
      ) : (
        <div className="card divide-y divide-zinc-100 dark:divide-zinc-800">
          {files?.map((f) => (
            <div key={f.path} className="flex items-center gap-3 px-4 py-2.5">
              {isHtml(f.path) ? <Globe size={16} className="text-indigo-500" /> : /\.(css|js|ts|py|json)$/i.test(f.path) ? <FileCode size={16} className="text-zinc-400" /> : <FileText size={16} className="text-zinc-400" />}
              <button className="flex-1 truncate text-left font-mono text-sm hover:text-indigo-600" onClick={() => open(f.path)}>{f.path}</button>
              <span className="text-xs text-zinc-500">{fmtSize(f.size)}</span>
              <span className="w-20 text-right text-xs text-zinc-500">{timeAgo(f.modified)}</span>
              {isHtml(f.path) && <button className="btn-ghost p-1.5 text-indigo-600" title="Preview" onClick={() => setSite(f.path)}><Eye size={14} /></button>}
              <a className="btn-ghost p-1.5" href={api.fileUrl(f.path)} title="Download"><Download size={14} /></a>
              <button className="btn-ghost p-1.5 hover:text-red-600" title="Delete" onClick={async () => { if (confirm(`Delete ${f.path}?`)) { await api.deleteFile(f.path); load(); } }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!text} onClose={() => setText(null)} title={<span className="font-mono text-sm">{text?.path}</span>} wide>
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-xs">{text?.text}</pre>
      </Modal>
      {site && <SitePreview path={site} onClose={() => setSite(null)} />}
    </div>
  );
}

const DEVICES = [
  { id: "desktop", label: "Desktop", icon: Monitor, width: "100%" },
  { id: "tablet", label: "Tablet", icon: Tablet, width: "820px" },
  { id: "phone", label: "Phone", icon: Smartphone, width: "390px" },
] as const;

function SitePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [device, setDevice] = useState<(typeof DEVICES)[number]["id"]>("desktop");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const width = DEVICES.find((d) => d.id === device)!.width;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-900/80 backdrop-blur-sm">
      <div className="flex items-center gap-3 border-b border-zinc-700 bg-zinc-900 px-4 py-2.5 text-zinc-100">
        <Globe size={16} className="text-indigo-400" />
        <span className="truncate font-mono text-sm">{path}</span>
        <div className="mx-auto flex rounded-lg bg-zinc-800 p-0.5">
          {DEVICES.map((d) => (
            <button key={d.id} title={d.label} onClick={() => setDevice(d.id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${device === d.id ? "bg-zinc-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
              <d.icon size={14} /> {d.label}
            </button>
          ))}
        </div>
        <button className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800" title="Reload" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={15} /></button>
        <a className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800" title="Open in a new tab" href={previewUrl(path)} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>
        <button className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800" title="Close (Esc)" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="flex flex-1 justify-center overflow-auto p-4">
        <iframe
          key={nonce}
          title="Website preview"
          src={previewUrl(path)}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className="h-full rounded-lg bg-white shadow-2xl transition-[width]"
          style={{ width, maxWidth: "100%" }}
        />
      </div>
      <p className="bg-zinc-900 py-1 text-center text-[11px] text-zinc-500">The preview runs isolated from AgentUI, so the site's code can't access your settings or data.</p>
    </div>
  );
}
