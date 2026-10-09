/**
 * The single place a key's authority is decided.
 *
 * Two key types: `user` keys are operators (manage keys, projects, and audit;
 * unscoped) and `system` keys are shared with people and agents (scoped, and
 * never able to manage anything). Legacy `broker`-mode keys are names-only:
 * they may list secret names (what CI gates such as "merge-gate secret
 * status" use) but never read values or write.
 *
 * The `sealed` kind is checked here rather than at a call site: `get` and
 * `?show=1` never return a sealed value; only the `?export=1` path that
 * `vault run` uses does.
 *
 * Keep these decisions in this module. A policy check inlined into a route is
 * a rule that the next route silently does not get.
 *
 * @see {@link https://vault.buildwithfriends.dev/concepts/keys-and-policy/}
 */
import type { ApiKeyRecord, SecretKind } from "./types.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * An error that carries the HTTP status it should surface as. Policy checks,
 * `VaultStore`, and `VaultKeyring` all throw it, and `app.ts` answers it with
 * `{ error: message }` and that status.
 */
export class PolicyError extends Error {
  readonly status: ContentfulStatusCode;
  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
  }
}

/** Operators (user keys) manage keys, projects, audit, and master keys. */
export function isOperator(key: ApiKeyRecord): boolean {
  return key.type === "user";
}

function canWriteSecrets(key: ApiKeyRecord): boolean {
  if (key.mode === "broker") return false;
  return key.permission === "full" || key.permission === "readwrite";
}

export function assertActiveKey(key: ApiKeyRecord, now: Date = new Date()): void {
  if (key.revoked) throw new PolicyError(401, "API key revoked");
  if (Date.parse(key.expiresAt) <= now.getTime()) {
    throw new PolicyError(401, "API key expired");
  }
}

export function assertScope(key: ApiKeyRecord, project: string, env: string): void {
  if (key.type === "user") return;
  const scopes = key.scopes ?? [];
  const allowed = scopes.some(
    (scope) => scope.project === project && (scope.env === "*" || scope.env === env),
  );
  if (!allowed)
    throw new PolicyError(403, "API key is not scoped to this project/environment");
}

/** Names-only (broker) keys never see a value, on any read path. */
export function assertCanReadValues(key: ApiKeyRecord): void {
  if (key.mode === "broker") throw new PolicyError(403, "this key can list names only");
}

export function assertCanWrite(key: ApiKeyRecord): void {
  if (!canWriteSecrets(key)) throw new PolicyError(403, "API key cannot write secrets");
}

export function valueVisibleOnGet(kind: SecretKind): boolean {
  return kind !== "sealed";
}
