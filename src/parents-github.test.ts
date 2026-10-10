import { describe, expect, test } from "bun:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { z } from "zod";

import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";
import { Minter } from "./parents/minter.ts";

const APP_ID = "123456";
const INSTALLATION = "987654";
const { privateKey: APP_KEY, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PERMISSIONS = { contents: "read", pull_requests: "write" };

/** A fake GitHub App API: checks the App JWT, mints sequential tokens and records every call. */
function fakeGitHub(options: { grant?: Record<string, string> } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const live = new Set<string>();
  let next = 0;
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body == null ? null : JSON.parse(String(init.body));
    const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
    calls.push({ method: init?.method ?? "GET", url, body });
    if (init?.method === "POST") {
      const [header, payload, signature] = auth.split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      if (!verifier.verify(createPublicKey(publicKey), Buffer.from(signature ?? "", "base64url")))
        return Response.json({ message: "bad JWT" }, { status: 401 });
      const claims = z
        .object({ iss: z.string(), iat: z.number(), exp: z.number() })
        .parse(JSON.parse(Buffer.from(payload ?? "", "base64url").toString()));
      if (claims.iss !== APP_ID || claims.exp - claims.iat > 600)
        return Response.json({ message: "bad claims" }, { status: 401 });
      next += 1;
      const token = `ghs_child${next}`;
      live.add(token);
      return Response.json(
        { token, expires_at: "2099-01-01T00:00:00Z", permissions: options.grant ?? body.permissions },
        { status: 201 },
      );
    }
    if (init?.method === "DELETE") {
      if (!live.delete(auth)) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { send, calls, live };
}

const secretsParser = z.looseObject({
  secrets: z.array(z.looseObject({ name: z.string(), value: z.optional(z.string()) })),
});
const mintedParser = z.looseObject({ minted: z.array(z.looseObject({ status: z.string() })) });

async function setup(options: { grant?: Record<string, string> } = {}) {
  const github = fakeGitHub(options);
  const vault = await createTestVault({ minter: new Minter(github.send) });
  const operator = await bootstrapUser(vault.app, vault.env);
  const call = (path: string, method = "GET", body?: unknown) =>
    vault.app.request(
      path,
      {
        method,
        headers: authHeaders(operator, body === undefined ? undefined : "application/json"),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      vault.env,
    );
  await call("/v1/projects", "POST", { name: "web" });
  const parent = await call("/v1/parents/github", "PUT", {
    provider: "github",
    config: { appId: APP_ID, installationId: INSTALLATION },
    value: APP_KEY,
  });
  expect(parent.status).toBe(200);
  const spec = (value: Record<string, unknown>) =>
    call("/v1/projects/web/environments/dev/secrets", "PATCH", {
      set: [{ name: "GITHUB_TOKEN", kind: "minted", value: JSON.stringify({ parent: "github", ...value }) }],
    });
  return { github, call, spec };
}

describe("github parent keys", () => {
  test("export mints an installation token signed by the App key", async () => {
    const { github, call, spec } = await setup();
    expect((await spec({ ttlMinutes: 30, permissions: PERMISSIONS, repositories: ["api"] })).status).toBe(200);
    const exported = await call("/v1/projects/web/environments/dev/secrets?export=1");
    expect(exported.status).toBe(200);
    const body = secretsParser.parse(await exported.json());
    expect(body.secrets.find((s) => s.name === "GITHUB_TOKEN")?.value).toBe("ghs_child1");
    expect(github.calls[0]).toEqual({
      method: "POST",
      url: `https://api.github.com/app/installations/${INSTALLATION}/access_tokens`,
      body: { permissions: PERMISSIONS, repositories: ["api"] },
    });
    // The ledger shows the child without its token.
    const ledger = await (await call("/v1/parents/github/minted")).text();
    expect(mintedParser.parse(JSON.parse(ledger)).minted[0]?.status).toBe("active");
    expect(ledger).not.toContain("ghs_child1");
    expect(await (await call("/v1/parents")).text()).not.toContain("PRIVATE KEY");
  });

  test("revoking the parent revokes its tokens with the tokens themselves", async () => {
    const { github, call, spec } = await setup();
    await spec({ permissions: PERMISSIONS });
    await call("/v1/projects/web/environments/dev/secrets?export=1");
    await call("/v1/projects/web/environments/dev/secrets?export=1");
    expect(github.live.size).toBe(2);
    const revoked = await call("/v1/parents/github/revoke", "POST", {});
    expect(z.unknown().parse(await revoked.json())).toEqual({ revoked: 2, failed: 0, untraceable: 0 });
    expect(github.live.size).toBe(0);
    expect((await call("/v1/parents/github", "DELETE")).status).toBe(200);
  });

  test("a token with other permissions is revoked and the export fails", async () => {
    const { github, call, spec } = await setup({ grant: { contents: "write" } });
    await spec({ permissions: PERMISSIONS });
    expect((await call("/v1/projects/web/environments/dev/secrets?export=1")).status).toBe(502);
    expect(github.live.size).toBe(0);
    const ledger = mintedParser.parse(await (await call("/v1/parents/github/minted")).json());
    expect(ledger.minted[0]?.status).toBe("failed");
  });

  test("specs, configs and keys are checked before they are stored", async () => {
    const { call, spec } = await setup();
    expect((await spec({ ttlMinutes: 61, permissions: PERMISSIONS })).status).toBe(400);
    expect((await spec({ permissions: {} })).status).toBe(400);
    expect((await spec({ permissions: { contents: "owner" } })).status).toBe(400);
    const put = (config: Record<string, string>, value: string) =>
      call("/v1/parents/second", "PUT", { provider: "github", config, value });
    expect((await put({ appId: "x", installationId: INSTALLATION }, APP_KEY)).status).toBe(400);
    expect((await put({ appId: APP_ID, installationId: INSTALLATION }, "ghp_not_a_key")).status).toBe(400);
    const pkcs8 = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    expect((await put({ appId: APP_ID, installationId: INSTALLATION }, pkcs8)).status).toBe(200);
  });
});
