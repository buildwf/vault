import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { taskTransport } from "./task-protocol.ts";
import { createTestVault, bootstrapUser, authHeaders } from "../harness.ts";
import { VaultClient } from "../client.ts";
import { AgentTasks } from "./tasks.ts";
import { AgentRuntime } from "./runtime.ts";
import { createAgentMcp } from "./mcp.ts";

async function fixture() {
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
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.fetch(request, env),
  });
  const client = new VaultClient(`http://127.0.0.1:${api.port}`, key);
  const tasks = new AgentTasks(":memory:");
  const runtime = new AgentRuntime(client, "demo", "dev", tasks);
  return {
    client,
    tasks,
    runtime,
    close: async () => {
      await runtime.close();
      tasks.close();
      await api.stop(true);
    },
  };
}
test("durable receipts survive reopen; immutable IDs and expired dispatch never replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "vault-agent-test-"));
  let now = 1000;
  const path = join(directory, "tasks.sqlite");
  const id = crypto.randomUUID();
  let tasks = new AgentTasks(path, () => now);
  tasks.create(id, "collection", "KEY");
  expect(tasks.claim(id)).toBe(true);
  expect(tasks.claim(id)).toBe(false);
  tasks.close();
  tasks = new AgentTasks(path, () => now);
  expect(tasks.get(id).state).toBe("saving");
  now += 60001;
  expect(tasks.get(id).state).toBe("unknown");
  expect(tasks.create(id, "collection", "KEY").created).toBe(false);
  expect(() => tasks.create(id, "collection", "OTHER")).toThrow();
  tasks.close();
  rmSync(directory, { recursive: true });
});
/** A stdio MCP connection to `runtime`; each call sends one request and reads one reply. */
function mcpClient(runtime: AgentRuntime) {
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = serveStdio(() => createAgentMcp(runtime), {
    transport: taskTransport(new StdioServerTransport(input, output), runtime),
  });
  async function rpc(
    method: string,
    args: z.infer<ReturnType<typeof z.json>>,
    capabilities: z.infer<ReturnType<typeof z.json>> = { elicitation: { url: {} } },
  ) {
    const params = z.record(z.string(), z.json()).parse(args);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("MCP response timed out"));
      }, 3000);
      output.once("data", (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      input.write(
        JSON.stringify({
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
        }) + "\n",
      );
    });
  }
  return { rpc, close: () => handle.close() };
}

test("MCP discovers tools, elicits a URL and negotiates durable Tasks without secret output", async () => {
  const f = await fixture();
  const { rpc, close } = mcpClient(f.runtime);
  try {
    const listed = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(JSON.parse(await rpc("tools/list", {})));
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "describe_context",
      "collect_secret",
      "use_secret",
      "share_access",
      "get_task",
      "cancel_task",
      "open_panel",
      "vault_panel",
    ]);
    const first = crypto.randomUUID();
    expect(
      await rpc("tools/call", {
        name: "collect_secret",
        arguments: { requestId: first, name: "KEY" },
      }),
    ).toContain("input_required");
    const task = f.tasks.get(first);
    const url = task.url!;
    await fetch(url + "/submit", {
      method: "POST",
      headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "synthetic-agent-secret" }),
    });
    await new Promise((done) => setTimeout(done, 5));
    const receipt = await rpc("tools/call", {
      name: "get_task",
      arguments: { requestId: first },
    });
    expect(receipt).toContain("stored");
    expect(receipt).not.toContain("synthetic-agent-secret");
    const second = crypto.randomUUID();
    const caps = {
      extensions: { "io.modelcontextprotocol/tasks": {} },
      elicitation: { url: {} },
    };
    const created = await rpc(
      "tools/call",
      { name: "collect_secret", arguments: { requestId: second, name: "SECOND" } },
      caps,
    );
    expect(created).toContain('"resultType":"task"');
    const pending = await rpc("tasks/get", { taskId: second }, caps);
    expect(pending).toContain("input_required");
    expect(pending).toContain("inputRequests");
    expect(
      await rpc(
        "tasks/update",
        { taskId: second, inputResponses: { vault: { action: "accept" } } },
        caps,
      ),
    ).toContain("input_required");
    expect(f.tasks.get(second).state).toBe("waiting");
    expect(await rpc("tasks/cancel", { taskId: second }, caps)).toContain("cancelled");
    const third = crypto.randomUUID();
    await rpc("tools/call", {
      name: "collect_secret",
      arguments: { requestId: third, name: "THIRD" },
    });
    const declined = await rpc("tools/call", {
      name: "collect_secret",
      arguments: { requestId: third, name: "THIRD" },
      inputResponses: { vault: { action: "cancel" } },
    });
    expect(declined).toContain("cancelled");
    expect(f.tasks.get(third).state).toBe("cancelled");
  } finally {
    await close();
    await f.close();
  }
});
test("pending collection resumes with the same request and a fresh browser URL after host restart", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  const first = await f.runtime.collect(id, "RESUME");
  await f.runtime.close();
  expect(f.tasks.get(id).state).toBe("waiting");
  expect(f.tasks.get(id).url).toBeNull();
  const resumed = new AgentRuntime(f.client, "demo", "dev", f.tasks);
  try {
    const second = await resumed.resume(first.taskId);
    expect(second.taskId).toBe(first.taskId);
    expect(second.url).not.toBe(first.url);
    const url = second.url!;
    await fetch(url + "/submit", {
      method: "POST",
      headers: { Origin: new URL(url).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "synthetic-resume" }),
    });
    await new Promise((done) => setTimeout(done, 5));
    expect(f.tasks.get(id).state).toBe("stored");
    expect((await resumed.collect(id, "RESUME")).state).toBe("stored");
  } finally {
    await resumed.close();
    await f.close();
  }
});

