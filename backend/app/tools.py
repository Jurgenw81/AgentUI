"""Tools that agents can be given. Each tool = JSON schema + async implementation."""
from __future__ import annotations

import asyncio
import json
import re
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from bs4 import BeautifulSoup

from . import db

MAX_OUTPUT = 12_000  # chars returned to the model per tool call
SANDBOX_IMAGE = "python:3.12-slim"


def _clip(text: str) -> str:
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + f"\n...[truncated {len(text) - MAX_OUTPUT} chars]"


def _safe_path(rel: str) -> Path:
    root = db.WORKSPACE_DIR.resolve()
    p = (root / (rel or ".").lstrip("/")).resolve()
    if p != root and root not in p.parents:
        raise ValueError("Path escapes the workspace folder")
    return p


# ---------- implementations ----------

SEARCH_BACKENDS = ("auto", "bing", "brave", "duckduckgo", "mojeek", "yahoo")


async def web_search(query: str, max_results: int = 6) -> str:
    """Free search via ddgs. Individual engines often block automated queries, so try several."""
    def _search():
        from ddgs import DDGS
        n = max(1, min(int(max_results), 10))
        errors = []
        for backend in SEARCH_BACKENDS:
            try:
                found = list(DDGS().text(query, max_results=n, backend=backend))
                if found:
                    return found, None
            except Exception as e:  # noqa: BLE001
                errors.append(f"{backend}: {e}")
        return [], "; ".join(errors)[:300]
    results, err = await asyncio.to_thread(_search)
    if not results:
        return f"No results (all search engines failed or blocked the request: {err}). Try different keywords."
    return "\n\n".join(f"{i+1}. {r.get('title')}\n{r.get('href')}\n{r.get('body')}" for i, r in enumerate(results))


async def fetch_url(url: str) -> str:
    async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                 headers={"User-Agent": "Mozilla/5.0 (AgentUI)"}) as c:
        r = await c.get(url)
    ctype = r.headers.get("content-type", "")
    if "html" in ctype:
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "svg"]):
            tag.decompose()
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        text = "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())
        return _clip(f"[{r.status_code}] {title}\n\n{text}")
    return _clip(f"[{r.status_code}] {r.text}")


async def http_request(method: str, url: str, headers: dict | None = None, body: Any = None) -> str:
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
        kwargs: dict[str, Any] = {"headers": headers or {}}
        if body is not None:
            if isinstance(body, (dict, list)):
                kwargs["json"] = body
            else:
                kwargs["content"] = str(body)
        r = await c.request(method.upper(), url, **kwargs)
    return _clip(f"HTTP {r.status_code}\n{r.text}")


async def list_files(path: str = ".") -> str:
    p = _safe_path(path)
    if not p.exists():
        return "Folder does not exist."
    entries = []
    for child in sorted(p.rglob("*"))[:300]:
        rel = child.relative_to(db.WORKSPACE_DIR.resolve())
        entries.append(f"{rel}/" if child.is_dir() else f"{rel}  ({child.stat().st_size} bytes)")
    return "\n".join(entries) or "(empty)"


READ_LIMIT = 60_000


async def read_file(path: str, start_line: int = 1, max_lines: int = 0) -> str:
    p = _safe_path(path)
    if not p.is_file():
        return f"File not found: {path}"
    text = p.read_text(errors="replace")
    lines = text.splitlines(keepends=True)
    start = max(1, int(start_line or 1))
    chunk = lines[start - 1:start - 1 + int(max_lines)] if max_lines else lines[start - 1:]
    out = "".join(chunk)
    if len(out) > READ_LIMIT:
        shown = out[:READ_LIMIT]
        last = start + shown.count("\n")
        return (shown + f"\n…[file continues: {len(lines)} lines total. Read more with start_line={last}. "
                f"To change part of a big file, use edit_file instead of rewriting it.]")
    if start > 1 or max_lines:
        out = f"[lines {start}–{start + len(chunk) - 1} of {len(lines)}]\n" + out
    return out


