# Use the vault in an app

## Get access

1. Ask an operator for a system key for your project and environment.
2. Set `VAULT_API_URL` to the vault URL.
3. Set `VAULT_API_KEY` to the key.

Example for the hosted vault:

```sh
export VAULT_API_URL=https://shared-vault.buildwithfriends.workers.dev
```

## Run the app

Add a `vault.json` to the app repository:

```json
{ "project": "web", "env": "dev" }
```

Run the app with `vault run`:

```sh
vault run -- bun run dev
```

`vault run` does these steps:

- It injects each secret as an environment variable.
- It removes `VAULT_API_KEY` from the app environment.
- It does not write secrets to disk.
- It does not inject `PATH`, `NODE_OPTIONS`, `LD_*` or `DYLD_*`.

## AI agents

Agents use the same key.
Use `vault run` to run commands with secrets.

If a secret is missing, the agent runs `vault secrets collect NAME`.
The user types the value into a browser form.
The agent gets only a receipt.
The agent must not ask for the value in chat.

For MCP tools, run `vault mcp --project PROJECT --env ENV`.
For Claude Code, install the plugin in `plugin/`.
Refer to the main [README](../README.md#ai-agents).
