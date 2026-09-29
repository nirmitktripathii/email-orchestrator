# email-orchestrator (Python)

Python port of the TypeScript `email-orchestrator` MCP server. It has the same 17 tools,
prompts and safety rules. See the [root README](../README.md) for the full explanation of the
architecture, auditing, debugging and deployment.

```bash
uv venv && uv pip install -e ".[dev]"                     # or python -m venv .venv && pip install -e ".[dev]"
python -m email_orchestrator.setup.test_connections       # LLM + every account
python -m email_orchestrator.setup.run_tool account_status '{"refresh": true}'
python -m email_orchestrator.setup.generate_config --install   # register with Claude Desktop
python -m email_orchestrator                              # what Claude Desktop runs (MCP over stdio)
pytest                                                    # 53 tests
```

Configuration is read from `ENV_FILE`, or else the nearest `.env` above this package (the
repo-root `.env`). Node.js is still required, because the Gmail and IMAP provider MCP servers
are npm packages installed by `npm install` at the repo root.

Optional desktop toasts: `pip install -e ".[notify]"`.
