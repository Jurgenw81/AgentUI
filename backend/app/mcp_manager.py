"""Connections to external MCP tool servers (GitHub, filesystem, browsers, databases...).

Each configured server gets one long-lived connection, owned by its own asyncio task (the MCP SDK
requires a session to be opened and closed in the same task). Tool calls are sent to that task
through a queue. Servers are configured in Settings and stored in the `mcp_servers` setting.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from contextlib import AsyncExitStack
from typing import Any

from . import db, policies

LOGIN_TIMEOUT = 15 * 60
# OAuth "state" -> future resolved by /api/mcp/oauth/callback
OAUTH_PENDING: dict[str, asyncio.Future] = {}


def server_url() -> str:
    from . import cli_agent
    return cli_agent.SERVER_URL["value"].replace("127.0.0.1", "localhost")


def redirect_uri() -> str:
    return f"{server_url()}/api/mcp/oauth/callback"


class DBTokenStorage:
    """Keeps a server's OAuth tokens + registered client in the local database."""

    def __init__(self, server_id: str) -> None:
        self.sid = server_id

    def _all(self) -> dict:
        return db.get_setting("mcp_oauth", {}) or {}

    def _put(self, key: str, value: Any) -> None:
        data = self._all()
        data.setdefault(self.sid, {})[key] = value
        db.set_setting("mcp_oauth", data)

    async def get_tokens(self):
        from mcp.shared.auth import OAuthToken
        t = self._all().get(self.sid, {}).get("tokens")
        return OAuthToken.model_validate(t) if t else None

    async def set_tokens(self, tokens) -> None:
        self._put("tokens", tokens.model_dump(mode="json", exclude_none=True))

    async def get_client_info(self):
        from mcp.shared.auth import OAuthClientInformationFull
        c = self._all().get(self.sid, {}).get("client_info")
        if not c:
            return None
        info = OAuthClientInformationFull.model_validate(c)
        # registered for a different port? register again
        if redirect_uri() not in [str(u) for u in (info.redirect_uris or [])]:
            return None
        return info

    async def set_client_info(self, client_info) -> None:
        self._put("client_info", client_info.model_dump(mode="json", exclude_none=True))


def has_login(server_id: str) -> bool:
    return bool((db.get_setting("mcp_oauth", {}) or {}).get(server_id, {}).get("tokens"))


def forget_login(server_id: str) -> None:
    data = db.get_setting("mcp_oauth", {}) or {}
    data.pop(server_id, None)
    db.set_setting("mcp_oauth", data)

CALL_TIMEOUT = 300
CONNECT_TIMEOUT = 60


def servers_config() -> list[dict]:
    return db.get_setting("mcp_servers", []) or []


def tool_prefix(server: dict) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", server.get("name") or server["id"]).strip("_").lower()
    return (slug or server["id"])[:20]


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        if hasattr(obj, n):
            return getattr(obj, n)
    return default


