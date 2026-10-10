/**
 * The contract a service implements to mint child keys from a parent key.
 *
 * A provider validates a parent's non-secret config and a minted secret's spec,
 * mints one child, and revokes one by the provider's own id. It never stores
 * anything: the ledger in `minter.ts` records every mint before the provider
 * is called.
 *
 * `ProviderError` separates the two failures that matter to the ledger: the
 * provider said no (`rejected`, nothing to clean up) and the outcome is not
 * known (`unknown`, a key may exist). A network failure is always `unknown`.
 */
import type { Parent } from "../db.ts";

export type Send = typeof fetch;

export class ProviderError extends Error {
  constructor(
    readonly outcome: "rejected" | "unknown",
    message: string,
    /** The provider's id for a key that may exist, when it is known. */
    readonly keyId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type MintRequest = {
  /** Shown in the provider's dashboard so a key traces back to its ledger row. */
  name: string;
  /** A whole-second ISO timestamp. */
  expiresAt: string;
};

export interface ParentProvider<TSpec = unknown> {
  readonly name: string;
  /** True when the provider disables a child at its expiry without the vault's help. */
  readonly selfExpiring: boolean;
  /** Validates the parent's non-secret config; throws `Error` with a reason. */
  parseConfig(config: Record<string, string>): Record<string, string>;
  /** Validates the provider fields of a minted secret's spec; throws `Error` with a reason. */
  parseSpec(spec: Record<string, unknown>): TSpec;
  mint(parent: Parent, spec: TSpec, request: MintRequest, send: Send): Promise<{ id: string; value: string }>;
  /** Revokes a child. A child the provider no longer has counts as revoked. */
  revoke(parent: Parent, keyId: string, send: Send): Promise<void>;
}

/** Calls a provider and returns its status and JSON body; a lost reply is `unknown`. */
export async function callProvider(
  send: Send,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await send(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProviderError("unknown", "the provider did not answer");
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
