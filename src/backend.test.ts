import { describe, expect, test } from "bun:test";

import { DEFAULT_ORG, type AuditRow, type KeyRow, type VaultBackend } from "./backend.ts";
import { openTestBackend } from "./harness.ts";

const FUTURE = "2999-01-01T00:00:00.000Z";
const NOW = "2026-10-09T00:00:00.000Z";

function userKey(prefix: string, overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    id: crypto.randomUUID(),
    orgId: DEFAULT_ORG,
    keyPrefix: prefix,
    keyHash: `hash-${prefix}`,
    type: "user",
    labelEncrypted: null,
    scopesEncrypted: null,
    permission: "full",
    mode: null,
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: FUTURE,
    revoked: false,
    revokedAt: null,
    ...overrides,
  };
}

function auditEvent(id: string, createdAt: string): AuditRow {
  return {
    id,
    orgId: DEFAULT_ORG,
    keyPrefix: "vault_usr_x",
    action: "list",
    hostEncrypted: null,
    secretNameEncrypted: null,
    status: "ok",
    createdAt,
  };
}

async function projectWithSecret(backend: VaultBackend) {
  await backend.createProject({
    project: { id: "p1", orgId: DEFAULT_ORG, name: "demo", createdAt: NOW },
    environments: [
      { id: "e1", name: "dev" },
      { id: "e2", name: "prod" },
    ],
  });
  await backend.upsertSecret({
    secret: {
      id: "s1",
      environmentId: "e1",
      keyEncrypted: "name-ciphertext",
      keyHash: "name-hash",
      valueEncrypted: "value-ciphertext",
      kind: "secret",
      updatedAt: NOW,
    },
  });
}

describe("D1 backend contract", () => {
  test("the last unexpired user key cannot be revoked, alone or by rotation", async () => {
    const backend = await openTestBackend();
    await backend.insertKey({ key: userKey("vault_usr_a") });
    await backend.insertKey({
      key: userKey("vault_usr_old", { expiresAt: "2020-01-01T00:00:00.000Z" }),
    });
    expect(await backend.revokeKey({ orgId: DEFAULT_ORG, keyPrefix: "vault_usr_a", revokedAt: NOW })).toBe(
      "last_user_key",
    );
    // An expired key is not what keeps the vault reachable, so it may go.
    expect(await backend.revokeKey({ orgId: DEFAULT_ORG, keyPrefix: "vault_usr_old", revokedAt: NOW })).toBe(
      "revoked",
    );
    expect(await backend.revokeKey({ orgId: DEFAULT_ORG, keyPrefix: "vault_usr_old", revokedAt: NOW })).toBe(
      "not_found",
    );

    // Rotation counts the replacement, so the only user key can rotate.
    expect(
      await backend.rotateKey({
        key: userKey("vault_usr_b"),
        revokePrefix: "vault_usr_a",
        revokedAt: NOW,
      }),
    ).toBe("rotated");
    expect((await backend.findKeyByPrefix({ orgId: DEFAULT_ORG, keyPrefix: "vault_usr_a" }))?.revoked).toBe(true);
    // ...but not into a replacement that is already expired.
    expect(
      await backend.rotateKey({
        key: userKey("vault_usr_c", { expiresAt: "2020-01-01T00:00:00.000Z" }),
        revokePrefix: "vault_usr_b",
        revokedAt: NOW,
      }),
    ).toBe("last_user_key");
    expect(await backend.findKeyByPrefix({ orgId: DEFAULT_ORG, keyPrefix: "vault_usr_c" })).toBeNull();
    expect((await backend.listKeys({ orgId: DEFAULT_ORG, includeRevoked: false })).map((k) => k.keyPrefix)).toEqual([
      "vault_usr_b",
    ]);
  });

  test("names are unique and deleting a project removes its environments and secrets", async () => {
    const backend = await openTestBackend();
    await projectWithSecret(backend);
    expect(
      await backend.createProject({
        project: { id: "p2", orgId: DEFAULT_ORG, name: "demo", createdAt: NOW },
        environments: [],
      }),
    ).toBe(false);
    expect(
      await backend.createEnvironment({
        environment: { id: "e3", projectId: "p1", name: "dev", createdAt: NOW },
      }),
    ).toBe(false);
    expect(await backend.listEnvironments({ projectId: "p1" })).toEqual(["dev", "prod"]);
    expect(
      await backend.insertSecret({
        secret: {
          id: "s2",
          environmentId: "e1",
          keyEncrypted: "other",
          keyHash: "name-hash",
          valueEncrypted: "other",
          kind: "secret",
          updatedAt: NOW,
        },
      }),
    ).toBe(false);
    expect(
      (await backend.getSecretRow({ environmentId: "e1", keyHash: "name-hash" }))
        ?.valueEncrypted,
    ).toBe("value-ciphertext");

    await backend.deleteProject({ id: "p1" });
    expect(await backend.listProjects({ orgId: DEFAULT_ORG })).toEqual([]);
    expect(await backend.getEnvironment({ projectId: "p1", name: "dev" })).toBeNull();
    expect(await backend.listSecretRows({ environmentId: "e1" })).toEqual([]);
  });

  test("audit pages by (createdAt, id) across equal timestamps and prunes in full", async () => {
    const backend = await openTestBackend();
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    for (const [id, createdAt] of [
      ["a", at(1)],
      ["b", at(2)],
      ["c", at(2)],
      ["d", at(2)],
      ["e", at(3)],
    ] as const)
      await backend.insertAudit({ event: auditEvent(id, createdAt) });

    const first = await backend.listAudit({ orgId: DEFAULT_ORG, limit: 2, before: null });
    expect(first.map((row) => row.id)).toEqual(["e", "d"]);
    const second = await backend.listAudit({
      orgId: DEFAULT_ORG,
      limit: 2,
      before: { createdAt: first[1]!.createdAt, id: first[1]!.id },
    });
    expect(second.map((row) => row.id)).toEqual(["c", "b"]);
    const third = await backend.listAudit({
      orgId: DEFAULT_ORG,
      limit: 2,
      before: { createdAt: second[1]!.createdAt, id: second[1]!.id },
    });
    expect(third.map((row) => row.id)).toEqual(["a"]);

    expect(await backend.pruneAudit({ before: at(3) })).toBe(4);
    expect((await backend.listAudit({ orgId: DEFAULT_ORG, limit: 10, before: null })).map((row) => row.id)).toEqual([
      "e",
    ]);
  });

  test("the bootstrap claim happens once", async () => {
    const backend = await openTestBackend();
    expect(await backend.isBootstrapped({})).toBe(false);
    expect(await backend.claimBootstrap({ claimedAt: NOW, key: userKey("vault_usr_1") })).toBe(
      true,
    );
    expect(await backend.claimBootstrap({ claimedAt: NOW, key: userKey("vault_usr_2") })).toBe(
      false,
    );
    expect(await backend.findKeyByPrefix({ orgId: DEFAULT_ORG, keyPrefix: "vault_usr_2" })).toBeNull();
    expect(await backend.isBootstrapped({})).toBe(true);
  });
});
