/**
 * GitHub: a parent is a GitHub App's private key; a child is an installation
 * access token for that App's installation, limited to the spec's permissions
 * and (optionally) repositories. GitHub disables every installation token one
 * hour after it is made, so a spec's `ttlMinutes` can be at most 60.
 *
 * GitHub can only revoke an installation token with the token itself, so the
 * ledger keeps the token (encrypted with the org's key, like any secret) as the
 * child's provider id until the child is closed.
 *
 * The created token is checked against what was asked for (permissions). A
 * token that does not match is revoked at once; if that revoke fails, the
 * outcome is `unknown` so the ledger keeps it live until it expires.
 *
 * @see {@link https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app}
 * @see {@link https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app}
 */
import * as v from "valibot";

import type { Parent } from "../db.ts";
import { ProviderError, callProvider, type ParentProvider, type Send } from "./provider.ts";

const API = "https://api.github.com";
const numericId = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,19}$/u));
const LEVELS = ["read", "write", "admin"] as const;

const configSchema = v.strictObject({ appId: numericId, installationId: numericId });
const specSchema = v.strictObject({
  permissions: v.pipe(
    v.record(v.pipe(v.string(), v.regex(/^[a-z_]{1,64}$/u)), v.picklist(LEVELS)),
    v.check((permissions) => {
      const count = Object.keys(permissions).length;
      return count >= 1 && count <= 50;
    }),
  ),
  repositories: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,100}$/u))),
      v.minLength(1),
      v.maxLength(500),
    ),
  ),
});
export type GitHubSpec = v.InferOutput<typeof specSchema>;

const createdSchema = v.looseObject({
  token: v.pipe(v.string(), v.minLength(1)),
  expires_at: v.string(),
  permissions: v.optional(v.record(v.string(), v.string()), {}),
});
const errorSchema = v.looseObject({ message: v.string() });

function rejection(status: number, body: unknown): string {
  const message = `GitHub refused (HTTP ${status})`;
  const parsed = v.safeParse(errorSchema, body);
  return parsed.success ? `${message}: ${parsed.output.message.slice(0, 200)}` : message;
}

function headers(auth: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "buildwf-vault",
    "content-type": "application/json",
  };
}

/** True when GitHub granted exactly the permissions asked for. */
function sameGrant(asked: Record<string, string>, granted: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(asked), ...Object.keys(granted)]);
  for (const key of keys) if (asked[key] !== granted[key]) return false;
  return true;
}

// --- App JWT (RS256) -------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(content.length), ...content]);
}

/** Wraps a PKCS#1 RSA key (GitHub's download format) in a PKCS#8 envelope. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const key = der(0x04, pkcs1);
  return der(0x30, new Uint8Array([...version, ...algorithm, ...key]));
}

const PEM = /^-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END (RSA )?PRIVATE KEY-----$/u;

async function importAppKey(pem: string): Promise<CryptoKey> {
  const match = PEM.exec(pem.trim());
  if (match?.[2] == null || match[1] !== match[3])
    throw new Error("a github parent must be the App's PEM private key");
  const bytes = Uint8Array.from(atob(match[2].replace(/\s+/gu, "")), (c) => c.charCodeAt(0));
  const pkcs8 = match[1] == null ? bytes : pkcs1ToPkcs8(bytes);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("a github parent must be the App's RSA private key");
  }
}

async function appJwt(parent: Parent): Promise<string> {
  let key: CryptoKey;
  try {
    key = await importAppKey(parent.value);
  } catch (error) {
    throw new ProviderError("rejected", error instanceof Error ? error.message : "invalid App key");
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  // GitHub allows at most 10 minutes; back-date iat for clock drift.
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: parent.config.appId })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// --- Provider --------------------------------------------------------------

export const github: ParentProvider<GitHubSpec> = {
  name: "github",
  selfExpiring: true,
  maxTtlMinutes: 60,

  parseConfig(config) {
    const parsed = v.safeParse(configSchema, config);
    if (!parsed.success) throw new Error("github parents need config appId and installationId (numbers)");
    return parsed.output;
  },

  async checkValue(value) {
    await importAppKey(value);
  },

  parseSpec(spec) {
    const parsed = v.safeParse(specSchema, spec);
    if (!parsed.success)
      throw new Error(
        'github specs need permissions: {"contents": "read", ...} and optional repositories: ["name", ...]',
      );
    return parsed.output;
  },

  async mint(parent, spec, _request, send) {
    const jwt = await appJwt(parent);
    const { status, body } = await callProvider(
      send,
      `${API}/app/installations/${parent.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: headers(jwt),
        body: JSON.stringify({
          permissions: spec.permissions,
          ...(spec.repositories == null ? {} : { repositories: spec.repositories }),
        }),
      },
    );
    if (status >= 500) throw new ProviderError("unknown", `GitHub failed (HTTP ${status})`);
    if (status < 200 || status >= 300) throw new ProviderError("rejected", rejection(status, body));
    const created = v.safeParse(createdSchema, body);
    if (!created.success) throw new ProviderError("unknown", "GitHub returned an unreadable token");
    const token = created.output;
    if (!sameGrant(spec.permissions, token.permissions)) {
      try {
        await this.revoke(parent, token.token, send);
      } catch {
        throw new ProviderError("unknown", "GitHub granted different permissions", token.token);
      }
      throw new ProviderError("rejected", "GitHub granted different permissions; the token was revoked");
    }
    return { id: token.token, value: token.token };
  },

  async revoke(_parent, keyId, send: Send) {
    const { status, body } = await callProvider(send, `${API}/installation/token`, {
      method: "DELETE",
      headers: headers(keyId),
    });
    // 401: the token no longer works (expired or already revoked).
    if (status === 401 || (status >= 200 && status < 300)) return;
    if (status >= 500) throw new ProviderError("unknown", `GitHub failed (HTTP ${status})`);
    throw new ProviderError("rejected", rejection(status, body));
  },
};
