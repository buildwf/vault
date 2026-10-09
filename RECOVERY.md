# Vault recovery runbook

This runbook covers the isolated `bwf-vault` D1 database. It does not authorize
restoring a live database: Time Travel restore is destructive and requires an
explicit incident decision, a target bookmark/timestamp, and a current export.

## Routine proof

From the repository root, record the current Time Travel bookmark and create
an encrypted data export in an approved restricted location. `cf` has no D1
export yet, so the export still uses Wrangler, by database name; both
`bunx cf auth login` and `bunx wrangler login` (or `CLOUDFLARE_API_TOKEN`) are
needed here and for `bun run recovery:rehearse`:

```sh
set -a; . ./.env; set +a   # CLOUDFLARE_ACCOUNT_ID and VAULT_D1_ID
bunx cf d1 time-travel get-bookmark "$VAULT_D1_ID"
bunx wrangler d1 export "${VAULT_D1_NAME:-bwf-vault}" --remote --output /restricted/bwf-vault.sql
```

The SQL export contains ciphertext and keyed lookup hashes, not root keys. It
is still sensitive operational data and must not be committed, attached to a
ticket, or placed in a shared temporary directory. A usable recovery requires
both the D1 state and at least one matching active Secrets Store root wrap.

Run the complete rehearsal with `bun run recovery:rehearse` from the
repository root. It creates the restricted export above, imports it into a
uniquely named disposable remote D1 database, deploys a disposable Worker bound
to the same Secrets Store roots, and proves the recovered operator key, a known
canary secret, and audit history. It then removes the disposable Worker and D1
database. The timestamped encrypted export and Time Travel receipt remain under
`~/.config/poc-vault/recovery/` with directory mode 0700 and file mode 0600.

The remote disposable Worker is required because Secrets Store values cannot be
read back into a local process. A local import can prove SQL structure but
cannot prove that the production root decrypts the restored rows. The rehearsal
does not mutate or restore the production database.

## Incident sequence

1. Stop writes or otherwise identify a precise consistency boundary.
2. Capture a fresh remote export before changing anything.
3. Run `bunx cf d1 time-travel get-bookmark "$VAULT_D1_ID" --timestamp <ISO time>` and
   record the returned bookmark.
4. Confirm the selected Secrets Store root has a wrap in the target database.
5. Obtain explicit approval for the exact database and bookmark.
6. Restore with the exact bookmark: `bunx cf d1 time-travel restore "$VAULT_D1_ID"
   --bookmark <bookmark>` (check `--help` for the current flags first).
7. Verify root health, synthetic canary read, API-key authentication, and audit
   continuity before reopening writes.
8. Rotate any credential whose confidentiality may have been affected.

If neither configured root can unwrap the restored database, do not initialize
new key material: that would create a different vault over the recovered data.
Recover a matching root from the approved root-key recovery system or treat the
encrypted contents as unrecoverable.

## Bootstrap after recovery

Bootstrap is stored in D1 as a singleton claim and cannot normally be repeated.
Restoring to a point before the claim makes the database empty from the vault's
perspective; use the existing bound bootstrap token only after confirming that
this is the intended recovery point. The CLI will immediately replace the
15-minute bootstrap key with a durable operator key and revoke the temporary
key.
