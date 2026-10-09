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
| `VAULT_D1_ID` | D1 only | |
| `VAULT_STORAGE` | No | `d1`. Set `convex` for Convex. |
| `CONVEX_SITE_URL` | Convex only | |
| `VAULT_WORKER_NAME` | No | `bwf-vault` |
| `VAULT_D1_NAME` | No | `bwf-vault` |
| `VAULT_SECRET_PREFIX` | No | `BWF_VAULT` |

Secrets Store must have these secrets:

- `<prefix>_MASTER_KEY_PRIMARY`
- `<prefix>_MASTER_KEY_SECONDARY`
- `<prefix>_BOOTSTRAP_TOKEN`
- `<prefix>_CONVEX_STORAGE_TOKEN` (Convex only)

## Deploy with D1

1. Log in: `bunx cf auth login`.
2. Apply the migrations: `bun run migrations:production`.
3. Examine the bindings: `bun run deploy:dry-run`.
4. Deploy: `bun run deploy`.
5. Bootstrap the production URL one time: `vault bootstrap --api-url URL`.

## Deploy with Convex

1. Push the Convex functions: `bunx convex deploy`.
2. Make a storage token of 32 characters or more.
3. Set the token in Convex as `VAULT_STORAGE_TOKEN`.
4. Set the same token in Secrets Store as `<prefix>_CONVEX_STORAGE_TOKEN`.
5. In `.env`, set `VAULT_STORAGE=convex`.
6. In `.env`, set `CONVEX_SITE_URL` to `https://<deployment>.convex.site`.
7. Run `bun run deploy:dry-run`.
8. Run `bun run deploy`.
9. Bootstrap the URL one time: `vault bootstrap --api-url URL`.

CAUTION: When you change the storage token, change it in Convex and in Secrets Store at the same time. Requests fail between the two changes.

## Verify

Run these commands before you merge a change:

```sh
bun run check
bun run test
bun run acceptance
```

`bun run test` runs all tests against D1 and against Convex.

## Recovery and root key rotation

Refer to [RECOVERY.md](../RECOVERY.md) and to the main [README](../README.md#master-key-rotation).
