# Outlook via Microsoft Graph (OAuth) — the add-on for locked-down Microsoft 365

Most Outlook accounts do **not** need this. Read this only if:

- your Outlook mailbox is a **Microsoft 365 work or school account**, **and**
- your organization has **disabled IMAP basic-auth** (so [OUTLOOK-SETUP.md](OUTLOOK-SETUP.md)'s
  app-password path can't sign in).

Personal **Outlook.com / Hotmail / Live** accounts keep using the simpler IMAP +
app-password path — they're unaffected by this document.

This add-on routes Outlook through the **Microsoft Graph API** over **OAuth**
(delegated `Mail.Read`), which M365 tenants allow even when IMAP is off. The
orchestrator has a built-in **`GraphAdapter`**; you supply an OAuth **Graph MCP
server** and a few env vars, and Outlook shows up alongside Gmail/Zoho/Yahoo.

> **Still never sends.** The `GraphAdapter` is read-only: it lists, reads and
> searches mail and refuses to create drafts. `smart_reply` still returns drafted
> text for you to send yourself. Only request read scopes (below).

---

## How it fits together

```
Claude Desktop ─▶ email-orchestrator ─▶ GraphAdapter ─▶ your Graph MCP server ─▶ Microsoft Graph
                                          (built in)      (OAuth: you run it)     (graph.microsoft.com)
```

The orchestrator speaks MCP to *your* Graph MCP server; that server holds the OAuth
token and calls Graph. The orchestrator never sees your Microsoft password — the
sign-in happens in the browser, owned by the MCP server.

---

## Part 1 — Azure app registration (needs your Microsoft 365 admin authority)

This is the part that **cannot be automated** — it requires the account owner (and
sometimes a tenant admin). Do it once per person, or once as a multi-tenant app.

1. **[Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations
   → New registration.**
   - Name: e.g. `Email AI Agent (read)`.
   - Supported account types: *Single tenant* is fine for one org; pick multi-tenant
     only if you deliberately want to share one app across tenants.
   - Redirect URI: match what your Graph MCP server documents. For a local device-code
     or loopback flow this is often `http://localhost` (Public client/native) — check
     the server's README.
2. **API permissions → Add a permission → Microsoft Graph → Delegated permissions:**
   - `Mail.Read`
   - `offline_access` (so the token can refresh without re-prompting)
   - *(Do **not** add `Mail.Send` / `Mail.ReadWrite` — the agent never sends or
     mutates. Least privilege keeps the blast radius small.)*
3. If your tenant shows **"Admin consent required = Yes"**, click **Grant admin
   consent** (or ask your IT admin to). Without consent the sign-in will fail.
4. **Authentication:** enable the flow your MCP server uses. Device-code / public
   client flows need **"Allow public client flows = Yes"**.
5. Copy the values your MCP server will need — typically **Application (client) ID**
   and **Directory (tenant) ID**. Only create a **client secret** (Certificates &
   secrets) if your server uses a confidential-client flow; device-code/PKCE flows
   don't need one. Treat any secret like a password.

> These IDs/secret are consumed by the **Graph MCP server**, via *its* own env vars —
> not by the orchestrator. The orchestrator only needs to know how to launch/reach
> that server (Part 3).

---

## Part 2 — Pick a Graph MCP server

You need an MCP server that (a) authenticates to Graph over OAuth and (b) exposes
tools to **list / read / search** mail. Requirements:

- OAuth delegated auth (device-code or auth-code/PKCE), storing/refreshing the token.
- A "list messages" tool, a "get message" tool, and ideally a "search messages" tool.
- Returns the **standard Graph message JSON** (it almost certainly will — that's just
  what Graph gives it). The `GraphAdapter` maps that shape; you only need to tell it
  the **tool names** via `OUTLOOK_GRAPH_TOOLMAP` if they're non-obvious.

Any community Graph/Outlook MCP that meets the above works. Configure that server's
own client-id/tenant/secret per its README.

---

## Part 3 — Wire it into the orchestrator

Set these in the person's `.env`. Two launch styles — pick one.

### A) Local stdio Graph MCP (the server runs as a child process)

```ini
OUTLOOK_EMAIL=you@yourcompany.com
OUTLOOK_DISPLAY_NAME=Work Outlook

# Launch the Graph MCP server locally over stdio:
OUTLOOK_GRAPH_MCP_COMMAND=npx
OUTLOOK_GRAPH_MCP_ARGS=["-y","<your-graph-mcp-server-package>"]

# Map the orchestrator's logical operations to THAT server's tool names.
# (Only needed if its names aren't auto-detected — see "Tool names" below.)
OUTLOOK_GRAPH_TOOLMAP={"listEmails":"list-mail-messages","getEmail":"get-mail-message","searchEmails":"search-mail-messages"}
```

Provide the Graph MCP server's **own** OAuth env (client id / tenant / secret) as its
README requires — those live in the same `.env` and are inherited by the child.

### B) Remote Graph MCP (an already-running HTTP/SSE endpoint)

```ini
OUTLOOK_EMAIL=you@yourcompany.com
OUTLOOK_DISPLAY_NAME=Work Outlook

OUTLOOK_GRAPH_MCP_URL=https://your-graph-mcp.example.com/mcp
OUTLOOK_GRAPH_MCP_TRANSPORT=http        # or: sse
OUTLOOK_GRAPH_AUTH_TOKEN=<bearer-if-the-endpoint-needs-one>   # optional
OUTLOOK_GRAPH_TOOLMAP={"listEmails":"list_messages","getEmail":"get_message","searchEmails":"search_messages"}
```

**Routing note:** setting **either** `OUTLOOK_GRAPH_MCP_URL` **or**
`OUTLOOK_GRAPH_MCP_COMMAND` switches this Outlook account to the Graph path
automatically. If neither is set, Outlook falls back to the IMAP + app-password path.
Don't set the old `OUTLOOK_MCP_COMMAND` for Graph — that one is the IMAP launcher.

### Tool names (`OUTLOOK_GRAPH_TOOLMAP`)

The adapter first tries your `toolMap`, then a built-in list of common names
(`list_messages`, `list-mail-messages`, `get_message`, `search_messages`, …), then a
fuzzy match. If a connection test complains **"No downstream tool found for operation
…"**, read the server's tool list from its docs and set `OUTLOOK_GRAPH_TOOLMAP`
explicitly. Keys are exactly `listEmails`, `getEmail`, `searchEmails`.

---

## Part 4 — First run & verify

1. Start the Graph MCP server once on its own if it needs an interactive OAuth
   sign-in (device code / browser). Complete the consent so it caches a refresh
   token. (Follow the server's README — this is the one interactive step, like
   Gmail's browser sign-in.)
2. Then:
   ```bash
   npm run test-connections
   ```
   Expect `outlook-primary (outlook): connected · listed N email(s)`.
3. In Claude Desktop: *"Summarize my Outlook inbox."*

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `AADSTS65001` / consent error | Admin consent not granted for the delegated scopes (Part 1 step 3). |
| `AADSTS7000218` / client secret required | Your server uses confidential-client flow — add a client secret, or switch it to device-code/PKCE. |
| "No downstream tool found for operation …" | Set `OUTLOOK_GRAPH_TOOLMAP` to the server's real tool names (Part 3). |
| Connects but 0 emails | Wrong folder/scope, or the token lacks `Mail.Read`. Re-consent; confirm the mailbox has mail in the default folder. |
| Sign-in loops / token not cached | `offline_access` scope missing, or the server can't write its token cache. |

See also [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and
[OUTLOOK-SETUP.md](OUTLOOK-SETUP.md) (the personal-account IMAP path).
