"""Starter agents and workflows created on first launch."""
from __future__ import annotations

from . import db

AGENT_TEMPLATES = [
    {
        "name": "Planner", "color": "#8b5cf6", "icon": "list-checks",
        "description": "Breaks a goal into a clear, ordered plan.",
        "system_prompt": "You are a pragmatic planner. Turn the request into a short, numbered plan of concrete "
                         "steps. Call out assumptions and open questions. Be concise.",
        "tools": [], "temperature": 0.3,
    },
    {
        "name": "Researcher", "color": "#0ea5e9", "icon": "search",
        "description": "Searches the web and gathers facts with sources.",
        "system_prompt": "You are a meticulous researcher. Use web search and read pages to gather accurate, "
                         "current facts. Always cite source URLs. Summarise findings as bullet points.",
        "tools": ["web_search", "fetch_url"], "temperature": 0.2,
    },
    {
        "name": "Coder", "color": "#10b981", "icon": "code",
        "description": "Writes and tests code in the shared workspace.",
        "system_prompt": "You are a senior software engineer. Write clean, working code. Save files to the "
                         "workspace. When code execution is available, run it to verify before answering.",
        "tools": ["list_files", "read_file", "write_file", "run_python"], "temperature": 0.2,
    },
    {
        "name": "Writer", "color": "#f59e0b", "icon": "pen-line",
        "description": "Turns notes and research into polished writing.",
        "system_prompt": "You are a skilled writer. Turn the material you are given into clear, well-structured, "
                         "engaging prose in Markdown. Keep facts and sources intact.",
        "tools": [], "temperature": 0.7,
    },
    {
        "name": "Reviewer", "color": "#ef4444", "icon": "shield-check",
        "description": "Critiques work and returns an improved final version.",
        "system_prompt": "You are a demanding reviewer. Check the work for errors, gaps and unclear parts. "
                         "Then output the improved final version, followed by a short list of what you changed.",
        "tools": [], "temperature": 0.3,
    },
    {
        "name": "Manager", "color": "#64748b", "icon": "users",
        "description": "Delegates sub-tasks to teammates and combines the results.",
        "system_prompt": "You are a team lead. Break the request into sub-tasks, delegate each to the best "
                         "teammate with complete instructions, then combine their answers into one result.",
        "tools": ["delegate"], "temperature": 0.3,
    },
]


def _n(nid, ntype, x, y, **data):
    return {"id": nid, "type": ntype, "position": {"x": x, "y": y}, "data": data}


def _e(src, tgt):
    return {"id": f"{src}-{tgt}", "source": src, "target": tgt}


def seed() -> None:
    if db.count_docs("agent") == 0 and not db.get_setting("seeded"):
        ids = {}
        for t in AGENT_TEMPLATES:
            ids[t["name"]] = db.save_doc("agent", {**t, "model": ""})["id"]

        db.save_doc("workflow", {
            "name": "Research report",
            "description": "Research a topic on the web, write it up, then review it.",
            "graph": {
                "nodes": [
                    _n("start", "start", 0, 150),
                    _n("research", "agent", 240, 130, agentId=ids["Researcher"],
                       instructions="Research the topic thoroughly and collect key facts with sources."),
                    _n("write", "agent", 520, 130, agentId=ids["Writer"],
                       instructions="Write a well-structured report from the research."),
                    _n("review", "agent", 800, 130, agentId=ids["Reviewer"]),
                    _n("output", "output", 1080, 150),
                ],
                "edges": [_e("start", "research"), _e("research", "write"), _e("write", "review"), _e("review", "output")],
            },
        })
        db.save_doc("workflow", {
            "name": "Plan, then build in parallel",
            "description": "A planner writes the plan, a researcher and a coder work at the same time, a writer combines it.",
            "graph": {
                "nodes": [
                    _n("start", "start", 0, 200),
                    _n("plan", "agent", 240, 180, agentId=ids["Planner"]),
                    _n("research", "agent", 520, 60, agentId=ids["Researcher"],
                       instructions="Research anything in the plan that needs facts."),
                    _n("code", "agent", 520, 300, agentId=ids["Coder"],
                       instructions="Implement the technical parts of the plan."),
                    _n("write", "agent", 800, 180, agentId=ids["Writer"],
                       instructions="Combine everything into one clear final answer."),
                    _n("output", "output", 1080, 200),
                ],
                "edges": [_e("start", "plan"), _e("plan", "research"), _e("plan", "code"),
                          _e("research", "write"), _e("code", "write"), _e("write", "output")],
            },
        })
        db.save_doc("workflow", {
            "name": "Smart router",
            "description": "A router reads the request and sends it to the right specialist.",
            "graph": {
                "nodes": [
                    _n("start", "start", 0, 200),
                    _n("route", "router", 240, 180, agentId=ids["Planner"],
                       instructions="Send coding tasks to the Coder, factual questions to the Researcher, "
                                    "and writing tasks to the Writer."),
                    _n("code", "agent", 540, 40, agentId=ids["Coder"]),
                    _n("research", "agent", 540, 190, agentId=ids["Researcher"]),
                    _n("write", "agent", 540, 340, agentId=ids["Writer"]),
                    _n("output", "output", 840, 200),
                ],
                "edges": [_e("start", "route"), _e("route", "code"), _e("route", "research"), _e("route", "write"),
                          _e("code", "output"), _e("research", "output"), _e("write", "output")],
            },
        })
        db.set_setting("seeded", True)