async def edit_file(path: str, old_text: str, new_text: str) -> str:
    """Replace one exact occurrence of old_text. Safer than rewriting whole files."""
    p = _safe_path(path)
    if not p.is_file():
        return f"File not found: {path}. Use write_file to create it."
    text = p.read_text(errors="replace")
    count = text.count(old_text) if old_text else 0
    if count == 0:
        return ("old_text was not found in the file (it must match exactly, including spaces and line breaks). "
                "Read the file again and copy the exact text.")
    if count > 1:
        return f"old_text appears {count} times. Include more surrounding text so it matches exactly once."
    updated = text.replace(old_text, new_text, 1)
    p.write_text(updated)
    msg = f"Edited {path}: replaced {len(old_text)} chars with {len(new_text)} chars."
    problem = check_file(path, updated)
    if problem:
        msg += f"\n⚠ WARNING: the file is now NOT valid ({problem}). Fix it before reporting success."
    return msg


def check_file(path: str, content: str) -> str | None:
    """Quick validity check for common code/data files. Returns a problem description, or None if fine.
    Catches truncated or garbled tool arguments (common with small local models) before the agent claims success."""
    suffix = Path(path).suffix.lower()
    if not content.strip():
        return "the file is empty"
    try:
        if suffix == ".py":
            compile(content, path, "exec")
        elif suffix == ".json":
            json.loads(content)
        elif suffix in (".yaml", ".yml"):
            try:
                import yaml  # optional
                yaml.safe_load(content)
            except ImportError:
                pass
        elif suffix in (".js", ".ts", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".css", ".jsx", ".tsx"):
            pairs = {"(": ")", "[": "]", "{": "}"}
            for o, c in pairs.items():
                if content.count(o) != content.count(c):
                    return f"unbalanced brackets: {content.count(o)} '{o}' but {content.count(c)} '{c}'. The code looks cut off or incomplete"
    except SyntaxError as e:
        return f"Python syntax error on line {e.lineno}: {e.msg}"
    except json.JSONDecodeError as e:
        return f"invalid JSON at line {e.lineno}: {e.msg}"
    except Exception as e:  # noqa: BLE001
        return f"{type(e).__name__}: {e}"
    return None


async def write_file(path: str, content: str) -> str:
    p = _safe_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    msg = f"Wrote {len(content)} chars to {path}"
    problem = check_file(path, content)
    if problem:
        preview = content if len(content) <= 300 else content[:300] + "…"
        msg += (f"\n\n⚠ WARNING: the saved file is NOT valid ({problem}). This is what was saved:\n{preview}\n\n"
                "It was probably cut off. Write the file again with the complete, correct content "
                "(make sure quotes inside the content are escaped as \\\" in the JSON arguments). "
                "Do not tell the user it worked until the file is valid.")
    return msg


