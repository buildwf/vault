/**
 * Cloudflare: a parent is an account API token allowed to create API tokens
 * ("Account API Tokens Write"); a child is an account-owned API token with the
 * spec's policies and an `expires_on`, after which Cloudflare disables it.
 *
 * The created token is checked against what was asked for (name and expiry).
 * A token that does not match is revoked at once; if that revoke fails, the
 * outcome is `unknown` so the ledger keeps it live until someone looks.
 *
 * @see {@link https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/}
 */
import * as v from "valibot";

import type { Parent } from "../db.ts";
import { ProviderError, callProvider, type ParentProvider, type Send } from "./provider.ts";

const API = "https://api.cloudflare.com/client/v4";
const cfId = v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u));

const configSchema = v.strictObject({ accountId: cfId });
const policySchema = v.strictObject({
  effect: v.picklist(["allow", "deny"]),
  permission_groups: v.pipe(
    v.array(v.strictObject({ id: cfId })),
    v.minLength(1),
    v.maxLength(50),
  ),
  resources: v.record(
    v.string(),
    v.union([v.literal("*"), v.record(v.string(), v.literal("*"))]),
  ),
});
const specSchema = v.strictObject({
  policies: v.pipe(v.array(policySchema), v.minLength(1), v.maxLength(20)),
});
export type CloudflareSpec = v.InferOutput<typeof specSchema>;

const createdSchema = v.looseObject({
  success: v.literal(true),
  result: v.looseObject({
    id: cfId,
    name: v.string(),
    expires_on: v.string(),
    value: v.pipe(v.string(), v.minLength(1)),
  }),
});
const errorsSchema = v.looseObject({
  errors: v.array(v.looseObject({ code: v.number(), message: v.string() })),
});

function rejection(status: number, body: unknown): string {
  const message = `Cloudflare refused (HTTP ${status})`;
  const parsed = v.safeParse(errorsSchema, body);
  if (!parsed.success || parsed.output.errors.length === 0) return message;
  return `${message}: ${parsed.output.errors
    .slice(0, 3)
    .map((error) => `${error.code} ${error.message.slice(0, 200)}`)
    .join("; ")}`;
}

function tokensUrl(parent: Parent, suffix = ""): string {
  return `${API}/accounts/${parent.config.accountId}/tokens${suffix}`;
}

function headers(parent: Parent): Record<string, string> {
  return { Authorization: `Bearer ${parent.value}`, "content-type": "application/json" };
}

export const cloudflare: ParentProvider<CloudflareSpec> = {
  name: "cloudflare",
  selfExpiring: true,

  parseConfig(config) {
    const parsed = v.safeParse(configSchema, config);
    if (!parsed.success) throw new Error("cloudflare parents need config accountId (32 hex characters)");
    return parsed.output;
  },

  parseSpec(spec) {
    const parsed = v.safeParse(specSchema, spec);
    if (!parsed.success)
      throw new Error(
        "cloudflare specs need policies: [{effect, permission_groups: [{id}], resources}]",
      );
    return parsed.output;
  },

  async mint(parent, spec, request, send) {
    const { status, body } = await callProvider(send, tokensUrl(parent), {
      method: "POST",
      headers: headers(parent),
      body: JSON.stringify({
        name: request.name,
        policies: spec.policies,
        expires_on: request.expiresAt.replace(/\.\d{3}Z$/u, "Z"),
      }),
    });
    if (status >= 500) throw new ProviderError("unknown", `Cloudflare failed (HTTP ${status})`);
    if (status < 200 || status >= 300) throw new ProviderError("rejected", rejection(status, body));
    const created = v.safeParse(createdSchema, body);
    if (!created.success)
      throw new ProviderError("unknown", "Cloudflare returned an unreadable token");
    const token = created.output.result;
    if (
      token.name !== request.name ||
      Date.parse(token.expires_on) !== Date.parse(request.expiresAt)
    ) {
      try {
        await this.revoke(parent, token.id, send);
      } catch {
        throw new ProviderError("unknown", "Cloudflare returned a different token", token.id);
      }
      throw new ProviderError("rejected", "Cloudflare returned a different token; it was revoked");
    }
    return { id: token.id, value: token.value };
  },

  async revoke(parent, keyId, send: Send) {
    v.parse(cfId, keyId);
    const { status, body } = await callProvider(send, tokensUrl(parent, `/${keyId}`), {
      method: "DELETE",
      headers: headers(parent),
    });
    if (status === 404 || (status >= 200 && status < 300)) return;
    if (status >= 500) throw new ProviderError("unknown", `Cloudflare failed (HTTP ${status})`);
    throw new ProviderError("rejected", rejection(status, body));
  },
};
