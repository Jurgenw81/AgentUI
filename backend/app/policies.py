"""Per-tool safety rules: allow / ai (AI check) / ask (ask the user) / block.

Keys: built-in tool name (e.g. "run_shell") or "mcp:<server_id>:<tool name>".
Anything the user hasn't set gets a sensible default: built-in tools are allowed (they're sandboxed);
MCP tools that look like they change something in the outside world default to "ask".
"""
from __future__ import annotations

import re

from . import db

POLICIES = ("allow", "ai", "ask", "block")

# words that suggest a tool changes something (sends, writes, deletes, pays...)
RISKY_WORDS = {
    "send", "post", "reply", "forward", "publish", "create", "add", "insert", "update", "edit", "modify", "write",
    "delete", "remove", "destroy", "drop", "archive", "merge", "push", "commit", "deploy", "close", "cancel",
    "invite", "share", "transfer", "pay", "charge", "refund", "purchase", "buy", "order", "book", "schedule",
    "move", "rename", "upload", "set", "enable", "disable", "execute", "run", "trigger", "approve", "assign",
    "comment", "react", "star", "fork", "kill", "stop", "start", "restart", "install", "uninstall", "submit",
}


def words(name: str) -> list[str]:
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)  # sendMessage -> send_Message
    return [w.lower() for w in re.split(r"[^A-Za-z0-9]+", snake) if w]


def mcp_key(server_id: str, tool: str) -> str:
    return f"mcp:{server_id}:{tool}"


def default_for(key: str, annotations: dict | None = None) -> str:
    if not key.startswith("mcp:"):
        return "allow"
    a = annotations or {}
    if a.get("readOnlyHint") is True or a.get("read_only_hint") is True:
        return "allow"
    if a.get("destructiveHint") is True or a.get("destructive_hint") is True:
        return "ask"
    tool = key.split(":", 2)[2]
    return "ask" if any(w in RISKY_WORDS for w in words(tool)) else "allow"


def all_set() -> dict[str, str]:
    return db.get_setting("tool_policies", {}) or {}


def get(key: str, annotations: dict | None = None) -> str:
    chosen = all_set().get(key)
    return chosen if chosen in POLICIES else default_for(key, annotations)


def set_many(changes: dict[str, str | None]) -> dict[str, str]:
    cur = all_set()
    for k, v in changes.items():
        if v is None:
            cur.pop(k, None)
        elif v in POLICIES:
            cur[k] = v
    db.set_setting("tool_policies", cur)
    return cur