def seed_v2() -> None:
    """Example workflow for review loops + approval checkpoints (added for existing installs too)."""
    if db.get_setting("seeded_v2"):
        return
    by_name = {a["name"]: a["id"] for a in db.list_docs("agent")}
    if all(n in by_name for n in ("Researcher", "Writer", "Reviewer")):
        db.save_doc("workflow", {
            "name": "Article with review loop & your approval",
            "description": "Research, check the facts yourself, then the Writer and Reviewer go back and forth until it's good.",
            "graph": {
                "nodes": [
                    _n("start", "start", 0, 160),
                    _n("research", "agent", 230, 140, agentId=by_name["Researcher"],
                       instructions="Research the topic and collect the key facts with sources."),
                    _n("check", "approval", 530, 150,
                       instructions="Check the research before the article gets written. Edit anything that's wrong."),
                    _n("write", "loop", 800, 130, agentId=by_name["Writer"], reviewerId=by_name["Reviewer"],
                       instructions="Write a clear, engaging article from the approved research.",
                       criteria="Accurate to the research, well structured with headings, engaging intro, "
                                "no filler, under 800 words.", maxRounds=3),
                    _n("output", "output", 1120, 160),
                ],
                "edges": [_e("start", "research"), _e("research", "check"), _e("check", "write"), _e("write", "output")],
            },
        })
    db.set_setting("seeded_v2", True)


def seed_v3() -> None:
    """'Website team': a lead that delegates (in parallel) to a designer, a frontend dev and a QA tester."""
    if db.get_setting("seeded_v3"):
        return
    from . import cli_agent
    sub = bool(cli_agent.claude_bin())
    strong = "claude-code/claude-sonnet-5-5" if sub else ""
    fast = "claude-code/claude-haiku-5-5" if sub else ""
    team = {
        "Web Designer": dict(
            model=fast, color="#ec4899", icon="sparkles", tools=["write_file", "edit_file", "read_file", "list_files"], max_steps=15,
            description="Designs the look: colours, fonts, layout, and writes the CSS design system.",
            system_prompt="You are a web designer. Create a clean, modern, accessible design. When asked, write a short "
                          "design spec and a complete CSS file (CSS variables for colours/spacing/fonts, mobile-first, "
                          "responsive). Save files exactly where you're told. Reply with what you created."),
        "Frontend Dev": dict(
            model=strong, color="#10b981", icon="code", tools=["write_file", "edit_file", "read_file", "list_files", "check_website"],
            max_steps=30, temperature=0.2,
            description="Builds websites with semantic HTML, CSS and vanilla JavaScript, and saves the files.",
            system_prompt="You are a senior frontend developer. Build complete, working pages with semantic HTML5, CSS "
                          "and vanilla JavaScript (no build tools, no external CDNs unless asked). Every page needs "
                          "<!DOCTYPE html>, <html lang>, <title> and a viewport meta tag. Use relative paths. Save every "
                          "file with write_file. When done, run check_website on the folder and fix anything it reports. "
                          "Reply with the list of files and what each does."),
        "QA Tester": dict(
            model=fast, color="#ef4444", icon="shield-check", tools=["check_website", "read_file", "list_files"], max_steps=12,
            description="Opens the website and checks it: broken links, missing files, HTML errors, requirements.",
            system_prompt="You are a meticulous QA tester. Run check_website on the site, read the main files, and "
                          "compare them with the requirements you were given. Report: PASS or FAIL, then a numbered "
                          "list of concrete problems (file, what's wrong, how to fix). Don't fix things yourself."),
    }
    ids = {}
    existing = {a["name"]: a for a in db.list_docs("agent")}
    for name, cfg in team.items():
        ids[name] = existing[name]["id"] if name in existing else db.save_doc("agent", {"name": name, **cfg})["id"]
    lead_cfg = dict(
        model=strong, color="#6366f1", icon="users", max_steps=40,
        tools=["delegate", "list_files", "read_file", "check_website"], team=list(ids.values()),
        description="Plans a website project, splits it into tasks and coordinates the web team until it passes QA.",
        system_prompt=(
            "You are the lead of a small web team: Web Designer, Frontend Dev and QA Tester. You do NOT write the site "
            "yourself: you plan, delegate and check.\n\n"
            "Process:\n"
            "1. Decide the folder (e.g. `site/`), the pages and the file names. Write a short plan.\n"
            "2. Use delegate_parallel to give independent work at the same time, e.g. the Web Designer writes "
            "`site/css/style.css` + a design spec while the Frontend Dev builds the HTML structure. Give every teammate "
            "complete instructions: exact file paths, content, class names to use, requirements.\n"
            "3. When the pieces exist, have the Frontend Dev integrate everything and add the JavaScript.\n"
            "4. Ask the QA Tester to check the site against the original requirements.\n"
            "5. If QA reports problems, delegate the fixes and run QA again (max 3 rounds).\n"
            "6. Finish with: the file list, how to open the site (Files → Preview), and anything left to do."),
    )
    if "Web Lead" not in existing:
        lead = db.save_doc("agent", {"name": "Web Lead", **lead_cfg})
    else:
        lead = existing["Web Lead"]

    def n(nid, ntype, x, y, **data):
        return {"id": nid, "type": ntype, "position": {"x": x, "y": y}, "data": data}

    db.save_doc("workflow", {
        "name": "🌐 Website team",
        "description": "Describe a website. The Web Lead plans it and has the Designer, Frontend Dev and QA Tester "
                       "build and test it, partly in parallel. Preview the result under Files.",
        "autonomous": True,
        "graph": {
            "nodes": [
                n("start", "start", 0, 150),
                n("lead", "agent", 260, 130, agentId=lead["id"],
                  instructions="Build the website described in the request with your team, then report back."),
                n("output", "output", 580, 150),
            ],
            "edges": [{"id": "s-l", "source": "start", "target": "lead"}, {"id": "l-o", "source": "lead", "target": "output"}],
        },
    })
    db.set_setting("seeded_v3", True)
