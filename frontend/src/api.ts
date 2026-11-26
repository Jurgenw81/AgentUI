export type Agent = {
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  tools: string[];
  temperature?: number;
  color?: string;
  icon?: string;
  max_steps?: number;
  team?: string[]; // agent ids this agent may delegate to (empty = everyone)
};

export type NodeData = {
  label?: string;
  agentId?: string;
  instructions?: string;
  reviewerId?: string; // review loop
  criteria?: string; // review loop
  maxRounds?: number; // review loop
  mode?: "ask" | "ai" | "auto"; // approval
  checkerId?: string; // approval (ai mode)
  timeoutMinutes?: number; // approval
  timeoutAction?: "approve" | "reject"; // approval
};
export type NodeType = "start" | "agent" | "router" | "output" | "loop" | "approval";
export type GraphNode = { id: string; type: NodeType; position: { x: number; y: number }; data: NodeData };
export type GraphEdge = { id: string; source: string; target: string };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type Project = { run_id: string | null; chat_agent_id?: string | null; lead: string; status: string; steps_done: number; steps_total: number };
export type Workflow = { id: string; name: string; description?: string; graph: Graph; updated_at?: number; autonomous?: boolean; project?: Project };

export type NodeState = {
  status: "pending" | "running" | "waiting" | "done" | "skipped" | "error" | "stopped";
  output?: string;
  content?: string; // approval: what's waiting for review
  concerns?: string | null; // approval: why the AI checker escalated
  deadline?: number | null; // approval: auto-decision time (epoch s)
  timeout_action?: "approve" | "reject" | null;
  round?: number;
  max_rounds?: number;
  error?: string;
  cost?: number;
  decision?: string;
  reason?: string;
  started_at?: number;
  finished_at?: number;
};

export type Run = {
  id: string;
  title: string;
  input: string;
  output?: string;
  error?: string;
  status: "queued" | "running" | "waiting" | "done" | "error" | "stopped";
  workflow_id?: string | null;
  workflow_name?: string | null;
  agent_id?: string | null;
  autonomous?: boolean;
  project?: boolean; // a task given to a lead agent; its plan is kept as a workflow
  project_workflow_id?: string;
  history?: { role: "user" | "assistant"; content: string }[]; // earlier messages in this project
  created_at: number;
  finished_at?: number;
  cost: number;
  tokens: { input: number; output: number };
  graph?: Graph;
  node_states: Record<string, NodeState>;
};

export type RunEvent = {
  type: string;
  ts: number;
  node?: string;
  agent?: string;
  agent_id?: string;
  scope?: string;
  depth?: number;
  [k: string]: unknown;
};

export type ToolInfo = { id: string; label: string; group: string; description: string; dangerous: boolean };

export type OllamaModel = { name: string; size: string; params: string; family: string; quant: string; chat: boolean; tools: boolean; vision: boolean };

export type ProviderModels = {
  label: string;
  kind: "subscription" | "local" | "api";
  configured: boolean;
  live: boolean;
  error: string | null;
  models: string[];
  info: Record<string, { detail?: string; tools?: boolean }>;
  status?: { installed: boolean; logged_in: boolean; method: string | null; detail: string | null };
  installed?: OllamaModel[];
};

export type ProviderSettings = {
  label: string;
  fields: string[];
  base_url: string;
  api_key_set: boolean;
  api_key_hint: string;
  env_key: boolean;
  kind: "subscription" | "local" | "api";
};

export type Settings = {
  providers: Record<string, ProviderSettings>;
  default_model: string;
  max_cost_per_run: number;
  allow_code_execution: boolean;
  autonomous_default: boolean;
  workspace_dir: string;
};

export type MCPServer = {
  id: string;
  name: string;
  description?: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  oauth?: boolean;
  registry_name?: string;
  prefix?: string;
  status?: "idle" | "connecting" | "needs_login" | "connected" | "error" | "disabled";
  error?: string | null;
  auth_url?: string | null;
  logged_in?: boolean;
  tools?: { name: string; description: string; policy: ToolPolicy; default_policy: ToolPolicy }[];
};

export type ToolPolicy = "allow" | "ai" | "ask" | "block";
export type BuiltinPolicy = { key: string; label: string; group: string; description: string; policy: ToolPolicy; default_policy: ToolPolicy };

export type RegistryInstall =
  | { kind: "remote"; type: "http"; url: string; headers: { name: string; value: string; description: string; required: boolean; secret: boolean }[] }
  | { kind: "npm" | "pypi" | "oci"; type: "stdio"; command: string; args: string[];
      env: { name: string; description: string; required: boolean; secret: boolean; default: string }[] };
