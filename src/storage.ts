/**
 * Choosing the Worker's `VaultBackend` from its configuration.
 *
 * `VAULT_STORAGE` is `d1` (the default, the `DB` binding) or `convex` (a Convex
 * deployment at `CONVEX_SITE_URL`, authenticated with the
 * `CONVEX_STORAGE_TOKEN` Secrets Store value). As with the root keys, nothing
 * here falls back: a missing or malformed setting for the selected backend is
 * a configuration error, and the Worker refuses to serve rather than open a
 * different, empty store.
 */
import type { VaultBackend } from "./backend.ts";
import { ConvexBackend } from "./backend-convex.ts";
import { D1Backend } from "./backend-d1.ts";
import { MasterKeyError } from "./crypto.ts";
import { readRuntimeSecret } from "./runtime-secrets.ts";

export type StorageEnv = {
  VAULT_STORAGE?: string;
  DB?: D1Database;
  CONVEX_SITE_URL?: string;
  CONVEX_STORAGE_TOKEN?: SecretsStoreSecret | string;
};

export async function openBackend(env: StorageEnv): Promise<VaultBackend> {
  const storage = env.VAULT_STORAGE ?? "d1";
  if (storage === "d1") {
    if (env.DB == null) throw new MasterKeyError("DB is required when VAULT_STORAGE is d1");
    return new D1Backend(env.DB);
  }
  if (storage === "convex") {
    const token = await readRuntimeSecret(env.CONVEX_STORAGE_TOKEN, "CONVEX_STORAGE_TOKEN");
    try {
      return new ConvexBackend({ siteUrl: env.CONVEX_SITE_URL ?? "", token });
    } catch (error) {
      // The client refuses a missing or non-https URL and a short token.
      throw new MasterKeyError(error instanceof Error ? error.message : String(error));
    }
  }
  throw new MasterKeyError("VAULT_STORAGE must be d1 or convex");
}
