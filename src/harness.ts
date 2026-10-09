import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.ts";
import type { VaultBackend } from "./backend.ts";
import { ConvexBackend } from "./backend-convex.ts";
import { D1Backend } from "./backend-d1.ts";
import { generateMasterKey, type VaultCrypto } from "./crypto.ts";
import { openMemoryD1 } from "./d1-sqlite.ts";
import { VaultStore } from "./db.ts";
import { VaultKeyring } from "./keyring.ts";

export const TEST_BOOTSTRAP_TOKEN = "test-bootstrap-token";

/**
 * Which backend the suite runs against: in-memory SQLite through the D1
 * adapter (default), or `VAULT_TEST_BACKEND=convex` for the real
 * `convex/` functions under `convex-test`, reached through the same HTTP action
 * and token check a deployment uses.
 */
export const TEST_BACKEND = process.env.VAULT_TEST_BACKEND === "convex" ? "convex" : "d1";

const TEST_STORAGE_TOKEN = "test-storage-token-0123456789abcdef0123456789";

type TestEnv = Record<string, unknown>;

const root = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(root, "..", "migrations");
const migrationSql = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(migrationDirectory, name), "utf8"))
  .join("\n");

export async function convexModules() {
  const directory = join(root, "..", "convex");
  const files = [
    "_generated/api.js",
    "_generated/server.js",
    "http.ts",
    "schema.ts",
    "vault.ts",
  ];
  return Object.fromEntries(
    files.map((file) => [join(directory, file), () => import(join(directory, file))]),
  );
}

/** A fresh, empty store of the backend under test. */
export async function openTestBackend(): Promise<VaultBackend> {
  if (TEST_BACKEND === "d1") return new D1Backend(openMemoryD1(migrationSql));
  const [{ convexTest }, schema] = await Promise.all([
    import("convex-test"),
    import("../convex/schema.ts"),
  ]);
  process.env.VAULT_STORAGE_TOKEN = TEST_STORAGE_TOKEN;
  const t = convexTest(schema.default, await convexModules());
  return new ConvexBackend({
    siteUrl: "https://vault-test.convex.site",
    token: TEST_STORAGE_TOKEN,
    fetch: (input, init) => t.fetch(new URL(input).pathname, init),
  });
}

export async function createTestVault(): Promise<{
  env: TestEnv;
  backend: VaultBackend;
  crypto: VaultCrypto;
  store: VaultStore;
  app: ReturnType<typeof createApp>;
  masterKey: string;
}> {
  const masterKey = generateMasterKey();
  const env: TestEnv = {};
  const backend = await openTestBackend();
  const keyring = await VaultKeyring.open(backend, masterKey);
  return {
    env,
    backend,
    crypto: keyring.crypto,
    store: new VaultStore(backend, keyring.crypto),
    app: createApp(keyring, {
      bootstrapToken: TEST_BOOTSTRAP_TOKEN,
      inactiveMasterKey: generateMasterKey(),
    }),
    masterKey,
  };
}

export async function bootstrapUser(
  app: ReturnType<typeof createApp>,
  env: TestEnv,
): Promise<string> {
  const response = await app.request(
    "/v1/bootstrap",
    {
      method: "POST",
      headers: { "X-Vault-Bootstrap-Token": TEST_BOOTSTRAP_TOKEN },
      body: "{}",
    },
    env,
  );
  if (!response.ok) throw new Error(`bootstrap failed: ${await response.text()}`);
  // SAFETY: the app's successful /v1/bootstrap response always contains its
  // generated API key under the string-valued key field.
  const body = (await response.json()) as { key: string };
  return body.key;
}

export function authHeaders(key: string, contentType?: "application/json") {
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  if (contentType !== undefined) headers.set("content-type", contentType);
  return headers;
}
