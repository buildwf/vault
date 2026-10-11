/**
 * OAuth 2.1 for the hosted MCP endpoint, so cloud agents (claude.ai, Claude
 * Desktop, Cowork, Managed Agents) can use the vault without a local CLI.
 *
 * - Discovery: RFC 9728 protected-resource metadata and RFC 8414
 *   authorization-server metadata, both on this Worker.
 * - Registration (RFC 7591) is stateless: the client id is the client's name
 *   and redirect URIs, signed with the vault's HMAC key. Nothing is stored
 *   until an operator approves.
 * - Authorization: `/oauth/authorize` checks the request and sends the browser
 *   to the web UI (`/ui#/connect/...`). An operator signs in there, picks the
 *   project/environments, and approves. Only public clients with PKCE S256.
 * - Tokens: trading the code makes a grant. Its identity is a new read-only
 *   system key scoped to what the operator picked, so it shows in `vault keys
 *   list` and revoking that key ends the grant. Nobody ever sees that key's
 *   plaintext. The client gets an access token (one hour) and a refresh token
 *   (rotated on use; the grant ends after 30 days). Both are stored as hashes,
 *   and the access token works only at `/mcp`, never on `/v1`, so a client
 *   cannot read values: `use_secret` sends them from inside the Worker.
 * - Device login (`vault login --device`), for a CLI where no browser runs,
 *   such as an agent in a cloud container. It registers with the redirect URI
 *   `/oauth/device` and prints the authorize link; an operator approves on the
 *   same connect page. The code is keyed by the PKCE challenge, so only the
 *   CLI, which holds the verifier, can poll it out of `/oauth/token`. The CLI
 *   gets a read-only system key for the picked environments, valid for one
 *   day, which `vault run` can read values with.
 */
import type { Context } from "hono";
import * as v from "valibot";

import type { OAuthGrantRow, VaultBackend } from "./backend.ts";
import type { VaultCrypto } from "./crypto.ts";
import { VaultStore } from "./db.ts";
import type { VaultKeyring } from "./keyring.ts";
import { bearerFrom, randomApiKey, randomSecretValue } from "./keys.ts";
import { PolicyError, assertActiveKey } from "./policy.ts";
import { scopeSchema, type ApiKeyRecord, type Scope } from "./types.ts";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
/** How long a use_secret approval link can be acted on. */
const PENDING_TTL_MS = 10 * 60 * 1000;
export const SCOPE = "vault:use";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** Where a device login's browser lands after the operator answers. */
export const deviceRedirect = (origin: string) => `${origin}/oauth/device`;
const deviceCodeHash = (crypto: VaultCrypto, challenge: string) => crypto.sha256(`device\n${challenge}`);

export function oauthMetadata(origin: string) {
  return {
    resource: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Vault",
    },
    server: {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    },
  };
}

/** The `WWW-Authenticate` value that points a client at the metadata. */
export const bearerChallenge = (origin: string, error?: string) =>
  `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` +
  (error == null ? "" : `, error="${error}"`);

// ---------- clients ----------

/** An https URL, or http on a loopback host (native apps such as Claude Code). */
const redirectUriSchema = v.pipe(
  v.string(),
  v.maxLength(500),
  v.check((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  }),
);
export const registerSchema = v.looseObject({
  redirect_uris: v.pipe(v.array(redirectUriSchema), v.minLength(1), v.maxLength(10)),
  client_name: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
type Client = { name: string; redirectUris: string[] };

const toBase64Url = (bytes: Uint8Array) => bytes.toBase64({ alphabet: "base64url", omitPadding: true });

/** A client id that carries the client: base64url(JSON).signature. */
export async function signClient(crypto: VaultCrypto, input: v.InferOutput<typeof registerSchema>) {
  const name = (input.client_name ?? "").replace(/[\p{C}]/gu, "").trim().slice(0, 60) || "MCP client";
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ n: name, r: input.redirect_uris })),
  );
  const signature = (await crypto.lookupHash(`oauth-client\n${payload}`)).slice(0, 32);
  return { clientId: `${payload}.${signature}`, client: { name, redirectUris: input.redirect_uris } };
}

const clientPayloadSchema = v.object({ n: v.string(), r: v.array(v.string()) });

export async function readClient(crypto: VaultCrypto, clientId: string): Promise<Client | null> {
  const [payload, signature, extra] = clientId.split(".");
  if (payload == null || signature == null || extra != null || clientId.length > 8000) return null;
  const expected = (await crypto.lookupHash(`oauth-client\n${payload}`)).slice(0, 32);
  if (signature !== expected) return null;
  try {
    const decoded = new TextDecoder().decode(Uint8Array.fromBase64(payload, { alphabet: "base64url" }));
    const parsed = v.parse(clientPayloadSchema, JSON.parse(decoded));
    return { name: parsed.n, redirectUris: parsed.r };
  } catch {
    return null;
  }
}

