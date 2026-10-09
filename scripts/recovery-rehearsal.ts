import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VaultClient } from "../src/client.ts";
import { readConfig } from "../src/config.ts";
import {
  d1DatabaseIdFromListOutput,
  deployedWorkersDevUrl,
} from "../src/operational-proofs.ts";
import { cf, production } from "./cloudflare.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
Bun.$.cwd(packageRoot);
const project = "bwf-shadow";
const canaryEnvironment = "prod-worker";
const canarySecret = "POSTHOG_PROJECT_TOKEN";

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const evidenceDirectory = join(homedir(), ".config", "poc-vault", "recovery", stamp);
  mkdirSync(evidenceDirectory, { mode: 0o700, recursive: true });
  chmodSync(evidenceDirectory, 0o700);
  const timeTravelPath = join(evidenceDirectory, "time-travel.json");
  const exportPath = join(evidenceDirectory, "bwf-vault.sql");

  const { accountId, worker: deployed } = await production();
  const database = deployed.env.DB;
  if (database == null)
    throw new Error(
      "the recovery rehearsal covers D1 storage; a Convex-backed vault is restored from Convex backups (see RECOVERY.md)",
    );
  const worker = { ...deployed, env: { ...deployed.env, DB: database } };
  const timeTravel = await cf(
    accountId,
    Bun.$`bunx cf d1 time-travel get-bookmark ${worker.env.DB.id}`,
  );
  // The evidence directory is timestamped per run, so the file is new and the mode applies.
  writeFileSync(timeTravelPath, timeTravel, { mode: 0o600 });
  // ponytail: cf 1.0.0-beta.10 has no D1 export or import; wrangler does both
  // by database name. Move these to cf once it ships them.
  await cf(
    accountId,
    Bun.$`bunx wrangler d1 export ${worker.env.DB.name} --remote --skip-confirmation --output ${exportPath}`,
  );
  chmodSync(exportPath, 0o600);
  console.log("PASS  production Time Travel bookmark and encrypted export captured");

  // mkdtemp creates the directory with mode 0700.
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "bwf-vault-recovery-"));
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `bwf-vault-recovery-${suffix}`;
  const workerName = `bwf-vault-recovery-${suffix}`;
  let databaseId: string | null = null;
  let deployAttempted = false;
  const cleanupFailures: string[] = [];
  try {
    await cf(accountId, Bun.$`bunx cf d1 create --name ${databaseName}`);
    databaseId = d1DatabaseIdFromListOutput(
      await cf(accountId, Bun.$`bunx cf d1 list --name ${databaseName}`),
      databaseName,
    );
    // Import progress streams to the terminal.
    const imported =
      await Bun.$`bunx wrangler d1 execute ${databaseName} --remote --yes --file ${exportPath}`
        .env({ ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId })
        .nothrow();
    if (imported.exitCode !== 0) throw new Error("wrangler d1 execute failed");
    writeTemporaryProject(temporaryDirectory, { accountId, worker }, workerName, {
      name: databaseName,
      id: databaseId,
    });
    // cf deploys the project in its cwd (there is no --config), so the
    // disposable project gets its own directory. Deploy prints its URL as text.
    // cf uploads the script before its trigger step, so a failed deploy can
    // still leave a Worker behind: clean up from the first attempt on.
    deployAttempted = true;
    const { exitCode, stdout, stderr } =
      await Bun.$`bunx cf deploy --message ${"Disposable bwf-vault recovery rehearsal"}`
        .cwd(temporaryDirectory)
        .env({ ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" })
        .quiet()
        .nothrow();
    if (exitCode !== 0) throw new Error(`cf deploy failed: ${stderr.toString()}`);
    const deployed = stdout.toString() + stderr.toString();
    const workerUrl = deployedWorkersDevUrl(deployed);
    await waitForWorker(workerUrl);
    await verifyRecoveredVault(workerUrl);
    console.log(
      "PASS  disposable D1 import decrypted through the production root binding",
    );
    console.log("PASS  recovered operator API key, canary secret, and audit continuity");
  } finally {
    if (deployAttempted) {
      try {
        // Without --force and a TTY, cf prints "Aborted." and exits 0.
        await cf(accountId, Bun.$`bunx cf workers delete ${workerName} --force`);
      } catch {
        cleanupFailures.push(`Worker ${workerName} (if the deploy created it)`);
      }
    }
    if (databaseId !== null) {
      try {
        await cf(accountId, Bun.$`bunx cf d1 delete ${databaseId} --force`);
      } catch {
        cleanupFailures.push(`D1 ${databaseId}`);
      }
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (cleanupFailures.length === 0 && databaseId !== null) {
      console.log("PASS  disposable Worker and D1 database removed");
    }
    // Printed here too: when the rehearsal itself failed, its error is what
    // propagates, and leftover resources bound to production roots must not
    // go unreported.
    if (cleanupFailures.length > 0) {
      console.error(
        `disposable recovery resources need manual cleanup: ${cleanupFailures.join(", ")}`,
      );
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `disposable recovery resources need manual cleanup: ${cleanupFailures.join(", ")}`,
    );
  }
  console.log(`Recovery evidence retained at ${evidenceDirectory}`);
}

/**
 * A throwaway cf project: the production Worker's code and bindings, renamed,
 * with D1 pointed at the disposable copy. cf builds through the repo's
 * wrangler, so the project links the repo's node_modules.
 */
export function writeTemporaryProject(
  directory: string,
  { accountId, worker }: Awaited<ReturnType<typeof production>>,
  workerName: string,
  database: { name: string; id: string },
): void {
  const config = {
    accountId,
    worker: {
      name: workerName,
      entrypoint: resolve(packageRoot, "src/worker.ts"),
      compatibilityDate: worker.compatibilityDate,
      workersDev: true,
      previewUrls: false,
      observability: { enabled: false },
      env: { ...worker.env, DB: { type: "d1", ...database } },
    },
  };
  // The files are inside a fresh mkdtemp directory, so the modes apply.
  writeFileSync(
    join(directory, "cloudflare.config.ts"),
    `export default ${JSON.stringify(config, null, 2)};\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ private: true, type: "module", devDependencies: { wrangler: "*" } })}\n`,
    { mode: 0o600 },
  );
  symlinkSync(join(packageRoot, "node_modules"), join(directory, "node_modules"));
}

async function verifyRecoveredVault(origin: URL): Promise<void> {
  const config = readConfig();
  if (config.apiKey == null) throw new Error("vault operator API key is missing");
  const client = new VaultClient(origin.href, config.apiKey);
  const keys = await client.listMasterKeys();
  if (!keys.wraps.some((wrap) => wrap.fingerprint === keys.activeFingerprint)) {
    throw new Error("recovered vault did not open the active root wrap");
  }
  const exported = await client.exportSecrets(project, canaryEnvironment);
  const secret = exported.secrets.find((candidate) => candidate.name === canarySecret);
  if (secret?.value == null || secret.value.length === 0) {
    throw new Error("recovered canary secret was absent or empty");
  }
  const audit = await client.listAudit(1);
  if (audit.events.length === 0) throw new Error("recovered audit history was empty");
}

async function waitForWorker(origin: URL): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      // The disposable workers.dev route has not propagated yet.
    }
    await Bun.sleep(500);
  }
  throw new Error("disposable recovery Worker did not become reachable");
}

if (import.meta.main) {
  void main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : "recovery rehearsal failed");
    process.exit(1);
  });
}
