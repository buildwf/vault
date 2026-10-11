import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";

import { deviceLogin } from "./cli.ts";
import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";

type Vault = Awaited<ReturnType<typeof createTestVault>>;
const ORIGIN = "http://vault.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const json = z.record(z.string(), z.json());

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => Response.json({ saw: request.headers.get("authorization") }),
});
afterAll(() => upstream.stop(true));

async function pkce() {
  const verifier = crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: new Uint8Array(digest).toBase64({ alphabet: "base64url", omitPadding: true }) };
}

async function setup() {
  const vault = await createTestVault();
  const { app, env } = vault;
  const operator = await bootstrapUser(app, env);
  const call = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init, env);
  await call("/v1/projects", {
    method: "POST",
    headers: authHeaders(operator, "application/json"),
    body: JSON.stringify({ name: "demo" }),
  });
  await call("/v1/projects/demo/environments/dev/secrets", {
    method: "PATCH",
    headers: authHeaders(operator, "application/json"),
    body: JSON.stringify({ set: [{ name: "API_KEY", value: "sk_synthetic_123", kind: "secret" }] }),
  });
  return { ...vault, operator, call };
}

/** Registers a client, approves it as the operator, and trades the code. */
async function connect(v: Awaited<ReturnType<typeof setup>>, scopes = [{ project: "demo", env: "dev" }]) {
  const registered = await v.call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = z.parse(z.object({ client_id: z.string() }), await registered.json());
  const { verifier, challenge } = await pkce();

  const authorize = await v.call(
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${ORIGIN}/mcp`,
    })}`,
  );
  expect(authorize.status).toBe(302);
  expect(authorize.headers.get("Location")).toStartWith("/ui#/connect/");

  const approved = await v.call("/v1/oauth/approve", {
    method: "POST",
    headers: authHeaders(v.operator, "application/json"),
    body: JSON.stringify({ client_id, redirect_uri: REDIRECT, code_challenge: challenge, state: "xyz", scopes }),
  });
  expect(approved.status).toBe(200);
  const redirect = new URL(z.parse(z.object({ redirect: z.string() }), await approved.json()).redirect);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("xyz");
  expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
  const code = redirect.searchParams.get("code")!;

  const tokens = await tokenRequest(v, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id,
    code_verifier: verifier,
  });
  expect(tokens.status).toBe(200);
  const body = z.parse(
    z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() }),
    await tokens.json(),
  );
  return { client_id, code, verifier, ...body };
}

