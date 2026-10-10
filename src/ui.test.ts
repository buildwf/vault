import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";
import { UI_JS } from "./ui/assets.ts";

describe("operator ui", () => {
  test("serves the page and its assets without a key, under a strict CSP", async () => {
    const { app, env } = await createTestVault();
    for (const [path, type] of [
      ["/ui", "text/html"],
      ["/ui/app.css", "text/css"],
      ["/ui/app.js", "text/javascript"],
    ] as const) {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toStartWith(type);
      expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    }
  });

  test("the script parses and never writes API data as HTML", () => {
    expect(() => new Function(UI_JS)).not.toThrow();
    expect(UI_JS).not.toContain("innerHTML");
    expect(UI_JS).not.toContain("insertAdjacentHTML");
  });

  test("the script never asks for secret values", () => {
    expect(UI_JS).not.toContain("show=1");
    expect(UI_JS).not.toContain("export=1");
  });
});

type TestVault = Awaited<ReturnType<typeof createTestVault>>;
type App = TestVault["app"];
type Env = TestVault["env"];

describe("vault ui sign-in links", () => {
  async function link(app: App, env: Env, key: string) {
    const response = await app.request("/v1/ui/links", { method: "POST", headers: authHeaders(key) }, env);
    expect(response.status).toBe(201);
    return z.parse(z.looseObject({ code: z.string(), expiresAt: z.string() }), await response.json());
  }
  function exchange(app: App, env: Env, code: string) {
    return app.request(
      "/v1/ui/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      },
      env,
    );
  }

  test("a code works once and yields a session key like the key that made it", async () => {
    const { app, env } = await createTestVault();
    const operator = await bootstrapUser(app, env);
    const { code } = await link(app, env, operator);

    const first = await exchange(app, env, code);
    expect(first.status).toBe(201);
    const session = z.parse(
      z.looseObject({ key: z.string(), prefix: z.string(), expiresAt: z.string() }),
      await first.json(),
    );
    expect(Date.parse(session.expiresAt) - Date.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000);
    const keys = await app.request("/v1/keys", { headers: authHeaders(session.key) }, env);
    expect(keys.status).toBe(200);

    expect((await exchange(app, env, code)).status).toBe(401);
    expect((await exchange(app, env, "0".repeat(64))).status).toBe(401);
  });

  test("a scoped key's session keeps its scopes", async () => {
    const { app, env } = await createTestVault();
    const operator = await bootstrapUser(app, env);
    const created = await app.request(
      "/v1/keys",
      {
        method: "POST",
        headers: authHeaders(operator, "application/json"),
        body: JSON.stringify({ type: "system", scopes: [{ project: "web", env: "dev" }] }),
      },
      env,
    );
    const scoped = z.parse(z.looseObject({ key: z.string() }), await created.json()).key;
    const { code } = await link(app, env, scoped);
    const session = z.parse(z.looseObject({ key: z.string() }), await (await exchange(app, env, code)).json());
    const keys = await app.request("/v1/keys", { headers: authHeaders(session.key) }, env);
    expect(keys.status).toBe(403);
    const other = await app.request(
      "/v1/projects/web/environments/prod/secrets",
      { headers: authHeaders(session.key) },
      env,
    );
    expect(other.status).toBe(403);
  });

  test("a code from a revoked key does not sign in", async () => {
    const { app, env } = await createTestVault();
    const operator = await bootstrapUser(app, env);
    const created = await app.request(
      "/v1/keys",
      {
        method: "POST",
        headers: authHeaders(operator, "application/json"),
        body: JSON.stringify({ type: "user" }),
      },
      env,
    );
    const second = z.parse(z.looseObject({ key: z.string(), prefix: z.string() }), await created.json());
    const { code } = await link(app, env, second.key);
    await app.request(`/v1/keys/${second.prefix}`, { method: "DELETE", headers: authHeaders(operator) }, env);
    expect((await exchange(app, env, code)).status).toBe(401);
  });
});
