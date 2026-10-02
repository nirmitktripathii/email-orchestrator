# Full Setup Guide — Email AI Agent on a New Machine (macOS & Windows)

This is the complete, start-to-finish guide for standing up the Email AI Agent on a fresh
computer and connecting **Gmail, Outlook, Zoho, and Yahoo** to **Claude Desktop**. It bakes
in every lesson learned during the first (Windows + Gmail) rollout so you don't hit the same
walls twice.

> **What you'll end up with:** one `email-orchestrator` MCP server in Claude Desktop that
> consolidates all your inboxes, with AI summaries, 8-tier categorization, urgency scoring,
> action suggestions, smart-reply drafts, and scheduled digests. The agent does **not send
> mail** by default — it only drafts. (An optional `send_email` tool exists but is off unless
> you set `EMAIL_SEND_ENABLED=true`; see the README.)

---

## 0. How it fits together (read this once)

```
Claude Desktop  ──MCP──►  email-orchestrator (this repo)
                              ├── AI engine (Gemini/Gemma, swappable)
                              ├── Gmail  server  → node .../server-gmail-autoauth-mcp
                              ├── Zoho   server  → remote mcp.zoho.com (.in)
                              ├── Yahoo  server  → node .../imap-mcp-server (IMAP)
                              └── Outlook server → node .../imap-mcp-server (IMAP)
```

The orchestrator is the only custom piece. It launches the provider MCP servers itself and
re-exposes 17 unified tools to Claude Desktop.

---

## 1. Prerequisites (both OSes)

- **Node.js 20+** (22 recommended). Check: `node --version`.
  - macOS: `brew install node` or use `nvm`.
  - Windows: installer from nodejs.org, or `winget install OpenJS.NodeJS.LTS`.
- **Claude Desktop** installed and signed in.
- **A Gemini API key** — https://aistudio.google.com/apikey (free tier is fine). Any
  OpenAI/Anthropic/Groq/Ollama key also works; you pick the provider in `.env`.
- The project folder copied to the new machine (or `git clone`).

---

## 2. Base install (both OSes)

### ⚡ Fast path — one script does §2, §4-part, §5, §6

After you've done the manual provider auth in §3 (OAuth clients, app passwords), a single
script automates install + build + local server installs + optional Gmail sign-in +
connection test + Claude Desktop config merge (with backup):

```bash
# macOS / Linux
bash scripts/onboard.sh
```
```powershell
# Windows PowerShell (from the project folder)
powershell -ExecutionPolicy Bypass -File scripts\onboard.ps1
```

It prompts before each optional step and can run `npm run setup` for you if `.env` is
missing. Prefer the manual steps below if you want full control. Either way, finish by
restarting Claude Desktop.

### Manual base install

From the project root:

```bash
npm install
npm run build
```

Then **install the provider servers locally** — this is important on Windows and harmless on
macOS (it lets the orchestrator launch them via **direct Node**, which avoids a Windows
`npx.cmd` stdin bug — see §8):

```bash
# Gmail (always, if you use Gmail)
npm install @gongrzhe/server-gmail-autoauth-mcp
# Yahoo and/or Outlook (IMAP)
npm install imap-mcp-server
```

---

## 3. Provider setup

Do the ones you need. Each writes a few values into `.env` (the wizard in §4 collects them).

### 3a. Gmail  (per-account — repeat for each Gmail)

