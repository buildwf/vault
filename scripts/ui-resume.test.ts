import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { UI_CSP, UI_FILES } from "../src/ui/assets.ts";

let browser: Browser;
const writes: { path: string; body: unknown }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = UI_FILES[path === "/ui" ? "index.html" : path.slice(1)];
    if (file) {
      return new Response(file.base64 ? Buffer.from(file.body, "base64") : file.body, {
        headers: { "Content-Type": file.type, "Content-Security-Policy": UI_CSP },
      });
    }
    if (path === "/") return Response.json({ githubSignIn: true });
    if (path === "/v1/ui/session" && request.method === "POST") {
      return Response.json({ key: "synthetic-session-key" });
    }
    if (request.headers.get("Authorization") !== "Bearer synthetic-session-key") {
      return Response.json({ error: "Sign in required" }, { status: 401 });
    }
    if (path === "/v1/overview") {
      return Response.json({
        key: { type: "user", keyPrefix: "test" },
        projects: [{ name: "demo", environments: [{ name: "dev", secrets: [] }] }],
      });
    }
    if (path === "/v1/keys" && request.method === "GET") return Response.json({ keys: [] });
    if (path === "/v1/people") return Response.json({ githubSignIn: false, people: [] });
    if ((path === "/v1/keys" && request.method === "POST") ||
        (path === "/v1/projects/demo/environments/dev/secrets" && request.method === "PATCH")) {
      writes.push({ path, body: await request.json() });
      return Response.json({ prefix: "synthetic-prefix", key: "synthetic-created-key" });
    }
    if (path === "/v1/oauth/client") {
      return Response.json({ name: "Test app", redirectUri: "https://example.com/callback" });
    }
    if (path === "/v1/oauth/approvals/test-approval") {
      return Response.json({
        client: "Test app", project: "demo", env: "dev", names: ["API_KEY"],
        host: "example.com", expiresAt: "2099-01-01T00:00:00Z",
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server.stop(true);
});

const connect = encodeURIComponent("client_id=test&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=resume-test");
for (const [flow, hash, heading] of [
  ["connect", `#/connect/${connect}`, "Connect Test app"],
  ["approve", "#/approve/test-approval", "Allow Test app to use API_KEY?"],
  ["collect", "#/collect/demo/dev/API_KEY", "Add API_KEY"],
] as const) {
  for (const newTab of [false, true]) {
    test(`resumes ${flow} after ${newTab ? "vault ui in a new tab" : "GitHub sign-in in the same tab"}`, async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(3_000);
        await page.goto(`${server.url}ui${hash}`);
        await page.getByText("Sign in to Vault", { exact: true }).waitFor();
        await page.waitForFunction(() => localStorage.getItem("vault.next") !== null);

        const resumed = newTab ? await context.newPage() : page;
        resumed.setDefaultTimeout(3_000);
        const documents: string[] = [];
        resumed.on("request", (request) => {
          if (request.isNavigationRequest()) documents.push(new URL(request.url()).pathname);
        });
        await resumed.goto(`${server.url}ui#signin=${"a".repeat(64)}`);
        await resumed.waitForURL((url) => url.hash === hash || /^\/(connect|approve|collect)\//.test(url.pathname));

        const url = new URL(resumed.url());
        expect(url.pathname).toBe("/ui");
        expect(url.hash).toBe(hash);
        await resumed.getByRole("heading", { name: heading, exact: true }).waitFor();
        expect(await resumed.evaluate("localStorage.getItem('vault.next')")).toBeNull();
        expect(documents.filter((path) => /^\/(connect|approve|collect)\//.test(path))).toEqual([]);
      } finally {
        await context.close();
      }
    }, 15_000);
  }
}

test("saving a config resets the displayed and submitted kind to secret", async () => {
  const context = await browser.newContext();
  const start = writes.length;
  try {
    const page = await context.newPage();
    await page.addInitScript(() => sessionStorage.setItem("vault.key", "synthetic-session-key"));
    await page.goto(`${server.url}ui#/projects/demo/dev`);
    await page.locator("#kind").selectOption("config");
    await page.getByLabel("Name", { exact: true }).fill("PUBLIC_SETTING");
    await page.getByLabel("Value", { exact: true }).fill("https://example.com");
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await browserExpect(page.getByLabel("Name", { exact: true })).toHaveValue("");
    await browserExpect(page.locator("#kind")).toHaveValue("secret");
    await browserExpect(page.getByText("A credential. Apps with access read it at runtime.", { exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("PRIVATE_CREDENTIAL");
    await page.getByLabel("Value", { exact: true }).fill("synthetic-credential");
    await page.getByRole("button", { name: "Save secret", exact: true }).click();
    await browserExpect(page.getByLabel("Name", { exact: true })).toHaveValue("");
    expect(writes.slice(start).map((write) => write.body)).toEqual([
      { set: [{ name: "PUBLIC_SETTING", kind: "config", value: "https://example.com" }] },
      { set: [{ name: "PRIVATE_CREDENTIAL", kind: "secret", value: "synthetic-credential" }] },
    ]);
  } finally {
    await context.close();
  }
}, 15_000);

test("creating an operator key resets to a scoped key with scope fields", async () => {
  const context = await browser.newContext();
  const start = writes.length;
  try {
    const page = await context.newPage();
    await page.addInitScript(() => sessionStorage.setItem("vault.key", "synthetic-session-key"));
    await page.goto(`${server.url}ui#/keys`);
    await page.locator("#type").selectOption("user");
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    await browserExpect(page.locator("#type")).toHaveValue("system");
    await browserExpect(page.getByLabel("Project", { exact: true })).toBeVisible();
    await page.getByLabel("Project", { exact: true }).fill("demo");
    await page.getByLabel("Environment", { exact: true }).fill("dev");
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    await browserExpect(page.getByLabel("Project", { exact: true })).toHaveValue("");
    expect(writes.slice(start).map((write) => write.body)).toEqual([
      { type: "user", expiresInDays: 90 },
      { type: "system", expiresInDays: 90, permission: "read", scopes: [{ project: "demo", env: "dev" }] },
    ]);
  } finally {
    await context.close();
  }
}, 15_000);

const untrusted = '<img src=x onerror="alert(1)">';
for (const [result, search, title, description] of [
  ["success", "", "Signed in", "The CLI finishes signing in by itself. You can close this tab."],
  ["denied", "?error=access_denied", "Cancelled", "The CLI was not signed in."],
  ["error", `?error=${encodeURIComponent(untrusted)}`, "The CLI was not signed in", `${untrusted}. Ask it for a new link.`],
  ["description", `?error=server_error&error_description=${encodeURIComponent(untrusted)}`, "The CLI was not signed in", `${untrusted}. Ask it for a new link.`],
] as const) {
  test(`the public device ${result} page needs no sign-in and renders API text safely`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const apiRequests: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/v1/")) apiRequests.push(path);
      });
      await page.goto(`${server.url}ui#/device${search}`);
      await page.getByText(title, { exact: true }).waitFor();
      await page.getByText(description, { exact: true }).waitFor();
      expect(await page.locator("img").count()).toBe(0);
      expect(apiRequests).toEqual([]);
      expect(await page.evaluate("sessionStorage.getItem('vault.key')")).toBeNull();
    } finally {
      await context.close();
    }
  }, 15_000);
}
