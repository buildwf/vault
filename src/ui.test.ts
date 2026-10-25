import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { UI_FILES } from "./ui/assets.ts";

describe("operator ui", () => {
  test("serves the page and its assets without a key, under a strict CSP", async () => {
    const { app, env } = await createTestVault();
    const script = Object.keys(UI_FILES).find((path) => path.endsWith(".js"))!;
    const font = Object.keys(UI_FILES).find((path) => path.endsWith(".woff2"))!;
    const style = Object.keys(UI_FILES).find((path) => path.endsWith(".css"))!;
    for (const [path, type] of [
      ["/ui", "text/html"],
      [`/${script}`, "text/javascript"],
      [`/${style}`, "text/css"],
      [`/${font}`, "font/woff2"],
    ] as const) {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toStartWith(type);
      expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'sha256-");
      expect(response.headers.get("Content-Security-Policy")).not.toContain("'unsafe-eval'");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    }
    expect((await app.request("/assets/missing.js", {}, env)).status).toBe(404);
  });

  test("the shell loads its scripts and styles from /assets", async () => {
    const { app, env } = await createTestVault();
    const html = await (await app.request("/ui", {}, env)).text();
    expect(html).toContain('src="/assets/');
    expect(html).toContain('href="/assets/');
  });

  test("the UI never writes API data as HTML", () => {
    const src = join(import.meta.dir, "../web/src");
    for (const name of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.tsx?$/u.test(name)) continue;
      expect(readFileSync(join(src, name), "utf8")).not.toContain("dangerouslySetInnerHTML");
    }
  });

  test("the UI never asks for secret values", () => {
    for (const file of Object.values(UI_FILES)) {
      if (file.base64) continue;
      expect(file.body).not.toContain("show=1");
      expect(file.body).not.toContain("export=1");
    }
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
