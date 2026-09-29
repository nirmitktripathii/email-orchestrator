# Outlook Setup

The orchestrator connects to Outlook the same way it connects to Yahoo — over **IMAP**
using the generic IMAP MCP server. This works well for **personal Outlook.com / Hotmail /
Live** accounts with an app password.

> ⚠️ **Microsoft 365 work/school accounts:** many organizations disable IMAP basic-auth
> by policy, and Microsoft is phasing out basic auth. If your M365 account can't sign in
> over IMAP, you need an **OAuth-based Microsoft Graph MCP server** + an Azure AD app
> registration instead (see "M365 via OAuth" below). Personal accounts are unaffected.

## Personal Outlook.com (recommended path)

### 1. Enable 2-step verification
**account.microsoft.com → Security → Advanced security options → Two-step verification → On.**

### 2. Create an app password
Same page → **App passwords → Create a new app password.** Copy the generated password.

### 3. Configure the orchestrator

In `.env` (or via `npm run setup`):

```ini
OUTLOOK_EMAIL=you@outlook.com
OUTLOOK_APP_PASSWORD=your-app-password
OUTLOOK_DISPLAY_NAME=Personal Outlook
OUTLOOK_IMAP_HOST=outlook.office365.com
OUTLOOK_IMAP_PORT=993
OUTLOOK_SMTP_HOST=smtp-mail.outlook.com
OUTLOOK_SMTP_PORT=587
```

### 4. Verify
```bash
npm run test-connections
```
Expect `outlook-primary (outlook): connected · listed N email(s)`.

## M365 via OAuth (work/school accounts with IMAP disabled)

If IMAP basic-auth is blocked, Outlook routes through the **Microsoft Graph API over
OAuth** instead. The orchestrator has a dedicated, read-only **`GraphAdapter`** for
this; you register an Azure app, run an OAuth **Graph MCP server**, and set the
`OUTLOOK_GRAPH_MCP_*` env vars — setting any of them switches this account to the
Graph path automatically (otherwise it stays on the IMAP path above).

Quick shape:
```ini
OUTLOOK_EMAIL=you@yourcompany.com
OUTLOOK_GRAPH_MCP_COMMAND=npx
OUTLOOK_GRAPH_MCP_ARGS=["-y","<your-graph-mcp-server-package>"]
OUTLOOK_GRAPH_TOOLMAP={"listEmails":"list-mail-messages","getEmail":"get-mail-message","searchEmails":"search-mail-messages"}
```

Full walkthrough — Azure app registration (delegated `Mail.Read` only), choosing a
Graph MCP server, remote-vs-local wiring, and troubleshooting — is in
**[OUTLOOK-GRAPH-SETUP.md](OUTLOOK-GRAPH-SETUP.md)**.

> Don't reuse the old `OUTLOOK_MCP_COMMAND` override for Graph — that one still builds
> the **IMAP** connection (`imap_*` tools) and would be pointed at a Graph server by
> mistake. Use the `OUTLOOK_GRAPH_MCP_*` vars instead.

## Notes
- Use the **app password**, never your normal Microsoft password.
- On Windows, the orchestrator launches IMAP servers via **direct Node** (not `npx.cmd`) to
  avoid a stdin-forwarding bug — this is automatic once the server package is installed
  locally (`npm install imap-mcp-server`).
