"""Multi-provider model layer built on LiteLLM.

Model ids use the form "<provider>/<model>", e.g.
  anthropic/claude-sonnet-5-5, openai/gpt-5, gemini/gemini-2.5-flash,
  ollama/llama3.1, openrouter/meta-llama/llama-3.3-70b-instruct, custom/my-model
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Awaitable, Callable

import httpx
import litellm

from . import db

litellm.drop_params = True  # silently drop params a provider doesn't support
litellm.suppress_debug_info = True
logging.getLogger("LiteLLM").setLevel(logging.WARNING)

PROVIDERS: dict[str, dict[str, Any]] = {
    "claude-code": {
        "label": "Claude subscription (via Claude Code)",
        "kind": "subscription",
        "fields": [],
        "suggested": ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
    },
    "chatgpt": {
        "label": "ChatGPT subscription (via Codex)",
        "kind": "subscription",
        "fields": [],
        "suggested": [],
    },
    "gemini-cli": {
        "label": "Gemini (Google account, via Gemini CLI)",
        "kind": "subscription",
        "fields": [],
        "suggested": [],
    },
    "ollama": {
        "label": "Ollama (local)",
        "kind": "local",
        "fields": ["base_url"],
        "defaults": {"base_url": "http://localhost:11434"},
        "suggested": [],
    },
    "anthropic": {
        "label": "Anthropic (Claude)",
        "fields": ["api_key"],
        "suggested": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
    },
    "openai": {
        "label": "OpenAI",
        "fields": ["api_key"],
        "suggested": ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o-mini"],
    },
    "gemini": {
        "label": "Google Gemini",
        "fields": ["api_key"],
        "suggested": ["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    "openrouter": {
        "label": "OpenRouter",
        "fields": ["api_key"],
        "suggested": ["meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-chat"],
    },
    "custom": {
        "label": "OpenAI-compatible (LM Studio, vLLM, Groq...)",
        "fields": ["base_url", "api_key"],
        "defaults": {"base_url": "http://localhost:1234/v1"},
        "suggested": [],
    },
}


# subscription providers -> function in cli_agent that runs an agent through that CLI
CLI_RUNNERS = {"claude-code": "run_claude_code", "chatgpt": "run_codex", "gemini-cli": "run_gemini"}


def provider_of(model: str) -> str:
    return model.split("/", 1)[0] if "/" in model else "openai"


# ---------- Ollama helpers ----------

FIRST_OLLAMA: dict[str, str] = {}  # remembers an installed chat model for the default-model fallback
_ollama_caps: dict[str, list[str]] = {}


def _human_size(n: int) -> str:
    return f"{n / 1e9:.1f} GB" if n >= 1e9 else f"{n / 1e6:.0f} MB"


async def _ollama_show(client: httpx.AsyncClient, base: str, name: str) -> list[str]:
    if name in _ollama_caps:
        return _ollama_caps[name]
    try:
        r = await client.post(f"{base}/api/show", json={"model": name})
        r.raise_for_status()
        caps = r.json().get("capabilities") or ["completion"]
    except Exception:  # noqa: BLE001 - older Ollama: assume chat, no tool info
        caps = ["completion"]
    _ollama_caps[name] = caps
    return caps


async def ollama_models() -> tuple[list[dict], str | None]:
    """Installed Ollama models with details. Returns (models, error)."""
    base = provider_config("ollama").get("base_url", "").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get(f"{base}/api/tags")
            r.raise_for_status()
            raw = r.json().get("models", [])
            caps = await asyncio.gather(*(_ollama_show(c, base, m["name"]) for m in raw))
    except Exception as e:  # noqa: BLE001
        return [], f"Ollama isn't reachable at {base} ({type(e).__name__})"
    out = []
    for m, cap in zip(raw, caps):
        d = m.get("details") or {}
        out.append({
            "name": m["name"],
            "size": _human_size(m.get("size") or 0),
            "params": d.get("parameter_size") or "",
            "family": d.get("family") or "",
            "quant": d.get("quantization_level") or "",
            "chat": "completion" in cap,
            "tools": "tools" in cap,
            "vision": "vision" in cap,
        })
    chat = [m for m in out if m["chat"]]
    if chat:
        best = next((m for m in chat if m["tools"]), chat[0])
        FIRST_OLLAMA["model"] = f"ollama/{best['name']}"
    return out, None


async def ollama_supports_tools(model: str) -> bool:
    name = model.split("/", 1)[1]
    if name not in _ollama_caps:
        await ollama_models()
    return "tools" in _ollama_caps.get(name, ["tools"])


def provider_config(provider: str) -> dict:
    cfg = dict(PROVIDERS.get(provider, {}).get("defaults", {}))
    cfg.update({k: v for k, v in (db.get_setting("providers", {}) or {}).get(provider, {}).items() if v})
    if not cfg.get("api_key") and os.environ.get(f"{provider.upper()}_API_KEY"):
        cfg["api_key"] = os.environ[f"{provider.upper()}_API_KEY"]
    return cfg


def resolve(model: str) -> tuple[str, dict]:
    """Turn our model id into (litellm_model, extra kwargs)."""
    if "/" not in model:
        model = f"openai/{model}"
    provider, name = model.split("/", 1)
    cfg = provider_config(provider)
    kwargs: dict[str, Any] = {}
    if provider == "ollama":
        kwargs["api_base"] = cfg.get("base_url")
        return f"ollama_chat/{name}", kwargs
    if provider == "custom":
        kwargs["api_base"] = cfg.get("base_url")
        kwargs["api_key"] = cfg.get("api_key") or "not-needed"
        return f"openai/{name}", kwargs
    if cfg.get("api_key"):
        kwargs["api_key"] = cfg["api_key"]
    return f"{provider}/{name}", kwargs


async def list_models() -> dict[str, dict]:
    """Ask each provider which models it has. Shape per provider:
    {label, kind, configured, live, error, models: [ids], info: {id: {detail, tools}}, status?}"""
    from . import cli_agent  # local import: cli_agent imports db only

    async def fetch(provider: str) -> dict:
        info = PROVIDERS[provider]
        cfg = provider_config(provider)
        saved = (db.get_setting("providers", {}) or {}).get(provider, {})
        result: dict[str, Any] = {"label": info["label"], "kind": info.get("kind", "api"), "info": {}}
        models: list[str] = []
        error = None

        if provider == "claude-code":
            st = await cli_agent.claude_status()
            result["status"] = st
            configured = st["installed"] and st["logged_in"]
            if not st["installed"]:
                error = "Claude Code isn't installed."
            elif not st["logged_in"]:
                error = "Claude Code is installed but not logged in. Run `claude` in a terminal and log in."
            models = info["suggested"] if configured else []
            return {**result, "configured": configured, "live": configured, "error": error,
                    "models": [f"{provider}/{m}" for m in (models or info["suggested"])]}

        if provider == "chatgpt":
            st = await cli_agent.codex_status()
            result["status"] = {k: st[k] for k in ("installed", "logged_in", "method", "detail")}
            configured = st["installed"] and st["logged_in"]
            if not st["installed"]:
                error = "Codex CLI isn't installed."
            elif not st["logged_in"]:
                error = "Codex is installed but not logged in. Run `codex login` in a terminal."
            ids = [m["id"] for m in st["models"]]
            result["names"] = {f"chatgpt/{m['id']}": m["name"] for m in st["models"]}
            return {**result, "configured": configured, "live": bool(ids), "error": error,
                    "models": [f"chatgpt/{m}" for m in ids]}

        if provider == "gemini-cli":
            st = await cli_agent.gemini_status()
            result["status"] = {k: st[k] for k in ("installed", "logged_in", "method", "detail")}
            configured = st["installed"] and st["logged_in"]
            if not st["installed"]:
                error = "Gemini CLI isn't installed."
            elif not st["logged_in"]:
                error = "Gemini CLI is installed but not logged in. Run `gemini` in a terminal and choose Login with Google."
            return {**result, "configured": configured, "live": configured, "error": error,
                    "models": [f"gemini-cli/{m}" for m in st["models"]]}

        if provider == "ollama":
            found, error = await ollama_models()
            chat = [m for m in found if m["chat"]]
            for m in chat:
                bits = [b for b in (m["params"], m["size"]) if b]
                result["info"][f"ollama/{m['name']}"] = {"detail": " · ".join(bits), "tools": m["tools"]}
            result["installed"] = found
            if not error and not chat:
                error = "Ollama is running but has no chat models. Install one with: ollama pull llama3.1"
            return {**result, "configured": error is None or bool(chat), "live": bool(chat), "error": error,
                    "models": [f"ollama/{m['name']}" for m in chat]}

        configured = bool(saved.get("base_url")) if provider == "custom" else bool(cfg.get("api_key"))
        if configured:
            try:
                async with httpx.AsyncClient(timeout=6) as c:
                    if provider == "anthropic":
                        r = await c.get("https://api.anthropic.com/v1/models?limit=100",
                                        headers={"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01"})
                        r.raise_for_status()
                        models = [m["id"] for m in r.json()["data"]]
                    elif provider == "openai":
                        r = await c.get("https://api.openai.com/v1/models",
                                        headers={"Authorization": f"Bearer {cfg['api_key']}"})
                        r.raise_for_status()
                        models = sorted(m["id"] for m in r.json()["data"]
                                        if m["id"].startswith(("gpt", "o1", "o3", "o4", "o5", "chatgpt")))
                    elif provider == "gemini":
                        r = await c.get("https://generativelanguage.googleapis.com/v1beta/models",
                                        params={"key": cfg["api_key"], "pageSize": 200})
                        r.raise_for_status()
                        models = [m["name"].removeprefix("models/") for m in r.json()["models"]
                                  if "generateContent" in m.get("supportedGenerationMethods", [])]
                    elif provider == "openrouter":
                        r = await c.get("https://openrouter.ai/api/v1/models")
                        r.raise_for_status()
                        models = sorted(m["id"] for m in r.json()["data"])
                    elif provider == "custom":
                        headers = {"Authorization": f"Bearer {cfg['api_key']}"} if cfg.get("api_key") else {}
                        r = await c.get(cfg["base_url"].rstrip("/") + "/models", headers=headers)
                        r.raise_for_status()
                        models = [m["id"] for m in r.json()["data"]]
            except Exception as e:  # noqa: BLE001
                error = f"{type(e).__name__}: {e}"[:200]
        return {**result, "configured": configured, "live": bool(models), "error": error,
                "models": [f"{provider}/{m}" for m in (models or info["suggested"])]}

    results = await asyncio.gather(*(fetch(p) for p in PROVIDERS))
    return dict(zip(PROVIDERS, results))


def _cost(response: Any) -> float:
    try:
        return float(litellm.completion_cost(completion_response=response) or 0.0)
    except Exception:  # noqa: BLE001 - unknown models have no price info
        return 0.0


async def stream_chat(
    model: str,
    messages: list[dict],
    *,
    tools: list[dict] | None = None,
    temperature: float | None = None,
    on_token: Callable[[str], Awaitable[None]] | None = None,
) -> dict:
    """Stream one model turn. Returns {content, tool_calls, usage, cost}."""
    lm_model, kwargs = resolve(model)
    if temperature is not None:
        kwargs["temperature"] = temperature
    if tools:
        kwargs["tools"] = tools
    response = await litellm.acompletion(
        model=lm_model, messages=messages, stream=True,
        stream_options={"include_usage": True}, **kwargs,
    )
    chunks = []
    async for chunk in response:
        chunks.append(chunk)
        try:
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", None)
        except (IndexError, AttributeError):
            text = None
        if text and on_token:
            await on_token(text)

    full = litellm.stream_chunk_builder(chunks, messages=messages)
    msg = full.choices[0].message
    tool_calls = []
    for tc in msg.tool_calls or []:
        tool_calls.append({
            "id": tc.id,
            "type": "function",
            "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"},
        })
    usage = getattr(full, "usage", None)
    return {
        "content": msg.content or "",
        "tool_calls": tool_calls,
        "usage": {
            "input": getattr(usage, "prompt_tokens", 0) or 0,
            "output": getattr(usage, "completion_tokens", 0) or 0,
        },
        "cost": _cost(full),
    }


async def test_model(model: str) -> str:
    if provider_of(model) in CLI_RUNNERS:
        from . import cli_agent

        async def _noop(_e: dict) -> None:
            pass

        async def _no_tools(_n: str, _a: str) -> str:
            return ""

        out = await getattr(cli_agent, CLI_RUNNERS[provider_of(model)])(
            model=model.split("/", 1)[1], system_prompt="You are terse.",
            messages=[{"role": "user", "content": "Reply with exactly: OK"}],
            schemas=[], call_tool=_no_tools, emit=_noop, max_steps=1)
        return out["output"].strip()[:100]
    out = await stream_chat(model, [{"role": "user", "content": "Reply with exactly: OK"}])
    return out["content"].strip()[:100]
