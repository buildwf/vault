# API keys

## Key types

| Type | Use | Access |
|---|---|---|
| `user` | Operators | All projects in the org. Can manage keys, projects and audit. |
| `system` | Apps, CI, agents | One or more `PROJECT/ENV` scopes only. |

System key permissions:

| Permission | Access |
|---|---|
| `read` | Read secrets |
| `readwrite` | Read and write secrets |
| `full` | Read and write secrets |

## Rules

- A key is shown one time only, when you make it or rotate it.
- Keys expire. The default is 90 days.
- You cannot revoke the last active operator key of an org.
- Do not put a key in a command line. Use hidden input, stdin or `VAULT_API_KEY`.

## Make a system key

```sh
vault keys create --type system --scope web/prod --permission read --label "web prod"
```

Give the key to the app or to the person.

## Rotate or revoke a key

```sh
vault keys list --include-revoked
vault keys rotate PREFIX
vault keys revoke PREFIX --yes
```

## Audit

```sh
vault audit --limit 50
```
