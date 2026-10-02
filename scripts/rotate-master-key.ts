import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VaultClient } from "../src/client.ts";
import { resolveClientOptions } from "../src/config.ts";
import {
  generateMasterKey,
  masterKeyFingerprint,
  parseMasterKey,
} from "../src/crypto.ts";
import { secretsStoreSecretId } from "../src/operational-proofs.ts";
import { cf, production } from "./cloudflare.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
Bun.$.cwd(packageRoot);

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "prepare" || argv[1] !== "--yes") {
    throw new Error("usage: rotate-master-key.ts prepare --yes");
  }
  const { accountId, worker } = await production();
  const activeSlot = worker.env.ACTIVE_MASTER_KEY.value;
  const inactiveSlot = activeSlot === "primary" ? "secondary" : "primary";
  const binding =
    inactiveSlot === "primary" ? worker.env.MASTER_KEY_PRIMARY : worker.env.MASTER_KEY_SECONDARY;
  const { apiUrl, apiKey } = resolveClientOptions({});
  const client = new VaultClient(apiUrl, apiKey);
  const before = await client.listMasterKeys();
  const secretId = secretsStoreSecretId(
    await cf(
      accountId,
      Bun.$`bunx cf secrets-store secrets list --store-id ${binding.storeId} --search ${binding.secretName} --per-page 100`,
    ),
    binding.secretName,
  );
  const root = generateMasterKey();
  const expectedFingerprint = await masterKeyFingerprint(parseMasterKey(root));
  // Root rotation is always an explicit human ceremony. The value goes in on
  // stdin, so no argv, shell history, or process listing ever holds it.
  // Never add --dry-run here: cf prints the value in dry-run output.
  const comment = "Root of trust for isolated bwf-vault replacement candidate";
  await cf(
    accountId,
    Bun.$`bunx cf secrets-store secrets edit ${secretId} --store-id ${binding.storeId} --value @/dev/stdin --scopes workers --comment ${comment} < ${Buffer.from(root)}`,
  );
  const prepared = await prepareExpectedRoot(client, expectedFingerprint);
  const after = await client.listMasterKeys();
  if (!after.wraps.some((wrap) => wrap.fingerprint === prepared.fingerprint)) {
    throw new Error("new root wrap was not persisted");
  }
  const receiptDirectory = join(homedir(), ".config", "poc-vault", "rotations");
  mkdirSync(receiptDirectory, { mode: 0o700, recursive: true });
  chmodSync(receiptDirectory, 0o700);
  const receiptPath = join(
    receiptDirectory,
    `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.json`,
  );
  writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        activeSlotBefore: activeSlot,
        preparedFingerprint: expectedFingerprint,
        preparedSlot: inactiveSlot,
      },
      null,
      2,
    )}\n`,
    // The timestamped path is new on every run, so the mode applies.
    { mode: 0o600 },
  );
  console.log(`prepared ${prepared.fingerprint} in ${inactiveSlot}`);
  console.log(`previous active ${before.activeFingerprint} in ${activeSlot}`);
  console.log(`rotation receipt ${receiptPath}`);
}

async function prepareExpectedRoot(
  client: VaultClient,
  expectedFingerprint: string,
): Promise<{ fingerprint: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const prepared = await client.prepareMasterKey();
    if (prepared.fingerprint === expectedFingerprint) return prepared;
    await Bun.sleep(1_000);
  }
  throw new Error("Secrets Store did not propagate the expected root within one minute");
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error(
      cause instanceof Error ? cause.message : "master-key preparation failed",
    );
    process.exit(1);
  });
}
