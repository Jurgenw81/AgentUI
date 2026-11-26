import { useEffect, useState } from "react";
import { api } from "./api";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Bot, FolderOpen, History, Home, MessageSquare, Moon, Settings, Sun, Workflow } from "lucide-react";
import HomePage from "./pages/HomePage";
import AgentsPage from "./pages/AgentsPage";
import WorkflowsPage from "./pages/WorkflowsPage";
import WorkflowEditor from "./pages/WorkflowEditor";
import RunsPage from "./pages/RunsPage";
import RunView from "./pages/RunView";
import ChatPage from "./pages/ChatPage";
import FilesPage from "./pages/FilesPage";
import SettingsPage from "./pages/SettingsPage";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/runs", label: "Runs", icon: History },
  { to: "/files", label: "Files", icon: FolderOpen },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    const check = () => api.runs().then((rs) => setWaiting(rs.filter((r) => r.status === "waiting").length)).catch(() => {});
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, []);
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.theme = next ? "dark" : "light";
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Workflow size={18} />
          </div>
          <div>
            <div className="font-semibold leading-tight">AgentUI</div>
            <div className="text-[11px] text-zinc-500">Agent orchestration</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`
              }
            >
              <n.icon size={18} />
              <span className="flex-1">{n.label}</span>
              {n.to === "/runs" && waiting > 0 && (
                <span title={`${waiting} run(s) waiting for your approval`} className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{waiting}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <button onClick={toggleTheme} className="btn-ghost m-3 justify-start">
          {dark ? <Sun size={16} /> : <Moon size={16} />}
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/:id" element={<WorkflowEditor />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:agentId" element={<ChatPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunView />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
