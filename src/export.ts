/**
 * The values `vault run` and `use_secret` export: every secret, sealed ones
 * included, with each `minted` secret replaced by a fresh child key from its
 * parent. Each mint is audited under the key that asked.
 */
import type { VaultStore } from "./db.ts";
import type { Minter } from "./parents/minter.ts";
import type { ApiKeyRecord } from "./types.ts";

export async function exportSecrets(
  store: VaultStore,
  minter: Minter,
  key: ApiKeyRecord,
  project: string,
  env: string,
  names?: string[],
) {
  const { environmentId } = await store.requireEnvironment(project, env);
  let secrets = await store.listSecrets(environmentId);
  if (names != null) secrets = secrets.filter((secret) => names.includes(secret.name));
  for (const secret of secrets) {
    if (secret.kind !== "minted") continue;
    const label = `${project}/${env}/${secret.name}`;
    try {
      secret.value = await minter.mint(store, { value: secret.value, label, keyPrefix: key.keyPrefix });
      await store.audit({ keyPrefix: key.keyPrefix, action: "mint", status: "ok", secretName: secret.name });
    } catch (error) {
      await store.audit({ keyPrefix: key.keyPrefix, action: "mint", status: "failed", secretName: secret.name });
      throw error;
    }
  }
  return secrets;
}
