import { expect, test } from "bun:test";

import { brokeredFetch, placeholderNames, requestHost } from "./broker.ts";

test("fills header placeholders, ignores a model Host header, and scrubs echoes", async () => {
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const auth = request.headers.get("authorization") ?? "";
      return Response.json(
        { auth, b64: btoa(auth), host: request.headers.get("host") },
        { headers: { "content-type": `application/json; x=${auth}` } },
      );
    },
  });
  try {
    const request = {
      method: "GET" as const,
      url: `http://127.0.0.1:${api.port}/v1`,
      headers: { Authorization: "{{API_KEY}}", Host: "attacker.example" },
    };
    expect(placeholderNames(request)).toEqual(["API_KEY"]);
    expect(requestHost(request)).toBe(`127.0.0.1:${api.port}`);
    const result = await brokeredFetch(request, { API_KEY: "sk_live_synthetic" });
    expect(result.status).toBe(200);
    expect(result.body).toContain('"auth":"{{API_KEY}}"');
    expect(result.body).toContain('"b64":"{{API_KEY}}"');
    expect(result.body).toContain(`"host":"127.0.0.1:${api.port}"`);
    expect(JSON.stringify(result)).not.toContain("sk_live_synthetic");
    expect(JSON.stringify(result)).not.toContain(btoa("sk_live_synthetic"));

    expect(() => requestHost({ method: "GET", url: "http://example.com/" })).toThrow("https://");
    for (const misplaced of [
      { method: "GET" as const, url: "https://api.example.com/?k={{API_KEY}}" },
      { method: "POST" as const, url: "https://api.example.com/", body: '{"k":"{{API_KEY}}"}' },
    ])
      expect(() => requestHost(misplaced)).toThrow("only in header values");
  } finally {
    await api.stop(true);
  }
});

test("errors never quote a filled-in secret, nested secrets scrub whole, big bodies stop", async () => {
  await expect(
    brokeredFetch(
      { method: "GET", url: "https://127.0.0.1:1/", headers: { Authorization: "{{API_KEY}}\u0000" } },
      { API_KEY: "sk_live_synthetic" },
    ),
  ).rejects.toThrow(/^use_secret request failed[^]*$/u);
  try {
    await brokeredFetch(
      { method: "GET", url: "https://127.0.0.1:1/", headers: { A: "Bearer {{API_KEY}}\r\nX: y" } },
      { API_KEY: "sk_live_synthetic" },
    );
  } catch (error) {
    expect(String(error)).not.toContain("sk_live_synthetic");
  }

  const echo = (text: string) => async () => new Response(text);
  const nested = await brokeredFetch(
    { method: "GET", url: "https://api.example.com/", headers: { A: "{{PASS}}", B: "{{URL}}" } },
    { PASS: "hunter2pass", URL: "postgres://admin:hunter2pass@db.internal/app" },
    Object.assign(echo("echo postgres://admin:hunter2pass@db.internal/app"), {
      preconnect: fetch.preconnect,
    }),
  );
  expect(nested.body).toBe("echo {{URL}}");

  const big = await brokeredFetch(
    { method: "GET", url: "https://api.example.com/", headers: { A: "{{KEY}}" } },
    { KEY: "sk_synthetic" },
    Object.assign(echo("x".repeat(200_000)), { preconnect: fetch.preconnect }),
  );
  expect(big.truncated).toBe(true);
  expect(big.body.length).toBe(65536);
});
