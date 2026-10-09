# Setup and deploy

## Install the CLI

1. Go to the repository root.
2. Run `bun run install:cli`.
3. Make sure that `~/.local/bin` is on your `PATH`.
4. Run `vault --help`.

To remove the CLI, run `bun run uninstall:cli`.

## Local development

1. Run `bun run cli init`.
2. Run `bun run migrations:local`.
3. When the command prints the applied migrations, push Ctrl-C.
4. Run `bun run dev`.
5. In a second terminal, run `bun run cli bootstrap --api-url http://127.0.0.1:8787`.

Bootstrap saves an operator key in `~/.config/poc-vault/config.json`.
It does not print the key.

## Configuration

1. Copy `.env.example` to `.env`.
2. Set the values for your deployment.

Do not commit `.env`. The repository is public.

| Variable | Required | Default |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Yes | |
| `VAULT_SECRETS_STORE_ID` | Yes | |
| `VAULT_D1_ID` | Yes | |
| `VAULT_WORKER_NAME` | No | `bwf-vault` |
| `VAULT_D1_NAME` | No | `bwf-vault` |
| `VAULT_SECRET_PREFIX` | No | `BWF_VAULT` |

Secrets Store must have these secrets:

- `<prefix>_MASTER_KEY_PRIMARY`
- `<prefix>_MASTER_KEY_SECONDARY`
- `<prefix>_BOOTSTRAP_TOKEN`

## Deploy

1. Log in: `bunx cf auth login`.
2. Apply the migrations: `bun run migrations:production`.
3. Examine the bindings: `bun run deploy:dry-run`.
4. Deploy: `bun run deploy`.
5. Bootstrap the production URL one time: `vault bootstrap --api-url URL`.

## Verify

Run these commands before you merge a change:

```sh
bun run check
bun run test
bun run acceptance
```

`bun run test` runs all tests against an in-memory D1.

## Recovery and root key rotation

Refer to [RECOVERY.md](../RECOVERY.md) and to the main [README](../README.md#master-key-rotation).
