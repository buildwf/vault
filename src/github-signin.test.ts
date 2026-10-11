import { describe, expect, test } from "bun:test";

import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";
import type { GithubFetch } from "./github-signin.ts";

type Vault = Awaited<ReturnType<typeof createTestVault>>;

const GITHUB = { clientId: "client-1", clientSecret: "secret-1" };
const ZACK = { id: 7391612, login: "nvsd" };

/** GitHub, as far as the vault talks to it: one good code, and two accounts. */
const fakeGithub: GithubFetch = async (url, init) => {
  if (url === "https://github.com/login/oauth/access_token") {
    const body = JSON.parse(String(init?.body)) as { code: string; client_secret: string };
    if (body.client_secret !== GITHUB.clientSecret) return Response.json({ error: "incorrect_client_credentials" });
    if (body.code === "zack") return Response.json({ access_token: "token-zack" });
    if (body.code === "stranger") return Response.json({ access_token: "token-stranger" });
    return Response.json({ error: "bad_verification_code" });
  }
  const auth = new Headers(init?.headers).get("Authorization");
  if (url === "https://api.github.com/user") {
    if (auth === "Bearer token-zack") return Response.json(ZACK);
    if (auth === "Bearer token-stranger") return Response.json({ id: 1, login: "stranger" });
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }
  if (url === "https://api.github.com/users/nvsd") return Response.json(ZACK);
  return Response.json({ message: "Not Found" }, { status: 404 });
};

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

/** Start at /auth/github and come back from GitHub with `code`; returns the callback response. */
async function signInWithGithub(vault: Vault, code: string) {
  const start = await vault.app.request("https://vault.test/auth/github", {}, vault.env);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("Location")!);
  expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(authorize.searchParams.get("client_id")).toBe(GITHUB.clientId);
  expect(authorize.searchParams.get("redirect_uri")).toBe("https://vault.test/auth/github/callback");
  const state = authorize.searchParams.get("state")!;
  const cookie = start.headers.get("Set-Cookie")!.split(";")[0]!;
  return vault.app.request(
    `https://vault.test/auth/github/callback?code=${code}&state=${state}`,
    { headers: { Cookie: cookie } },
    vault.env,
  );
}

async function trade(vault: Vault, code: string) {
  return vault.app.request(
    "/v1/ui/session",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) },
    vault.env,
  );
}

describe("sign in with GitHub", () => {
  test("is off unless a GitHub app is configured", async () => {
    const off = await createTestVault();
    expect(((await (await off.app.request("/", {}, off.env)).json()) as { githubSignIn: boolean }).githubSignIn).toBe(false);
    expect((await off.app.request("/auth/github", {}, off.env)).status).toBe(404);

    const on = await createTestVault({ github: GITHUB, githubFetch: fakeGithub });
    expect(((await (await on.app.request("/", {}, on.env)).json()) as { githubSignIn: boolean }).githubSignIn).toBe(true);
  });

  test("an added GitHub account signs in as an operator of its org", async () => {
    const vault = await createTestVault({ github: GITHUB, githubFetch: fakeGithub });
    const operator = await bootstrapUser(vault.app, vault.env);
    expect((await call(vault, operator, "POST", "/v1/people", { login: "nvsd" })).status).toBe(201);
    expect((await call(vault, operator, "POST", "/v1/people", { login: "nvsd" })).status).toBe(200);

    const callback = await signInWithGithub(vault, "zack");
    expect(callback.status).toBe(302);
    const match = /^\/ui#signin=([0-9a-f]+)$/u.exec(callback.headers.get("Location")!);
    expect(match).not.toBeNull();

    const session = await trade(vault, match![1]!);
    expect(session.status).toBe(201);
    const { key } = (await session.json()) as { key: string };
    const keys = await call(vault, key, "GET", "/v1/keys");
    expect(keys.status).toBe(200);
    const labels = ((await keys.json()) as { keys: { label: string; type: string }[] }).keys;
    expect(labels).toContainEqual(expect.objectContaining({ label: "web ui (GitHub @nvsd)", type: "user" }));

    // The code works once.
    expect((await trade(vault, match![1]!)).status).toBe(401);
  });

  test("an account nobody added is refused, and so is a callback without its cookie", async () => {
    const vault = await createTestVault({ github: GITHUB, githubFetch: fakeGithub });
    await bootstrapUser(vault.app, vault.env);
    const stranger = await signInWithGithub(vault, "stranger");
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toContain("@stranger");

    const forged = await vault.app.request(
      "https://vault.test/auth/github/callback?code=zack&state=abc",
      {},
      vault.env,
    );
    expect(forged.status).toBe(400);
  });

  test("an account in two orgs chooses one, and removing it stops the sign-in", async () => {
    const vault = await createTestVault({ github: GITHUB, githubFetch: fakeGithub });
    const platform = await bootstrapUser(vault.app, vault.env);
    const created = await call(vault, platform, "POST", "/v1/orgs", { name: "manyave" });
    const manyave = ((await created.json()) as { key: string }).key;
    for (const key of [platform, manyave]) {
      expect((await call(vault, key, "POST", "/v1/people", { login: "nvsd" })).status).toBe(201);
    }

    const callback = await signInWithGithub(vault, "zack");
    const choose = /^\/ui#choose=(.+)$/u.exec(callback.headers.get("Location")!);
    expect(choose).not.toBeNull();
    const choices = Object.fromEntries(choose![1]!.split(",").map((pair) => pair.split(":")));
    expect(Object.keys(choices).sort()).toEqual(["manyave", "platform"]);

    const session = await trade(vault, choices.manyave!);
    const { key } = (await session.json()) as { key: string };
    const overview = (await (await call(vault, key, "GET", "/v1/overview")).json()) as { org: string };
    expect(overview.org).toBe("manyave");

    expect((await call(vault, manyave, "DELETE", "/v1/people/NVSD")).status).toBe(200);
    expect((await trade(vault, choices.platform!)).status).toBe(201);
    const again = await signInWithGithub(vault, "zack");
    expect(again.headers.get("Location")).toStartWith("/ui#signin=");
    const people = (await (await call(vault, manyave, "GET", "/v1/people")).json()) as { people: unknown[] };
    expect(people.people).toEqual([]);
  });

  test("only operators manage people, and unknown GitHub accounts are refused", async () => {
    const vault = await createTestVault({ github: GITHUB, githubFetch: fakeGithub });
    const operator = await bootstrapUser(vault.app, vault.env);
    expect((await call(vault, operator, "POST", "/v1/people", { login: "nobody-here" })).status).toBe(404);
    expect((await call(vault, operator, "POST", "/v1/people", { login: "bad login" })).status).toBe(400);
    const scoped = await call(vault, operator, "POST", "/v1/keys", {
      type: "system",
      permission: "read",
      scopes: [{ project: "p", env: "dev" }],
    });
    const { key } = (await scoped.json()) as { key: string };
    expect((await call(vault, key, "POST", "/v1/people", { login: "nvsd" })).status).toBe(403);
    expect((await call(vault, key, "GET", "/v1/people")).status).toBe(403);
  });
});
