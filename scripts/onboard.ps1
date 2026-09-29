# Email AI Agent — onboarding script (Windows PowerShell 5.1+)
# Automates: dependency install, build, local provider-server installs,
# optional Gmail sign-in, connection test, and Claude Desktop config merge.
#
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\onboard.ps1
#
# Manual steps it can't do for you (creating OAuth clients, Zoho connectors,
# app passwords) are called out with links to docs\.

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot   # scripts\ -> project root
Set-Location $Root

function Bold($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function DieIfFailed($label) { if ($LASTEXITCODE -ne 0) { Warn "$label failed (exit $LASTEXITCODE)"; exit 1 } }

Bold "Email AI Agent - onboarding (Windows)"
Info "Project: $Root"

# --- 1. Node check ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Warn "Node.js not found. Install Node 20+ and re-run."; exit 1
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Warn "Node $(node -v) is too old; need 20+."; exit 1 }
Ok "Node $(node -v)"

# --- 2. Install + build ---
Bold "1) Installing dependencies & building"
npm install;   DieIfFailed "npm install"
npm run build; DieIfFailed "npm run build"
Ok "Built dist\"

# --- 3. Local provider servers ---
Bold "2) Installing provider MCP servers locally"
npm install '@gongrzhe/server-gmail-autoauth-mcp' imap-mcp-server; DieIfFailed "npm install servers"
Ok "Provider servers installed"

# --- 4. .env ---
Bold "3) Checking .env"
if (-not (Test-Path .env)) {
  Warn ".env not found."
  $ans = Read-Host "  Run the interactive setup wizard now? [Y/n]"
  if ($ans -notmatch '^[Nn]') {
    npm run setup
  } else {
    Copy-Item .env.example .env -ErrorAction SilentlyContinue
    Warn "Copied .env.example -> .env. Edit it (LLM_API_KEY, providers), then re-run this script."
    exit 0
  }
}
Ok ".env present"

# --- 5. Gmail sign-in (optional) ---
if (Select-String -Path .env -Pattern '^GMAIL_EMAIL=' -Quiet) {
  $gdir = Join-Path $HOME ".gmail-mcp"
  $keys = Join-Path $gdir "gcp-oauth.keys.json"
  if (-not (Test-Path $keys)) {
    $cs = Get-ChildItem -Path . -Filter 'client_secret_*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cs) {
      New-Item -ItemType Directory -Force $gdir | Out-Null
      Copy-Item $cs.FullName $keys
      Ok "Copied $($cs.Name) -> $keys"
    } else {
      Warn "No client_secret_*.json here and ~\.gmail-mcp\gcp-oauth.keys.json missing."
      Warn "Create a Desktop OAuth client (docs\GMAIL-SETUP.md), download the JSON here, then re-run."
    }
  }
  if ((Test-Path $keys) -and -not (Test-Path (Join-Path $gdir 'credentials.json'))) {
    $ans = Read-Host "  Run Gmail sign-in in the browser now? [y/N]"
    if ($ans -match '^[Yy]') { npx '@gongrzhe/server-gmail-autoauth-mcp' auth }
  }
}

# --- 6. Connection test (optional) ---
Bold "4) Verifying connections"
$ans = Read-Host "  Run 'npm run test-connections' now? [Y/n]"
if ($ans -notmatch '^[Nn]') { npm run test-connections }

# --- 7. Generate + merge Claude Desktop config ---
Bold "5) Wiring into Claude Desktop"
npm run generate-config; DieIfFailed "generate-config"
$gen = Join-Path $Root "config\generated\claude_desktop_config.json"
$cfg = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
New-Item -ItemType Directory -Force (Split-Path $cfg) | Out-Null
if (Test-Path $cfg) {
  Copy-Item $cfg "$cfg.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Ok "Backed up existing config"
}

node -e "const fs=require('fs');const[c,g]=process.argv.slice(1);const cur=fs.existsSync(c)?JSON.parse(fs.readFileSync(c,'utf8')):{};const gen=JSON.parse(fs.readFileSync(g,'utf8'));cur.mcpServers=cur.mcpServers||{};cur.mcpServers['email-orchestrator']=gen.mcpServers['email-orchestrator'];fs.writeFileSync(c,JSON.stringify(cur,null,2)+'\n');console.log('  merged mcpServers:',Object.keys(cur.mcpServers).join(', '));" "$cfg" "$gen"
DieIfFailed "config merge"
Ok "Merged into $cfg"

Bold "Done!"
Info "Fully quit and reopen Claude Desktop, then ask: 'summarize my inbox'."