/** The `requestState` an input_required reply asks the client to echo back. */
const stateOf = (reply: string) =>
  z.object({ result: z.object({ requestState: z.string() }) }).parse(JSON.parse(reply)).result
    .requestState;

test("in-chat prompts store secrets; use_secret and share_access ask first; panel adds", async () => {
  const f = await fixture();
  const { rpc, close } = mcpClient(f.runtime);
  const caps = { elicitation: { form: {}, url: {} } };
  const allow = { vault: { action: "accept", content: { decision: "allow" } } };
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => Response.json({ saw: request.headers.get("authorization") }),
  });
  try {
    const collect = {
      name: "collect_secret",
      arguments: { requestId: crypto.randomUUID(), name: "API_KEY" },
    };
    expect(await rpc("tools/call", collect, caps)).toContain('"mode":"form"');
    const typed = { vault: { action: "accept", content: { value: "sk_synthetic_123" } } };
    const saved = await rpc("tools/call", { ...collect, inputResponses: typed }, caps);
    expect(saved).toContain("stored");
    expect(saved).not.toContain("sk_synthetic_123");

    const use = {
      name: "use_secret",
      arguments: {
        method: "GET",
        url: `http://127.0.0.1:${upstream.port}/`,
        headers: { Authorization: "Bearer {{API_KEY}}" },
      },
    };
    const asked = await rpc("tools/call", use, caps);
    expect(asked).toContain("send API_KEY to 127.0.0.1");
    const requestState = stateOf(asked);
    const deny = { vault: { action: "accept", content: { decision: "deny" } } };
    expect(await rpc("tools/call", { ...use, inputResponses: deny, requestState }, caps)).toContain(
      "denied",
    );
    // An allow that does not echo the question's state is asked again.
    expect(await rpc("tools/call", { ...use, inputResponses: allow }, caps)).toContain(
      "input_required",
    );
    const used = await rpc("tools/call", { ...use, inputResponses: allow, requestState }, caps);
    expect(used).toContain("Bearer {{API_KEY}}");
    expect(used).not.toContain("sk_synthetic_123");
    // The grant holds: no second prompt.
    expect(await rpc("tools/call", use, caps)).toContain("Bearer {{API_KEY}}");

    const share = { name: "share_access", arguments: { minutes: 5 } };
    const shareState = stateOf(await rpc("tools/call", share, caps));
    const shared = z
      .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
      .parse(
        JSON.parse(
          await rpc(
            "tools/call",
            { ...share, inputResponses: allow, requestState: shareState },
            caps,
          ),
        ),
      );
    const key = z
      .object({ env: z.object({ VAULT_API_KEY: z.string() }) })
      .parse(JSON.parse(shared.result.content[0]!.text)).env.VAULT_API_KEY;
    const meta = await new VaultClient(f.client.apiUrl, key).listSecretMeta("demo", "dev");
    expect(meta.secrets.map((secret) => secret.name)).toContain("API_KEY");

    const panel = await rpc(
      "tools/call",
      { name: "vault_panel", arguments: { add: { name: "PANEL_KEY", value: "from-panel" } } },
      caps,
    );
    expect(panel).toContain('\\"added\\":\\"stored\\"');
    expect(panel).not.toContain("from-panel");
    expect(await rpc("resources/read", { uri: "ui://vault/panel.html" }, caps)).toContain(
      "text/html;profile=mcp-app",
    );
  } finally {
    await upstream.stop(true);
    await close();
    await f.close();
  }
});

