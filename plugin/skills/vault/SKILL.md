---
name: vault
description: Use when a task needs API keys, tokens, passwords, or other secrets, or when a command fails because an environment variable is missing. Covers asking the user for secrets safely, calling APIs without seeing keys, running commands with secrets, and sharing access with other agents.
---

Secrets live in the vault. Never ask the user to paste a secret into chat, and never print one.

1. Call `describe_context` to see which secret names exist (never values).
2. Missing one? Call `collect_secret` with a new UUID `requestId` and the name. The user types it into a prompt; you get only a receipt. Continue after `stored`; on `unknown`, check `describe_context` before retrying.
3. Calling an HTTP API? Prefer `use_secret`: put `{{NAME}}` where the key goes, e.g. header `Authorization: Bearer {{STRIPE_KEY}}`. The user approves each key/host once per 15 minutes; responses come back with keys replaced by placeholders.
4. Running a program that reads env vars (dev servers, tests, scripts)? Run it as `vault run -- CMD`.
5. Another agent or person needs access? Call `share_access` (read by default, short TTL) and hand over the returned env lines.
6. The user wants to see or manage secrets in a host that shows MCP Apps (Claude Desktop, VS Code, Cursor)? Call `open_panel`. Claude Code cannot show it; use `describe_context` and `collect_secret` there.
