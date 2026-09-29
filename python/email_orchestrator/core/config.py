"""Configuration: read ``.env`` into a typed ``AppConfig``.

Everything the orchestrator needs to know about *your* setup (which accounts,
which LLM, when to send digests) lives in environment variables. This module is
the single place that reads them.

The downstream provider MCP servers (Gmail, IMAP) are Node.js packages. The
Python port launches them the same way the TypeScript build does: resolve the
package's entry file inside a ``node_modules`` folder and run it with ``node``
(falling back to ``npx -y <package>``).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

from ..utils.errors import ConfigError
from ..utils.logger import logger
from .types import (
    AppConfig,
    CacheConfig,
    EmailAccount,
    LLMConfig,
    McpConnectionConfig,
    NotificationConfig,
    ScheduleConfig,
)

_log = logger.child("config")

PACKAGE_DIR = Path(__file__).resolve().parent.parent


def _walk_up(start: Path, max_levels: int = 8):
    d = start
    for _ in range(max_levels):
        yield d
        if d.parent == d:
            return
        d = d.parent


def find_env_file() -> Path | None:
    """ENV_FILE if set; else the nearest ``.env`` walking up from this package; else ``cwd/.env``."""
    explicit = os.environ.get("ENV_FILE")
    if explicit:
        return Path(explicit)
    for d in _walk_up(PACKAGE_DIR):
        if (d / ".env").is_file():
            return d / ".env"
    cwd_env = Path.cwd() / ".env"
    return cwd_env if cwd_env.is_file() else None


def project_root() -> Path:
    """The directory holding ``.env`` (repo root in this layout)."""
    env_file = find_env_file()
    return env_file.parent if env_file else Path.cwd()


def load_env_file() -> Path | None:
    env_file = find_env_file()
    if env_file and env_file.is_file():
        # override=False: a variable already set in the real environment (e.g. by
        # Claude Desktop's config "env" block) wins over the file.
        load_dotenv(env_file, override=False)
    return env_file


def env(key: str, default: str | None = None) -> str:
    value = os.environ.get(key)
    if value not in (None, ""):
        return value  # type: ignore[return-value]
    if default is not None:
        return default
    raise ConfigError(f"Missing required environment variable: {key}")


def env_optional(key: str) -> str | None:
    value = os.environ.get(key)
    return value if value not in (None, "") else None


# ---------------------------------------------------------------- launching Node MCP servers

NPX = "npx.cmd" if sys.platform == "win32" else "npx"


def _node_modules_dirs() -> list[Path]:
    dirs: list[Path] = []
    override = env_optional("NODE_MODULES_DIR")
    if override:
        dirs.append(Path(override))
    for d in _walk_up(PACKAGE_DIR):
        if (d / "node_modules").is_dir():
            dirs.append(d / "node_modules")
    return dirs


def resolve_package_entry(pkg: str) -> str | None:
    """Find ``node_modules/<pkg>`` and return the absolute path of its bin (or main) file."""
    for nm in _node_modules_dirs():
        pkg_json = nm / pkg / "package.json"
        if not pkg_json.is_file():
            continue
        try:
            meta = json.loads(pkg_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rel = None
        binv = meta.get("bin")
        if isinstance(binv, str):
            rel = binv
        elif isinstance(binv, dict) and binv:
            first = next(iter(binv.values()))
            rel = first if isinstance(first, str) else None
        if not rel and isinstance(meta.get("main"), str):
            rel = meta["main"]
        if rel:
            entry = (pkg_json.parent / rel).resolve()
            if entry.is_file():
                return str(entry)
    return None


def parse_args_env(key: str, default: list[str]) -> list[str]:
    raw = env_optional(key)
    if not raw:
        return list(default)
    trimmed = raw.strip()
    if trimmed.startswith("["):
        try:
            parsed = json.loads(trimmed)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except ValueError:
            _log.warn(f"Could not parse {key} as JSON array; falling back to whitespace split")
    return trimmed.split()


def build_stdio_launcher(pkg: str, command_key: str, args_key: str, child_env: dict[str, str] | None = None) -> McpConnectionConfig:
    """How to start a Node MCP server: explicit override → local node_modules → npx."""
    override = env_optional(command_key)
    if override:
        return McpConnectionConfig(transport="stdio", command=override, args=parse_args_env(args_key, []), env=child_env)
    entry = resolve_package_entry(pkg)
    node = shutil.which("node")
    if entry and node:
        return McpConnectionConfig(transport="stdio", command=node, args=[entry], env=child_env)
    return McpConnectionConfig(transport="stdio", command=NPX, args=parse_args_env(args_key, ["-y", pkg]), env=child_env)


def _gmail_connection() -> McpConnectionConfig:
    return build_stdio_launcher("@gongrzhe/server-gmail-autoauth-mcp", "GMAIL_MCP_COMMAND", "GMAIL_MCP_ARGS")


def _zoho_connection() -> McpConnectionConfig | None:
    url = env_optional("ZOHO_MCP_URL")
    if not url:
        _log.warn("ZOHO_MCP_URL not set — Zoho account will be configured but not wired to an MCP server")
        return None
    token = env_optional("ZOHO_MCP_AUTH_TOKEN")
    return McpConnectionConfig(
        transport=env_optional("ZOHO_MCP_TRANSPORT") or "sse",  # type: ignore[arg-type]
        url=url,
        account_id=env_optional("ZOHO_MAIL_ACCOUNT_ID"),
        headers={"Authorization": f"Bearer {token}"} if token else None,
    )


# The IMAP MCP server also exposes send/delete/move tools. We tell the child
# process to register ONLY these read tools (plus account provisioning), so even
# a confused or prompt-injected model has no send tool to call.
IMAP_READONLY_TOOLS = "imap_list_accounts,imap_add_account,imap_get_latest_emails,imap_search_emails,imap_get_email"


def with_imap_guards(child_env: dict[str, str]) -> dict[str, str]:
    guarded = {**child_env, "IMAP_MCP_ENABLED_TOOLS": IMAP_READONLY_TOOLS}
    if (env_optional("IMAP_ALLOW_INSECURE_TLS") or "").lower() in ("1", "true", "yes", "on"):
        guarded["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
        _log.warn(
            "IMAP_ALLOW_INSECURE_TLS is set — disabling TLS certificate validation for the IMAP "
            "child process. Use this ONLY for local antivirus interception; never in production."
        )
    return guarded


def _imap_child_env(prefix: str, default_host: str, default_smtp: str, default_smtp_port: str) -> dict[str, str]:
    addr = env_optional(f"{prefix}_EMAIL") or ""
    password = env_optional(f"{prefix}_APP_PASSWORD") or ""
    host = env_optional(f"{prefix}_IMAP_HOST") or default_host
    port = env_optional(f"{prefix}_IMAP_PORT") or "993"
    smtp_host = env_optional(f"{prefix}_SMTP_HOST") or default_smtp
    smtp_port = env_optional(f"{prefix}_SMTP_PORT") or default_smtp_port
    return with_imap_guards(
        {
            "IMAP_HOST": host, "IMAP_PORT": port, "IMAP_USER": addr, "IMAP_PASSWORD": password, "IMAP_TLS": "true",
            "EMAIL_HOST": host, "EMAIL_PORT": port, "EMAIL_USER": addr, "EMAIL_PASSWORD": password,
            "SMTP_HOST": smtp_host, "SMTP_PORT": smtp_port, "SMTP_USER": addr, "SMTP_PASSWORD": password,
        }
    )


def _yahoo_connection() -> McpConnectionConfig:
    child = _imap_child_env("YAHOO", "imap.mail.yahoo.com", "smtp.mail.yahoo.com", "465")
    return build_stdio_launcher("imap-mcp-server", "YAHOO_MCP_COMMAND", "YAHOO_MCP_ARGS", child)


def _parse_tool_map(key: str) -> dict[str, str] | None:
    raw = env_optional(key)
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return {k: v for k, v in parsed.items() if isinstance(v, str)}
    except ValueError:
        _log.warn(f"Could not parse {key} as a JSON object; ignoring it.")
    return None


def _outlook_connection() -> McpConnectionConfig:
    url = env_optional("OUTLOOK_GRAPH_MCP_URL")
    command = env_optional("OUTLOOK_GRAPH_MCP_COMMAND")
    if url or command:
        _log.info("Outlook: using Microsoft Graph MCP (OAuth) connection")
        tool_map = _parse_tool_map("OUTLOOK_GRAPH_TOOLMAP")
        if url:
            token = env_optional("OUTLOOK_GRAPH_AUTH_TOKEN")
            return McpConnectionConfig(
                transport=env_optional("OUTLOOK_GRAPH_MCP_TRANSPORT") or "http",  # type: ignore[arg-type]
                url=url,
                headers={"Authorization": f"Bearer {token}"} if token else None,
                tool_map=tool_map,
            )
        return McpConnectionConfig(
            transport="stdio", command=command, args=parse_args_env("OUTLOOK_GRAPH_MCP_ARGS", []), tool_map=tool_map
        )
    child = _imap_child_env("OUTLOOK", "outlook.office365.com", "smtp-mail.outlook.com", "587")
    return build_stdio_launcher("imap-mcp-server", "OUTLOOK_MCP_COMMAND", "OUTLOOK_MCP_ARGS", child)


# ---------------------------------------------------------------- sections

VALID_LLM_PROVIDERS = ("gemini", "openai", "anthropic", "groq", "ollama", "custom")


def _llm_config() -> LLMConfig:
    provider = env("LLM_PROVIDER", "gemini")
    if provider not in VALID_LLM_PROVIDERS:
        raise ConfigError(f"Invalid LLM_PROVIDER: {provider}. Must be one of: {', '.join(VALID_LLM_PROVIDERS)}")
    return LLMConfig(
        provider=provider,
        model=env("LLM_MODEL", "gemma-3-27b-it"),
        api_key=env("LLM_API_KEY", ""),
        base_url=env_optional("LLM_BASE_URL"),
        max_tokens=int(env("LLM_MAX_TOKENS", "4096")),
        temperature=float(env("LLM_TEMPERATURE", "0.3")),
        requests_per_minute=int(env("LLM_REQUESTS_PER_MINUTE", "0") or 0),
    )


def _accounts() -> list[EmailAccount]:
    accounts: list[EmailAccount] = []
    if env_optional("GMAIL_CLIENT_ID") or env_optional("GMAIL_EMAIL"):
        accounts.append(
            EmailAccount(
                id=env("GMAIL_ACCOUNT_ID", "gmail-primary"), provider="gmail", email=env("GMAIL_EMAIL", ""),
                display_name=env("GMAIL_DISPLAY_NAME", "Gmail"), mcp_server_name=env("GMAIL_MCP_SERVER", "gmail"),
                connection=_gmail_connection(),
            )
        )
    if env_optional("ZOHO_MCP_URL") or env_optional("ZOHO_CLIENT_ID") or env_optional("ZOHO_EMAIL"):
        accounts.append(
            EmailAccount(
                id=env("ZOHO_ACCOUNT_ID", "zoho-primary"), provider="zoho", email=env("ZOHO_EMAIL", ""),
                display_name=env("ZOHO_DISPLAY_NAME", "Zoho Mail"), mcp_server_name=env("ZOHO_MCP_SERVER", "zoho-mail"),
                connection=_zoho_connection(),
            )
        )
    if env_optional("YAHOO_EMAIL"):
        accounts.append(
            EmailAccount(
                id=env("YAHOO_ACCOUNT_ID", "yahoo-primary"), provider="yahoo", email=env("YAHOO_EMAIL", ""),
                display_name=env("YAHOO_DISPLAY_NAME", "Yahoo Mail"), mcp_server_name=env("YAHOO_MCP_SERVER", "yahoo-mail"),
                connection=_yahoo_connection(),
            )
        )
    if env_optional("OUTLOOK_EMAIL"):
        accounts.append(
            EmailAccount(
                id=env("OUTLOOK_ACCOUNT_ID", "outlook-primary"), provider="outlook", email=env("OUTLOOK_EMAIL", ""),
                display_name=env("OUTLOOK_DISPLAY_NAME", "Outlook"),
                mcp_server_name=env("OUTLOOK_MCP_SERVER", "outlook-mail"), connection=_outlook_connection(),
            )
        )
    _log.info(
        f"Parsed {len(accounts)} email accounts",
        {"accounts": [{"id": a.id, "provider": a.provider, "email": a.email} for a in accounts]},
    )
    return accounts


def _schedule() -> ScheduleConfig:
    import re

    times = [t.strip() for t in env("DIGEST_SCHEDULE", "09:00").split(",")]
    times = [t for t in times if re.fullmatch(r"\d{2}:\d{2}", t)]
    if len(times) > 3:
        raise ConfigError("Maximum 3 scheduled digest times per day allowed")
    return ScheduleConfig(enabled=len(times) > 0, times=times, timezone=env("TIMEZONE", "Asia/Kolkata"))


def load_config() -> AppConfig:
    env_file = load_env_file()
    _log.info("Loading application configuration...", {"envFile": str(env_file) if env_file else None})
    config = AppConfig(
        llm=_llm_config(),
        accounts=_accounts(),
        schedule=_schedule(),
        notifications=NotificationConfig(
            enabled=env("NOTIFICATIONS_ENABLED", "true") == "true",
            sound=env("NOTIFICATIONS_SOUND", "true") == "true",
            urgent_only=env("NOTIFICATIONS_URGENT_ONLY", "false") == "true",
        ),
        cache=CacheConfig(
            enabled=env("CACHE_ENABLED", "true") == "true",
            ttl_seconds=int(env("CACHE_TTL", "300")),
            max_entries=int(env("CACHE_MAX_ENTRIES", "1000")),
        ),
        log_level=env("LOG_LEVEL", "info"),
    )
    _log.info(
        "Configuration loaded successfully",
        {
            "llmProvider": config.llm.provider,
            "llmModel": config.llm.model,
            "accountCount": len(config.accounts),
            "scheduleEnabled": config.schedule.enabled,
            "scheduleTimes": config.schedule.times,
            "notificationsEnabled": config.notifications.enabled,
        },
    )
    return config


def validate_config(config: AppConfig) -> list[str]:
    issues: list[str] = []
    if not config.llm.api_key and config.llm.provider not in ("ollama", "custom"):
        issues.append("LLM_API_KEY is not set — AI features will not work")
    if not config.accounts:
        issues.append("No email accounts configured — configure at least one provider")
    for a in config.accounts:
        if not a.email:
            issues.append(f"Account {a.id}: email address is not set")
    if len(config.schedule.times) > config.schedule.max_times_per_day:
        issues.append(f"Schedule: maximum {config.schedule.max_times_per_day} digest times per day")
    return issues
