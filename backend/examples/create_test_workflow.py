"""Create the "🧪 Full system test" workflow: one run that exercises every AgentUI feature.

Usage (with AgentUI running):   backend/.venv/bin/python backend/examples/create_test_workflow.py [http://localhost:3000]

Safe to re-run: it updates the test agents / MCP server / workflow instead of duplicating them.
Everything it creates is named "Test …" so it's easy to spot and delete.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000").rstrip("/")
HERE = Path(__file__).resolve().parent
PYTHON = str(Path(sys.executable))  # the backend venv python (has the mcp package)


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} failed: {e.code} {e.read().decode()[:300]}")
    except urllib.error.URLError:
        raise SystemExit(f"Can't reach AgentUI at {BASE}. Start it with ./start.sh first.")


# ---------- pick models from what's actually connected ----------
providers = api("GET", "/api/models")["providers"]


def pick(*candidates):
    for c in candidates:
        prov = c.split("/", 1)[0]
        p = providers.get(prov, {})
        if p.get("configured") and (c in p.get("models", []) or prov == "claude-code"):
            return c
    return ""  # fall back to the default model


CLAUDE_FAST = pick("claude-code/claude-haiku-5-5", "chatgpt/gpt-5.6-luna", "ollama/llama3.1:latest")
CLAUDE_GOOD = pick("claude-code/claude-sonnet-5-5", "chatgpt/gpt-6.2-sol", "ollama/llama3.1:latest")
GPT_FAST = pick("chatgpt/gpt-5.6-luna", "chatgpt/gpt-6-luna", "claude-code/claude-haiku-5-5")
LOCAL = pick("ollama/llama3.1:latest", "ollama/huihui_ai/qwen2.5-abliterate:latest", "claude-code/claude-haiku-5-5")

# ---------- MCP test server ----------
mcp_cfg = {"name": "Test tools", "type": "stdio", "command": PYTHON,
           "args": [str(HERE / "test_mcp_server.py")], "description": "Dice, temperature, clock (for testing)"}
existing = next((s for s in api("GET", "/api/mcp") if s["name"] == "Test tools"), None)
mcp = api("PUT", f"/api/mcp/{existing['id']}", mcp_cfg) if existing else api("POST", "/api/mcp", mcp_cfg)
print(f"MCP server 'Test tools': {mcp['status']} ({len(mcp.get('tools', []))} tools)")
MCP = f"mcp:{mcp['id']}"

# ---------- agents ----------
AGENTS = {
    "Test Planner": dict(model=LOCAL, color="#8b5cf6", icon="list-checks", tools=[],
        description="Turns the request into a short checklist.",
        system_prompt="You are a planner. Turn the request into a short numbered checklist (max 6 items). Be brief."),
    "Test Researcher": dict(model=GPT_FAST, color="#0ea5e9", icon="search", tools=["web_search", "fetch_url"],
        description="Finds facts on the web, with sources.",
        system_prompt="You are a researcher. Use web search to find accurate, current facts. "
                      "Return bullet points, each with its source URL. Keep it short."),
    "Test Toolsmith": dict(model=CLAUDE_FAST, color="#10b981", icon="zap",
        tools=[MCP, "write_file", "read_file", "run_python"],
        description="Uses the test MCP tools, files and Python.",
        system_prompt="You are a tool operator. Do each requested action by CALLING THE TOOLS, one at a time. "
                      "Never invent tool results. Finish with a short list of every tool result."),
    "Test Writer": dict(model=CLAUDE_GOOD, color="#f59e0b", icon="pen-line", tools=[],
        description="Writes clear, structured reports.",
        system_prompt="You are a skilled writer. Write clear, well-structured Markdown. Keep facts and numbers exact."),
    "Test Reviewer": dict(model=GPT_FAST, color="#ef4444", icon="shield-check", tools=[],
        description="Strictly checks work against criteria.",
        system_prompt="You are a strict but fair reviewer."),
    "Test Manager": dict(model=CLAUDE_FAST, color="#64748b", icon="users", tools=["delegate"],
        description="Final sign-off; delegates a fact-check to a teammate.",
        system_prompt="You are the team lead doing the final sign-off. You MUST use the delegate tool once to ask "
                      "Test Researcher to double-check ONE fact from the report. Then output the final report "
                      "with a short 'Sign-off' section at the end saying what was checked and the result."),
}
by_name = {a["name"]: a for a in api("GET", "/api/agents")}
ids = {}
for name, cfg in AGENTS.items():
    body = {"name": name, **cfg}
    a = api("PUT", f"/api/agents/{by_name[name]['id']}", body) if name in by_name else api("POST", "/api/agents", body)
    ids[name] = a["id"]
    print(f"Agent {name:16} → {cfg['model'] or '(default model)'}")


# ---------- workflow ----------
def node(nid, ntype, x, y, **data):
    return {"id": nid, "type": ntype, "position": {"x": x, "y": y}, "data": data}


def edge(a, b):
    return {"id": f"{a}-{b}", "source": a, "target": b}


graph = {
    "nodes": [
        node("start", "start", 0, 250),
        node("plan", "agent", 200, 230, agentId=ids["Test Planner"],
             instructions="Make a checklist of everything the request asks for."),
        node("research", "agent", 480, 90, agentId=ids["Test Researcher"],
             instructions="Do ONLY the web-research parts of the request (find the facts it asks for)."),
        node("tools", "agent", 480, 370, agentId=ids["Test Toolsmith"],
             instructions="Do ONLY the tool parts of the request: roll the dice, convert the temperature and get "
                          "the current time with the Test tools; compute the Python calculation with run_python; "
                          "then write all results to test_results.txt with write_file and read it back."),
        node("approve", "approval", 780, 240,
             instructions="Check the research facts and the tool results look sensible. Edit anything that's wrong."),
        node("route", "router", 1030, 230, agentId=ids["Test Planner"],
             instructions="If the request asks for a DETAILED report, choose the Writer review loop. "
                          "Otherwise choose the quick summary."),
        node("loop", "loop", 1300, 90, agentId=ids["Test Writer"], reviewerId=ids["Test Reviewer"], maxRounds=3,
             instructions="Write the detailed report from the approved material.",
             criteria="Has exactly these 4 sections with ## headings: Facts, Tool results, Python, Summary. "
                      "Every fact has a source URL. The dice rolls, temperature, time and Python result are all "
                      "included with their exact values. Under 400 words."),
        node("quick", "agent", 1300, 400, agentId=ids["Test Writer"], label="Quick summary",
             instructions="Write a 3-sentence summary of the approved material."),
        node("signoff", "agent", 1600, 230, agentId=ids["Test Manager"],
             instructions="Do the final sign-off as described in your role."),
        node("output", "output", 1880, 250),
    ],
    "edges": [
        edge("start", "plan"), edge("plan", "research"), edge("plan", "tools"),
        edge("research", "approve"), edge("tools", "approve"), edge("approve", "route"),
        edge("route", "loop"), edge("route", "quick"),
        edge("loop", "signoff"), edge("quick", "signoff"), edge("signoff", "output"),
    ],
}
WF_NAME = "🧪 Full system test"
wf_body = {"name": WF_NAME, "graph": graph,
           "description": "Exercises everything: Claude + ChatGPT subscriptions and Ollama, parallel steps, "
                          "web search, MCP tools, files, Python sandbox, your approval, a router, a review loop "
                          "and delegation."}
existing_wf = next((w for w in api("GET", "/api/workflows") if w["name"] == WF_NAME), None)
wf = api("PUT", f"/api/workflows/{existing_wf['id']}", wf_body) if existing_wf else api("POST", "/api/workflows", wf_body)

print(f"""
Workflow '{WF_NAME}' is ready → {BASE}/workflows/{wf['id']}

Paste this as the task when you click Run:

  Make a DETAILED report about the planet Mars. Find 3 interesting facts about Mars on the web (with sources).
  Also: roll 2 six-sided dice, convert 25 °C to Fahrenheit and get the current time using the Test tools,
  and compute the sum of the squares of 1..100 with Python. Save all tool results to test_results.txt.
""")
