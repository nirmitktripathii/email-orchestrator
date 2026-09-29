# Troubleshooting

Logs go to **stderr** as JSON (stdout is reserved for the MCP protocol). Set
`LOG_LEVEL=debug` in `.env` for detail. When running under Claude Desktop, check its MCP
log files.

## The server won't start / Claude Desktop shows it as failed

- Run it directly to see the error:
  ```bash
  npm run build && node dist/index.js
  ```
  It should print `email-orchestrator MCP server is running on stdio` and wait.
- Make sure the `args` path in `claude_desktop_config.json` is the **absolute** path to
  `dist/index.js` and that you ran `npm run build`.
- Fully quit and relaunch Claude Desktop after editing its config.

## `.env` values seem ignored under Claude Desktop

Claude Desktop may launch the server from a different working directory. `npm run
generate-config` sets `ENV_FILE` to your absolute `.env` path and forwards key values in
the config's `env` block, which avoids this. Regenerate and re-merge the config.

## LLM call failed / rate limited

- `LLM_API_KEY` missing or wrong → `npm run setup` and re-enter it.
- `429` errors → the client already retries with backoff; reduce `URGENT_POLL_MINUTES`
  and large `maxPerAccount` values, or switch `LLM_MODEL` to a higher-quota model.
- Behind a proxy / using Ollama → set `LLM_PROVIDER` and `LLM_BASE_URL` accordingly.

## "No downstream tool found for operation ..."

The provider MCP server connected, but the orchestrator couldn't match one of its tools
to a logical operation (list/search/get/draft). The error lists the **discovered tool
names**. Two fixes:

1. Confirm you're pointing at a mail-capable MCP server.
2. The orchestrator auto-detects common names and fuzzy-matches; if a server uses an
   unusual name, note it from the log — a `toolMap` override per account is supported in
   the connection config (`src/orchestrator/core/config.ts`), e.g. mapping
   `listEmails → "unusual_list_tool_name"`.

## A provider won't connect

- **Gmail:** re-run the Gmail MCP server's `auth` step; ensure the token cache exists.
- **Zoho:** verify `ZOHO_MCP_URL` host and `ZOHO_REGION` are both `.in`; check the token.
- **Yahoo:** use the **app password**, not your login password; confirm 2-step is on.
- On Windows, `npx` is invoked as `npx.cmd` automatically; make sure Node/npm are on PATH.

## Emails come back but categories/summaries look wrong

- Summaries/categories are only as good as the model. Try a stronger `LLM_MODEL`.
- The fallback keyword categorizer is used when the LLM fails — if everything is
  `informational`, the LLM calls are probably failing (check stderr).

## No desktop notifications

- `NOTIFICATIONS_ENABLED=true`?
- Notifications are best-effort; on headless/CI there's no popup (this is logged, not an
  error).
- Digest notifications only fire while the orchestrator process is running and at the
  configured `DIGEST_SCHEDULE` times (`TIMEZONE` matters).

## Multiple accounts of the same provider

The current `.env` schema wires one account per provider (`gmail-primary`,
`zoho-primary`, `yahoo-primary`). For a second Gmail (e.g. a shared company inbox), the
simplest path today is a **second orchestrator instance** with its own `.env` and its own
entry in `claude_desktop_config.json` (e.g. `email-orchestrator-work`). Each instance
gets a distinct account id via `GMAIL_ACCOUNT_ID`.

## Resetting

Delete `.env` and `config/generated/`, then re-run `npm run setup` and
`npm run generate-config`.
