import { describe, expect, test } from "bun:test";

import { createTestVault } from "./harness.ts";
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
