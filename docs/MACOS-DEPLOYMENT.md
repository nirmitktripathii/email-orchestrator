# macOS Deployment — shipping the Email AI Agent to Nitin & Aarushi

Goal: get the `email-orchestrator` running **inside Claude Desktop** on someone
else's Mac, driven by **one command** they run — `bash install.sh` — with the
credential steps that genuinely need their login clearly spelled out.

The people receiving this are **not technical**, so the design splits into:

- **You (Nirmit) prepare once** — the shared pieces and each person's `.env`.
- **They run one script** — `install.sh` builds everything and wires Claude Desktop.
- **A few credential steps can't be automated** (OAuth apps, app passwords, Zoho
  MCP URLs). They're listed explicitly in [Part D](#part-d--the-manual-steps-that-cannot-be-automated).

---

## How the pieces fit

```
Claude Desktop  ──talks to──▶  email-orchestrator (this project, on their Mac)
                                   │  connects out to:
                                   ├─ Gmail   → @gongrzhe/server-gmail-autoauth-mcp (browser OAuth, one time)
                                   ├─ Zoho    → their hosted Zoho MCP URL (the URL IS the credential)
                                   └─ Yahoo/Outlook → imap-mcp-server (app password)
```

`install.sh` handles everything **mechanical** (Node deps, build, Gmail browser
sign-in, merging the Claude Desktop config with a backup). It cannot create
Google/Zoho accounts or generate secrets — those need the account owner.

---

## Part A — You (Nirmit) prepare ONCE

These are shared across both installs.

### A1. The shared Gemini API key
For now everyone uses **one free Gemini key** (this is what we agreed for testing).
Get it from Google AI Studio → API keys. You'll paste it into each person's `.env`
as `LLM_API_KEY`. (Later we can switch to per-person keys or one paid key — the
`.env` is the only thing that changes.)

> Reliability note baked into the code: `gemma-4-31b-it` is a *thinking* model, so
> the AI calls need a large token budget (already set to 2048) and run at
> concurrency 4 to stay under the free-tier rate limit. Don't lower those.

### A2. The shared Google OAuth app (for Gmail)
Do this **once**; both people reuse the same downloaded keys file.

