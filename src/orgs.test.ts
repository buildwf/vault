import { describe, expect, test } from "bun:test";

import { DEFAULT_ORG } from "./backend.ts";
import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";

type Vault = Awaited<ReturnType<typeof createTestVault>>;

async function call(vault: Vault, key: string, method: string, path: string, body?: unknown) {
  return vault.app.request(
    path,
    {
      method,
      headers: authHeaders(key, body === undefined ? undefined : "application/json"),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    vault.env,
  );
}

async function createOrg(vault: Vault, platformKey: string, name: string): Promise<string> {
  const response = await call(vault, platformKey, "POST", "/v1/orgs", { name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { key: string }).key;
}

async function setSecret(vault: Vault, key: string, project: string, value: string) {
  expect((await call(vault, key, "POST", "/v1/projects", { name: project })).status).toBe(201);
  const response = await call(
    vault,
    key,
    "PATCH",
    `/v1/projects/${project}/environments/dev/secrets`,
    { set: [{ name: "TOKEN", value }] },
  );
  expect(response.status).toBe(200);
}

describe("orgs", () => {
  test("each org sees only its own projects, secrets, keys and audit", async () => {
    const vault = await createTestVault();
    const platform = await bootstrapUser(vault.app, vault.env);
    const acme = await createOrg(vault, platform, "acme");
    const globex = await createOrg(vault, platform, "globex");

    // The same project name in three orgs, each with its own value.
    await setSecret(vault, platform, "web", "platform-value");
    await setSecret(vault, acme, "web", "acme-value");
    await setSecret(vault, globex, "web", "globex-value");

    for (const [key, value] of [
      [platform, "platform-value"],
      [acme, "acme-value"],
      [globex, "globex-value"],
    ] as const) {
      const response = await call(vault, key, "GET", "/v1/projects/web/environments/dev/secrets/TOKEN");
      expect(((await response.json()) as { value: string }).value).toBe(value);
      const projects = await call(vault, key, "GET", "/v1/projects");
      expect(((await projects.json()) as { projects: string[] }).projects).toEqual(["web"]);
    }

    // Keys: acme lists only its own, and cannot revoke or rotate another org's.
    const acmeKeys = (await (await call(vault, acme, "GET", "/v1/keys")).json()) as {
      keys: { keyPrefix: string; orgId?: string }[];
    };
    expect(acmeKeys.keys).toHaveLength(1);
    expect(acmeKeys.keys[0]!.orgId).toBeUndefined();
    const globexPrefix = (
      (await (await call(vault, globex, "GET", "/v1/keys")).json()) as {
        keys: { keyPrefix: string }[];
      }
    ).keys[0]!.keyPrefix;
    expect((await call(vault, acme, "DELETE", `/v1/keys/${globexPrefix}`)).status).toBe(404);
    expect((await call(vault, acme, "POST", `/v1/keys/${globexPrefix}/rotate`, {})).status).toBe(
      404,
    );

    // A system key scoped to web/dev in acme cannot read globex's web/dev.
    const shared = (await (
      await call(vault, acme, "POST", "/v1/keys", {
        type: "system",
        scopes: [{ project: "web", env: "dev" }],
      })
    ).json()) as { key: string };
    const exported = (await (
      await call(vault, shared.key, "GET", "/v1/projects/web/environments/dev/secrets?export=1")
    ).json()) as { secrets: { value: string }[] };
    expect(exported.secrets.map((secret) => secret.value)).toEqual(["acme-value"]);

    // Audit: acme's log holds only acme's events.
    const audit = (await (await call(vault, acme, "GET", "/v1/audit?limit=200")).json()) as {
      events: { keyPrefix: string }[];
    };
    const acmeActors = new Set(
      ((await (await call(vault, acme, "GET", "/v1/keys")).json()) as {
        keys: { keyPrefix: string }[];
      }).keys.map((key) => key.keyPrefix),
    );
    expect(audit.events.length).toBeGreaterThan(0);
    for (const event of audit.events) expect(acmeActors.has(event.keyPrefix)).toBe(true);

    // Each org's rows are encrypted under its own data key.
    const row = await vault.backend.findKeyByHash({ keyHash: await vault.crypto.sha256(acme) });
    expect(row?.orgId).not.toBe(DEFAULT_ORG);
    const project = await vault.backend.getProject({ orgId: row!.orgId, name: "web" });
    const environment = await vault.backend.getEnvironment({ projectId: project!.id, name: "dev" });
    const [secret] = await vault.backend.listSecretRows({ environmentId: environment!.id });
    await expect(vault.crypto.decrypt(secret!.valueEncrypted)).rejects.toThrow();
  });

  test("only platform operators create orgs or manage master keys", async () => {
    const vault = await createTestVault();
    const platform = await bootstrapUser(vault.app, vault.env);
    const acme = await createOrg(vault, platform, "acme");

    expect((await call(vault, acme, "POST", "/v1/orgs", { name: "evil" })).status).toBe(403);
    expect((await call(vault, acme, "GET", "/v1/orgs")).status).toBe(403);
    expect((await call(vault, acme, "GET", "/v1/master-keys")).status).toBe(403);
    expect((await call(vault, acme, "POST", "/v1/master-keys/prepare")).status).toBe(403);

    expect((await call(vault, platform, "POST", "/v1/orgs", { name: "acme" })).status).toBe(409);
    expect((await call(vault, platform, "POST", "/v1/orgs", { name: DEFAULT_ORG })).status).toBe(
      409,
    );
    expect((await call(vault, platform, "POST", "/v1/orgs", { name: "Bad Name" })).status).toBe(
      400,
    );
    const orgs = (await (await call(vault, platform, "GET", "/v1/orgs")).json()) as {
      orgs: string[];
    };
    expect(orgs.orgs).toEqual(["acme"]);
  });

  test("the last-operator guard is per org", async () => {
    const vault = await createTestVault();
    const platform = await bootstrapUser(vault.app, vault.env);
    const acme = await createOrg(vault, platform, "acme");
    const prefixOf = async (key: string) =>
      (
        (await (await call(vault, key, "GET", "/v1/keys")).json()) as {
          keys: { keyPrefix: string }[];
        }
      ).keys[0]!.keyPrefix;
    // Acme's only operator cannot revoke itself, even though the platform org has one too.
    expect((await call(vault, acme, "DELETE", `/v1/keys/${await prefixOf(acme)}`)).status).toBe(
      409,
    );
    expect(
      (await call(vault, platform, "DELETE", `/v1/keys/${await prefixOf(platform)}`)).status,
    ).toBe(409);
  });
});
