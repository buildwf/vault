/**
 * `VaultBackend` — the storage boundary under `VaultStore` and `VaultKeyring`.
 *
 * Everything that crosses this interface is already encrypted or hashed:
 * names, values, labels, scopes and audit fields arrive as ciphertext, and
 * lookups are by keyed hash. A backend never sees a root key, the data key, or
 * a plaintext secret, which is what lets the rows live outside Cloudflare.
 *
 * Two implementations: `D1Backend` (the original SQL, `backend-d1.ts`) and
 * `ConvexBackend` (a Convex deployment reached over one authenticated HTTP
 * action, `backend-convex.ts` and `convex/`). Each method takes one object
 * argument so the Convex side can expose the same names with the same shapes.
 *
 * Methods that the D1 schema made atomic with a constraint, trigger or batch
 * (bootstrap claim, unique names, the last-user-key guard, key rotation) must
 * stay atomic in every backend. They report the refused case as a value rather
 * than an exception so that each backend can say it the same way.
 */
import type { AuditAction, KeyMode, KeyType, Permission, SecretKind } from "./types.ts";

export type WrapRow = {
  fingerprint: string;
  wrappedDataKey: string;
  createdAt: string;
};

export type KeyRow = {
  id: string;
  keyPrefix: string;
  keyHash: string;
  type: KeyType;
  labelEncrypted: string | null;
  scopesEncrypted: string | null;
  permission: Permission;
  mode: KeyMode | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revoked: boolean;
  revokedAt: string | null;
};

export type NamedRow = { id: string; name: string };

export type SecretRow = {
  id: string;
  environmentId: string;
  keyEncrypted: string;
  keyHash: string;
  valueEncrypted: string;
  kind: SecretKind;
  updatedAt: string;
};

export type AuditRow = {
  id: string;
  keyPrefix: string;
  action: AuditAction;
  hostEncrypted: string | null;
  secretNameEncrypted: string | null;
  status: string;
  createdAt: string;
};

export type RevokeOutcome = "revoked" | "not_found" | "last_user_key";

export interface VaultBackend {
  findWrap(input: { fingerprint: string }): Promise<WrapRow | null>;
  countWraps(input: Record<string, never>): Promise<number>;
  /** Inserts the wrap unless one with this fingerprint already exists. */
  insertWrap(input: { wrap: WrapRow }): Promise<void>;
  listWraps(input: Record<string, never>): Promise<WrapRow[]>;
  deleteWrap(input: { fingerprint: string }): Promise<boolean>;

  insertKey(input: { key: KeyRow }): Promise<void>;
  /** Claims the singleton bootstrap and inserts its key together; false if already claimed. */
  claimBootstrap(input: { claimedAt: string; key: KeyRow }): Promise<boolean>;
  isBootstrapped(input: Record<string, never>): Promise<boolean>;
  findKeyByHash(input: { keyHash: string }): Promise<KeyRow | null>;
  findKeyByPrefix(input: { keyPrefix: string }): Promise<KeyRow | null>;
  /** Ordered by creation time. */
  listKeys(input: { includeRevoked: boolean }): Promise<KeyRow[]>;
  /**
   * Revokes an active key. Refuses (`last_user_key`) when it is the only
   * unexpired, unrevoked user key left.
   */
  revokeKey(input: { keyPrefix: string; revokedAt: string }): Promise<RevokeOutcome>;
  /** Inserts the replacement and revokes the current key as one change. */
  rotateKey(input: {
    key: KeyRow;
    revokePrefix: string;
    revokedAt: string;
  }): Promise<"rotated" | "last_user_key">;
  touchKey(input: { keyPrefix: string; at: string }): Promise<void>;

  /** Creates the project and its environments together; false if the name exists. */
  createProject(input: {
    project: NamedRow & { createdAt: string };
    environments: NamedRow[];
  }): Promise<boolean>;
  /** Names, sorted. */
  listProjects(input: Record<string, never>): Promise<string[]>;
  getProject(input: { name: string }): Promise<NamedRow | null>;
  /** Deletes the project with its environments and their secrets. */
  deleteProject(input: { id: string }): Promise<void>;
  /** False if the project already has an environment with this name. */
  createEnvironment(input: {
    environment: NamedRow & { projectId: string; createdAt: string };
  }): Promise<boolean>;
  /** Deletes the environment with its secrets. */
  deleteEnvironment(input: { projectId: string; name: string }): Promise<boolean>;
  /** Names, sorted. */
  listEnvironments(input: { projectId: string }): Promise<string[]>;
  getEnvironment(input: { projectId: string; name: string }): Promise<NamedRow | null>;

  listSecretRows(input: { environmentId: string }): Promise<SecretRow[]>;
  /** False, and nothing written, when the environment already has this name. */
  insertSecret(input: { secret: SecretRow }): Promise<boolean>;
  /** Replaces the name, value and kind of an existing secret, or inserts it. */
  upsertSecret(input: { secret: SecretRow }): Promise<void>;
  deleteSecret(input: { environmentId: string; keyHash: string }): Promise<boolean>;
  getSecretRow(input: { environmentId: string; keyHash: string }): Promise<SecretRow | null>;

  insertAudit(input: { event: AuditRow }): Promise<void>;
  /** Newest first by `(createdAt, id)`, strictly before the cursor when one is given. */
  listAudit(input: {
    limit: number;
    before: { createdAt: string; id: string } | null;
  }): Promise<AuditRow[]>;
  /** Deletes audit rows created before the cutoff; returns how many. */
  pruneAudit(input: { before: string }): Promise<number>;
}