/** The client, if `redirectUri` is one it registered; otherwise a 400. */
export async function requireClient(crypto: VaultCrypto, clientId: string, redirectUri: string) {
  const client = await readClient(crypto, clientId);
  if (client == null) throw new PolicyError(400, "unknown OAuth client; connect again");
  if (!client.redirectUris.includes(redirectUri))
    throw new PolicyError(400, "redirect_uri is not registered for this client");
  return client;
}

// ---------- codes and tokens ----------

export const approveSchema = v.strictObject({
  client_id: v.pipe(v.string(), v.maxLength(8000)),
  redirect_uri: v.pipe(v.string(), v.maxLength(500)),
  code_challenge: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  state: v.optional(v.pipe(v.string(), v.maxLength(1000))),
  scopes: v.pipe(v.array(scopeSchema), v.minLength(1), v.maxLength(50)),
});

/** Called by the web UI for a signed-in operator; returns where to send the browser. */
export async function approve(
  keyring: VaultKeyring,
  store: VaultStore,
  key: ApiKeyRecord,
  origin: string,
  body: v.InferOutput<typeof approveSchema>,
) {
  await requireClient(keyring.crypto, body.client_id, body.redirect_uri);
  const scopes: Scope[] = [];
  for (const scope of body.scopes) {
    await store.requireEnvironment(scope.project, scope.env);
    if (!scopes.some((s) => s.project === scope.project && s.env === scope.env)) scopes.push(scope);
  }
  const device = body.redirect_uri === deviceRedirect(origin);
  const code = `vault_oac_${randomSecretValue()}`;
  const orgCrypto = await keyring.cryptoFor(store.orgId);
  const now = new Date();
  await keyring.backend.insertOAuthCode({
    code: {
      codeHash: device
        ? await deviceCodeHash(keyring.crypto, body.code_challenge)
        : await keyring.crypto.sha256(code),
      orgId: store.orgId,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      keyPrefix: key.keyPrefix,
      scopesEncrypted: await orgCrypto.encrypt(JSON.stringify(scopes)),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    },
    now: now.toISOString(),
  });
  await store.audit({ keyPrefix: key.keyPrefix, action: "oauth_approve", status: "ok" });
  // The CLI polls for this code, so it never goes through the browser.
  if (device) return body.redirect_uri;
  const redirect = new URL(body.redirect_uri);
  redirect.searchParams.set("code", code);
  if (body.state != null) redirect.searchParams.set("state", body.state);
  redirect.searchParams.set("iss", origin);
  return redirect.toString();
}

/** An RFC 6749 error from the token endpoint. */
class TokenError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_grant"
      | "unsupported_grant_type"
      | "invalid_client"
      | "authorization_pending",
    message: string,
  ) {
    super(message);
  }
}

async function pkceMatches(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest)) === challenge;
}

async function newTokens(keyring: VaultKeyring, grantExpiresAt: number) {
  const access = `vault_oat_${randomSecretValue()}`;
  const refresh = `vault_ort_${randomSecretValue()}`;
  const accessExpiresAt = Math.min(Date.now() + ACCESS_TTL_MS, grantExpiresAt);
  return {
    response: {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((accessExpiresAt - Date.now()) / 1000)),
      refresh_token: refresh,
      scope: SCOPE,
    },
    hashes: {
      accessHash: await keyring.crypto.sha256(access),
      accessExpiresAt: new Date(accessExpiresAt).toISOString(),
      refreshHash: await keyring.crypto.sha256(refresh),
    },
  };
}