test("older clients (initialize handshake, like Claude Code 2.1.274) get real prompts", async () => {
  const f = await fixture();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => Response.json({ saw: request.headers.get("authorization") }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = serveStdio(() => createAgentMcp(f.runtime), {
    transport: taskTransport(new StdioServerTransport(input, output), f.runtime),
  });
  const replies = new Map<number, string>();
  const prompts: string[] = [];
  let buffer = "";
  const send = (message: Record<string, unknown>) =>
    input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  output.on("data", (data: Buffer) => {
    buffer += data.toString();
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const message = z
        .looseObject({
          id: z.number().optional(),
          method: z.string().optional(),
          params: z
            .looseObject({
              message: z.string(),
              requestedSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
            })
            .optional(),
        })
        .parse(JSON.parse(line));
      if (message.method === "elicitation/create" && message.params != null) {
        // Answer like a person would: allow approvals, type a value for secrets.
        const decision = message.params.requestedSchema.properties["decision"] != null;
        prompts.push(message.params.message);
        send({
          id: message.id,
          result: {
            action: "accept",
            content: decision ? { decision: "allow" } : { value: "typed-in-chat" },
          },
        });
      } else if (message.id != null) replies.set(message.id, line);
    }
  });
  const reply = async (id: number) => {
    for (let tries = 0; tries < 300 && !replies.has(id); tries++) await Bun.sleep(10);
    return replies.get(id) ?? "";
  };
  try {
    send({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { elicitation: {} },
        clientInfo: { name: "claude-code", version: "2.1.274" },
      },
    });
    await reply(0);
    send({ method: "notifications/initialized" });
    send({
      id: 1,
      method: "tools/call",
      params: {
        name: "collect_secret",
        arguments: { requestId: crypto.randomUUID(), name: "LEGACY_KEY" },
      },
    });
    expect(await reply(1)).toContain("stored");
    send({
      id: 2,
      method: "tools/call",
      params: {
        name: "use_secret",
        arguments: {
          method: "GET",
          url: `http://127.0.0.1:${upstream.port}/`,
          headers: { Authorization: "Bearer {{LEGACY_KEY}}" },
        },
      },
    });
    const used = await reply(2);
    expect(used).toContain("Bearer {{LEGACY_KEY}}");
    expect(used).not.toContain("typed-in-chat");
    expect(prompts.length).toBe(2);
  } finally {
    await upstream.stop(true);
    await handle.close();
    await f.close();
  }
});

test("use_secret approvals expire and can be revoked", async () => {
  const f = await fixture();
  try {
    const request = {
      method: "GET" as const,
      url: "https://api.example.com/v1",
      headers: { Authorization: "Bearer {{API_KEY}}" },
    };
    expect(f.runtime.ungranted(request).names).toEqual(["API_KEY"]);
    f.runtime.grant(["API_KEY"], "api.example.com");
    expect(f.runtime.ungranted(request).names).toEqual([]);
    f.runtime.revokeGrant("API_KEY", "api.example.com");
    expect(f.runtime.ungranted(request).names).toEqual(["API_KEY"]);
    f.runtime.grant(["API_KEY"], "api.example.com", 0);
    expect(f.runtime.ungranted(request).names).toEqual(["API_KEY"]);
  } finally {
    await f.close();
  }
});
