# Gmail Setup

The orchestrator talks to Gmail through a Gmail MCP server that it launches for you
(default: [`@gongrzhe/server-gmail-autoauth-mcp`](https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp)).
That server handles Google OAuth; you do it once and it caches a token.

## 1. Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create (or pick) a project.
3. **APIs & Services → Library →** enable the **Gmail API**.
4. **APIs & Services → OAuth consent screen:** choose *External*, add yourself as a
   *Test user*.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID →**
   *Desktop app*.
6. Download the JSON — this is your `client_secret_*.json`.

> Scopes: read + compose/drafts are enough. This project never needs send-on-your-behalf
> scope for its core features, since it only ever drafts replies.

## 2. Authorize the Gmail MCP server (one time)

Follow the Gmail MCP server's own auth step. For `@gongrzhe/server-gmail-autoauth-mcp`:

```bash
# Place the downloaded client secret where the server expects it, then:
npx @gongrzhe/server-gmail-autoauth-mcp auth
```

A browser window opens; sign in and approve. The server caches a refresh token locally
(commonly under `~/.gmail-mcp/`). After this, the orchestrator can spawn it non-interactively.

## 3. Tell the orchestrator about the account

In `.env` (or via `npm run setup`):

```ini
GMAIL_EMAIL=you@gmail.com
GMAIL_DISPLAY_NAME=My Gmail
```

Advanced (only if you use a different Gmail MCP server):

```ini
# Override the launcher command/args the orchestrator uses:
GMAIL_MCP_COMMAND=npx
GMAIL_MCP_ARGS=["-y","@lobehub/gmail-mcp"]
```

## 4. Verify

```bash
npm run test-connections
```

You should see `gmail-primary (gmail): connected · listed N email(s)`.

## Notes

- **Shared company Gmail:** treat it as a second account with its own `GMAIL_ACCOUNT_ID`.
- **`npx` on Windows:** the orchestrator uses `npx.cmd` automatically.
- If listing fails after connecting, the server's tool names may differ — see
  [TROUBLESHOOTING → "No downstream tool found"](TROUBLESHOOTING.md#no-downstream-tool-found-for-operation).
