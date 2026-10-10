import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { VaultStore } from "./db.ts";
import { authHeaders, bootstrapUser, createTestVault } from "./harness.ts";
import { Minter } from "./parents/minter.ts";

const ACCOUNT = "a".repeat(32);
const PARENT_TOKEN = "cf-parent-token-value";
const POLICIES = [
  {
    effect: "allow",
    permission_groups: [{ id: "b".repeat(32) }],
    resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
  },
];

type Call = { method: string; url: string; auth: string | null; body: unknown };

/** A fake Cloudflare token API: mints sequential tokens and records every call. */
function fakeCloudflare(options: { status?: number } = {}) {
  const calls: Call[] = [];
  const live = new Set<string>();
  let next = 0;
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body == null ? null : JSON.parse(String(init.body));
    calls.push({
      method: init?.method ?? "GET",
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (options.status != null)
      return Response.json({ success: false, errors: [{ code: 9109, message: "nope" }] }, { status: options.status });
    if (init?.method === "POST") {
      next += 1;
      const id = next.toString(16).padStart(32, "0");
      live.add(id);
      return Response.json({
        success: true,
        result: { id, name: body.name, expires_on: body.expires_on, value: `child-${next}` },
      });
    }
    if (init?.method === "DELETE") {
      const id = url.split("/").at(-1)!;
      if (!live.delete(id)) return Response.json({ success: false, errors: [] }, { status: 404 });
      return Response.json({ success: true, result: { id } });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { send, calls, live };
}

const mintedParser = z.looseObject({
  minted: z.array(z.looseObject({ label: z.string(), status: z.string(), keyPrefix: z.string() })),
});
const secretsParser = z.looseObject({
  secrets: z.array(z.looseObject({ name: z.string(), kind: z.string(), value: z.optional(z.string()) })),
});

async function setup(options: { status?: number; now?: () => Date } = {}) {
  const cloudflare = fakeCloudflare(options);
  const vault = await createTestVault({ minter: new Minter(cloudflare.send, options.now) });
  const operator = await bootstrapUser(vault.app, vault.env);
  const call = (key: string, path: string, method = "GET", body?: unknown) =>
    vault.app.request(
      path,
      {
        method,
        headers: authHeaders(key, body === undefined ? undefined : "application/json"),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      vault.env,
    );
  await call(operator, "/v1/projects", "POST", { name: "web" });
  const parent = await call(operator, "/v1/parents/cloudflare", "PUT", {
    provider: "cloudflare",
    config: { accountId: ACCOUNT },
    value: PARENT_TOKEN,
  });
  expect(parent.status).toBe(200);
  const spec = await call(operator, "/v1/projects/web/environments/dev/secrets", "PATCH", {
    set: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        kind: "minted",
        value: JSON.stringify({ parent: "cloudflare", ttlMinutes: 30, policies: POLICIES }),
      },
      { name: "PLAIN", kind: "secret", value: "plain-value" },
    ],
  });
  expect(spec.status).toBe(200);
  const created = await call(operator, "/v1/keys", "POST", {
    type: "system",
    permission: "read",
    scopes: [{ project: "web", env: "dev" }],
  });
  const agent = z.object({ key: z.string(), prefix: z.string() }).parse(await created.json());
  return { ...vault, cloudflare, operator, agent, call };
}

describe("overview", () => {
  test("names minted secrets' parents and never returns a value", async () => {
    const { call, operator, agent } = await setup();
    await call(operator, "/v1/projects/web/environments", "POST", { name: "prod" });
    const listed = await call(operator, "/v1/projects/web/environments/dev/secrets");
    expect(z.unknown().parse(await listed.json())).toEqual({
      secrets: [
        { name: "CLOUDFLARE_API_TOKEN", kind: "minted", parent: "cloudflare" },
        { name: "PLAIN", kind: "secret" },
      ],
    });

    const asOperator = await call(operator, "/v1/overview");
    expect(asOperator.status).toBe(200);
    const text = await asOperator.text();
    expect(text).not.toContain("plain-value");
    expect(text).not.toContain(PARENT_TOKEN);
    const overview = z
      .looseObject({
        platform: z.boolean(),
        projects: z.array(z.looseObject({ name: z.string(), environments: z.array(z.looseObject({ name: z.string() })) })),
        parents: z.array(z.looseObject({ name: z.string() })),
      })
      .parse(JSON.parse(text));
    expect(overview.platform).toBe(true);
    expect(overview.projects[0]?.environments.map((e) => e.name)).toEqual(["dev", "prod"]);
    expect(overview.parents.map((p) => p.name)).toEqual(["cloudflare"]);

    const asAgent = z
      .looseObject({
        projects: z.array(z.looseObject({ environments: z.array(z.looseObject({ name: z.string() })) })),
        parents: z.null(),
      })
      .parse(await (await call(agent.key, "/v1/overview")).json());
    expect(asAgent.projects[0]?.environments.map((e) => e.name)).toEqual(["dev"]);
  });
});

describe("parent keys", () => {
  test("export mints a child from the parent; the parent value never comes back", async () => {
    const { call, cloudflare, operator, agent, backend } = await setup();
    const exported = await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1");
    expect(exported.status).toBe(200);
    const body = secretsParser.parse(await exported.json());
    expect(body.secrets.find((s) => s.name === "CLOUDFLARE_API_TOKEN")?.value).toBe("child-1");
    expect(body.secrets.find((s) => s.name === "PLAIN")?.value).toBe("plain-value");

    const [mint] = cloudflare.calls;
    expect(mint?.method).toBe("POST");
    expect(mint?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens`);
    expect(mint?.auth).toBe(`Bearer ${PARENT_TOKEN}`);
    expect(z.looseObject({ policies: z.unknown(), name: z.string() }).parse(mint?.body)).toMatchObject({
      policies: POLICIES,
      name: expect.stringContaining("web/dev/CLOUDFLARE_API_TOKEN"),
    });

    const ledger = mintedParser.parse(await (await call(operator, "/v1/parents/cloudflare/minted")).json());
    expect(ledger.minted).toEqual([
      expect.objectContaining({
        label: "web/dev/CLOUDFLARE_API_TOKEN",
        status: "active",
        keyPrefix: agent.prefix,
      }),
    ]);

    const parents = await (await call(operator, "/v1/parents")).text();
    expect(parents).not.toContain(PARENT_TOKEN);
    expect(parents).toContain(ACCOUNT);
    const audit = await (await call(operator, "/v1/audit")).text();
    expect(audit).toContain('"action":"mint"');

    // Shown values are the spec, not a key; nothing is minted to show them.
    const shown = secretsParser.parse(
      await (await call(operator, "/v1/projects/web/environments/dev/secrets?show=1")).json(),
    );
    expect(shown.secrets.find((s) => s.name === "CLOUDFLARE_API_TOKEN")?.value).toContain('"parent":"cloudflare"');
    expect(cloudflare.calls).toHaveLength(1);

    const rows = await backend.listParents({ orgId: "default" });
    expect(JSON.stringify(rows)).not.toContain(PARENT_TOKEN);
  });

  test("names narrows an export to the secrets asked for", async () => {
    const { call, cloudflare, agent } = await setup();
    const exported = await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1&names=PLAIN");
    const body = secretsParser.parse(await exported.json());
    expect(body.secrets.map((s) => s.name)).toEqual(["PLAIN"]);
    expect(cloudflare.calls).toHaveLength(0);
  });

  test("only operators manage parents and write minted specs", async () => {
    const { call, operator } = await setup();
    const created = await call(operator, "/v1/keys", "POST", {
      type: "system",
      permission: "readwrite",
      scopes: [{ project: "web", env: "dev" }],
    });
    const writer = z.object({ key: z.string() }).parse(await created.json()).key;
    expect((await call(writer, "/v1/parents")).status).toBe(403);
    const put = await call(writer, "/v1/parents/other", "PUT", {
      provider: "cloudflare",
      config: { accountId: ACCOUNT },
      value: "x",
    });
    expect(put.status).toBe(403);
    const spec = await call(writer, "/v1/projects/web/environments/dev/secrets", "PATCH", {
      set: [{ name: "WIDE", kind: "minted", value: JSON.stringify({ parent: "cloudflare", policies: POLICIES }) }],
    });
    expect(spec.status).toBe(403);
  });

  test("specs must name an existing parent and fit its provider", async () => {
    const { call, operator } = await setup();
    const missing = await call(operator, "/v1/projects/web/environments/dev/secrets", "PATCH", {
      set: [{ name: "X", kind: "minted", value: JSON.stringify({ parent: "nope", policies: POLICIES }) }],
    });
    expect(missing.status).toBe(400);
    const bad = await call(operator, "/v1/projects/web/environments/dev/secrets", "PATCH", {
      set: [{ name: "X", kind: "minted", value: JSON.stringify({ parent: "cloudflare", policies: [] }) }],
    });
    expect(bad.status).toBe(400);
    const badConfig = await call(operator, "/v1/parents/second", "PUT", {
      provider: "cloudflare",
      config: { accountId: "short" },
      value: "x",
    });
    expect(badConfig.status).toBe(400);
  });

  test("a refused mint fails the export and the ledger says so", async () => {
    const { call, operator, agent } = await setup({ status: 403 });
    const exported = await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1");
    expect(exported.status).toBe(502);
    expect(await exported.text()).not.toContain(PARENT_TOKEN);
    const ledger = mintedParser.parse(await (await call(operator, "/v1/parents/cloudflare/minted")).json());
    expect(ledger.minted[0]?.status).toBe("failed");
  });

  test("a lost reply leaves the child unknown, which blocks deleting the parent", async () => {
    const { call, operator, agent } = await setup({ status: 503 });
    expect((await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1")).status).toBe(502);
    const ledger = mintedParser.parse(await (await call(operator, "/v1/parents/cloudflare/minted")).json());
    expect(ledger.minted[0]?.status).toBe("unknown");
    expect((await call(operator, "/v1/parents/cloudflare", "DELETE")).status).toBe(409);
  });

  test("revoking a parent revokes its live children, then the parent can go", async () => {
    const { call, cloudflare, operator, agent } = await setup();
    await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1");
    await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1");
    expect(cloudflare.live.size).toBe(2);
    expect((await call(operator, "/v1/parents/cloudflare", "DELETE")).status).toBe(409);
    const revoked = await call(operator, "/v1/parents/cloudflare/revoke", "POST", {});
    expect(z.unknown().parse(await revoked.json())).toEqual({ revoked: 2, failed: 0, untraceable: 0 });
    expect(cloudflare.live.size).toBe(0);
    expect(cloudflare.calls.filter((c) => c.method === "DELETE").every((c) => c.auth === `Bearer ${PARENT_TOKEN}`)).toBe(true);
    expect((await call(operator, "/v1/parents/cloudflare", "DELETE")).status).toBe(200);
    expect((await call(operator, "/v1/parents")).status).toBe(200);
  });

  test("the reaper closes children past expiry", async () => {
    let now = new Date("2026-10-10T00:00:00.000Z");
    const { call, cloudflare, operator, agent, backend, keyring } = await setup({ now: () => now });
    await call(agent.key, "/v1/projects/web/environments/dev/secrets?export=1");
    const reaper = new Minter(cloudflare.send, () => now);
    const storeFor = async (orgId: string) =>
      new VaultStore(backend, await keyring.cryptoFor(orgId), orgId);
    expect(await reaper.reap(backend, storeFor)).toEqual({ closed: 0, failed: 0, untraceable: 0 });
    now = new Date("2026-10-10T00:31:00.000Z");
    expect(await reaper.reap(backend, storeFor)).toEqual({ closed: 1, failed: 0, untraceable: 0 });
    expect(cloudflare.live.size).toBe(0);
    const ledger = mintedParser.parse(await (await call(operator, "/v1/parents/cloudflare/minted")).json());
    expect(ledger.minted[0]?.status).toBe("expired");
  });
});
