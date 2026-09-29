#!/usr/bin/env bash
#
# Email AI Agent — onboarding script (macOS / Linux)
# Automates: dependency install, build, local provider-server installs,
# optional Gmail sign-in, connection test, and Claude Desktop config merge.
#
# Usage:   bash scripts/onboard.sh
# Manual steps it can't do for you (creating OAuth clients, Zoho connectors,
# app passwords) are called out with links to docs/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

bold() { printf "\n\033[1m\033[36m%s\033[0m\n" "$1"; }
info() { printf "  %s\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

bold "Email AI Agent — onboarding (macOS/Linux)"
info "Project: $ROOT"

# --- 1. Node check ---
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js not found. Install Node 20+ (e.g. 'brew install node') and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $(node -v) is too old; need 20+."
  exit 1
fi
ok "Node $(node -v)"

# --- 2. Install + build ---
bold "1) Installing dependencies & building"
npm install
npm run build
ok "Built dist/"

# --- 3. Local provider servers (reliable launch on all platforms) ---
bold "2) Installing provider MCP servers locally"
npm install @gongrzhe/server-gmail-autoauth-mcp imap-mcp-server
ok "Provider servers installed"

# --- 4. .env ---
bold "3) Checking .env"
if [ ! -f .env ]; then
  warn ".env not found."
  read -r -p "  Run the interactive setup wizard now? [Y/n] " ans || ans=""
  if [[ ! "$ans" =~ ^[Nn] ]]; then
    npm run setup
  else
    cp -n .env.example .env || true
    warn "Copied .env.example -> .env. Edit it (LLM_API_KEY, providers), then re-run this script."
    exit 0
  fi
fi
ok ".env present"

# --- 5. Gmail sign-in (optional, if a Gmail account is configured) ---
if grep -q '^GMAIL_EMAIL=' .env; then
  GMAIL_DIR="$HOME/.gmail-mcp"
  KEYS="$GMAIL_DIR/gcp-oauth.keys.json"
  if [ ! -f "$KEYS" ]; then
    CS="$(ls client_secret_*.json 2>/dev/null | head -1 || true)"
    if [ -n "$CS" ]; then
      mkdir -p "$GMAIL_DIR"; cp "$CS" "$KEYS"; ok "Copied $CS -> $KEYS"
    else
      warn "No client_secret_*.json found and ~/.gmail-mcp/gcp-oauth.keys.json missing."
      warn "Create a Desktop OAuth client (docs/GMAIL-SETUP.md), download the JSON here, then re-run."
    fi
  fi
  if [ -f "$KEYS" ] && [ ! -f "$GMAIL_DIR/credentials.json" ]; then
    read -r -p "  Run Gmail sign-in in the browser now? [y/N] " ans || ans=""
    if [[ "$ans" =~ ^[Yy] ]]; then
      npx @gongrzhe/server-gmail-autoauth-mcp auth
    fi
  fi
fi

# --- 6. Connection test (optional) ---
bold "4) Verifying connections"
read -r -p "  Run 'npm run test-connections' now? [Y/n] " ans || ans=""
if [[ ! "$ans" =~ ^[Nn] ]]; then
  npm run test-connections || warn "Some checks failed — see output and docs/TROUBLESHOOTING.md"
fi

# --- 7. Generate + merge Claude Desktop config ---
bold "5) Wiring into Claude Desktop"
npm run generate-config
GEN="$ROOT/config/generated/claude_desktop_config.json"

case "$(uname -s)" in
  Darwin) CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *)      CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
esac
mkdir -p "$(dirname "$CFG")"
if [ -f "$CFG" ]; then
  cp "$CFG" "$CFG.bak-$(date +%Y%m%d%H%M%S)"; ok "Backed up existing config"
fi

node -e '
const fs=require("fs");
const [c,g]=process.argv.slice(1);
const cur=fs.existsSync(c)?JSON.parse(fs.readFileSync(c,"utf8")):{};
const gen=JSON.parse(fs.readFileSync(g,"utf8"));
cur.mcpServers=cur.mcpServers||{};
cur.mcpServers["email-orchestrator"]=gen.mcpServers["email-orchestrator"];
fs.writeFileSync(c,JSON.stringify(cur,null,2)+"\n");
console.log("  merged mcpServers:",Object.keys(cur.mcpServers).join(", "));
' "$CFG" "$GEN"
ok "Merged into $CFG"

bold "Done! 🎉"
info "Fully quit and reopen Claude Desktop, then ask: \"summarize my inbox\"."