function tokenRequest(v: Vault & { call: (p: string, i?: RequestInit) => Response | Promise<Response> }, form: Record<string, string>) {
  return v.call("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

/** One 2026-07-28 MCP request; returns the JSON-RPC result. */
async function rpc(
  v: Awaited<ReturnType<typeof setup>>,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
) {
  const response = await v.call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(typeof params.name === "string" && { "Mcp-Name": params.name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    }),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`MCP ${response.status}: ${text}`);
  const payload = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
  return z.parse(z.object({ result: json }), JSON.parse(payload)).result;
}

const toolText = (result: Record<string, unknown>) =>
  z.parse(z.object({ content: z.array(z.object({ text: z.string() })) }), result).content[0]!.text;

describe("hosted MCP with OAuth", () => {
  test("discovery points clients at this Worker", async () => {
    const v = await setup();
    const unauthorized = await v.call("/mcp", { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resource = z.parse(json, await (await v.call("/.well-known/oauth-protected-resource/mcp")).json());
    expect(resource.authorization_servers).toEqual([ORIGIN]);
    const server = z.parse(json, await (await v.call("/.well-known/oauth-authorization-server")).json());
    expect(server.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("registration refuses non-https redirects and forged client ids", async () => {
    const v = await setup();
    const bad = await v.call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(bad.status).toBe(400);
    const { client_id } = await connect(v);
    const [payload] = client_id.split(".");
    const forged = await v.call(
      `/v1/oauth/client?client_id=${payload}.${"0".repeat(32)}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      { headers: authHeaders(v.operator) },
    );
    expect(forged.status).toBe(400);
    const otherRedirect = await v.call(
      `/v1/oauth/client?client_id=${client_id}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`,
      { headers: authHeaders(v.operator) },
    );
    expect(otherRedirect.status).toBe(400);
  });

  test("codes need the PKCE verifier and work once; tokens never open /v1", async () => {
    const v = await setup();
    const t = await connect(v);
    const reused = await tokenRequest(v, {
      grant_type: "authorization_code",
      code: t.code,
      redirect_uri: REDIRECT,
      client_id: t.client_id,
      code_verifier: t.verifier,
    });
    expect(reused.status).toBe(400);
    const v1 = await v.call("/v1/projects/demo/environments/dev/secrets?export=1", {
      headers: authHeaders(t.access_token),
    });
    expect(v1.status).toBe(401);
  });

  test("tools list names, broker calls after approval, and never return values", async () => {
    const v = await setup();
    const t = await connect(v);
    const tools = z.parse(z.object({ tools: z.array(z.object({ name: z.string() })) }), await rpc(v, t.access_token, "tools/list"));
    expect(tools.tools.map((tool) => tool.name)).toEqual(["describe_context", "use_secret", "collect_secret"]);

    const context = toolText(await rpc(v, t.access_token, "tools/call", { name: "describe_context", arguments: {} }));
    expect(context).toContain("API_KEY");
    expect(context).not.toContain("sk_synthetic_123");

    const use = {
      name: "use_secret",
      arguments: {
        method: "GET",
        url: `http://127.0.0.1:${upstream.port}/`,
        headers: { Authorization: "Bearer {{API_KEY}}" },
      },
    };
    // No in-chat prompts: the client gets a link only an operator can use.
    const asked = z.parse(
      z.object({ approvalRequired: z.literal(true), url: z.string() }),
      JSON.parse(toolText(await rpc(v, t.access_token, "tools/call", use))),
    );
    const id = decodeURIComponent(asked.url.split("#/approve/")[1]!);
    expect((await v.call(`/v1/oauth/approvals/${encodeURIComponent(id)}`, { headers: authHeaders(t.access_token) })).status).toBe(401);
    const shown = z.parse(json, await (await v.call(`/v1/oauth/approvals/${encodeURIComponent(id)}`, { headers: authHeaders(v.operator) })).json());
    expect(shown.names).toEqual(["API_KEY"]);
    expect(shown.host).toBe(`127.0.0.1:${upstream.port}`);
    const allowed = await v.call(`/v1/oauth/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: authHeaders(v.operator, "application/json"),
      body: JSON.stringify({ minutes: 15 }),
    });
    expect(allowed.status).toBe(200);

    const used = toolText(await rpc(v, t.access_token, "tools/call", use));
    expect(used).toContain("Bearer {{API_KEY}}");
    expect(used).not.toContain("sk_synthetic_123");

    // A client that can ask in the chat gets the question instead of a link.
    const other = { ...use, arguments: { ...use.arguments, url: `http://localhost:${upstream.port}/` } };
    const prompt = await rpc(v, t.access_token, "tools/call", other, { elicitation: { form: {} } });
    expect(JSON.stringify(prompt)).toContain("input_required");
    const allow = { vault: { action: "accept", content: { decision: "allow" } } };
    const answered = await rpc(
      v,
      t.access_token,
      "tools/call",
      { ...other, inputResponses: allow, requestState: prompt.requestState },
      { elicitation: { form: {} } },
    );
    expect(toolText(answered)).toContain("Bearer {{API_KEY}}");
  });

  test("collect_secret links to the web UI, never the chat", async () => {
    const v = await setup();
    const t = await connect(v);
    const asked = toolText(
      await rpc(v, t.access_token, "tools/call", { name: "collect_secret", arguments: { name: "NEW_KEY" } }),
    );
    expect(asked).toContain(`${ORIGIN}/ui#/collect/demo/dev/NEW_KEY`);
    await v.call("/v1/projects/demo/environments/dev/secrets/NEW_KEY", {
      method: "POST",
      headers: authHeaders(v.operator, "application/json"),
      body: JSON.stringify({ value: "typed-in-ui", kind: "secret" }),
    });
    const stored = toolText(
      await rpc(v, t.access_token, "tools/call", { name: "collect_secret", arguments: { name: "NEW_KEY" } }),
    );
    expect(stored).toContain('"state":"stored"');
  });

  test("a connection only reaches the environments it was given", async () => {
    const v = await setup();
    const t = await connect(v);
    const outside = toolText(
      await rpc(v, t.access_token, "tools/call", {
        name: "use_secret",
        arguments: { project: "demo", env: "prod", method: "GET", url: "https://api.example.com/", headers: { A: "{{API_KEY}}" } },
      }),
    );
    expect(outside).toContain("not scoped");
  });

  test("refresh rotates tokens; revoking the connector's key ends it", async () => {
    const v = await setup();
    const t = await connect(v);
    const refreshed = await tokenRequest(v, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    expect(refreshed.status).toBe(200);
    const next = z.parse(z.object({ access_token: z.string(), refresh_token: z.string() }), await refreshed.json());
    const replay = await tokenRequest(v, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    expect(replay.status).toBe(400);
    expect((await v.call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(401);

    const keys = z.parse(
      z.object({ keys: z.array(z.object({ keyPrefix: z.string(), label: z.string().nullable() })) }),
      await (await v.call("/v1/keys", { headers: authHeaders(v.operator) })).json(),
    );
    const connector = keys.keys.find((key) => key.label === "Claude (MCP connector)")!;
    await v.call(`/v1/keys/${connector.keyPrefix}`, { method: "DELETE", headers: authHeaders(v.operator) });
    expect((await v.call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${next.access_token}` } })).status).toBe(401);
    const afterRevoke = await tokenRequest(v, { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: t.client_id });
    expect(afterRevoke.status).toBe(400);
  });
});

test("2025-era clients are served statelessly", async () => {
  const v = await setup();
  const t = await connect(v);
  const post = (body: unknown) =>
    v.call("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
  });
  expect(init.status).toBe(200);
  const called = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "describe_context", arguments: {} },
  });
  const text = await called.text();
  expect(called.status).toBe(200);
  expect(text).toContain("API_KEY");
});

describe("vault login --device", () => {
  const HTTPS = "https://vault.test";

  /** Runs the CLI's device login against the app; `onWait` acts as the operator. */
  async function login(v: Awaited<ReturnType<typeof setup>>, onWait: (link: URL) => Promise<void>) {
    let printed = "";
    const fetch = ((input: string | URL | Request, init?: RequestInit) =>
      v.app.request(String(input), init, v.env)) as typeof globalThis.fetch;
    return deviceLogin(
      HTTPS,
      "Claude cloud",
      { log: (text: string) => (printed = text.split("\n")[1]!), error: () => {} },
      { fetch, sleep: async () => onWait(await expand(v, printed)), intervalMs: 0 },
    );
  }

  /** Follows the CLI's short link to the authorize URL it stands for. */
  async function expand(v: Awaited<ReturnType<typeof setup>>, short: string) {
    expect(short.length).toBeLessThan(150);
    const response = await v.app.request(short, {}, v.env);
    expect(response.status).toBe(302);
    const link = new URL(response.headers.get("Location")!, HTTPS);
    const authorize = await v.app.request(link.toString(), {}, v.env);
    expect(authorize.headers.get("Location")).toStartWith("/ui#/connect/");
    return link;
  }

  async function approve(v: Awaited<ReturnType<typeof setup>>, link: URL, scopes = [{ project: "demo", env: "dev" }]) {
    const q = link.searchParams;
    const approved = await v.app.request(
      `${HTTPS}/v1/oauth/approve`,
      {
        method: "POST",
        headers: authHeaders(v.operator, "application/json"),
        body: JSON.stringify({
          client_id: q.get("client_id"),
          redirect_uri: q.get("redirect_uri"),
          code_challenge: q.get("code_challenge"),
          scopes,
        }),
      },
      v.env,
    );
    expect(approved.status).toBe(200);
    // The browser lands on the vault's own page; the code is not in the URL.
    expect(z.parse(z.object({ redirect: z.string() }), await approved.json()).redirect).toBe(`${HTTPS}/oauth/device`);
  }

  test("an approved login gets a one-day read-only key that reads values", async () => {
    const v = await setup();
    let waits = 0;
    const key = await login(v, async (link) => {
      waits += 1;
      if (waits === 2) await approve(v, link);
    });
    expect(waits).toBe(2);
    const read = await v.app.request(
      `${HTTPS}/v1/projects/demo/environments/dev/secrets/API_KEY`,
      { headers: authHeaders(key) },
      v.env,
    );
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("sk_synthetic_123");
    const keys = await v.app.request(`${HTTPS}/v1/keys`, { headers: authHeaders(v.operator) }, v.env);
    const listed = z
      .parse(z.object({ keys: z.array(z.object({ label: z.string().nullable(), permission: z.string().nullable(), expiresAt: z.string() })) }), await keys.json())
      .keys.find((k) => k.label === "Claude cloud (CLI login)")!;
    expect(listed.permission).toBe("read");
    expect(Date.parse(listed.expiresAt) - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    const write = await v.app.request(
      `${HTTPS}/v1/projects/demo/environments/dev/secrets`,
      {
        method: "PATCH",
        headers: authHeaders(key, "application/json"),
        body: JSON.stringify({ set: [{ name: "OTHER", value: "x", kind: "secret" }] }),
      },
      v.env,
    );
    expect(write.status).toBe(403);
  });

  test("polling needs the verifier: the challenge in the link is not enough", async () => {
    const v = await setup();
    let link: URL | undefined;
    await expect(
      login(v, async (l) => {
        link = l;
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    await approve(v, link!);
    const stolen = await v.app.request(
      `${HTTPS}/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: link!.searchParams.get("code_challenge")!,
          client_id: link!.searchParams.get("client_id")!,
        }).toString(),
      },
      v.env,
    );
    expect(z.parse(z.object({ error: z.string() }), await stolen.json()).error).toBe("authorization_pending");
  });

  test("only operators can approve, and nothing is issued before they do", async () => {
    const v = await setup();
    const reader = await v.app.request(
      `${HTTPS}/v1/keys`,
      {
        method: "POST",
        headers: authHeaders(v.operator, "application/json"),
        body: JSON.stringify({ type: "system", scopes: [{ project: "demo", env: "dev" }], permission: "read" }),
      },
      v.env,
    );
    const { key: systemKey } = z.parse(z.object({ key: z.string() }), await reader.json());
    await expect(
      login(v, async (link) => {
        const q = link.searchParams;
        const tried = await v.app.request(
          `${HTTPS}/v1/oauth/approve`,
          {
            method: "POST",
            headers: authHeaders(systemKey, "application/json"),
            body: JSON.stringify({
              client_id: q.get("client_id"),
              redirect_uri: q.get("redirect_uri"),
              code_challenge: q.get("code_challenge"),
              scopes: [{ project: "demo", env: "dev" }],
            }),
          },
          v.env,
        );
        expect(tried.status).toBe(403);
        throw new Error("not approved");
      }),
    ).rejects.toThrow("not approved");
  });

  test("the landing page says what happened", async () => {
    const v = await setup();
    expect(await (await v.call("/oauth/device")).text()).toContain("Approved");
    expect(await (await v.call("/oauth/device?error=access_denied")).text()).toContain("Cancelled");
    const failed = await (await v.call("/oauth/device?error=invalid_request&error_description=<b>PKCE</b>")).text();
    expect(failed).toContain("&#60;b&#62;PKCE");
    expect(failed).toContain("new link");
  });
});