1. [Google Cloud Console](https://console.cloud.google.com/) → create/pick a project.
2. **APIs & Services → Library →** enable **Gmail API**.
3. **APIs & Services → OAuth consent screen →** *External*. Under **Test users**,
   add **both** Gmail addresses (Nitin's and Aarushi's). *(Test-user apps don't
   need Google verification.)*
4. **Credentials → Create credentials → OAuth client ID → Desktop app** → download
   the JSON. Rename it to **`gcp-oauth.keys.json`**.
5. You'll ship this one file to each person (see A4). It is a secret — send it
   privately.

### A3. Build-check the project on your machine
From the project root, make sure it's healthy before shipping:

```bash
npm ci
npm run build
npm test
```

### A4. Assemble each person's kit
For **each** person, prepare three things:

1. **The project folder** — a zip of this repo **without** `node_modules/`,
   **without** your own `.env`, and **without** `dist/` (the installer rebuilds
   these on their Mac, where the native pieces must be compiled). Keeping
   `.env.example` and `install.sh` is fine.
2. **Their `.env`** — copy `.env.example` → `.env` and fill it in with *their*
   details (see [Part B](#part-b--per-person-credentials)). Send it privately.
3. **`gcp-oauth.keys.json`** from step A2 (only if they use Gmail).

---

## Part B — Per-person credentials

Fill these into each person's `.env` (start from `.env.example`). Only include the
providers that person actually uses; blank/absent sections are simply skipped.

| Provider | Keys to set | Where it comes from |
|---|---|---|
| **LLM** | `LLM_API_KEY` | Shared Gemini key (A1) |
| **Gmail** | `GMAIL_EMAIL`, `GMAIL_DISPLAY_NAME` | Their Gmail address. (Auth is the browser step during install.) |
| **Zoho** | `ZOHO_EMAIL`, `ZOHO_MCP_URL`, `ZOHO_MCP_TRANSPORT=http`, `ZOHO_REGION`, `ZOHO_MAIL_ACCOUNT_ID` | Their own Zoho MCP console (see [ZOHO-SETUP.md](ZOHO-SETUP.md)) |
| **Yahoo** | `YAHOO_EMAIL`, `YAHOO_APP_PASSWORD` | Yahoo app password ([YAHOO-SETUP.md](YAHOO-SETUP.md)) |
| **Outlook** | `OUTLOOK_EMAIL`, `OUTLOOK_APP_PASSWORD` | Outlook app password ([OUTLOOK-SETUP.md](OUTLOOK-SETUP.md)) |

**Zoho specifics** (the URL *is* the credential — treat it like a password):
- In each person's Zoho MCP console, enable the **Message + Search + Account**
  tool groups (Folders too if listed), and set **Connection → "Authorization via
  Connection"** so the headless server needs no interactive login.
- `ZOHO_MCP_URL` is their `https://…zohomcp.in/mcp/<key>/message` URL.
- `ZOHO_MAIL_ACCOUNT_ID` is their mailbox account id (a long number). If you leave
  it blank the agent auto-detects it, but setting it is faster and more reliable.

---

## Part C — What the end user does (the easy part)

Give them these five lines. That's the whole experience:

1. Unzip the folder I sent you (e.g. to your Desktop).
2. Put the **`.env`** file I sent you *inside* that folder.
3. *(Gmail only)* Put **`gcp-oauth.keys.json`** in a folder called `.gmail-mcp` in
   your home directory. In Terminal:
   ```bash
   mkdir -p ~/.gmail-mcp && mv ~/Downloads/gcp-oauth.keys.json ~/.gmail-mcp/
   ```
4. Open **Terminal**, then drag the folder onto the Terminal window to `cd` into it
   (or `cd` to it), and run:
   ```bash
   bash install.sh
   ```
   A browser will open for Gmail — sign in and approve.
5. **Quit Claude Desktop completely (Cmd+Q) and reopen it.** Then ask it:
   *"Summarize my inbox across all accounts."*

The script is safe to run again if anything was skipped.

> **Not just Gmail.** The installer configures **every** account in the `.env`
> (Gmail, Zoho, Yahoo, Outlook). Gmail is the only one that needs a sign-in *during
> install* (the browser step). Zoho works from its `ZOHO_MCP_URL`, and Yahoo/Outlook
> from their app passwords — all already in the `.env`, so they need no extra action
> here. The installer prints the list of accounts it found so you can confirm.

---

## Part D — The manual steps that CANNOT be automated

These need the account owner's authority/login, so `install.sh` deliberately does
**not** attempt them — it detects what's missing and tells the user what to do.

- **Creating the Google OAuth app + enabling the Gmail API** → you, once (A2).
- **Approving the Gmail browser sign-in** → each user, during install.
- **Generating each Zoho hosted-MCP URL** and enabling its tool groups → each user,
  in their Zoho MCP console.
- **Generating Yahoo/Outlook app passwords** → each user, in their mail security
  settings.
- **Providing the shared Gemini API key** → you.

Everything else (installing Node deps, building, authorizing via the browser,
editing the Claude Desktop config) is automated.

---

## Part E — Speed & the tool timeout

`gemma-4-31b-it` is accurate but **slow** (it "thinks" before answering), so a
large inbox summary can take a few minutes. Two things keep this smooth:

- Keep the common request modest — e.g. *"summarize my last 10 emails"* — rather
  than hundreds at once.
- If Claude Desktop reports a tool timeout on big requests, raise its limit and
  relaunch:
  ```bash
  launchctl setenv MCP_TOOL_TIMEOUT 300000
  ```
  (Sets a 5-minute ceiling for GUI apps launched afterward; re-run after a reboot,
  or set it in a login item if you want it permanent.)

---

## Verifying / troubleshooting

- Re-run the checker any time:
  ```bash
  npm run test-connections
  ```
- If the agent doesn't appear in Claude Desktop, confirm the merge landed in
  `~/Library/Application Support/Claude/claude_desktop_config.json` and that you
  **fully quit** Claude Desktop (Cmd+Q) before reopening.
- The installer backs up that file to `…claude_desktop_config.json.bak-<timestamp>`
  before touching it, so your existing MCP servers are never lost.
- More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
