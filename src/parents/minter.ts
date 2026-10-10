/**
 * Minting child keys from parent keys, and the ledger that traces each one.
 *
 * A `minted` secret stores a spec, never a key:
 *
 *   { "parent": "cloudflare", "ttlMinutes": 60, ...provider fields }
 *
 * Exporting the secret calls `mint`, which writes a `pending` ledger row,
 * asks the provider for a child that expires after `ttlMinutes`, then marks
 * the row `active` (with the provider's id), `failed` (the provider said no)
 * or `unknown` (a key may exist). The row exists before the provider is
 * called, so no child can be created without a trace.
 *
 * `revokeParent` revokes every child of a parent that may still work. `reap`
 * runs from the cron: it revokes children past their expiry at the provider
 * (for a self-expiring provider that only deletes a disabled key) and closes
 * their ledger rows.
 *
 * Parent values never leave this module and the providers it calls.
 */
import * as v from "valibot";

import type { VaultBackend } from "../backend.ts";
import { VaultStore, type Parent } from "../db.ts";
import { PolicyError } from "../policy.ts";
import { cloudflare } from "./cloudflare.ts";
import { github } from "./github.ts";
import { ProviderError, type ParentProvider, type Send } from "./provider.ts";

export const PARENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_TTL_MINUTES = 10080;
const DEFAULT_TTL_MINUTES = 60;

const PROVIDERS: ReadonlyMap<string, ParentProvider> = new Map(
  [cloudflare as ParentProvider, github as ParentProvider].map((provider) => [provider.name, provider]),
);

export function providerNames(): string[] {
  return [...PROVIDERS.keys()];
}

const specBaseSchema = v.looseObject({
  parent: v.pipe(v.string(), v.regex(PARENT_NAME)),
  ttlMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_TTL_MINUTES)),
  ),
});

type ParsedSpec = { parent: string; ttlMinutes: number; fields: Record<string, unknown> };

function parseSpec(value: string): ParsedSpec {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new PolicyError(400, "a minted secret's value must be a JSON spec");
  }
  const parsed = v.safeParse(specBaseSchema, json);
  if (!parsed.success)
    throw new PolicyError(
      400,
      `a minted spec needs "parent" (a parent name) and optional "ttlMinutes" (1 to ${MAX_TTL_MINUTES})`,
    );
  const { parent, ttlMinutes, ...fields } = parsed.output;
  return { parent, ttlMinutes: ttlMinutes ?? DEFAULT_TTL_MINUTES, fields };
}

function providerFor(name: string): ParentProvider {
  const provider = PROVIDERS.get(name);
  if (provider == null) throw new PolicyError(400, `unknown provider "${name}"`);
  return provider;
}

function providerSpec(provider: ParentProvider, spec: ParsedSpec): unknown {
  if (provider.maxTtlMinutes != null && spec.ttlMinutes > provider.maxTtlMinutes)
    throw new PolicyError(
      400,
      `${provider.name} keys last at most ${provider.maxTtlMinutes} minutes; set "ttlMinutes" to ${provider.maxTtlMinutes} or less`,
    );
  const fields = spec.fields;
  try {
    return provider.parseSpec(fields);
  } catch (error) {
    throw new PolicyError(400, error instanceof Error ? error.message : "invalid spec");
  }
}

/** Validates a parent before it is stored; returns the normalized config. */
export async function parseParent(
  providerName: string,
  config: Record<string, string>,
  value: string,
): Promise<Record<string, string>> {
  const provider = providerFor(providerName);
  try {
    const parsed = provider.parseConfig(config);
    await provider.checkValue?.(value);
    return parsed;
  } catch (error) {
    throw new PolicyError(400, error instanceof Error ? error.message : "invalid parent");
  }
}

