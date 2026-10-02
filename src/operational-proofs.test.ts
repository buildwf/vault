import { describe, expect, test } from "bun:test";

import {
  d1DatabaseIdFromListOutput,
  deployedWorkersDevUrl,
  secretsStoreSecretId,
} from "./operational-proofs.ts";

describe("operational proof parsers", () => {
  test("extracts disposable Cloudflare resource identities", () => {
    expect(
      d1DatabaseIdFromListOutput(
        '[{"name":"temporary","uuid":"123e4567-e89b-42d3-a456-426614174000"}]',
        "temporary",
      ),
    ).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(
      deployedWorkersDevUrl(
        "Deployed bwf-vault-recovery-abcd triggers\n  https://bwf-vault-recovery-abcd.example.workers.dev",
      ).origin,
    ).toBe("https://bwf-vault-recovery-abcd.example.workers.dev");
    expect(
      secretsStoreSecretId(
        JSON.stringify([
          { id: "11111111111111111111111111111111", name: "BWF_VAULT_BOOTSTRAP_TOKEN" },
          { id: "22222222222222222222222222222222", name: "BWF_VAULT_MASTER_KEY_PRIMARY" },
        ]),
        "BWF_VAULT_MASTER_KEY_PRIMARY",
      ),
    ).toBe("22222222222222222222222222222222");
  });
});
