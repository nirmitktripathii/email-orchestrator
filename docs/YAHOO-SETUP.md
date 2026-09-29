# Yahoo Mail Setup (IMAP + App Password)

Yahoo doesn't offer OAuth for third-party IMAP clients, so we connect over IMAP/SMTP
using a **Yahoo app-specific password**. The orchestrator launches an IMAP MCP server
(default: `imap-mcp-server`) and passes it your credentials.

## 1. Turn on 2-step verification

App passwords require it: **Yahoo Account → Account Security → Two-step verification → On.**

## 2. Generate an app password

1. **Account Security → Generate app password** (or "Manage app passwords").
2. Name it e.g. `Email AI Agent`.
3. Copy the 16-character password (shown once — spaces don't matter).

## 3. Configure the orchestrator

In `.env` (or via `npm run setup`):

```ini
YAHOO_EMAIL=you@yahoo.com
YAHOO_APP_PASSWORD=abcd efgh ijkl mnop
YAHOO_DISPLAY_NAME=Yahoo Mail
YAHOO_IMAP_HOST=imap.mail.yahoo.com
YAHOO_IMAP_PORT=993
YAHOO_SMTP_HOST=smtp.mail.yahoo.com
YAHOO_SMTP_PORT=465
```

The orchestrator forwards these to the IMAP MCP server under several common variable
names (`IMAP_HOST`/`IMAP_USER`/`IMAP_PASSWORD`, `EMAIL_*`, `SMTP_*`) so most IMAP MCP
implementations work without extra tweaks.

Advanced (different IMAP MCP server):

```ini
YAHOO_MCP_COMMAND=npx
YAHOO_MCP_ARGS=["-y","@codefuturist/email-mcp"]
```

## 4. Verify

```bash
npm run test-connections
```

Expect `yahoo-primary (yahoo): connected · listed N email(s)`.

## Notes

- Use the **app password**, never your normal Yahoo login password.
- Any other IMAP mailbox (Outlook-via-IMAP, custom domains) can reuse this adapter — set
  the host/port and credentials accordingly.
- Draft-saving depends on the IMAP MCP server exposing a draft/append tool; if it
  doesn't, `smart_reply` still returns the draft text for you to copy.
