import * as v from "valibot";
/**
 * Reading the Worker's required runtime configuration.
 *
 * The three Secrets Store roots and both vars are *required*: every accessor
 * here throws on absence rather than returning a default. Vault has no mode in
 * which a missing root selects a fallback — presence of a credential must never
 * decide whether a capability is on, and an empty default would be a second,
 * untested configuration of the product.
 *
 * `resolveMasterKeys` returns both slots because rotation needs the inactive
 * one: `POST /v1/master-keys/prepare` wraps the data key for the slot that is
 * not currently live.
 *
 * @see {@link https://vault.buildwithfriends.dev/reference/configuration/}
 */
import { MasterKeyError } from "./crypto.ts";
import type { GithubSignInConfig } from "./github-signin.ts";

export async function readRuntimeSecret(
  binding: SecretsStoreSecret | string | undefined,
  name: string,
): Promise<string> {
  // A plain string is the value itself; a binding has to be read.
  let value: string | undefined;
  if (v.is(v.string(), binding)) value = binding;
  else if (binding != null) value = await binding.get();
  if (value == null || value.length === 0) {
    throw new MasterKeyError(`${name} is required`);
  }
  return value;
}

export async function resolveMasterKeys(env: Env): Promise<{
  active: string;
  inactive: string;
  activeSlot: "primary" | "secondary";
}> {
  const [primary, secondary] = await Promise.all([
    readRuntimeSecret(env.MASTER_KEY_PRIMARY, "MASTER_KEY_PRIMARY"),
    readRuntimeSecret(env.MASTER_KEY_SECONDARY, "MASTER_KEY_SECONDARY"),
  ]);
  const activeSlot: string = env.ACTIVE_MASTER_KEY;
  if (activeSlot !== "primary" && activeSlot !== "secondary") {
    throw new MasterKeyError("ACTIVE_MASTER_KEY must be primary or secondary");
  }
  return activeSlot === "primary"
    ? { active: primary, inactive: secondary, activeSlot }
    : { active: secondary, inactive: primary, activeSlot };
}

export function auditRetentionDays(env: Env): number {
  const days = Number(env.AUDIT_RETENTION_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("AUDIT_RETENTION_DAYS must be an integer from 1 to 3650");
  }
  return days;
}

/**
 * GitHub sign-in is on when the deploy names an OAuth app (`GITHUB_CLIENT_ID`).
 * Then its secret is required like any root: a named app with no secret is a
 * configuration error, not a reason to quietly turn sign-in off.
 */
export async function resolveGithubSignIn(env: Env): Promise<GithubSignInConfig | undefined> {
  // SAFETY: both bindings exist only in deploys that configured GitHub sign-in.
  const github = env as unknown as {
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: SecretsStoreSecret | string;
  };
  if (github.GITHUB_CLIENT_ID == null || github.GITHUB_CLIENT_ID === "") return undefined;
  return {
    clientId: github.GITHUB_CLIENT_ID,
    clientSecret: await readRuntimeSecret(github.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET"),
  };
}
