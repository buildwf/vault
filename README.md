# BWF vault

This is Build With Friends' credential plane: an isolated Cloudflare Worker +
D1 that has been the authoring authority for every secret since the 2026-09-01
cutover from Infisical. It is production infrastructure. The production
secrets live in the vault project `bwf-shadow`, an import-era name that
renaming would strand, not a statement of authority.

**The full documentation is at <https://vault.buildwithfriends.dev>** — concepts,
the complete CLI and HTTP references, the database schema, and the operational
runbooks. It is built from `apps/vault-docs` in the Build With Friends monorepo
and has not caught up with this repository yet (it still describes removed
commands and Wrangler deploys); where they disagree, this file is current.

The only production values outside the encrypted D1 database are the two
envelope-encryption roots and one-time bootstrap token. They live in Cloudflare
Secrets Store and are bound only to the `bwf-vault` Worker. Secret names,
values, API-key labels/scopes, and audit host/secret fields are encrypted in D1;
lookup hashes are keyed. API keys expire, can be rotated or revoked, and a
database trigger prevents revoking the last active human key.

## Install the CLI

Build a platform-specific standalone executable and install it from the
repository root:

```sh
bun run install:cli
vault --help
```

The installer embeds the Bun runtime, so the installed command does not need
Bun or this checkout to run. It defaults to `~/.local/bin/vault`, which is
already on the standard BWF developer PATH. Override the destination for an
isolated or system-specific installation:

```sh
BWF_VAULT_INSTALL_DIR=/chosen/bin bun run install:cli
```

The installer records the binary digest beside the command. Upgrades and
uninstallations refuse to replace an unrelated or locally modified `vault`
executable. It never edits a shell profile or copies credentials. If
`~/.local/bin` is not on PATH, add this to the relevant shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Remove a managed installation with `bun run uninstall:cli`. Rebuild on
the target operating system and architecture; the generated executable is not
portable between platforms.

## Operator CLI

Once installed, run from this repository or any directory below one that has a
`vault.json` (it supplies the default `project` and `env`):

```sh
vault --help
vault projects list
vault environments list --project bwf
vault secrets list --project bwf --env dev
vault audit --limit 50
vault keys list --include-revoked
```

Credentials are read from hidden input/stdin or `VAULT_API_KEY`; `--api-key`
and `NAME=value` are rejected so they do not enter shell history. Destructive
commands require `--yes`. A newly created or rotated API key is shown once.

```sh
vault secrets set NAME --kind secret
vault secrets collect NEW_NAME --kind secret
vault secrets delete NAME --yes
vault keys rotate vault_sys_PREFIX
vault keys revoke vault_sys_PREFIX --yes
```

## Sharing

Share an environment with a person, machine, or agent by giving it a scoped
system key. It can read (and with `readwrite`, write) only the listed
project/environments, and never manage keys, projects, or audit:

```sh
vault keys create --type system --scope bwf/dev --permission read --label "ci"
```

The holder sets `VAULT_API_URL` and `VAULT_API_KEY` (or runs `vault login`) and
uses the same commands. Keys expire (default 90 days) and can be rotated or
revoked at any time.

## AI agents

Agents use secrets by running commands under `vault run`, which injects every
secret in the project/environment as an environment variable and removes
`VAULT_API_KEY` from the child. Nothing is written to the repository:

```sh
vault run -- bun run dev
```

When a required user-supplied value is missing, agents first check names, then
run `vault secrets collect NAME --project PROJECT --env ENV` themselves. Tell
the user the form is ready and wait for the receipt; do not give them a command
to run or ask for the value in chat. Continue after `stored`, respect
cancellation or expiry, and inspect an `unknown` outcome before any new request.

`vault secrets collect NEW_NAME` opens a local browser form. The person enters
the value there; the command returns only a JSON receipt. It uses the operator
login and an existing project/environment, creates only a missing name, and
never replaces a value. Entry expires after ten minutes. Cancellation before
submission writes nothing. A lost save reply is `unknown`; inspect Vault before
starting another request. The form assets are embedded in the CLI, with no CDN
or telemetry. This protects ordinary agent context, not against a malicious
process with access to the same operating-system account.

`vault mcp --project PROJECT --env ENV` exposes this as native agent tools:

- `describe_context`: secret names and kinds, never values.
- `collect_secret`: the user types the missing value into a prompt right in the
  chat (MCP form elicitation; the browser form is the fallback). The model gets
  only the receipt. The prompt box is not masked: MCP forms have no password
  field.
- `use_secret`: the agent writes `{{NAME}}` where a key belongs in a request
  (URL, headers, body); the vault fills it in, refuses any substitution that
  changes the host, sends it without following redirects, and puts the
  placeholders back in the response. The user approves each key/host pair in
  the chat; approvals last 15 minutes and are kept in memory only.
- `share_access`: after the user approves, mints a read or readwrite key scoped
  to this project/env for 5 minutes to 7 days, for another agent or person.