class Connection:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.tools: list[dict] = []
        self.error: str | None = None
        self.status = "idle"  # idle | connecting | needs_login | connected | error
        self.auth_url: str | None = None
        self._login_state = ""
        self.connected_at: float | None = None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._ready = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def ensure(self) -> None:
        if self._task is None or self._task.done():
            self._ready.clear()
            self.status, self.error = "connecting", None
            self._task = asyncio.create_task(self._run())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            self.status, self.error = "error", f"Timed out after {CONNECT_TIMEOUT}s while connecting"
            await self.stop()

    async def _run(self) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        cfg = self.cfg
        try:
            async with AsyncExitStack() as stack:
                if cfg.get("type") == "http":
                    from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
                    headers = {k: v for k, v in (cfg.get("headers") or {}).items() if k}
                    auth = None
                    # No token given? Then sign in with OAuth if (and only if) the server asks for it.
                    if not any(k.lower() == "authorization" for k in headers) and cfg.get("oauth", True):
                        auth = self._oauth_provider()
                    client = create_mcp_http_client(headers=headers, auth=auth)
                    await stack.enter_async_context(client)
                    streams = await stack.enter_async_context(streamable_http_client(cfg["url"], http_client=client))
                    read, write = streams[0], streams[1]
                else:
                    env = {**os.environ, **{k: v for k, v in (cfg.get("env") or {}).items() if k}}
                    params = StdioServerParameters(command=cfg["command"], args=list(cfg.get("args") or []),
                                                   env=env, cwd=cfg.get("cwd") or None)
                    devnull = stack.enter_context(open(os.devnull, "w"))
                    read, write = await stack.enter_async_context(stdio_client(params, errlog=devnull))
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                listed = await session.list_tools()
                self.tools = [{
                    "name": t.name,
                    "description": (_get(t, "description") or "").strip()[:1000],
                    "input_schema": _get(t, "input_schema", "inputSchema", default=None) or {"type": "object", "properties": {}},
                    "annotations": _annotations(_get(t, "annotations")),
                } for t in listed.tools]
                self.status, self.connected_at, self.auth_url = "connected", time.time(), None
                self._ready.set()
                while True:
                    name, args, fut = await self._queue.get()
                    if fut.cancelled():
                        continue
                    try:
                        res = await session.call_tool(name, args, read_timeout_seconds=CALL_TIMEOUT)
                        fut.set_result(_render_result(res))
                    except Exception as e:  # noqa: BLE001
                        if not fut.done():
                            fut.set_result(f"Tool error: {type(e).__name__}: {e}")
                        if isinstance(e, (BrokenPipeError, ConnectionError, EOFError)):
                            raise
        except asyncio.CancelledError:
            self.status = "idle"
            raise
        except BaseException as e:  # noqa: BLE001 - includes ExceptionGroup from anyio
            msg = str(e)
            if hasattr(e, "exceptions") and e.exceptions:  # unwrap TaskGroup errors
                inner = e.exceptions[0]
                msg = f"{type(inner).__name__}: {inner}"
            if cfg.get("type") != "http" and ("No such file" in msg or "not found" in msg.lower()):
                msg = f"Couldn't start '{cfg.get('command')}': command not found. Is it installed and on your PATH?"
            elif cfg.get("type") == "http" and any(w in msg for w in ("401", "403", "Unauthorized")):
                msg = f"The server refused the connection ({msg[:120]}). Check the Authorization header / token."
            self.status, self.error = "error", (msg or type(e).__name__)[:500]
        finally:
            self._ready.set()
            while not self._queue.empty():
                _, _, fut = self._queue.get_nowait()
                if not fut.done():
                    fut.set_result(f"Tool error: MCP server '{self.cfg.get('name')}' disconnected")

    def _oauth_provider(self):
        from mcp.client.auth import OAuthClientProvider
        from mcp.shared.auth import OAuthClientMetadata

        conn = self

        async def redirect_handler(url: str) -> None:
            from urllib.parse import parse_qs, urlparse
            state = (parse_qs(urlparse(url).query).get("state") or [""])[0]
            OAUTH_PENDING[state] = asyncio.get_running_loop().create_future()
            conn._login_state = state
            conn.auth_url, conn.status = url, "needs_login"
            conn._ready.set()  # let callers know: waiting for the user to log in

        async def callback_handler():
            fut = OAUTH_PENDING.get(conn._login_state)
            try:
                return await asyncio.wait_for(fut, timeout=LOGIN_TIMEOUT)
            except asyncio.TimeoutError:
                raise RuntimeError("Login wasn't completed in time. Click Log in to try again.")
            finally:
                OAUTH_PENDING.pop(conn._login_state, None)

        return OAuthClientProvider(
            server_url=self.cfg["url"],
            client_metadata=OAuthClientMetadata(
                client_name="AgentUI", redirect_uris=[redirect_uri()], grant_types=["authorization_code", "refresh_token"],
                response_types=["code"], token_endpoint_auth_method="none"),
            storage=DBTokenStorage(self.cfg["id"]),
            redirect_handler=redirect_handler,
            callback_handler=callback_handler,
        )

    async def call(self, name: str, args: dict) -> str:
        await self.ensure()
        if self.status == "needs_login":
            return f"Tool error: MCP server '{self.cfg.get('name')}' needs you to log in first (Settings → Tool servers)."
        if self.status != "connected":
            return f"Tool error: MCP server '{self.cfg.get('name')}' isn't available: {self.error}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._queue.put((name, args, fut))
        try:
            return await asyncio.wait_for(fut, timeout=CALL_TIMEOUT + 10)
        except asyncio.TimeoutError:
            return f"Tool error: '{name}' timed out after {CALL_TIMEOUT}s"

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except BaseException:  # noqa: BLE001
                pass
        self.status = "idle"


def _annotations(a: Any) -> dict:
    if not a:
        return {}
    if hasattr(a, "model_dump"):
        a = a.model_dump(by_alias=True, exclude_none=True)
    return {k: v for k, v in dict(a).items() if isinstance(v, (bool, str))}