async function exchangeCode(keyring: VaultKeyring, form: Record<string, string>) {
  const code = form.code ?? "";
  const row = await keyring.backend.takeOAuthCode({ codeHash: await keyring.crypto.sha256(code) });
  if (row == null || Date.parse(row.expiresAt) <= Date.now())
    throw new TokenError("invalid_grant", "authorization code is used or expired");
  if (row.clientId !== form.client_id || row.redirectUri !== form.redirect_uri)
    throw new TokenError("invalid_grant", "client_id or redirect_uri does not match the code");
  if (!(await pkceMatches(form.code_verifier ?? "", row.codeChallenge)))
    throw new TokenError("invalid_grant", "code_verifier does not match");
  const client = await readClient(keyring.crypto, row.clientId);
  if (client == null) throw new TokenError("invalid_client", "unknown OAuth client");
  const orgCrypto = await keyring.cryptoFor(row.orgId);
  const store = new VaultStore(keyring.backend, orgCrypto, row.orgId);
  // SAFETY: `approve` encrypts the JSON of a validated Scope[].
  const scopes = JSON.parse(await orgCrypto.decrypt(row.scopesEncrypted)) as Scope[];
  const expiresAt = Date.now() + GRANT_TTL_MS;
  // The grant's identity. Its plaintext is dropped here: nobody ever holds it.
  const identity = randomApiKey("system");
  await store.insertKey({
    plaintext: identity.plaintext,
    prefix: identity.prefix,
    type: "system",
    permission: "read",
    mode: "inject",
    label: `${client.name} (MCP connector)`,
    scopes,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  const tokens = await newTokens(keyring, expiresAt);
  await keyring.backend.insertOAuthGrant({
    grant: {
      id: crypto.randomUUID(),
      orgId: row.orgId,
      keyPrefix: identity.prefix,
      clientId: row.clientId,
      ...tokens.hashes,
      approvalsEncrypted: null,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    now: new Date().toISOString(),
  });
  await store.audit({ keyPrefix: row.keyPrefix, action: "oauth_grant", status: "ok" });
  return tokens.response;
}

/** RFC 8628 polling: pending until an operator approves, then a one-day read-only system key, once. */
async function exchangeDeviceCode(keyring: VaultKeyring, form: Record<string, string>, origin: string) {
  const verifier = form.device_code ?? "";
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier))
    throw new TokenError("invalid_request", "device_code must be the PKCE verifier");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const row = await keyring.backend.takeOAuthCode({
    codeHash: await deviceCodeHash(keyring.crypto, toBase64Url(new Uint8Array(digest))),
  });
  if (row == null) throw new TokenError("authorization_pending", "waiting for an operator to approve");
  if (Date.parse(row.expiresAt) <= Date.now())
    throw new TokenError("invalid_grant", "the approval expired; log in again");
  if (row.clientId !== form.client_id || row.redirectUri !== deviceRedirect(origin))
    throw new TokenError("invalid_grant", "client_id does not match the approval");
  const client = await readClient(keyring.crypto, row.clientId);
  if (client == null) throw new TokenError("invalid_client", "unknown OAuth client");
  const orgCrypto = await keyring.cryptoFor(row.orgId);
  const store = new VaultStore(keyring.backend, orgCrypto, row.orgId);
  // SAFETY: `approve` encrypts the JSON of a validated Scope[].
  const scopes = JSON.parse(await orgCrypto.decrypt(row.scopesEncrypted)) as Scope[];
  const key = randomApiKey("system");
  await store.insertKey({
    plaintext: key.plaintext,
    prefix: key.prefix,
    type: "system",
    permission: "read",
    mode: "inject",
    label: `${client.name} (CLI login)`,
    scopes,
    expiresAt: new Date(Date.now() + DEVICE_KEY_TTL_MS).toISOString(),
  });
  await store.audit({ keyPrefix: row.keyPrefix, action: "oauth_grant", status: "ok" });
  return {
    access_token: key.plaintext,
    token_type: "Bearer",
    expires_in: DEVICE_KEY_TTL_MS / 1000,
    scopes,
  };
}

async function refresh(keyring: VaultKeyring, form: Record<string, string>) {
  const refreshHash = await keyring.crypto.sha256(form.refresh_token ?? "");
  const grant = await keyring.backend.findOAuthGrant({ refreshHash });
  if (grant == null || grant.clientId !== form.client_id || Date.parse(grant.expiresAt) <= Date.now())
    throw new TokenError("invalid_grant", "refresh token is invalid or expired");
  try {
    await grantKey(keyring, grant);
  } catch {
    throw new TokenError("invalid_grant", "this connection was revoked");
  }
  const tokens = await newTokens(keyring, Date.parse(grant.expiresAt));
  if (!(await keyring.backend.rotateOAuthGrant({ id: grant.id, refreshHash, next: tokens.hashes })))
    throw new TokenError("invalid_grant", "refresh token was already used");
  return tokens.response;
}

/** `POST /oauth/token`. */
export async function token(c: Context, keyring: VaultKeyring) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const parsed = await c.req.parseBody().catch(() => ({}));
    const form = Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    let body;
    if (form.grant_type === "authorization_code") body = await exchangeCode(keyring, form);
    else if (form.grant_type === "refresh_token") body = await refresh(keyring, form);
    else if (form.grant_type === DEVICE_GRANT)
      body = await exchangeDeviceCode(keyring, form, new URL(c.req.url).origin);
    else throw new TokenError("unsupported_grant_type", "use authorization_code, refresh_token or device_code");
    return c.json(body, 200, headers);
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    return c.json(
      { error: error.code, error_description: error.message },
      error.code === "invalid_client" ? 401 : 400,
      headers,
    );
  }
}