- `open_panel`: an MCP Apps panel (Claude Desktop, VS Code, Cursor and other
  hosts that render apps) listing secrets, with a masked box to add one and the
  active approvals to revoke.
- `get_task`/`cancel_task`: durable receipts across reconnects (MCP Tasks).

### Claude Code plugin

`plugin/` packages the MCP server, a `vault` skill, and hooks: at session start
the agent learns which secret names exist, and after a failed command it is
told which env vars are missing and whether to `collect_secret` them or rerun
under `vault run`. Install it with the CLI on PATH and logged in:

```sh
claude plugin marketplace add /path/to/this/repo
claude plugin install vault@vault
```

Run `bun run acceptance:collection` for synthetic browser and encrypted-storage
acceptance. Images and the receipt are under `.wrangler/collection-acceptance`.

`sealed` hides a value from `vault secrets get`, but it is still exported to
`vault run` and to any key scoped to the environment, so it is not access
control. `vault run` never injects loader or exec variables such as `PATH`,
`NODE_OPTIONS`, or `LD_*`/`DYLD_*`, even when a secret has that name.

## Cloudflare CLI

Config, build, dev, deploy, types and D1 migrations go through Cloudflare's
`cf` CLI (pinned `1.0.0-beta.10`) and `cloudflare.config.ts`. `--mode
production` selects the real `bwf-vault` Worker; no mode is the local
`bwf-vault-local` one. `cf` builds through Wrangler, so `wrangler` stays a
dependency; the recovery rehearsal also still calls it for D1 export and
import, which `cf` does not have yet. The two keep separate logins: `cf` for
everything, plus Wrangler for the recovery rehearsal's export and import (or
set `CLOUDFLARE_API_TOKEN`, which both accept):

```sh
bunx cf auth login
bunx wrangler login
```

`.cloudflare/` (build output and generated types) is ignored; `bun run check`
regenerates the types first.

### Configuration

Account and resource ids are deployment-specific and never committed (this
repository is public). Copy `.env.example` to `.env` (gitignored) and fill in
your own; the real environment wins over the file:

| Variable | Required | Default |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | for production | |
| `VAULT_D1_ID` | for production | |
| `VAULT_SECRETS_STORE_ID` | for production | |
| `VAULT_WORKER_NAME` | no | `bwf-vault` (local: `bwf-vault-local`) |
| `VAULT_D1_NAME` | no | `bwf-vault` |
| `VAULT_SECRET_PREFIX` | no | `BWF_VAULT` |

The Secrets Store names are `<prefix>_MASTER_KEY_PRIMARY`,
`<prefix>_MASTER_KEY_SECONDARY` and `<prefix>_BOOTSTRAP_TOKEN`. `--mode
production` refuses to run without the required ids; local mode needs none.
`ACTIVE_MASTER_KEY` stays in `cloudflare.config.ts` on purpose: the live root
slot must not depend on whose `.env` deployed. A test fails if anything shaped
like a Cloudflare id lands in a committed file.

## Convex storage

A deployment can keep its encrypted rows in Convex instead of D1. The Worker,
the CLI, the HTTP API and the root keys are unchanged: the Worker still holds
both Secrets Store roots and does every encryption and decryption, so the
Convex deployment stores only the ciphertext and keyed hashes D1 would hold.

The Worker reaches Convex through one HTTP action, `POST /vault/rpc` in
`convex/http.ts`, authenticated by a shared token. That action runs exactly
one internal function from `convex/vault.ts`; none of them is callable
through the public Convex client. Each is one Convex transaction, which keeps
the guarantees D1 got from constraints and triggers: one bootstrap claim,
unique names, atomic key rotation, and no revoking the last active user key.

To set up a Convex-backed vault:

1. Create the Convex deployment and push the functions:

   ```sh
   bunx convex deploy
   ```

2. Generate one storage token and set it on both sides: in Convex as
   `VAULT_STORAGE_TOKEN`, and in the Worker's Secrets Store as
   `<prefix>_CONVEX_STORAGE_TOKEN` (Wrangler prompts for the value, so it stays
   out of argv and shell history):

   ```sh
   openssl rand -base64 48 | tr -d '\n' | bunx convex env set VAULT_STORAGE_TOKEN --prod
   bunx convex env get VAULT_STORAGE_TOKEN --prod   # copy it for the next prompt
   bunx wrangler secrets-store secret create "$VAULT_SECRETS_STORE_ID" \
     --name BWF_VAULT_CONVEX_STORAGE_TOKEN --scopes workers --remote
   ```

3. In `.env`, set `VAULT_STORAGE=convex` and `CONVEX_SITE_URL` to the
   deployment's HTTP actions URL (`https://<deployment>.convex.site`).
   `VAULT_D1_ID` is not needed. Check the bindings, then deploy and bootstrap
   as in Production deployment:

   ```sh
   bun run deploy:dry-run
   bun run deploy
   ```