def _render_result(res: Any) -> str:
    parts = []
    for c in _get(res, "content", default=[]) or []:
        ctype = _get(c, "type", default="")
        if ctype == "text":
            parts.append(_get(c, "text", default=""))
        elif ctype == "image":
            parts.append(f"[image: {_get(c, 'mime_type', 'mimeType', default='image')}]")
        elif ctype == "resource":
            r = _get(c, "resource")
            parts.append(_get(r, "text", default=None) or f"[resource: {_get(r, 'uri', default='')}]")
        else:
            parts.append(str(_get(c, "text", default=c)))
    structured = _get(res, "structured_content", "structuredContent", default=None)
    if not parts and structured is not None:
        parts.append(str(structured))
    text = "\n".join(parts) or "(no output)"
    if _get(res, "is_error", "isError", default=False):
        text = f"Tool error: {text}"
    return text[:20000]


class Manager:
    def __init__(self) -> None:
        self.conns: dict[str, Connection] = {}

    def conn(self, server_id: str) -> Connection | None:
        cfg = next((s for s in servers_config() if s["id"] == server_id), None)
        if not cfg or not cfg.get("enabled", True):
            return None
        c = self.conns.get(server_id)
        if c is None or c.cfg != cfg:  # new or edited server
            if c:
                asyncio.create_task(c.stop())
            c = self.conns[server_id] = Connection(cfg)
        return c

    async def tools_for(self, server_id: str) -> tuple[dict | None, list[dict]]:
        c = self.conn(server_id)
        if not c:
            return None, []
        await c.ensure()
        return c.cfg, c.tools

    async def status(self) -> list[dict]:
        out = []
        for cfg in servers_config():
            c = self.conns.get(cfg["id"])
            out.append({
                **cfg,
                "prefix": tool_prefix(cfg),
                "status": "disabled" if not cfg.get("enabled", True) else (c.status if c else "idle"),
                "error": c.error if c else None,
                "auth_url": c.auth_url if c and c.status == "needs_login" else None,
                "logged_in": has_login(cfg["id"]),
                "tools": [{
                    "name": t["name"], "description": t["description"],
                    "policy": policies.get(policies.mcp_key(cfg["id"], t["name"]), t.get("annotations")),
                    "default_policy": policies.default_for(policies.mcp_key(cfg["id"], t["name"]), t.get("annotations")),
                } for t in (c.tools if c else [])],
            })
        return out

    async def reconnect(self, server_id: str) -> None:
        c = self.conns.pop(server_id, None)
        if c:
            await c.stop()
        c = self.conn(server_id)
        if c:
            await c.ensure()

    async def remove(self, server_id: str) -> None:
        c = self.conns.pop(server_id, None)
        if c:
            await c.stop()

    async def connect_all(self) -> None:
        """Connect every enabled server in the background (at startup), so tool lists are ready."""
        async def one(sid: str) -> None:
            c = self.conn(sid)
            if c:
                await c.ensure()
        await asyncio.gather(*(one(s["id"]) for s in servers_config() if s.get("enabled", True)),
                             return_exceptions=True)

    async def shutdown(self) -> None:
        for c in list(self.conns.values()):
            await c.stop()


manager = Manager()


async def agent_tool_schemas(tool_ids: list[str]) -> tuple[list[dict], dict[str, tuple], list[str]]:
    """For an agent's "mcp:<server_id>" tool ids: (OpenAI-style schemas, name -> (server_id, tool), problems)."""
    schemas: list[dict] = []
    routes: dict[str, tuple[str, str]] = {}
    problems: list[str] = []
    for tid in tool_ids:
        if not tid.startswith("mcp:"):
            continue
        sid = tid[4:]
        cfg, tools = await manager.tools_for(sid)
        if cfg is None:
            continue
        c = manager.conns.get(sid)
        if c and c.status == "needs_login":
            problems.append(f"MCP server '{cfg.get('name')}' needs you to log in (Settings → Tool servers), so its tools are unavailable this time.")
            continue
        if c and c.status != "connected":
            problems.append(f"MCP server '{cfg.get('name')}' isn't available: {c.error}")
            continue
        prefix = tool_prefix(cfg)
        for t in tools:
            name = re.sub(r"[^a-zA-Z0-9_-]", "_", f"{prefix}__{t['name']}")[:64]
            routes[name] = (sid, t["name"], t.get("annotations") or {})
            schema = t["input_schema"] if isinstance(t["input_schema"], dict) else {"type": "object", "properties": {}}
            schema = {**schema, "type": "object"}
            schema.setdefault("properties", {})
            schemas.append({"type": "function", "function": {
                "name": name,
                "description": f"[{cfg.get('name')}] {t['description'] or t['name']}"[:1024],
                "parameters": schema,
            }})
    return schemas, routes, problems


async def call(route: tuple, args: dict) -> str:
    sid, tool = route[0], route[1]
    c = manager.conn(sid)
    if not c:
        return "Tool error: this MCP server was removed or disabled."
    return await c.call(tool, args)