export class Minter {
  constructor(
    private readonly send: Send = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Refuses a spec that names a missing parent or does not fit its provider. */
  async validate(store: VaultStore, value: string): Promise<void> {
    const spec = parseSpec(value);
    const parent = await store.getParent(spec.parent);
    if (parent == null) throw new PolicyError(400, `parent "${spec.parent}" does not exist`);
    providerSpec(providerFor(parent.provider), spec);
  }

  /** Mints one child for `label` (project/env/NAME) and returns its value. */
  async mint(
    store: VaultStore,
    input: { value: string; label: string; keyPrefix: string },
  ): Promise<string> {
    const spec = parseSpec(input.value);
    const parent = await store.getParent(spec.parent);
    if (parent == null) throw new PolicyError(409, `${input.label}: parent "${spec.parent}" does not exist`);
    const provider = providerFor(parent.provider);
    const providerFields = providerSpec(provider, spec);
    const expires = new Date(this.now().getTime() + spec.ttlMinutes * 60_000);
    expires.setUTCMilliseconds(0);
    const expiresAt = expires.toISOString();
    const id = await store.recordMint({
      parentId: parent.id,
      keyPrefix: input.keyPrefix,
      label: input.label,
      expiresAt,
    });
    try {
      const child = await provider.mint(
        parent,
        providerFields,
        { name: `vault ${input.label.slice(0, 80)} ${id.slice(0, 8)}`, expiresAt },
        this.send,
      );
      await store.updateMint(id, "active", child.id);
      return child.value;
    } catch (error) {
      const outcome = error instanceof ProviderError ? error.outcome : "unknown";
      await store.updateMint(
        id,
        outcome === "rejected" ? "failed" : "unknown",
        error instanceof ProviderError ? error.keyId : undefined,
      );
      const reason = error instanceof ProviderError ? error.message : "minting failed";
      throw new PolicyError(502, `${input.label}: ${reason}`);
    }
  }

  /** Revokes every child of the parent that may still work. */
  async revokeParent(
    store: VaultStore,
    name: string,
  ): Promise<{ revoked: number; failed: number; untraceable: number }> {
    const parent = await store.getParent(name);
    if (parent == null) throw new PolicyError(404, "parent not found");
    const provider = providerFor(parent.provider);
    const counts = { revoked: 0, failed: 0, untraceable: 0 };
    for (const child of await store.listLiveMinted(parent.id)) {
      const outcome = await this.revokeChild(store, parent, provider, child.id, child.providerKeyId, "revoked");
      counts[outcome] += 1;
    }
    return counts;
  }

  /** Closes ledger rows past their expiry across every org. */
  async reap(
    backend: VaultBackend,
    storeFor: (orgId: string) => Promise<VaultStore>,
    limit = 200,
  ): Promise<{ closed: number; failed: number; untraceable: number }> {
    const counts = { closed: 0, failed: 0, untraceable: 0 };
    const due = await backend.listDueMinted({ now: this.now().toISOString(), limit });
    const stores = new Map<string, VaultStore>();
    for (const row of due) {
      let store = stores.get(row.orgId);
      if (store == null) {
        store = await storeFor(row.orgId);
        stores.set(row.orgId, store);
      }
      const parent = await store.getParentById(row.parentId);
      const child = await store.liveMint(row);
      if (parent == null) {
        counts.untraceable += 1;
        continue;
      }
      const provider = providerFor(parent.provider);
      const outcome = await this.revokeChild(store, parent, provider, row.id, child.providerKeyId, "expired");
      if (outcome === "revoked") counts.closed += 1;
      else counts[outcome] += 1;
    }
    return counts;
  }

  private async revokeChild(
    store: VaultStore,
    parent: Parent,
    provider: ParentProvider,
    id: string,
    providerKeyId: string | null,
    closedAs: "revoked" | "expired",
  ): Promise<"revoked" | "failed" | "untraceable"> {
    if (providerKeyId == null) {
      // No provider id: the mint never got a reply. A self-expiring provider
      // has disabled it by now if it exists; otherwise someone must look.
      const pastExpiry = closedAs === "expired";
      if (pastExpiry && provider.selfExpiring) {
        await store.updateMint(id, "expired");
        return "revoked";
      }
      return "untraceable";
    }
    try {
      await provider.revoke(parent, providerKeyId, this.send);
      await store.updateMint(id, closedAs);
      return "revoked";
    } catch {
      return "failed";
    }
  }
}