async def _docker(cmd: list[str], timeout: int = 60) -> str:
    if not db.get_setting("allow_code_execution", False):
        return "Code execution is disabled. The user can enable it in Settings."
    if not shutil.which("docker"):
        return "Docker is not installed, so code cannot be run safely."
    full = [
        "docker", "run", "--rm", "-i", "--network", "none",
        "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
        "-v", f"{db.WORKSPACE_DIR.resolve()}:/workspace", "-w", "/workspace",
        SANDBOX_IMAGE, *cmd,
    ]
    proc = await asyncio.create_subprocess_exec(
        *full, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return f"Timed out after {timeout}s"
    return _clip(f"exit code {proc.returncode}\n{out.decode(errors='replace')}")


async def run_python(code: str) -> str:
    return await _docker(["python", "-c", code])


async def run_shell(command: str) -> str:
    return await _docker(["sh", "-c", command])


# ---------- website checker (for QA agents) ----------

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"}


def _is_local(ref: str) -> bool:
    ref = ref.strip()
    return bool(ref) and not re.match(r"^(https?:|//|mailto:|tel:|data:|javascript:|#|\{\{)", ref, re.I)


def _resolve(base: Path, ref: str) -> Path:
    ref = ref.split("#", 1)[0].split("?", 1)[0]
    root = db.WORKSPACE_DIR.resolve()
    target = (root / ref.lstrip("/")) if ref.startswith("/") else (base / ref)
    return target.resolve()


async def check_website(path: str = ".") -> str:
    """Open a website in the workspace and report concrete problems."""
    from html.parser import HTMLParser

    start = _safe_path(path)
    if start.is_dir():
        start = start / "index.html"
    if not start.is_file():
        return f"No HTML file at {path} (looked for {start.relative_to(db.WORKSPACE_DIR.resolve())})."
    root = db.WORKSPACE_DIR.resolve()
    rel = lambda p: str(p.relative_to(root)) if root in p.parents or p == root else str(p)  # noqa: E731

    problems: list[str] = []
    checked_pages: list[str] = []
    checked_assets: set[str] = set()
    queue, seen = [start.resolve()], set()

    class Parser(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.stack: list[tuple[str, int]] = []
            self.refs: list[tuple[str, str, int]] = []  # (kind, ref, line)
            self.ids: dict[str, int] = {}
            self.issues: list[str] = []
            self.meta_viewport = self.title = self.html_lang = False

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            line = self.getpos()[0]
            if tag == "html" and a.get("lang"):
                self.html_lang = True
            if tag == "title":
                self.title = True
            if tag == "meta" and (a.get("name") or "").lower() == "viewport":
                self.meta_viewport = True
            if a.get("id"):
                if a["id"] in self.ids:
                    self.issues.append(f"line {line}: duplicate id=\"{a['id']}\" (first on line {self.ids[a['id']]})")
                self.ids.setdefault(a["id"], line)
            if tag == "img":
                if a.get("alt") is None:
                    self.issues.append(f"line {line}: <img> without alt text")
                if a.get("src"):
                    self.refs.append(("image", a["src"], line))
            if tag == "link" and a.get("href") and "stylesheet" in (a.get("rel") or "").lower():
                self.refs.append(("css", a["href"], line))
            if tag == "script" and a.get("src"):
                self.refs.append(("js", a["src"], line))
            if tag == "a" and a.get("href"):
                self.refs.append(("link", a["href"], line))
            if tag in ("source", "video", "audio", "iframe") and a.get("src"):
                self.refs.append(("media", a["src"], line))
            if tag not in VOID_TAGS:
                self.stack.append((tag, line))

        def handle_endtag(self, tag):
            if tag in VOID_TAGS:
                return
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    for unclosed, ln in self.stack[i + 1:]:
                        if unclosed not in ("p", "li", "td", "th", "tr", "option", "dt", "dd"):
                            self.issues.append(f"line {ln}: <{unclosed}> is never closed")
                    del self.stack[i:]
                    return
            self.issues.append(f"line {self.getpos()[0]}: stray </{tag}> with no matching opening tag")

    while queue and len(checked_pages) < 20:
        page = queue.pop(0)
        if page in seen:
            continue
        seen.add(page)
        checked_pages.append(rel(page))
        html = page.read_text(errors="replace")
        p = Parser()
        try:
            p.feed(html)
            p.close()
        except Exception as e:  # noqa: BLE001
            problems.append(f"{rel(page)}: couldn't parse HTML ({e})")
            continue
        for tag, ln in p.stack:
            if tag not in ("html", "body", "head", "p", "li"):
                p.issues.append(f"line {ln}: <{tag}> is never closed")
        if "<!doctype" not in html[:200].lower():
            p.issues.append("missing <!DOCTYPE html> at the top")
        if not p.title:
            p.issues.append("missing <title>")
        if not p.meta_viewport:
            p.issues.append('missing <meta name="viewport" …>, so the page won\'t scale on phones')
        if not p.html_lang:
            p.issues.append('missing lang attribute on <html> (e.g. <html lang="en">)')
        for kind, ref, ln in p.refs:
            if not _is_local(ref):
                continue
            target = _resolve(page.parent, ref)
            if root not in target.parents:
                p.issues.append(f"line {ln}: {kind} '{ref}' points outside the workspace")
                continue
            if not target.exists():
                p.issues.append(f"line {ln}: {kind} '{ref}' not found (looked for {rel(target)})")
                continue
            if target.is_dir():
                target = target / "index.html"
                if not target.exists():
                    p.issues.append(f"line {ln}: link '{ref}' is a folder without index.html")
                    continue
            if target.suffix.lower() in (".html", ".htm"):
                queue.append(target)
            elif target.suffix.lower() in (".css", ".js") and str(target) not in checked_assets:
                checked_assets.add(str(target))
                text = target.read_text(errors="replace")
                bad = check_file(str(target), text)
                if bad:
                    problems.append(f"{rel(target)}: {bad}")
                if target.suffix.lower() == ".css":
                    for m in re.finditer(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", text):
                        u = m.group(1)
                        if _is_local(u) and not _resolve(target.parent, u).exists():
                            problems.append(f"{rel(target)}: url('{u}') not found")
        problems += [f"{rel(page)}: {i}" for i in p.issues]

    summary = (f"Checked {len(checked_pages)} page(s): {', '.join(checked_pages)}; "
               f"{len(checked_assets)} CSS/JS file(s).")
    if not problems:
        return summary + "\n✅ No problems found."
    return summary + f"\n❌ {len(problems)} problem(s):\n" + "\n".join(f"- {x}" for x in problems[:60])


# ---------- registry ----------

def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }}


TOOLS: dict[str, dict] = {
    "web_search": {
        "label": "Web search", "group": "Web",
        "description": "Search the web (DuckDuckGo).",
        "schema": _fn("web_search", "Search the web. Returns titles, URLs and snippets.",
                      {"query": {"type": "string"}, "max_results": {"type": "integer", "default": 6}}, ["query"]),
        "impl": web_search,
    },
    "fetch_url": {
        "label": "Read web page", "group": "Web",
        "description": "Download a URL and return its readable text.",
        "schema": _fn("fetch_url", "Fetch a web page and return its text content.",
                      {"url": {"type": "string"}}, ["url"]),
        "impl": fetch_url,
    },
    "http_request": {
        "label": "Call an API", "group": "Web",
        "description": "Make any HTTP request (GET, POST...).",
        "schema": _fn("http_request", "Make an HTTP request to an API.",
                      {"method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                       "url": {"type": "string"},
                       "headers": {"type": "object"},
                       "body": {"description": "JSON object or raw string body"}}, ["method", "url"]),
        "impl": http_request,
    },
    "list_files": {
        "label": "List files", "group": "Files",
        "description": "List files in the shared workspace folder.",
        "schema": _fn("list_files", "List files in the shared workspace.",
                      {"path": {"type": "string", "default": "."}}, []),
        "impl": list_files,
    },
    "read_file": {
        "label": "Read files", "group": "Files",
        "description": "Read a file from the shared workspace.",
        "schema": _fn("read_file", "Read a text file from the workspace. For big files you can read a range of lines.",
                      {"path": {"type": "string"},
                       "start_line": {"type": "integer", "description": "1-based line to start at (optional)"},
                       "max_lines": {"type": "integer", "description": "how many lines to read (optional, 0 = all)"}},
                      ["path"]),
        "impl": read_file,
    },
    "edit_file": {
        "label": "Edit files", "group": "Files",
        "description": "Change part of a file (find & replace) without rewriting it.",
        "schema": _fn("edit_file", "Edit a file in the workspace by replacing ONE exact occurrence of old_text with "
                      "new_text. Much safer than rewriting a whole file for small changes. old_text must match exactly "
                      "(copy it from read_file) and be unique in the file.",
                      {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}},
                      ["path", "old_text", "new_text"]),
        "impl": edit_file,
    },
    "write_file": {
        "label": "Write files", "group": "Files",
        "description": "Create or overwrite a file in the shared workspace.",
        "schema": _fn("write_file", "Write a text file to the workspace (creates folders as needed).",
                      {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
        "impl": write_file,
    },
    "run_python": {
        "label": "Run Python", "group": "Code", "dangerous": True,
        "description": "Run Python in an isolated Docker container (no network).",
        "schema": _fn("run_python", "Run Python code in a sandbox. The workspace is mounted at /workspace (the "
                      "current directory). No internet. Print results to see them.",
                      {"code": {"type": "string"}}, ["code"]),
        "impl": run_python,
    },
    "run_shell": {
        "label": "Run shell", "group": "Code", "dangerous": True,
        "description": "Run shell commands in an isolated Docker container (no network).",
        "schema": _fn("run_shell", "Run a shell command in a sandbox with the workspace as current directory. No internet.",
                      {"command": {"type": "string"}}, ["command"]),
        "impl": run_shell,
    },
    "check_website": {
        "label": "Check website", "group": "Files",
        "description": "Open a website in the workspace and find broken links, missing files and HTML errors.",
        "schema": _fn("check_website", "Check a website in the workspace like a QA tester: follows its internal links "
                      "and reports broken links, missing CSS/JS/images, unclosed tags, broken CSS/JS brackets and "
                      "basic accessibility problems. Give the folder or the HTML file.",
                      {"path": {"type": "string", "description": "e.g. 'site' or 'site/index.html'"}}, ["path"]),
        "impl": check_website,
    },
    "delegate": {
        "label": "Ask another agent", "group": "Team",
        "description": "Hand a sub-task to another agent and get its answer back.",
        "schema": None,  # built dynamically from the list of agents
        "impl": None,    # handled by the engine
    },
}


def tool_catalog() -> list[dict]:
    return [
        {"id": k, "label": v["label"], "group": v["group"], "description": v["description"],
         "dangerous": v.get("dangerous", False)}
        for k, v in TOOLS.items()
    ]


def delegate_schemas(agents: list[dict]) -> list[dict]:
    """Two tools: hand off one task, or several tasks that run at the same time."""
    names = [a["name"] for a in agents]
    roster = "\n".join(f"- {a['name']}: {a.get('description', '')}" for a in agents)
    task_desc = "Complete, self-contained instructions. The teammate can't see your conversation or other tasks."
    return [
        _fn("delegate", "Hand ONE self-contained sub-task to a teammate agent and wait for its final answer.\n"
            f"Available teammates:\n{roster}",
            {"agent": {"type": "string", "enum": names}, "task": {"type": "string", "description": task_desc}},
            ["agent", "task"]),
        _fn("delegate_parallel", "Hand SEVERAL independent sub-tasks to teammates at once. They work IN PARALLEL "
            "(much faster than one by one), and you get all their answers back together. Use this whenever "
            "tasks don't depend on each other. The same teammate can get more than one task.\n"
            f"Available teammates:\n{roster}",
            {"tasks": {"type": "array", "minItems": 1, "maxItems": 6, "items": {
                "type": "object", "required": ["agent", "task"],
                "properties": {"agent": {"type": "string", "enum": names}, "task": {"type": "string", "description": task_desc}},
            }}},
            ["tasks"]),
    ]


async def call_tool(name: str, args_json: str,
                    delegate: Callable[[str, str], Awaitable[str]] | None = None) -> str:
    try:
        args = json.loads(args_json or "{}")
    except json.JSONDecodeError:
        return f"Invalid JSON arguments: {args_json[:200]}"
    try:
        if name in ("delegate", "delegate_parallel") and not delegate:
            return "Delegation is not available here."
        if name == "delegate":
            return await delegate(args.get("agent", ""), args.get("task", ""))
        if name == "delegate_parallel":
            tasks = [t for t in (args.get("tasks") or []) if isinstance(t, dict)][:6]
            if not tasks:
                return "Give at least one task as {agent, task}."
            results = await asyncio.gather(*(delegate(t.get("agent", ""), t.get("task", "")) for t in tasks),
                                           return_exceptions=True)
            parts = []
            for i, (t, r) in enumerate(zip(tasks, results), 1):
                body = f"Error: {type(r).__name__}: {r}" if isinstance(r, BaseException) else r
                parts.append(f"### Task {i}: {t.get('agent')}\n{body}")
            return "\n\n".join(parts)
        tool = TOOLS.get(name)
        if not tool or not tool["impl"]:
            return f"Unknown tool: {name}"
        return await tool["impl"](**args)
    except Exception as e:  # noqa: BLE001 - errors go back to the model
        return f"Tool error: {type(e).__name__}: {e}"