export type RegistryServer = {
  name: string; title: string; description: string; version?: string; website?: string; icon?: string | null; installs: RegistryInstall[];
};

export type WorkspaceFile = { path: string; size: number; modified: number };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  agents: () => request<Agent[]>("GET", "/api/agents"),
  createAgent: (a: Partial<Agent>) => request<Agent>("POST", "/api/agents", a),
  updateAgent: (id: string, a: Partial<Agent>) => request<Agent>("PUT", `/api/agents/${id}`, a),
  duplicateAgent: (id: string) => request<Agent>("POST", `/api/agents/${id}/duplicate`),
  deleteAgent: (id: string) => request("DELETE", `/api/agents/${id}`),

  workflows: () => request<Workflow[]>("GET", "/api/workflows"),
  workflow: (id: string) => request<Workflow>("GET", `/api/workflows/${id}`),
  createWorkflow: (w: Partial<Workflow>) => request<Workflow>("POST", "/api/workflows", w),
  updateWorkflow: (id: string, w: Partial<Workflow>) => request<Workflow>("PUT", `/api/workflows/${id}`, w),
  duplicateWorkflow: (id: string) => request<Workflow>("POST", `/api/workflows/${id}/duplicate`),
  deleteWorkflow: (id: string) => request("DELETE", `/api/workflows/${id}`),

  runs: () => request<Run[]>("GET", "/api/runs"),
  run: (id: string) => request<{ run: Run; events: RunEvent[] }>("GET", `/api/runs/${id}`),
  startRun: (body: { workflow_id?: string; agent_id?: string; input: string; graph?: Graph; autonomous?: boolean; continue_run?: string }) =>
    request<Run>("POST", "/api/runs", body),
  stopRun: (id: string) => request("POST", `/api/runs/${id}/stop`),
  deleteRun: (id: string) => request("DELETE", `/api/runs/${id}`),
  decideApproval: (runId: string, nodeId: string, body: { approved: boolean; content?: string; note?: string }) =>
    request("POST", `/api/runs/${runId}/approvals/${nodeId}`, body),

  mcpServers: () => request<MCPServer[]>("GET", "/api/mcp"),
  createMcp: (s: Partial<MCPServer>) => request<MCPServer>("POST", "/api/mcp", s),
  updateMcp: (id: string, s: Partial<MCPServer>) => request<MCPServer>("PUT", `/api/mcp/${id}`, s),
  reconnectMcp: (id: string) => request<MCPServer>("POST", `/api/mcp/${id}/reconnect`),
  deleteMcp: (id: string) => request("DELETE", `/api/mcp/${id}`),
  logoutMcp: (id: string) => request<MCPServer>("POST", `/api/mcp/${id}/logout`),
  searchRegistry: (q: string, cursor?: string) =>
    request<{ servers: RegistryServer[]; next?: string | null }>("GET", `/api/mcp/registry?q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  toolPolicies: () => request<BuiltinPolicy[]>("GET", "/api/tool-policies"),
  setToolPolicies: (changes: Record<string, ToolPolicy | null>) => request("PUT", "/api/tool-policies", changes),

  models: () => request<{ providers: Record<string, ProviderModels>; default_model: string }>("GET", "/api/models"),
  tools: () => request<ToolInfo[]>("GET", "/api/tools"),
  settings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (s: Record<string, unknown>) => request<Settings>("PUT", "/api/settings", s),
  refreshClaudeCode: () => request("POST", "/api/claude-code/refresh"),
  testModel: (model: string) => request<{ ok: boolean; reply?: string; error?: string }>("POST", "/api/test-model", { model }),

  files: () => request<WorkspaceFile[]>("GET", "/api/workspace"),
  deleteFile: (path: string) => request("DELETE", `/api/workspace/file?path=${encodeURIComponent(path)}`),
  fileUrl: (path: string) => `/api/workspace/file?path=${encodeURIComponent(path)}`,
};

export function wsUrl(path: string) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

export function modelLabel(model?: string) {
  if (!model) return "Default model";
  const [provider, ...rest] = model.split("/");
  const name = rest.join("/") || provider;
  const m = name.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  const pretty = m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : name.replace(/:latest$/, "");
  return ["claude-code", "chatgpt", "gemini-cli"].includes(provider) ? `${pretty} · subscription` : pretty;
}

export function providerOf(model?: string) {
  return model?.split("/")[0] ?? "";
}

export function fmtCost(c?: number) {
  if (!c) return "$0";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function fmtTokens(n?: number) {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function timeAgo(ts: number) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
