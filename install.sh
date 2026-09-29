#!/usr/bin/env bash
#
# Email AI Agent — one-shot macOS installer for Claude Desktop.
#
# What it does (safe to re-run):
#   1. Checks macOS + Node.js 20+.
#   2. Installs dependencies and builds the orchestrator.
#   3. Makes sure a .env exists (runs the setup wizard if it doesn't).
#   4. Authorizes Gmail (browser sign-in) if a Gmail account is configured.
#   5. Merges the orchestrator into your Claude Desktop config (with a backup).
#
# The credential steps that need YOUR Google/Zoho/Yahoo login (creating the OAuth
# app, generating app passwords, getting your Zoho MCP URL) are NOT automated —
# they can't be. This script tells you exactly what to do and where, and skips a
# step gracefully if its credentials aren't ready yet. See docs/MACOS-DEPLOYMENT.md.
#
# Usage:   bash install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- pretty output -----------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$BOLD$CYN" "$*" "$RST"; }
ok()   { printf '  %s✅ %s%s\n' "$GRN" "$*" "$RST"; }
warn() { printf '  %s⚠️  %s%s\n' "$YLW" "$*" "$RST"; }
die()  { printf '  %s❌ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

printf '%s\n' "${BOLD}${CYN}"
cat <<'BANNER'
  ┌───────────────────────────────────────────────┐
  │   Email AI Agent · Claude Desktop installer    │
  └───────────────────────────────────────────────┘
BANNER
printf '%s' "$RST"
say "${DIM}Installing from: $SCRIPT_DIR${RST}"

# ---- 1. environment ----------------------------------------------------------
step "1/6  Checking your system"

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "This installer targets macOS. Detected: $(uname -s). Continuing, but Claude Desktop paths assume macOS."
else
  ok "macOS detected"
fi

if ! command -v node >/dev/null 2>&1; then
  say ""
  die "Node.js is not installed. Install the LTS version, then re-run this script:
       • Easiest: download the macOS installer from ${BOLD}https://nodejs.org${RST} (pick the LTS button) and run it.
       • Or with Homebrew:  ${BOLD}brew install node${RST}"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  die "Node.js 20+ is required (found $(node -v)). Update from https://nodejs.org and re-run."
fi
ok "Node.js $(node -v)"
command -v npm >/dev/null 2>&1 || die "npm was not found alongside Node.js. Reinstall Node.js from https://nodejs.org."

# ---- 2. dependencies + build -------------------------------------------------
step "2/6  Installing dependencies and building (this can take a couple of minutes)"

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
ok "Dependencies installed"

npm run build
[[ -f dist/index.js ]] || die "Build did not produce dist/index.js. Scroll up for the error above."
ok "Built dist/index.js"

# ---- 3. .env -----------------------------------------------------------------
step "3/6  Checking configuration (.env)"

if [[ ! -f .env ]]; then
  warn "No .env file found."
  if [[ -t 0 ]]; then
    say "  You can either paste a .env prepared for you (recommended for non-technical setup),"
    say "  or answer a few questions now to create one."
    read -r -p "  Run the setup wizard now? [y/N] " reply
    if [[ "${reply:-}" =~ ^[Yy] ]]; then
      npm run setup
    fi
  fi
  [[ -f .env ]] || die "Still no .env. Get the .env file prepared for this person (see docs/MACOS-DEPLOYMENT.md) and place it at:
       $SCRIPT_DIR/.env
     then re-run this script."
fi
ok ".env present"

# small helper: read a KEY=value from .env (strips surrounding quotes)
env_get() { sed -n "s/^$1=//p" .env | head -n1 | sed 's/^"//; s/"$//'; }

# The agent connects to EVERY account present in .env — not just Gmail.
say ""
say "  ${BOLD}Mail accounts found in .env:${RST}"
found_any=0
show_acct() {  # $1 label  $2 env-key  $3 note
  local val; val="$(env_get "$2" || true)"
  if [[ -n "$val" ]]; then printf '    • %-8s → %s  %s%s%s\n' "$1" "$val" "$DIM" "$3" "$RST"; found_any=1; fi
}
show_acct "Gmail"   GMAIL_EMAIL   "(one-time browser sign-in, below)"
show_acct "Zoho"    ZOHO_EMAIL    "(via ZOHO_MCP_URL — no sign-in step)"
show_acct "Yahoo"   YAHOO_EMAIL   "(via app password — no sign-in step)"
show_acct "Outlook" OUTLOOK_EMAIL "(via app password — no sign-in step)"
[[ "$found_any" -eq 1 ]] || warn "No mail accounts in .env (no *_EMAIL keys) — add at least one or the agent has nothing to read."

LLM_KEY="$(env_get LLM_API_KEY || true)"
[[ -n "${LLM_KEY:-}" ]] || warn "LLM_API_KEY is empty in .env — AI features won't work until it's set (ask for the shared Gemini key)."

# ---- 4. Gmail authorization (only if a Gmail account is configured) ----------
step "4/6  Gmail sign-in (the only account type that needs one)"

GMAIL_EMAIL="$(env_get GMAIL_EMAIL || true)"
if [[ -z "${GMAIL_EMAIL:-}" ]]; then
  say "  ${DIM}No Gmail account in .env — skipping.${RST}"
else
  KEYS="$HOME/.gmail-mcp/gcp-oauth.keys.json"
  TOKEN="$HOME/.gmail-mcp/credentials.json"
  if [[ -f "$TOKEN" ]]; then
    ok "Gmail already authorized for a Google account (token found)"
  elif [[ ! -f "$KEYS" ]]; then
    warn "Google OAuth keys not found at: $KEYS"
    say  "     Gmail needs a one-time Google sign-in. Ask for the shared ${BOLD}gcp-oauth.keys.json${RST} file,"
    say  "     create the folder and place it there:"
    say  "        ${BOLD}mkdir -p ~/.gmail-mcp && cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp/${RST}"
    say  "     then re-run this script (or authorize later — see docs/MACOS-DEPLOYMENT.md)."
  else
    say "  Opening a browser so you can sign in to ${BOLD}$GMAIL_EMAIL${RST} and approve access…"
    if npx --yes @gongrzhe/server-gmail-autoauth-mcp auth; then
      ok "Gmail authorized"
    else
      warn "Gmail authorization didn't complete. You can re-run this script to try again."
    fi
  fi
fi

# ---- 5. verify every configured account connects (optional, non-fatal) -------
step "5/6  Verifying your accounts connect"
if [[ -t 0 ]]; then
  read -r -p "  Test the LLM + all mail accounts now? (~1 min) [Y/n] " do_verify
  if [[ ! "${do_verify:-}" =~ ^[Nn] ]]; then
    if npm run test-connections; then
      ok "All configured accounts connected"
    else
      warn "Some checks failed above — the agent is still safe to install. Fix the flagged credential(s) and re-run."
    fi
  else
    say "  ${DIM}Skipped. Run 'npm run test-connections' anytime to verify.${RST}"
  fi
else
  say "  ${DIM}Non-interactive shell — skipping the live test. Run 'npm run test-connections' to verify.${RST}"
fi

# ---- 6. wire into Claude Desktop ---------------------------------------------
step "6/6  Adding the agent to Claude Desktop"
npx --yes tsx src/setup/config-generator.ts --install

say ""
say "${BOLD}${GRN}Done.${RST}"
say "Next:"
say "  1. ${BOLD}Fully quit Claude Desktop${RST} (Cmd+Q — not just the red dot) and reopen it."
say "  2. In a chat, try:  ${BOLD}\"Summarize my inbox across all accounts\"${RST}"
say ""
say "${DIM}If a step above was skipped for missing credentials, finish it using docs/MACOS-DEPLOYMENT.md,${RST}"
say "${DIM}then just run  bash install.sh  again — it's safe to re-run.${RST}"