The token must be at least 32 characters; the Worker and the Convex action
both refuse to run with a shorter or missing one. To rotate it, set the new
value in Convex and Secrets Store together; requests fail with a 500 in
between.

A Convex-backed vault can host several organizations; see Orgs.

`bun run test` runs the whole suite twice, once against D1 and once against
the real `convex/` functions under `convex-test`, through the same HTTP action
and token check. The D1-only operator scripts (`acceptance`,
`recovery:rehearse`) refuse to run in Convex mode; restore a Convex-backed
vault from Convex's own backups, together with the matching Secrets Store root
(see [RECOVERY.md](RECOVERY.md)). `convex/_generated/` is committed;
`bunx convex dev` or `bunx convex deploy` regenerates it.

## Orgs

A Convex-backed deployment can hold many organizations. Every API key, project
and audit event belongs to one org, and a key only ever sees its own org: its
projects, secrets, keys and audit log. Project names are unique per org, so two
orgs can each have a `web` project. Each org has its own data key, stored
encrypted by the vault data key, so one org's rows are ciphertext to another
org's keys. Root rotation is unchanged; it never touches org keys.

The org that bootstrap creates is the platform org (`default`). Every row from
before orgs existed belongs to it. Its operators are platform operators: only
they create orgs and manage master keys.

```sh
vault orgs create acme            # prints acme's first operator key once
vault orgs list
```

Give the printed key to the org's first operator. They use it like any operator
key (`VAULT_API_KEY` or `vault login`) to create projects and share scoped
system keys. Within an org, the last active operator key still cannot be
revoked.

D1 deployments hold only the platform org; `vault orgs create` answers 501
there.

## Local development

```sh
bun run cli init
bun run migrations:local
bun run dev
```

`migrations:local` prints its result and then may not exit (a `cf` beta bug);
press Ctrl-C once it has printed the applied migrations.

`init` creates a private `.dev.vars` containing only local root credentials;
the repository ignores this file. In a second terminal, provide the bootstrap
token through hidden input or the environment:

```sh
bun run cli bootstrap --api-url http://127.0.0.1:8787
```

Bootstrap atomically claims an empty database, creates a 15-minute temporary
key, uses it to create a 90-day operator key, revokes the temporary key, and
saves only the durable key in `~/.config/poc-vault/config.json` with mode 0600.
The key is not printed.

## Production deployment

Production resources are deliberately isolated (names are the defaults; see
Configuration):

- Worker: `bwf-vault`
- D1: `bwf-vault`
- Secrets Store roots: `BWF_VAULT_MASTER_KEY_PRIMARY`,
  `BWF_VAULT_MASTER_KEY_SECONDARY`, `BWF_VAULT_BOOTSTRAP_TOKEN`

Apply migrations before deploying code that requires them, and check the
dry run's bindings first:

```sh
bun run migrations:production
bun run deploy:dry-run
bun run deploy
```

`cf d1 migrations` records into the same `d1_migrations` table Wrangler used,
so migrations applied before the switch to `cf` count as applied. The first
`cf` deploy also drops the `cf:service`/`cf:environment` dashboard tags that
Wrangler's environments added; nothing at runtime changes.

Deployment is not a BWF credential cutover. Bootstrap the production URL once,
then verify root health, project CRUD, encrypted secret CRUD with a synthetic
value, API-key rotation, audit pagination, and the recovery checks in
[RECOVERY.md](RECOVERY.md).

## Master-key rotation

The checked-in `ACTIVE_MASTER_KEY` selects one of two Secrets Store bindings.
Rotation never decrypts and rewrites every row:

1. Run `bunx cf auth login` as the human operator authorized to update the
   production Secrets Store. Vault-held runtime credentials are never used for
   this root-of-trust ceremony.
2. Run `bun run master-keys:prepare-rotation`. The helper generates a new
   random 32-byte root, writes it to the inactive binding through the logged-in
   `cf` client (on stdin, never argv), computes its expected fingerprint, and retries preparation
   until that exact fingerprint is wrapped. A merely new fingerprint is not
   sufficient because Secrets Store updates can reach existing Worker isolates
   asynchronously.
3. Change `ACTIVE_MASTER_KEY` in `cloudflare.config.ts` to that slot and deploy.
4. Confirm `vault master-keys status` reports the expected active fingerprint
   and read a synthetic secret.
5. Keep the prior active wrap and root through an observation window. Retire
   only stale, unbound preparation wraps during activation.
6. Run `vault master-keys retire OLD_FINGERPRINT --yes` after the rollback
   window closes.
7. Replace the now-inactive old root so it cannot be reused.

The API refuses to retire the active wrap and refuses to start when the selected
root has not been prepared.

## Verification

```sh
bun run check
bun run test
bun run acceptance
```

`acceptance` starts real local workerd + D1 state, bootstraps it, writes and
decrypts a synthetic secret, verifies audit evidence, and removes the temporary
state. `bun run recovery:rehearse` proves the production restore path; see
[RECOVERY.md](RECOVERY.md).
