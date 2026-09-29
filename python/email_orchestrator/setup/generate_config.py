"""Generate the Claude Desktop / Antigravity entry that launches the Python orchestrator.

    python -m email_orchestrator.setup.generate_config            # write to config/generated/
    python -m email_orchestrator.setup.generate_config --install  # also merge into Claude Desktop

Difference from the TypeScript generator: secrets are NOT copied into the
client config. The entry only carries ``ENV_FILE`` (plus TLS/proxy variables),
and the orchestrator reads the API keys from ``.env`` itself — one place to
rotate a key, and no keys sitting in Claude's JSON.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

from ..core.config import find_env_file, project_root

PASSTHROUGH = (
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "NODE_USE_SYSTEM_CA", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
)


def claude_config_path() -> Path:
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Claude" / "claude_desktop_config.json"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    return home / ".config" / "Claude" / "claude_desktop_config.json"


def build_entry(env_path: Path) -> dict:
    env = {k: os.environ[k] for k in PASSTHROUGH if os.environ.get(k)}
    env["ENV_FILE"] = str(env_path)
    env["PYTHONUTF8"] = "1"
    return {"command": sys.executable, "args": ["-m", "email_orchestrator"], "env": env}


def install(target: Path, entry: dict) -> None:
    existing: dict = {}
    if target.exists():
        raw = target.read_text(encoding="utf-8").strip()
        try:
            existing = json.loads(raw) if raw else {}
        except ValueError as e:
            print(f"❌ Could not parse {target}; aborting to avoid data loss. ({e})")
            sys.exit(1)
        backup = target.with_name(f"{target.name}.bak-{datetime.now().strftime('%Y%m%dT%H%M%S')}")
        backup.write_text(raw + "\n", encoding="utf-8")
        print(f"🛟 Backed up existing config → {backup}")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
    merged = {**existing, "mcpServers": {**existing.get("mcpServers", {}), "email-orchestrator": entry}}
    target.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    others = [k for k in existing.get("mcpServers", {}) if k != "email-orchestrator"]
    print(f"✅ Installed into {target}" + (f" (kept: {', '.join(others)})" if others else ""))
    print("👉 Fully quit Claude Desktop (tray icon → Quit) and reopen it.")


def main() -> None:
    env_path = find_env_file() or (project_root() / ".env")
    entry = build_entry(env_path)
    out_dir = project_root() / "config" / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "claude_desktop_config.python.json"
    out.write_text(json.dumps({"mcpServers": {"email-orchestrator": entry}}, indent=2) + "\n", encoding="utf-8")
    print(f"✅ Wrote {out}")
    if not env_path.exists():
        print(f"⚠️  {env_path} does not exist yet — copy .env.example to .env and fill it in.")
    if "--install" in sys.argv:
        install(claude_config_path(), entry)
    else:
        print(f"Merge the 'email-orchestrator' entry into {claude_config_path()}, or re-run with --install.")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
