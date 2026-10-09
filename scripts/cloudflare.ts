/** Shared by the operator scripts: production config, and running `cf` for one account. */
import * as v from "valibot";

import config from "../cloudflare.config.ts";

const textSchema = v.object({ type: v.literal("text"), value: v.string() });
const storeSecretSchema = v.object({
  type: v.literal("secrets-store-secret"),
  storeId: v.string(),
  secretName: v.string(),
});
const productionSchema = v.looseObject({
  accountId: v.string(),
  worker: v.looseObject({
    compatibilityDate: v.string(),
    env: v.looseObject({
      ACTIVE_MASTER_KEY: v.object({
        type: v.literal("text"),
        value: v.picklist(["primary", "secondary"]),
      }),
      AUDIT_RETENTION_DAYS: textSchema,
      DB: v.object({ type: v.literal("d1"), name: v.string(), id: v.string() }),
      MASTER_KEY_PRIMARY: storeSecretSchema,
      MASTER_KEY_SECONDARY: storeSecretSchema,
      BOOTSTRAP_TOKEN: storeSecretSchema,
    }),
  }),
});

/** The production Worker exactly as `cf ... --mode production` evaluates it. */
export async function production() {
  const parsed = v.safeParse(
    productionSchema,
    await config({ mode: "production", isPreview: false }),
  );
  if (!parsed.success) throw new Error("cloudflare.config.ts production mode is invalid");
  return parsed.output;
}

/**
 * Runs `cf` against one account and returns stdout. The account comes from the
 * environment, so cf never evaluates the cloudflare.config.ts in the cwd.
 */
export async function cf(accountId: string, shell: ReturnType<typeof Bun.$>) {
  const { exitCode, stdout, stderr } = await shell
    // cf colors JSON even into a pipe when FORCE_COLOR is set; parsers need it plain.
    .env({ ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, FORCE_COLOR: "0", NO_COLOR: "1" })
    .quiet()
    .nothrow();
  if (exitCode !== 0) throw new Error(`command failed: ${stderr.toString() || stdout.toString()}`);
  return stdout.toString();
}
