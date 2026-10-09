import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";
import { randomApiKey } from "./keys.ts";

const secretsParser = z.looseObject({
  secrets: z.array(
    z.looseObject({ name: z.string(), kind: z.string(), value: z.optional(z.string()) }),
  ),
});
const errorParser = z.looseObject({ error: z.string() });

describe("worker api", () => {
  test("human can set a secret, list hides it, run-shaped get returns it", async () => {
    const { app, env } = await createTestVault();
    const key = await bootstrapUser(app, env);
    await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "demo" }),
      },
      env,
    );
    const set = await app.request(
      "/v1/projects/demo/environments/dev/secrets",
      {
        method: "PATCH",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({
          set: [{ name: "DATABASE_URL", value: "postgres://x", kind: "secret" }],
        }),
      },
      env,
    );
    expect(set.status).toBe(200);

    const listed = await app.request(
      "/v1/projects/demo/environments/dev/secrets",
      {
        headers: authHeaders(key),
      },
      env,
    );
    const listedBody = z.parse(secretsParser, await listed.json());
    expect(listedBody.secrets).toEqual([{ name: "DATABASE_URL", kind: "secret" }]);

    const shown = await app.request(
      "/v1/projects/demo/environments/dev/secrets?show=1",
      {
        headers: authHeaders(key),
      },
      env,
    );
    const shownBody = z.parse(secretsParser, await shown.json());
    expect(shownBody.secrets[0]?.value).toBe("postgres://x");
  });

  test("empty values are rejected and ciphertext is not plaintext", async () => {
    const { app, env, store, backend } = await createTestVault();
    const key = await bootstrapUser(app, env);
    await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "demo" }),
      },
      env,
    );
    const empty = await app.request(
      "/v1/projects/demo/environments/dev/secrets",
      {
        method: "PATCH",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ set: [{ name: "X", value: "", kind: "secret" }] }),
      },
      env,
    );
    expect(empty.status).toBe(400);

    await app.request(
      "/v1/projects/demo/environments/dev/secrets",
      {
        method: "PATCH",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({
          set: [{ name: "TOKEN", value: "super-secret-value", kind: "sealed" }],
        }),
      },
      env,
    );
    const { environmentId } = await store.requireEnvironment("demo", "dev");
    const dump = await store.listSecretRows(environmentId);
    const blob = JSON.stringify(dump);
    expect(blob.includes("super-secret-value")).toBe(false);
    expect(blob.includes("TOKEN")).toBe(false);
    const auditRow = (await backend.listAudit({ orgId: store.orgId, limit: 200, before: null })).find(
      (row) => row.action === "set",
    );
    expect(auditRow?.secretNameEncrypted).toBeString();
    expect(auditRow!.secretNameEncrypted!.includes("TOKEN")).toBe(false);
  });

  test("legacy broker keys list names only, and new keys take no broker mode", async () => {
    const { app, env, store } = await createTestVault();
    const user = await bootstrapUser(app, env);
    await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(user, "application/json"),
        body: JSON.stringify({ name: "demo" }),
      },
      env,
    );
    await app.request(
      "/v1/projects/demo/environments/dev/secrets",
      {
        method: "PATCH",
        headers: authHeaders(user, "application/json"),
        body: JSON.stringify({ set: [{ name: "GATE_CHECKED", value: "hidden-value" }] }),
      },
      env,
    );
    const broker = randomApiKey("system");
    await store.insertKey({
      plaintext: broker.plaintext,
      prefix: broker.prefix,
      type: "system",
      permission: "readwrite",
      mode: "broker",
      label: "legacy",
      scopes: [{ project: "demo", env: "dev" }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const base = "/v1/projects/demo/environments/dev/secrets";
    const as = (init: RequestInit = {}) => ({
      ...init,
      headers: authHeaders(broker.plaintext, "application/json"),
    });
    const listed = await app.request(base, as(), env);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("GATE_CHECKED");
    for (const path of [`${base}?show=1`, `${base}?export=1`, `${base}/GATE_CHECKED`]) {
      const denied = await app.request(path, as(), env);
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain("hidden-value");
    }
    const write = await app.request(
      base,
      as({ method: "PATCH", body: JSON.stringify({ set: [{ name: "X_Y", value: "v" }] }) }),
      env,
    );
    expect(write.status).toBe(403);

    const created = await app.request(
      "/v1/keys",
      {
        method: "POST",
        headers: authHeaders(user, "application/json"),
        body: JSON.stringify({
          type: "system",
          mode: "broker",
          scopes: [{ project: "demo", env: "dev" }],
        }),
      },
      env,
    );
    expect(created.status).toBe(400);
  });

  test("export returns sealed values, get does not", async () => {
    const { app, env } = await createTestVault();
    const user = await bootstrapUser(app, env);
    await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(user, "application/json"),
        body: JSON.stringify({ name: "demo" }),
      },
      env,
    );
    await app.request(
      "/v1/projects/demo/environments/dev/secrets",
      {
        method: "PATCH",
        headers: authHeaders(user, "application/json"),
        body: JSON.stringify({
          set: [{ name: "GITHUB_TOKEN", value: "real-token", kind: "sealed" }],
        }),
      },
      env,
    );
    const exported = await app.request(
      "/v1/projects/demo/environments/dev/secrets?export=1",
      { headers: authHeaders(user) },
      env,
    );
    const exportedBody = z.parse(secretsParser, await exported.json());
    expect(exportedBody.secrets[0]?.value).toBe("real-token");

    const got = await app.request(
      "/v1/projects/demo/environments/dev/secrets/GITHUB_TOKEN",
      { headers: authHeaders(user) },
      env,
    );
    expect(got.status).toBe(403);
  });

  test("handoff keys can expire in minutes", async () => {
    const { app, env } = await createTestVault();
    const user = await bootstrapUser(app, env);
    const before = Date.now();
    const created = await app.request(
      "/v1/keys",
      {
        method: "POST",
        headers: authHeaders(user, "application/json"),
        body: JSON.stringify({
          type: "system",
          scopes: [{ project: "demo", env: "dev" }],
          expiresInMinutes: 5,
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const prefix = z.parse(z.looseObject({ prefix: z.string() }), await created.json()).prefix;
    const listed = z.parse(
      z.looseObject({ keys: z.array(z.looseObject({ keyPrefix: z.string(), expiresAt: z.string() })) }),
      await (await app.request("/v1/keys", { headers: authHeaders(user) }, env)).json(),
    );
    const expiresAt = Date.parse(listed.keys.find((key) => key.keyPrefix === prefix)!.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);
  });

  test("creating a duplicate project is a 409 conflict, not a 500", async () => {
    const { app, env } = await createTestVault();
    const key = await bootstrapUser(app, env);
    const first = await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "demo" }),
      },
      env,
    );
    expect(first.status).toBe(201);

    const duplicate = await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "Demo" }),
      },
      env,
    );
    expect(duplicate.status).toBe(409);
    const conflictBody = z.parse(errorParser, await duplicate.json());
    expect(conflictBody).toEqual({ error: 'project "demo" already exists' });
  });

  test("creating a duplicate environment is a 409 conflict, not a 500", async () => {
    const { app, env } = await createTestVault();
    const key = await bootstrapUser(app, env);
    await app.request(
      "/v1/projects",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "demo" }),
      },
      env,
    );

    const duplicate = await app.request(
      "/v1/projects/demo/environments",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "dev" }),
      },
      env,
    );
    expect(duplicate.status).toBe(409);
    const conflictBody = z.parse(errorParser, await duplicate.json());
    expect(conflictBody).toEqual({ error: 'environment "dev" already exists' });

    const fresh = await app.request(
      "/v1/projects/demo/environments",
      {
        method: "POST",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ name: "staging" }),
      },
      env,
    );
    expect(fresh.status).toBe(201);
  });
});
