"""Tiny SQLite layer. Agents and workflows are stored as JSON documents."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

# AGENTUI_DATA_DIR lets you keep separate setups (e.g. a demo or a test copy)
DATA_DIR = Path(os.environ.get("AGENTUI_DATA_DIR") or Path(__file__).resolve().parent.parent / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR = DATA_DIR / "workspace"
WORKSPACE_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "agentui.db"

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")

_conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind);
    CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id);
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """
)
_conn.commit()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


# ---------- documents (agents, workflows) ----------

def list_docs(kind: str) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT data FROM docs WHERE kind=? ORDER BY created_at", (kind,)
        ).fetchall()
    return [json.loads(r["data"]) for r in rows]


def get_doc(kind: str, doc_id: str) -> dict | None:
    with _lock:
        row = _conn.execute(
            "SELECT data FROM docs WHERE kind=? AND id=?", (kind, doc_id)
        ).fetchone()
    return json.loads(row["data"]) if row else None


def save_doc(kind: str, doc: dict) -> dict:
    now = time.time()
    doc = dict(doc)
    doc.setdefault("id", new_id())
    doc.setdefault("created_at", now)
    doc["updated_at"] = now
    with _lock:
        _conn.execute(
            """INSERT INTO docs(id, kind, data, created_at, updated_at) VALUES(?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at""",
            (doc["id"], kind, json.dumps(doc), doc["created_at"], now),
        )
        _conn.commit()
    return doc


def delete_doc(kind: str, doc_id: str) -> None:
    with _lock:
        _conn.execute("DELETE FROM docs WHERE kind=? AND id=?", (kind, doc_id))
        _conn.commit()


def count_docs(kind: str) -> int:
    with _lock:
        return _conn.execute("SELECT COUNT(*) FROM docs WHERE kind=?", (kind,)).fetchone()[0]


# ---------- runs ----------

def save_run(run: dict) -> None:
    with _lock:
        _conn.execute(
            """INSERT INTO runs(id, data, created_at) VALUES(?,?,?)
               ON CONFLICT(id) DO UPDATE SET data=excluded.data""",
            (run["id"], json.dumps(run), run["created_at"]),
        )
        _conn.commit()


def get_run(run_id: str) -> dict | None:
    with _lock:
        row = _conn.execute("SELECT data FROM runs WHERE id=?", (run_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def list_runs(limit: int = 200) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT data FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    out = []
    for r in rows:
        d = json.loads(r["data"])
        d.pop("graph", None)
        out.append(d)
    return out


def delete_run(run_id: str) -> None:
    with _lock:
        _conn.execute("DELETE FROM runs WHERE id=?", (run_id,))
        _conn.execute("DELETE FROM run_events WHERE run_id=?", (run_id,))
        _conn.commit()


def add_event(run_id: str, event: dict) -> None:
    with _lock:
        _conn.execute(
            "INSERT INTO run_events(run_id, data) VALUES(?,?)", (run_id, json.dumps(event))
        )
        _conn.commit()


def get_events(run_id: str) -> list[dict]:
    with _lock:
        rows = _conn.execute(
            "SELECT data FROM run_events WHERE run_id=? ORDER BY id", (run_id,)
        ).fetchall()
    return [json.loads(r["data"]) for r in rows]


def mark_interrupted_runs() -> None:
    """Runs still 'running' after a server restart can never finish."""
    for run in list_runs(10_000):
        if run.get("status") in ("running", "queued", "waiting"):
            full = get_run(run["id"])
            if full:
                full["status"] = "error"
                full["error"] = "Server restarted while this run was in progress."
                save_run(full)


# ---------- settings ----------

def get_setting(key: str, default: Any = None) -> Any:
    with _lock:
        row = _conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value: Any) -> None:
    with _lock:
        _conn.execute(
            "INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        _conn.commit()
