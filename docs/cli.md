# CLI reference

## Connection

The CLI reads these values:

| Value | Source |
|---|---|
| API URL | `VAULT_API_URL` or `vault login` |
| API key | `VAULT_API_KEY` or `vault login` |
| Project | `--project`, `VAULT_PROJECT` or `vault.json` |
| Environment | `--env`, `VAULT_ENV` or `vault.json` |

`vault.json` can be in the current directory or in a parent directory:

```json
{ "project": "web", "env": "dev" }
```

## Commands

| Command | Function |
|---|---|
| `vault bootstrap --api-url URL` | Make the first operator key. One time only. |
| `vault login --api-url URL` | Save the URL and a key. |
| `vault orgs list\|create NAME` | Manage orgs. Platform operators only. |
| `vault projects list\|create\|delete NAME` | Manage projects. |
| `vault environments list\|create\|delete NAME` | Manage environments. |
| `vault secrets list\|get\|set\|delete NAME` | Manage secrets. |
| `vault secrets collect NAME` | Open a browser form. A person types the value. |
| `vault keys list\|create\|rotate\|revoke` | Manage API keys. |
| `vault parents list\|set\|minted\|revoke\|delete` | Manage parent keys and their child keys. Operators only. See [parent keys](parents.md). |
| `vault audit` | Show the audit log. |
| `vault ui` | Open the web UI, signed in as your login. See [Web UI](ui.md). |
| `vault master-keys status\|prepare\|retire` | Manage root keys. Platform operators only. |
| `vault run -- CMD` | Run a command with the secrets as environment variables. |
| `vault mcp` | Start the MCP server for AI agents. |
| `vault hook` | Claude Code hook. |
| `vault init` | Make local development credentials. |

## Safety rules

- Commands that delete or revoke need `--yes`.
- The CLI does not accept `--api-key` or `NAME=value`.
- Type values into the hidden prompt or give them on stdin.