// ---------- using a grant ----------

/** The grant's system key, if it is still active. */
async function grantKey(keyring: VaultKeyring, grant: OAuthGrantRow) {
  const crypto = await keyring.cryptoFor(grant.orgId);
  const store = new VaultStore(keyring.backend, crypto, grant.orgId);
  const key = await store.findKeyByPrefix(grant.keyPrefix);
  if (key == null) throw new PolicyError(401, "this connection was revoked");
  assertActiveKey(key);
  return { crypto, store, key };
}

/** Resolves an `/mcp` bearer token to its grant, key and org store. */
export async function authenticate(keyring: VaultKeyring, header: string | undefined) {
  const bearer = bearerFrom(header);
  if (bearer == null) throw new PolicyError(401, "missing bearer token");
  const grant = await keyring.backend.findOAuthGrant({
    accessHash: await keyring.crypto.sha256(bearer),
  });
  if (grant == null || Date.parse(grant.accessExpiresAt) <= Date.now())
    throw new PolicyError(401, "access token is invalid or expired");
  const resolved = await grantKey(keyring, grant);
  await resolved.store.touchKey(resolved.key.keyPrefix);
  return { grant, ...resolved };
}

// ---------- use_secret approvals ----------

type Pending = { project: string; env: string; names: string[]; host: string; expiresAt: number };
type Approvals = { granted: Record<string, number>; pending: Record<string, Pending> };

export const approvalKey = (scope: Scope, name: string, host: string) =>
  `${scope.project}/${scope.env}/${name} ${host}`;

/** A grant's use_secret approvals, without expired ones. */
export class GrantApprovals {
  constructor(
    private readonly backend: VaultBackend,
    private readonly crypto: VaultCrypto,
    readonly grant: OAuthGrantRow,
  ) {}

  async read(): Promise<Approvals> {
    // SAFETY: only `write` stores this column, as the JSON of an Approvals.
    const stored: Approvals =
      this.grant.approvalsEncrypted == null
        ? { granted: {}, pending: {} }
        : JSON.parse(await this.crypto.decrypt(this.grant.approvalsEncrypted));
    const now = Date.now();
    const live = <T>(entries: Record<string, T>, at: (value: T) => number) =>
      Object.fromEntries(Object.entries(entries).filter(([, value]) => at(value) > now));
    return {
      granted: live(stored.granted, (at) => at),
      pending: live(stored.pending, (p) => p.expiresAt),
    };
  }

  private async write(approvals: Approvals) {
    const approvalsEncrypted = await this.crypto.encrypt(JSON.stringify(approvals));
    await this.backend.setOAuthApprovals({ id: this.grant.id, approvalsEncrypted });
    this.grant.approvalsEncrypted = approvalsEncrypted;
  }

  async allow(scope: Scope, names: string[], host: string, minutes: number) {
    const approvals = await this.read();
    for (const name of names)
      approvals.granted[approvalKey(scope, name, host)] = Date.now() + minutes * 60000;
    await this.write(approvals);
  }

  /** Records a request for the user to approve in the web UI; returns its id. */
  async request(scope: Scope, names: string[], host: string) {
    const approvals = await this.read();
    const id = `${this.grant.id}.${randomSecretValue(16)}`;
    approvals.pending[id] = { ...scope, names, host, expiresAt: Date.now() + PENDING_TTL_MS };
    await this.write(approvals);
    return id;
  }

  /** Allows a pending request (`minutes` > 0) or drops it. */
  async settle(id: string, minutes: number) {
    const approvals = await this.read();
    const pending = approvals.pending[id];
    if (pending == null) throw new PolicyError(404, "approval request is used or expired");
    delete approvals.pending[id];
    if (minutes > 0)
      for (const name of pending.names)
        approvals.granted[approvalKey(pending, name, pending.host)] = Date.now() + minutes * 60000;
    await this.write(approvals);
  }
}

/** The grant and pending request behind an approval link, for an operator of its org. */
export async function pendingApproval(keyring: VaultKeyring, orgId: string, id: string) {
  const grant = await keyring.backend.findOAuthGrant({ id: id.split(".")[0] ?? "" });
  if (grant == null || grant.orgId !== orgId)
    throw new PolicyError(404, "approval request is used or expired");
  const approvals = new GrantApprovals(keyring.backend, await keyring.cryptoFor(orgId), grant);
  const pending = (await approvals.read()).pending[id];
  if (pending == null) throw new PolicyError(404, "approval request is used or expired");
  const client = await readClient(keyring.crypto, grant.clientId);
  return { approvals, pending, client: client?.name ?? "MCP client" };
}
