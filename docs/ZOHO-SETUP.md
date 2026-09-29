# Zoho Mail Setup (Official Hosted MCP)

Zoho provides an **official hosted MCP platform** at [mcp.zoho.com](https://mcp.zoho.com).
We use it directly — there is no custom Zoho server to build or run. Your data stays in
the `.in` (India) data center as configured.

## 1. Create the Zoho MCP connector

1. Sign in at [mcp.zoho.com](https://mcp.zoho.com) with the Zoho account that owns the
   mailbox.
2. Create / enable an **MCP server** (connector) for **Zoho Mail**.
3. Select the **India (.in)** data center to match `ZOHO_REGION=in`.
4. Authorize the mail scopes it requests (read, search, drafts).
5. Copy the connector's **server URL** and, if shown, its **auth token**.

> The exact URL looks like `https://mcp.zoho.in/...`. Transport is usually SSE; some
> connectors use streamable HTTP.

## 2. Configure the orchestrator

In `.env` (or via `npm run setup`):

```ini
ZOHO_EMAIL=you@yourdomain.com
ZOHO_DISPLAY_NAME=Work Zoho
ZOHO_REGION=in
ZOHO_MCP_URL=https://mcp.zoho.in/your-connector-endpoint
ZOHO_MCP_TRANSPORT=sse          # use "http" if the connector is streamable-HTTP
ZOHO_MCP_AUTH_TOKEN=            # only if the connector issued a token
```

## 3. Verify

```bash
npm run test-connections
```

Expect `zoho-primary (zoho): connected · listed N email(s)`.

## Notes

- **No `ZOHO_MCP_URL`?** The account is still recorded, but it won't be wired to a server
  until you paste the URL. `test-connections` will flag it.
- **Auth style varies.** If the connector expects a different header than
  `Authorization: Bearer <token>`, connect it in the Zoho console with its own session
  instead of a token, and leave `ZOHO_MCP_AUTH_TOKEN` blank.
- **Region mismatch** is the most common failure — the URL host and `ZOHO_REGION` must
  both be `.in`.
