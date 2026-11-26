"""Run agents through a logged-in CLI (Claude Code) so they use your subscription instead of an API key.

Claude Code runs the model loop itself. The agent's AgentUI tools are handed to it through a tiny MCP
server (mcp_bridge.py) that calls back into this backend, so tools, sandboxing and the live
timeline behave exactly like they do for API-key models.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import db

CLAUDE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"]
BRIDGE = Path(__file__).with_name("mcp_bridge.py")

# ctx id -> {"tools": [...mcp tool defs], "call": async (name, args_json) -> str}
CONTEXTS: dict[str, dict] = {}
SERVER_URL = {"value": os.environ.get("AGENTUI_URL", "http://127.0.0.1:3000")}


def claude_bin() -> str | None:
    found = shutil.which("claude")
    if found:
        return found
    for p in (Path.home() / ".local/bin/claude", Path.home() / ".claude/local/claude"):
        if p.is_file():
            return str(p)
    return None


_status_cache: dict[str, Any] = {"at": 0.0, "value": None}


async def claude_status(force: bool = False) -> dict:
    """{installed, logged_in, method, detail} — cached for a minute."""
    if not force and _status_cache["value"] and time.time() - _status_cache["at"] < 60:
        return _status_cache["value"]
    exe = claude_bin()
    status = {"installed": bool(exe), "logged_in": False, "method": None, "detail": None}
    if exe:
        try:
            proc = await asyncio.create_subprocess_exec(
                exe, "auth", "status", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await asyncio.wait_for(proc.communicate(), timeout=20)
            data = json.loads(out.decode() or "{}")
            status["logged_in"] = bool(data.get("loggedIn"))
            status["method"] = data.get("authMethod")
            warn = err.decode().strip()
            if warn:
                status["detail"] = warn.splitlines()[0][:300]
        except Exception as e:  # noqa: BLE001
            status["detail"] = f"Couldn't check login: {e}"[:300]
    _status_cache.update(at=time.time(), value=status)
    return status


def _to_prompt(messages: list[dict]) -> str:
    msgs = [m for m in messages if m.get("role") in ("user", "assistant") and m.get("content")]
    if len(msgs) == 1:
        return str(msgs[0]["content"])
    lines = ["Here is the conversation so far:\n"]
    for m in msgs:
        who = "User" if m["role"] == "user" else "You (assistant)"
        lines.append(f"### {who}\n{m['content']}\n")
    lines.append("Reply to the user's last message.")
    return "\n".join(lines)


async def run_claude_code(
    *,
    model: str,
    system_prompt: str,
    messages: list[dict],
    schemas: list[dict],
    call_tool: Callable[[str, str], Awaitable[str]],
    emit: Callable[[dict], Awaitable[None]],
    max_steps: int,
) -> dict:
    """Returns {"output", "usage": {"input","output"}}."""
    exe = claude_bin()
    if not exe:
        raise RuntimeError("Claude Code isn't installed. Install it from https://claude.com/claude-code and run `claude` once to log in.")

    ctx_id = os.urandom(12).hex()
    args = [
        exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--model", model, "--system-prompt", system_prompt,
        "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
        "--max-turns", str(max_steps + 1),
    ]
    if schemas:
        CONTEXTS[ctx_id] = {
            "tools": [{"name": s["function"]["name"], "description": s["function"]["description"],
                       "inputSchema": s["function"]["parameters"]} for s in schemas],
            "call": call_tool,
        }
        mcp = {"mcpServers": {"agentui": {
            "command": sys.executable, "args": [str(BRIDGE)],
            "env": {"AGENTUI_URL": SERVER_URL["value"], "AGENTUI_CTX": ctx_id},
        }}}
        args += ["--mcp-config", json.dumps(mcp), "--allowedTools", "mcp__agentui"]

    env = {**os.environ, "MCP_TOOL_TIMEOUT": "900000", "MCP_TIMEOUT": "30000"}
    env.pop("ANTHROPIC_API_KEY", None)  # make sure the subscription login is used
    proc = await asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=str(db.WORKSPACE_DIR), env=env, limit=64 * 1024 * 1024,
    )
    stderr_chunks: list[bytes] = []

    async def read_stderr():
        assert proc.stderr
        async for chunk in proc.stderr:
            stderr_chunks.append(chunk)

    err_task = asyncio.create_task(read_stderr())
    final: dict | None = None
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write(_to_prompt(messages).encode())
        await proc.stdin.drain()
        proc.stdin.close()

        cur_text, stop_reason = "", None
        async for raw in proc.stdout:
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "stream_event":
                e = ev.get("event", {})
                et = e.get("type")
                if et == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                    text = e["delta"]["text"]
                    cur_text += text
                    await emit({"type": "token", "text": text})
                elif et == "message_delta":
                    stop_reason = e.get("delta", {}).get("stop_reason")
                elif et == "message_stop":
                    if stop_reason == "tool_use" and cur_text.strip():
                        await emit({"type": "message", "content": cur_text, "intermediate": True})
                    cur_text, stop_reason = "", None
            elif ev.get("type") == "result":
                final = ev
        await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
        raise
    finally:
        CONTEXTS.pop(ctx_id, None)
        err_task.cancel()

    if not final or final.get("is_error") or final.get("subtype") != "success":
        detail = (final or {}).get("result") or b"".join(stderr_chunks).decode(errors="replace").strip()
        if final and final.get("subtype") == "error_max_turns":
            detail = "The agent used all its tool steps without finishing."
        hint = ""
        if any(w in (detail or "").lower() for w in ("login", "log in", "auth", "credential", "/login")):
            hint = " — run `claude` in a terminal and log in with your Claude subscription."
        raise RuntimeError(f"Claude Code failed: {(detail or 'unknown error')[:500]}{hint}")

    u = final.get("usage") or {}
    return {
        "output": final.get("result") or "",
        "usage": {
            "input": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
            "output": u.get("output_tokens") or 0,
        },
    }


# =====================================================================
# ChatGPT subscription via Codex CLI
# =====================================================================

def _find_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    # servers started outside an interactive shell may not have nvm's bin dir on PATH
    for p in sorted(Path.home().glob(f".nvm/versions/node/*/bin/{name}"), reverse=True):
        return str(p)
    p = Path.home() / ".local/bin" / name
    return str(p) if p.is_file() else None


def codex_bin() -> str | None:
    return _find_bin("codex")


def _bin_env(exe: str) -> dict:
    """Env for npm-installed CLIs: make sure their own node is on PATH."""
    env = dict(os.environ)
    env["PATH"] = f"{Path(exe).parent}:{env.get('PATH', '')}"
    return env


_codex_cache: dict[str, Any] = {"at": 0.0, "value": None}


async def codex_status(force: bool = False) -> dict:
    """{installed, logged_in, method, detail, models}"""
    if not force and _codex_cache["value"] and time.time() - _codex_cache["at"] < 60:
        return _codex_cache["value"]
    exe = codex_bin()
    st: dict[str, Any] = {"installed": bool(exe), "logged_in": False, "method": None, "detail": None, "models": []}
    if exe:
        try:
            proc = await asyncio.create_subprocess_exec(
                exe, "login", "status", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=_bin_env(exe))
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
            text = out.decode(errors="replace").strip()
            st["logged_in"] = proc.returncode == 0 and "logged in" in text.lower() and "not logged in" not in text.lower()
            st["method"] = "ChatGPT" if "chatgpt" in text.lower() else ("API key" if "api key" in text.lower() else None)
            if not st["logged_in"]:
                st["detail"] = text.splitlines()[-1][:300] if text else None
            if st["logged_in"]:
                proc = await asyncio.create_subprocess_exec(
                    exe, "debug", "models", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=_bin_env(exe))
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
                data = json.loads(out.decode() or "[]")
                models = data.get("models", data) if isinstance(data, dict) else data
                st["models"] = [
                    {"id": m["slug"], "name": m.get("display_name") or m["slug"]}
                    for m in sorted(models, key=lambda m: m.get("priority", 99))
                    if isinstance(m, dict) and m.get("slug") and m.get("visibility", "list") == "list"
                ]
        except Exception as e:  # noqa: BLE001
            st["detail"] = f"Couldn't check Codex: {e}"[:300]
    _codex_cache.update(at=time.time(), value=st)
    return st


def _toml(value: Any) -> str:
    return json.dumps(value)  # JSON strings/arrays are valid TOML values


async def run_codex(
    *,
    model: str,
    system_prompt: str,
    messages: list[dict],
    schemas: list[dict],
    call_tool: Callable[[str, str], Awaitable[str]],
    emit: Callable[[dict], Awaitable[None]],
    max_steps: int,
) -> dict:
    exe = codex_bin()
    if not exe:
        raise RuntimeError("Codex CLI isn't installed. Run: npm install -g @openai/codex && codex login")

    ctx_id = os.urandom(12).hex()
    # An empty folder + read-only sandbox: Codex's own shell can't change anything.
    # Real work goes through AgentUI's tools (bridged over MCP), same as every other model.
    sandbox_dir = db.DATA_DIR / "codex-sandbox"
    sandbox_dir.mkdir(exist_ok=True)
    args = [
        exe, "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "-s", "read-only", "-C", str(sandbox_dir),
        "-c", 'approval_policy="never"',
        "-c", f"developer_instructions={_toml(system_prompt)}",
        "-c", "web_search=\"disabled\"",
    ]
    if model and model != "default":
        args += ["-m", model]
    if schemas:
        CONTEXTS[ctx_id] = {
            "tools": [{"name": s["function"]["name"], "description": s["function"]["description"],
                       "inputSchema": s["function"]["parameters"]} for s in schemas],
            "call": call_tool,
        }
        args += [
            "-c", f"mcp_servers.agentui.command={_toml(sys.executable)}",
            "-c", f"mcp_servers.agentui.args={_toml([str(BRIDGE)])}",
            "-c", "mcp_servers.agentui.env={" + ", ".join(
                f"{k} = {_toml(v)}" for k, v in {"AGENTUI_URL": SERVER_URL["value"], "AGENTUI_CTX": ctx_id}.items()) + "}",
            "-c", "mcp_servers.agentui.tool_timeout_sec=900",
            "-c", 'mcp_servers.agentui.default_tools_approval_mode="approve"',
        ]
    args.append("-")  # prompt from stdin

    env = _bin_env(exe)
    env.pop("OPENAI_API_KEY", None)  # use the ChatGPT login
    proc = await asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=str(sandbox_dir), env=env, limit=64 * 1024 * 1024,
    )
    stderr_chunks: list[bytes] = []

    async def read_stderr():
        assert proc.stderr
        async for chunk in proc.stderr:
            stderr_chunks.append(chunk)

    err_task = asyncio.create_task(read_stderr())
    pending: str | None = None  # latest agent message; earlier ones were "thinking out loud"
    usage = {"input": 0, "output": 0}
    error: str | None = None
    turns = 0
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write(_to_prompt(messages).encode())
        await proc.stdin.drain()
        proc.stdin.close()
        async for raw in proc.stdout:
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = ev.get("type")
            item = ev.get("item") or {}
            itype = item.get("type")
            if t == "item.completed" and itype == "agent_message":
                if pending:
                    await emit({"type": "message", "content": pending, "intermediate": True})
                pending = item.get("text") or ""
                await emit({"type": "token", "text": pending})
            elif itype == "command_execution" and t in ("item.started", "item.completed"):
                # Codex's own read-only shell; show it for transparency
                call_id = f"codex-{item.get('id')}"
                if t == "item.started":
                    await emit({"type": "tool_call", "tool": "codex_shell", "call_id": call_id,
                                "args": json.dumps({"command": item.get("command", "")})})
                else:
                    await emit({"type": "tool_result", "tool": "codex_shell", "call_id": call_id,
                                "output": (item.get("aggregated_output") or "")[:12000], "duration": 0})
            elif t == "turn.completed":
                turns += 1
                u = ev.get("usage") or {}
                usage["input"] += u.get("input_tokens") or 0
                usage["output"] += (u.get("output_tokens") or 0) + (u.get("reasoning_output_tokens") or 0)
            elif t == "turn.failed":
                error = ((ev.get("error") or {}).get("message")) or "Codex turn failed"
            elif t == "error":
                error = ev.get("message") or "Codex error"
        await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
        raise
    finally:
        CONTEXTS.pop(ctx_id, None)
        err_task.cancel()

    if error or proc.returncode != 0 or pending is None:
        detail = error or b"".join(stderr_chunks).decode(errors="replace").strip()[-500:] or "no answer"
        hint = " — run `codex login` and sign in with ChatGPT." if any(
            w in detail.lower() for w in ("login", "auth", "401", "unauthorized", "token")) else ""
        raise RuntimeError(f"Codex failed: {detail[:500]}{hint}")
    return {"output": pending, "usage": usage}


# =====================================================================
# Gemini (Google account / Google AI subscription) via Gemini CLI
# =====================================================================

def gemini_bin() -> str | None:
    return _find_bin("gemini")


GEMINI_FALLBACK_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"]
_gemini_cache: dict[str, Any] = {"at": 0.0, "value": None}


async def gemini_status(force: bool = False) -> dict:
    """{installed, logged_in, method, detail, models}. Login = cached Google OAuth credentials."""
    if not force and _gemini_cache["value"] and time.time() - _gemini_cache["at"] < 60:
        return _gemini_cache["value"]
    exe = gemini_bin()
    home = Path(os.environ.get("GEMINI_CLI_HOME") or Path.home()) / ".gemini"
    st: dict[str, Any] = {"installed": bool(exe), "logged_in": False, "method": None, "detail": None, "models": []}
    if exe:
        if (home / "oauth_creds.json").is_file():
            st.update(logged_in=True, method="Google account")
        if st["logged_in"]:
            try:
                proc = await asyncio.create_subprocess_exec(
                    exe, "--list-models", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                    env={**_bin_env(exe), "GEMINI_CLI_TRUST_WORKSPACE": "true"}, cwd=str(db.DATA_DIR))
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=40)
                import re
                found = re.findall(r"\b(gemini-[a-z0-9.\-]+)\b", out.decode(errors="replace"))
                st["models"] = list(dict.fromkeys(found))
            except Exception as e:  # noqa: BLE001
                st["detail"] = f"Couldn't list models: {e}"[:200]
            if not st["models"]:
                st["models"] = GEMINI_FALLBACK_MODELS
    _gemini_cache.update(at=time.time(), value=st)
    return st


async def run_gemini(
    *,
    model: str,
    system_prompt: str,
    messages: list[dict],
    schemas: list[dict],
    call_tool: Callable[[str, str], Awaitable[str]],
    emit: Callable[[dict], Awaitable[None]],
    max_steps: int,
) -> dict:
    exe = gemini_bin()
    if not exe:
        raise RuntimeError("Gemini CLI isn't installed. Run: npm install -g @google/gemini-cli, then `gemini` to log in.")

    ctx_id = os.urandom(12).hex()
    run_dir = db.DATA_DIR / "gemini-runs" / ctx_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "system.md").write_text(system_prompt)
    # Per-run settings (highest precedence): no built-in tools; only AgentUI's tools via MCP.
    settings: dict[str, Any] = {
        "tools": {"core": ["__none__"]},
        "general": {"checkpointing": {"enabled": False}},
        "context": {"fileName": "__agentui_none__.md"},
        "mcpServers": {},
    }
    if schemas:
        CONTEXTS[ctx_id] = {
            "tools": [{"name": s["function"]["name"], "description": s["function"]["description"],
                       "inputSchema": s["function"]["parameters"]} for s in schemas],
            "call": call_tool,
        }
        settings["mcpServers"]["agentui"] = {
            "command": sys.executable, "args": [str(BRIDGE)], "trust": True, "timeout": 900_000,
            "env": {"AGENTUI_URL": SERVER_URL["value"], "AGENTUI_CTX": ctx_id},
        }
    (run_dir / "settings.json").write_text(json.dumps(settings))

    args = [exe, "--output-format", "stream-json", "--approval-mode", "yolo", "-p", " "]
    if schemas:
        args += ["--allowed-mcp-server-names", "agentui"]
    if model and model != "default":
        args += ["-m", model]
    env = _bin_env(exe)
    env.update({
        "GEMINI_SYSTEM_MD": str(run_dir / "system.md"),
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH": str(run_dir / "settings.json"),
        "GEMINI_CLI_TRUST_WORKSPACE": "true",
    })
    for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        env.pop(k, None)  # use the Google login

    proc = await asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=str(run_dir), env=env, limit=64 * 1024 * 1024,
    )
    stderr_chunks: list[bytes] = []

    async def read_stderr():
        assert proc.stderr
        async for chunk in proc.stderr:
            stderr_chunks.append(chunk)

    err_task = asyncio.create_task(read_stderr())
    segments: list[str] = [""]  # assistant text, split at tool calls
    usage = {"input": 0, "output": 0}
    status, error = None, None
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write(_to_prompt(messages).encode())
        await proc.stdin.drain()
        proc.stdin.close()
        async for raw in proc.stdout:
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            t = ev.get("type")
            if t == "message" and ev.get("role") == "assistant":
                text = ev.get("content") or ""
                segments[-1] += text
                await emit({"type": "token", "text": text})
            elif t == "tool_use":
                if segments[-1].strip():
                    await emit({"type": "message", "content": segments[-1], "intermediate": True})
                segments.append("")
            elif t == "error":
                error = ev.get("message") or (ev.get("error") or {}).get("message")
            elif t == "result":
                status = ev.get("status")
                if ev.get("error"):
                    error = ev["error"].get("message")
                stats = ev.get("stats") or {}
                usage = {"input": stats.get("input_tokens") or 0, "output": stats.get("output_tokens") or 0}
        await proc.wait()
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
        raise
    finally:
        CONTEXTS.pop(ctx_id, None)
        err_task.cancel()
        shutil.rmtree(run_dir, ignore_errors=True)

    output = segments[-1].strip()
    if status != "success" or error or not output:
        detail = error or b"".join(stderr_chunks).decode(errors="replace").strip()[-500:] or "no answer"
        hint = " — run `gemini` in a terminal and choose “Login with Google”." if any(
            w in detail.lower() for w in ("auth", "login", "credential", "401", "403")) else ""
        raise RuntimeError(f"Gemini CLI failed: {detail[:500]}{hint}")
    return {"output": output, "usage": usage}
