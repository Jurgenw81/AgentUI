"""Minimal stdio MCP server that exposes an AgentUI agent's tools to a CLI agent (e.g. Claude Code).

Claude Code launches this script; every tool call is forwarded to the AgentUI backend, which runs the
tool with the same sandbox/settings as API-key models and records it in the live timeline.
Stdlib only, so it starts fast. Env: AGENTUI_URL, AGENTUI_CTX.
"""
import json
import os
import sys
import urllib.request

URL = os.environ["AGENTUI_URL"].rstrip("/")
CTX = os.environ["AGENTUI_CTX"]


def backend(method: str, path: str, body=None, timeout=900):
    req = urllib.request.Request(
        f"{URL}/api/internal/ctx/{CTX}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method, msg_id = msg.get("method"), msg.get("id")
        if msg_id is None:  # notification
            continue
        try:
            if method == "initialize":
                reply(msg_id, {
                    "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "agentui", "version": "1.0"},
                })
            elif method == "tools/list":
                reply(msg_id, {"tools": backend("GET", "/tools")["tools"]})
            elif method == "tools/call":
                p = msg.get("params", {})
                res = backend("POST", "/call", {"name": p.get("name"), "arguments": p.get("arguments") or {}})
                reply(msg_id, {"content": [{"type": "text", "text": res["output"]}], "isError": False})
            elif method == "ping":
                reply(msg_id, {})
            else:
                reply(msg_id, error={"code": -32601, "message": f"Method not found: {method}"})
        except Exception as e:  # noqa: BLE001
            if method == "tools/call":
                reply(msg_id, {"content": [{"type": "text", "text": f"Tool error: {e}"}], "isError": True})
            else:
                reply(msg_id, error={"code": -32603, "message": str(e)})


if __name__ == "__main__":
    main()
