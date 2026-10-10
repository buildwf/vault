/**
 * The `bwf-vault` Worker entry point.
 *
 * Every request resolves both root-key slots and the bootstrap token from
 * Secrets Store, selects the active root by `ACTIVE_MASTER_KEY`, opens the
 * D1 backend over the `DB` binding, opens
 * the keyring over it, and builds the Hono application around the result.
 *
 * A `MasterKeyError` anywhere in that chain answers 500 and logs one structured
 * line. The Worker does not serve with key material or storage it could not
 * verify: a missing root, an unparseable one, one with no prepared wrap, or an
 * incomplete storage setting are all configuration errors, not conditions to
 * degrade through.
 *
 * `scheduled` runs hourly. It prunes audit rows past `AUDIT_RETENTION_DAYS`
 * and closes minted child keys past their expiry (revoking them at the
 * provider). It opens the keyring exactly as a request does, so a
 * misconfigured root fails the cron rather than pruning against the wrong
 * database.
 *
 * @see {@link https://vault.buildwithfriends.dev/concepts/architecture/}
 */
import { createApp } from "./app.ts";
import { D1Backend } from "./backend-d1.ts";
import { MasterKeyError } from "./crypto.ts";
import { VaultStore } from "./db.ts";
import { VaultKeyring } from "./keyring.ts";
import { Minter } from "./parents/minter.ts";
import {
  auditRetentionDays,
  readRuntimeSecret,
  resolveMasterKeys,
} from "./runtime-secrets.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const [masterKeys, bootstrapToken, backend] = await Promise.all([
        resolveMasterKeys(env),
        readRuntimeSecret(env.BOOTSTRAP_TOKEN, "BOOTSTRAP_TOKEN"),
        new D1Backend(env.DB),
      ]);
      const keyring = await VaultKeyring.open(backend, masterKeys.active);
      return await createApp(keyring, {
        bootstrapToken,
        inactiveMasterKey: masterKeys.inactive,
      }).fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof MasterKeyError) {
        console.error(
          JSON.stringify({ message: "vault root key rejected", error: error.message }),
        );
        return Response.json({ error: error.message }, { status: 500 });
      }
      throw error;
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const masterKeys = await resolveMasterKeys(env);
    const keyring = await VaultKeyring.open(new D1Backend(env.DB), masterKeys.active);
    const store = new VaultStore(keyring.backend, keyring.crypto);
    const cutoff = new Date(
      Date.now() - auditRetentionDays(env) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const deleted = await store.pruneAudit(cutoff);
    console.log(
      JSON.stringify({ message: "vault audit retention complete", deleted, cutoff }),
    );
    const reaped = await new Minter().reap(
      keyring.backend,
      async (orgId) => new VaultStore(keyring.backend, await keyring.cryptoFor(orgId), orgId),
    );
    console.log(JSON.stringify({ message: "vault minted keys closed", ...reaped }));
  },
} satisfies ExportedHandler<Env>;
