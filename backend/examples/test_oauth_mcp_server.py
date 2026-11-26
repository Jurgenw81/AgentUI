"""A local MCP server that requires OAuth login, for testing AgentUI's "Log in" flow.

    backend/.venv/bin/python backend/examples/test_oauth_mcp_server.py      # → http://localhost:8799/mcp

It runs a tiny in-memory OAuth server (dynamic client registration + PKCE). The consent screen
is a single "Allow" button, so you can try the full browser login without any real account.
"""
import secrets
import sys
import time

from mcp.server.auth.provider import (AccessToken, AuthorizationCode, AuthorizationParams, RefreshToken,
                                      construct_redirect_uri)
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from mcp.server.mcpserver import MCPServer
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse
from starlette.routing import Route

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
BASE = f"http://localhost:{PORT}"
AUTO_APPROVE = "--auto" in sys.argv  # skip the consent page (used by automated tests)


class MemoryProvider:
    def __init__(self):
        self.clients: dict[str, OAuthClientInformationFull] = {}
        self.codes: dict[str, AuthorizationCode] = {}
        self.tokens: dict[str, AccessToken] = {}
        self.refresh: dict[str, RefreshToken] = {}
        self.pending: dict[str, tuple[str, AuthorizationParams]] = {}

    async def get_client(self, client_id):
        return self.clients.get(client_id)

    async def register_client(self, client_info):
        self.clients[client_info.client_id] = client_info

    async def authorize(self, client, params):
        req_id = secrets.token_urlsafe(16)
        self.pending[req_id] = (client.client_id, params)
        if AUTO_APPROVE:
            return self.approve(req_id)
        return f"{BASE}/consent?req={req_id}"

    def approve(self, req_id: str) -> str:
        client_id, params = self.pending.pop(req_id)
        code = secrets.token_urlsafe(24)
        self.codes[code] = AuthorizationCode(
            code=code, scopes=params.scopes or [], expires_at=time.time() + 300, client_id=client_id,
            code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly, resource=params.resource)
        return construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)

    async def load_authorization_code(self, client, authorization_code):
        return self.codes.get(authorization_code)

    async def exchange_authorization_code(self, client, authorization_code):
        self.codes.pop(authorization_code.code, None)
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client, refresh_token):
        return self.refresh.get(refresh_token)

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        self.refresh.pop(refresh_token.token, None)
        return self._issue(client.client_id, scopes or refresh_token.scopes, refresh_token.resource)

    async def load_access_token(self, token):
        t = self.tokens.get(token)
        return t if t and (t.expires_at is None or t.expires_at > time.time()) else None

    async def revoke_token(self, token):
        self.tokens.pop(token.token, None)
        self.refresh.pop(token.token, None)

    async def exchange_identity_assertion(self, client, params):
        raise NotImplementedError

    def _issue(self, client_id, scopes, resource):
        access, refresh = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        self.tokens[access] = AccessToken(token=access, client_id=client_id, scopes=scopes,
                                          expires_at=int(time.time()) + 3600, resource=resource)
        self.refresh[refresh] = RefreshToken(token=refresh, client_id=client_id, scopes=scopes, resource=resource)
        return OAuthToken(access_token=access, token_type="Bearer", expires_in=3600, refresh_token=refresh,
                          scope=" ".join(scopes) if scopes else None)


provider = MemoryProvider()
app = MCPServer(
    "oauth-test-server",
    auth_server_provider=provider,
    auth=AuthSettings(issuer_url=BASE, resource_server_url=f"{BASE}/mcp",
                      client_registration_options=ClientRegistrationOptions(enabled=True)),
)


@app.tool()
def whoami() -> str:
    """Confirm that the OAuth login worked."""
    return "You are logged in to the OAuth test server. 🎉"


@app.tool()
def send_test_message(to: str, text: str) -> str:
    """Pretend to send a message (nothing is actually sent). Use it to test risky-tool approvals."""
    return f"(pretend) message to {to}: {text!r} was 'sent'"


async def consent(request: Request):
    req_id = request.query_params.get("req", "")
    if request.method == "POST" and req_id in provider.pending:
        return RedirectResponse(provider.approve(req_id), status_code=302)
    return HTMLResponse(f"""<body style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center">
      <h2>OAuth test server</h2><p><b>AgentUI</b> wants to use your (pretend) account.</p>
      <form method="post"><input type="hidden" name="req" value="{req_id}">
      <button style="font-size:16px;padding:10px 24px">Allow</button></form></body>""")


if __name__ == "__main__":
    import uvicorn
    web = app.streamable_http_app()
    web.router.routes.append(Route("/consent", consent, methods=["GET", "POST"]))
    uvicorn.run(web, host="127.0.0.1", port=PORT, log_level="warning")
