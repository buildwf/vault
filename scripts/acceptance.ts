import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import config from "../cloudflare.config.ts";
import { VaultClient } from "../src/client.ts";
import { generateMasterKey } from "../src/crypto.ts";
import { randomSecretValue } from "../src/keys.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const state = mkdtempSync(join(tmpdir(), "bwf-vault-acceptance-"));
const envFile = join(state, "vault.env");
const port = 18787;
const origin = `http://127.0.0.1:${port}`;
const bootstrapToken = randomSecretValue();

type WorkerProcess = {
  exited: Promise<number>;
  kill: () => void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

writeFileSync(
  envFile,
  [
    `MASTER_KEY_PRIMARY=${generateMasterKey()}`,
    `MASTER_KEY_SECONDARY=${generateMasterKey()}`,
    `BOOTSTRAP_TOKEN=${bootstrapToken}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

let worker: WorkerProcess | null = null;
try {
  await applyLocalMigrations(state);
  worker = Bun.spawn(
    [
      "bunx",
      "wrangler",
      "dev",
      // The same wrangler code path `cf dev` delegates to, called directly
      // because `cf dev` forwards only --mode/--port/--host/--local and so
      // cannot isolate --persist-to or --env-file.
      "--experimental-new-config",
      "--local",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--env-file",
      envFile,
    ],
    { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
  );
  await waitForWorker(origin, worker);

  const temporary = await new VaultClient(origin, "").bootstrap(
    bootstrapToken,
    "acceptance bootstrap",
  );
  const client = new VaultClient(origin, temporary.key);
  await client.createProject("acceptance");
  await client.patchSecrets("acceptance", "dev", {
    set: [{ name: "ACCEPTANCE_TOKEN", value: "acceptance-value", kind: "secret" }],
  });
  const listed = await client.listSecretMeta("acceptance", "dev");
  if (listed.secrets.length !== 1 || listed.secrets[0]?.name !== "ACCEPTANCE_TOKEN") {
    throw new Error("local Worker did not return the stored secret metadata");
  }
  const read = await client.getSecret("acceptance", "dev", "ACCEPTANCE_TOKEN");
  if (read.value !== "acceptance-value") {
    throw new Error("local Worker did not decrypt the stored secret");
  }
  const audit = await client.listAudit(20);
  if (!audit.events.some((event) => event.action === "set")) {
    throw new Error("local Worker did not record the secret write audit event");
  }
  console.log(
    "vault acceptance passed: workerd + D1 + bootstrap + encrypted CRUD + audit",
  );
} finally {
  if (worker != null) {
    worker.kill();
    await worker.exited;
  }
  rmSync(state, { recursive: true, force: true });
}

async function waitForWorker(url: string, child: WorkerProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("wrangler dev exited before becoming ready");
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Wrangler has not bound the port yet.
    }
    await Bun.sleep(200);
  }
  throw new Error("wrangler dev did not become ready within 30 seconds");
}

async function applyLocalMigrations(persistTo: string): Promise<void> {
  const { worker: local } = await config({ mode: undefined, isPreview: false });
  const databaseId = "DB" in local.env ? local.env.DB.id : undefined;
  if (databaseId == null)
    throw new Error("acceptance runs the D1 Worker; unset VAULT_STORAGE=convex for it");
  const child = Bun.spawn(
    ["bunx", "cf", "d1", "migrations", "apply", databaseId, "--local", "--persist-to", persistTo],
    { cwd: packageRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  // ponytail: cf 1.0.0-beta.10 prints the JSON result for --local and then
  // often never exits (a file watcher stays open), and its cleanup hook
  // swallows the first SIGTERM. The parsed result is the completion signal;
  // wait on `child.exited` instead once cf exits on its own.
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let text = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of child.stdout) {
      text += decoder.decode(chunk, { stream: true });
      let rows: { name: string; status: string }[];
      try {
        rows = JSON.parse(text);
      } catch {
        continue;
      }
      if (rows.some((row) => row.status !== "\u2705")) {
        throw new Error(`cf d1 migrations apply failed:\n${text}`);
      }
      return;
    }
    throw new Error(
      `cf d1 migrations apply exited without a result:\n${text}${await new Response(child.stderr).text()}`,
    );
  } finally {
    clearTimeout(deadline);
    // SIGTERM first (cf may swallow one), then SIGKILL so nothing lingers.
    for (
      let attempt = 0;
      attempt < 5 && child.exitCode == null && child.signalCode == null;
      attempt++
    ) {
      child.kill(attempt < 2 ? "SIGTERM" : "SIGKILL");
      await Promise.race([child.exited, Bun.sleep(1_000)]);
    }
  }
}
