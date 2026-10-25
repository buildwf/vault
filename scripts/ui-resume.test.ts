import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { UI_CSP, UI_FILES } from "../src/ui/assets.ts";

let browser: Browser;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
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
      return Response.json({ key: { type: "user", keyPrefix: "test" }, projects: [] });
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
        await page.waitForFunction("localStorage.getItem('vault.next') !== null");

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
