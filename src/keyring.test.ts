import { describe, expect, test } from "bun:test";

import { generateMasterKey } from "./crypto.ts";
import { VaultStore } from "./db.ts";
import { openTestBackend } from "./harness.ts";
import { VaultKeyring } from "./keyring.ts";

describe("master-key envelope rotation", () => {
  test("a prepared second root unwraps the same data and the old wrap can retire", async () => {
    const db = await openTestBackend();
    const primary = generateMasterKey();
    const secondary = generateMasterKey();
    const first = await VaultKeyring.open(db, primary);
    const store = new VaultStore(db, first.crypto);
    const project = await store.createProject("demo");
    const environment = await store.getEnvironment(project.id, "dev");
    expect(environment).not.toBeNull();
    await store.setSecret(environment!.id, "TOKEN", "value", "secret");

    const secondaryFingerprint = await first.prepare(secondary);
    const second = await VaultKeyring.open(db, secondary);
    expect(second.activeFingerprint).toBe(secondaryFingerprint);
    expect(
      (await new VaultStore(db, second.crypto).listSecrets(environment!.id))[0],
    ).toEqual({
      name: "TOKEN",
      value: "value",
      kind: "secret",
    });

    expect(second.retire(secondaryFingerprint)).rejects.toThrow(
      "cannot retire the active master-key wrap",
    );
    await second.retire(first.activeFingerprint);
    expect(VaultKeyring.open(db, primary)).rejects.toThrow("has no prepared vault wrap");
  });
});
