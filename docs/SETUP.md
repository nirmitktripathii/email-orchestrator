# Email AI Agent — Setup Guide

This is the main setup guide. It gets you from a fresh clone to a working, AI-powered,
multi-account inbox inside Claude Desktop (or Antigravity).

## Architecture in one picture

```
Claude Desktop / Antigravity
        │  (MCP)
        ▼
  email-orchestrator   ← the only custom component (this repo)
   ├── AI engine (Gemini/Gemma by default, swappable)
   ├── Gmail  MCP  (spawned: @gongrzhe/server-gmail-autoauth-mcp)
   ├── Zoho   MCP  (remote: mcp.zoho.com, .in region)
   └── IMAP   MCP  (spawned: imap-mcp-server → Yahoo)
```

The orchestrator is both an **MCP server** (to Claude Desktop) and an **MCP client**
(to the provider servers). You configure it once; it fans out to every account, runs
per-email AI enrichment, and exposes 17 unified tools.

## Prerequisites

- Node.js **20+** (`node --version`)
- Claude Desktop (or Antigravity)
- A Gemini API key (free tier works) — https://aistudio.google.com/apikey
- Credentials for whichever accounts you want (see the per-provider docs)

## Step 1 — Install & build

```bash
npm install
npm run build
```

## Step 2 — Configure

Run the interactive wizard (writes `.env`):

```bash
npm run setup
```

Or copy `.env.example` to `.env` and edit it by hand. At minimum set `LLM_API_KEY` and
one email account.

Then complete each provider's auth:
- [Gmail](GMAIL-SETUP.md)
- [Zoho Mail](ZOHO-SETUP.md)
- [Yahoo Mail](YAHOO-SETUP.md)

## Step 3 — Verify connectivity

```bash
npm run test-connections
```

This checks that the LLM responds and that each configured account connects and can list
mail. Fix anything that reports ❌ before continuing (see [TROUBLESHOOTING](TROUBLESHOOTING.md)).

## Step 4 — Wire it into Claude Desktop

```bash
npm run generate-config
```

This writes `config/generated/claude_desktop_config.json`. Merge its `email-orchestrator`
entry into your real Claude Desktop config:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Fully **quit and reopen** Claude Desktop (not just close the window).

## Step 5 — Use it

Ask Claude things like:

- "Summarize my inbox across all accounts."
- "What's urgent today?"
- "Prioritize my unread email."
- "Draft a reply to the email from Aarushi about the appraisal." (drafts only — never auto-sends)
- "Give me my daily digest."

Optional: paste `config/prompts/system-prompt.md` into your Claude project/instructions so
the agent leads with the right behavior.

## Scheduled digests & urgent alerts

- `DIGEST_SCHEDULE` (e.g. `09:00,14:00,19:00`, up to 3/day) drives background digest
  notifications while the orchestrator is running.
- `URGENT_POLL_MINUTES` (default `0` = off) enables real-time desktop alerts for newly
  seen high-urgency emails. Note: polling makes AI calls, so it consumes API quota.

## Adding more accounts later

Nirmit is the Phase-1 target (Gmail + Yahoo + Zoho). To add Nitin's or Aarushi's
accounts, give each its own account id (`GMAIL_ACCOUNT_ID`, etc.) or run a second
orchestrator instance with its own `.env`. See [TROUBLESHOOTING](TROUBLESHOOTING.md#multiple-accounts-of-the-same-provider).

## Swapping the AI model

The AI engine is provider-agnostic. To switch, change `LLM_PROVIDER` / `LLM_MODEL` /
`LLM_API_KEY` (and `LLM_BASE_URL` for Ollama/LiteLLM). Supported: `gemini`, `openai`,
`anthropic`, `groq`, `ollama`, `custom` (any OpenAI-compatible endpoint).
