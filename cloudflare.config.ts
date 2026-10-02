import { join } from "node:path";

import { bindings, defineConfig, triggers } from "cf/config";

// One Worker, two modes. `cf ... --mode production` deploys the real Worker;
// no --mode (cf dev, local scripts) evaluates the local one.
// Node compatibility is on by default from compatibility date 2026-08-04.
// Lowering the date below that would silently drop the Node built-ins this
// Worker imports.
//
// Account and resource ids are deployment-specific and stay out of this public
// repository: they come from the environment, or from a gitignored `.env` next
// to this file (see `.env.example`). The real environment wins over `.env`.
try {
  process.loadEnvFile(join(import.meta.dirname, ".env"));
} catch {
  // No .env: the environment alone configures production.
}

/** The local Worker's D1 id; it names local state only, never a real database. */
const LOCAL_D1_ID = "00000000-0000-4000-8000-00000000d1d1";

function required(name: string): string {
  const value = process.env[name];
  if (value == null || value === "")
    throw new Error(`cloudflare.config.ts: set ${name} in .env or the environment (see .env.example)`);
  return value;
}

export default defineConfig(({ mode }) => {
  const production = mode === "production";
  const workerName = process.env.VAULT_WORKER_NAME ?? "bwf-vault";
  const d1Name = process.env.VAULT_D1_NAME ?? "bwf-vault";
  const prefix = process.env.VAULT_SECRET_PREFIX ?? "BWF_VAULT";
  const storeSecret = (slot: string) =>
    bindings.secretsStoreSecret({
      storeId: required("VAULT_SECRETS_STORE_ID"),
      secretName: `${prefix}_${slot}`,
    });
  return {
    accountId: production ? required("CLOUDFLARE_ACCOUNT_ID") : process.env.CLOUDFLARE_ACCOUNT_ID,
    worker: {
      name: production ? workerName : `${workerName}-local`,
      entrypoint: "src/worker.ts",
      compatibilityDate: "2026-08-31",
      workersDev: production,
      previewUrls: false,
      observability: {
        enabled: true,
        logs: { headSamplingRate: 1 },
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
      triggers: [triggers.scheduled({ schedule: "0 3 * * *" })],
      env: {
        // Which root slot is live. Committed on purpose: if each operator's
        // .env chose it, two deploys could disagree and lock the vault out.
        ACTIVE_MASTER_KEY: bindings.text("primary"),
        AUDIT_RETENTION_DAYS: bindings.text("365"),
        // migrations_dir has no field here: wrangler and `cf d1 migrations`
        // both default to ./migrations and the d1_migrations table.
        DB: bindings.d1({ name: d1Name, id: production ? required("VAULT_D1_ID") : LOCAL_D1_ID }),
        ...(production
          ? {
              MASTER_KEY_PRIMARY: storeSecret("MASTER_KEY_PRIMARY"),
              MASTER_KEY_SECONDARY: storeSecret("MASTER_KEY_SECONDARY"),
              BOOTSTRAP_TOKEN: storeSecret("BOOTSTRAP_TOKEN"),
            }
          : {
              // Local dev reads these as plain strings from .dev.vars / .env.
              MASTER_KEY_PRIMARY: bindings.secret(),
              MASTER_KEY_SECONDARY: bindings.secret(),
              BOOTSTRAP_TOKEN: bindings.secret(),
            }),
      },
    },
  };
});