1. **Google Cloud Console** → create/pick a project.
2. **APIs & Services → Library → enable "Gmail API".**
3. **Google Auth Platform → Audience:** set **User type = External**, keep **Publishing
   status = Testing**, and under **Test users → + Add users**, add every Gmail address you
   will connect. *(Skipping this is the #1 cause of "Access blocked" at sign-in.)*
4. **Clients → Create client → Application type = Desktop app.** Name it, Create, then
   **download the JSON** (`client_secret_….json`).
5. Put the JSON where the Gmail server expects it and authorize once:
   ```bash
   # create the config dir
   #   macOS/Linux:  mkdir -p ~/.gmail-mcp
   #   Windows (Git Bash): mkdir -p ~/.gmail-mcp
   # copy the downloaded file to ~/.gmail-mcp/gcp-oauth.keys.json, then:
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```
   A browser opens → pick the account → **"Google hasn't verified this app" → Advanced →
   Go to … (unsafe) → Allow** (grant both Gmail scopes) → "authentication successful". The
   token is saved to `~/.gmail-mcp/credentials.json`.
   - The consent screen shows your **OAuth consent "App name"** (Branding), which may differ
     from the client name — that's cosmetic.
6. In `.env`: `GMAIL_EMAIL=you@gmail.com`.

Full details: [GMAIL-SETUP.md](GMAIL-SETUP.md).

### 3b. Zoho Mail  (official hosted MCP)

1. Sign in at **mcp.zoho.com**, create an **MCP connector for Zoho Mail**, choose the
   **India (.in)** data center, authorize mail scopes.
2. Copy the connector **URL** (and token if issued).
3. In `.env`:
   ```ini
   ZOHO_EMAIL=you@yourdomain.com
   ZOHO_REGION=in
   ZOHO_MCP_URL=https://mcp.zoho.in/...
   ZOHO_MCP_TRANSPORT=sse        # or http
   ZOHO_MCP_AUTH_TOKEN=          # only if issued
   ```

Full details: [ZOHO-SETUP.md](ZOHO-SETUP.md).

### 3c. Yahoo Mail  (IMAP + app password)

1. Yahoo → **Account Security → Two-step verification → On**, then **Generate app password**.
2. In `.env`:
   ```ini
   YAHOO_EMAIL=you@yahoo.com
   YAHOO_APP_PASSWORD=the-app-password
   ```

Full details: [YAHOO-SETUP.md](YAHOO-SETUP.md).

### 3d. Outlook  (IMAP + app password for personal; OAuth for M365)

- **Personal Outlook.com/Hotmail:** account.microsoft.com → Security → **two-step
  verification on** → **App passwords → create**. Then in `.env`:
  ```ini
  OUTLOOK_EMAIL=you@outlook.com
  OUTLOOK_APP_PASSWORD=the-app-password
  ```
- **Microsoft 365 work/school:** IMAP basic-auth is often disabled by policy — use a
  Microsoft Graph MCP server + Azure AD app instead. See
  [OUTLOOK-SETUP.md](OUTLOOK-SETUP.md).

---

## 4. Configure `.env`

Run the interactive wizard (recommended) — it walks LLM + every provider:

```bash
npm run setup
```

Or copy `.env.example` to `.env` and edit by hand. **Model tips:**
- Set a **real** model. Good defaults: `gemini-2.0-flash` (fast, generous free tier) or a
  current Gemma like `gemma-3-27b-it`/`gemma-4-31b-it`. A wrong name fails with a 404.
- Timezone must be a real IANA zone, e.g. `Asia/Kolkata` (not `y`!).
- `URGENT_POLL_MINUTES=0` disables the real-time urgent monitor; set e.g. `60` to enable it
  (it uses API quota).

---

## 5. Verify connectivity (do this before touching Claude Desktop)

```bash
npm run test-connections
```

You want:
```
LLM:       OK
Providers: OK        (each account: connected · listed N email(s))
```
Fix any ❌ now — see §8 and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 6. Wire it into Claude Desktop

Generate a ready-to-merge config (it also forwards your **TLS/proxy CA** vars — see §8):

```bash
npm run generate-config
```

This writes `config/generated/claude_desktop_config.json`. Merge its `email-orchestrator`
entry into your real Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

If the file already has an `mcpServers` block, **add** the `email-orchestrator` key alongside
the others (don't overwrite). A safe merge with `node`:

```bash
# macOS example — adjust the project path
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
GEN="/path/to/project/config/generated/claude_desktop_config.json"
cp "$CFG" "$CFG.bak" 2>/dev/null
node -e 'const fs=require("fs");const[c,g]=process.argv.slice(1);const cur=fs.existsSync(c)?JSON.parse(fs.readFileSync(c,"utf8")):{};const gen=JSON.parse(fs.readFileSync(g,"utf8"));cur.mcpServers=cur.mcpServers||{};cur.mcpServers["email-orchestrator"]=gen.mcpServers["email-orchestrator"];fs.writeFileSync(c,JSON.stringify(cur,null,2)+"\n");console.log("merged:",Object.keys(cur.mcpServers).join(", "))' "$CFG" "$GEN"
```

Then **fully quit and reopen Claude Desktop** (not just close the window).

> **Note:** the generated config embeds your API key and (on the source machine) any AV/proxy
> CA paths. Keep that file private; it's already covered by `.gitignore`.

---

## 7. Use it

In Claude Desktop, ask:
- "Summarize my inbox across all accounts."
- "What's urgent today?" / "Prioritize my unread email."
- "Draft a reply to the email from … about …" (drafts only — never auto-sends).
- "Give me my daily digest."

Optional: paste `config/prompts/system-prompt.md` into your Claude project instructions so
the agent leads with the right behavior.

---

## 8. Gotchas we already solved (so you don't have to)

| Symptom | Cause | Fix (already built in) |
|---|---|---|
| Provider "Request timed out" at connect on **Windows** | Node 22 won't spawn `.cmd`, and `npx.cmd` doesn't forward stdin to the server | The orchestrator launches servers via **direct Node** when the package is installed locally — so **`npm install` the server packages** (§2). |
| "unable to verify the first certificate" | Antivirus/proxy (e.g. **Avast**) does HTTPS inspection; Node doesn't trust its CA | The orchestrator passes the **full environment** (incl. `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`) to child servers, and `generate-config` forwards these into the Claude Desktop config. On macOS this is rarely needed unless behind a corporate proxy. |
| Gmail sign-in "Access blocked / not verified" | App is *External + Testing* with no test users | Add every Gmail address as a **Test user** on the Audience page (§3a). |
| LLM 404 / empty answers | Bad `LLM_MODEL` name | Use a real model (`gemini-2.0-flash`, `gemma-3-27b-it`, …). |
| Scheduler errors / no digests | Invalid `TIMEZONE` | Use a real IANA zone like `Asia/Kolkata`. |
| Emails connect but list is empty | Provider returns text, not JSON | Handled by the Gmail adapter's text parser; for other servers, check discovered tool names in the logs (`LOG_LEVEL=debug`). |

macOS-specific: `npx` works fine there, so the `.cmd` issue doesn't apply — but installing
the servers locally (§2) is still the most reliable path and keeps behavior identical to
Windows.

---

## 9. Multiple accounts & multiple people

- **A second account of the same provider** (e.g. two Gmails): the simplest reliable pattern
  today is a **second orchestrator instance** with its own `.env` and its own entry in the
  Claude Desktop config (e.g. `email-orchestrator-work`). Give each a distinct account id
  (`GMAIL_ACCOUNT_ID`, `OUTLOOK_ACCOUNT_ID`, …). Each Gmail must also be added as a Test user.
- **Different people on their own laptops:** each person repeats this guide on their machine
  with their own accounts and their own Gemini key. Nothing is shared or centralized.
- **One person, mixed providers on one machine:** just fill in each provider's block in the
  same `.env`; a single orchestrator handles Gmail + Zoho + Yahoo + Outlook together.

---

## 10. Quick checklist

- [ ] Node 20+, `npm install`, `npm run build`
- [ ] `npm install` the server packages you need (Gmail / IMAP)
- [ ] Per provider: OAuth/app-password done (Gmail test user added!)
- [ ] `npm run setup` → `.env` (valid model + timezone + API key)
- [ ] `npm run test-connections` → LLM OK, Providers OK
- [ ] `npm run generate-config` → merge into Claude Desktop config
- [ ] Fully restart Claude Desktop → ask "summarize my inbox"
