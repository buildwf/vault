/**
 * `VaultBackend` — the storage boundary under `VaultStore` and `VaultKeyring`.
 *
 * Everything that crosses this interface is already encrypted or hashed:
 * names, values, labels, scopes and audit fields arrive as ciphertext, and
 * lookups are by keyed hash. A backend never sees a root key, the data key, or
 * a plaintext secret.
 *
 * `D1Backend` (`backend-d1.ts`) implements it over the schema in `migrations/`.
 *
 * Keys, projects and audit rows belong to an org (`orgId`). Every org-scoped
 * method takes the org and must never return or change another org's row; the
 * Worker resolves the org from the caller's key before it touches anything.
 * `DEFAULT_ORG` is the vault's own org: what bootstrap creates and every row
 * that predates orgs belongs to.
 *
 * Methods that are atomic through a constraint, trigger or batch (bootstrap
 * claim, unique names, the last-user-key guard, key rotation) report the
 * refused case as a value rather than an exception.
 */
import type {
  AuditAction,
  KeyMode,
  KeyType,
  MintedKeyStatus,
  Permission,
  SecretKind,
} from "./types.ts";

/** The vault's own org: bootstrap, pre-org rows, and the platform operators. */
export const DEFAULT_ORG = "default";

export type OrgRow = {
  id: string;
  name: string;
  /** The org's data key, encrypted by the vault data key. */
  wrappedDataKey: string;
  createdAt: string;
};

export type WrapRow = {
  fingerprint: string;
  wrappedDataKey: string;
  createdAt: string;
};

export type KeyRow = {
  id: string;
  orgId: string;
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
  orgId: string;
  keyPrefix: string;
  action: AuditAction;
  hostEncrypted: string | null;
  secretNameEncrypted: string | null;
  status: string;
  createdAt: string;
};

export type ParentRow = {
  id: string;
  orgId: string;
  nameHash: string;
  nameEncrypted: string;
  provider: string;
  configEncrypted: string;
  valueEncrypted: string;
  createdAt: string;
  updatedAt: string;
};

export type MintedKeyRow = {
  id: string;
  orgId: string;
  parentId: string;
  providerKeyIdEncrypted: string | null;
  keyPrefix: string;
  labelEncrypted: string;
  status: MintedKeyStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

/** Ledger statuses whose child key may still work at the provider. */
export const LIVE_MINTED_STATUSES: readonly MintedKeyStatus[] = ["pending", "active", "unknown"];

/** A one-time web UI sign-in link, issued for the key `keyPrefix` in `orgId`. */
export type UiLinkRow = {
  codeHash: string;
  orgId: string;
  keyPrefix: string;
  expiresAt: string;
};

export type RevokeOutcome = "revoked" | "not_found" | "last_user_key";

export interface VaultBackend {
  findWrap(input: { fingerprint: string }): Promise<WrapRow | null>;
  countWraps(input: Record<string, never>): Promise<number>;
  /** Inserts the wrap unless one with this fingerprint already exists. */
  insertWrap(input: { wrap: WrapRow }): Promise<void>;
  listWraps(input: Record<string, never>): Promise<WrapRow[]>;
  deleteWrap(input: { fingerprint: string }): Promise<boolean>;

  /** Creates the org and its first key together; false if the name exists. */
  createOrg(input: { org: OrgRow; key: KeyRow }): Promise<boolean>;
  getOrg(input: { id: string }): Promise<OrgRow | null>;
  /** Names, sorted; never includes `DEFAULT_ORG`. */
  listOrgs(input: Record<string, never>): Promise<string[]>;

  insertKey(input: { key: KeyRow }): Promise<void>;
  /** Claims the singleton bootstrap and inserts its key together; false if already claimed. */
  claimBootstrap(input: { claimedAt: string; key: KeyRow }): Promise<boolean>;
  isBootstrapped(input: Record<string, never>): Promise<boolean>;
  /** Any org: the caller's key is how the Worker learns its org. */
  findKeyByHash(input: { keyHash: string }): Promise<KeyRow | null>;
  findKeyByPrefix(input: { orgId: string; keyPrefix: string }): Promise<KeyRow | null>;
  /** Ordered by creation time. */
  listKeys(input: { orgId: string; includeRevoked: boolean }): Promise<KeyRow[]>;
  /**
   * Revokes an active key. Refuses (`last_user_key`) when it is the org's only
   * unexpired, unrevoked user key left.
   */
  revokeKey(input: {
    orgId: string;
    keyPrefix: string;
    revokedAt: string;
  }): Promise<RevokeOutcome>;
  /** Inserts the replacement and revokes the current key (same org) as one change. */
  rotateKey(input: {
    key: KeyRow;
    revokePrefix: string;
    revokedAt: string;
  }): Promise<"rotated" | "last_user_key">;
  touchKey(input: { keyPrefix: string; at: string }): Promise<void>;

  /** Creates the project and its environments together; false if the name exists. */
  createProject(input: {
    project: NamedRow & { orgId: string; createdAt: string };
    environments: NamedRow[];
  }): Promise<boolean>;
  /** Names, sorted. */
  listProjects(input: { orgId: string }): Promise<string[]>;
  getProject(input: { orgId: string; name: string }): Promise<NamedRow | null>;
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

  /** Inserts the parent, or replaces its provider, config and value (keeping its id). */
  upsertParent(input: { parent: ParentRow }): Promise<void>;
  getParent(input: { orgId: string; nameHash: string }): Promise<ParentRow | null>;
  getParentById(input: { id: string }): Promise<ParentRow | null>;
  listParents(input: { orgId: string }): Promise<ParentRow[]>;
  /**
   * Deletes the parent with its finished ledger rows. Refuses (`live_children`)
   * while any of its children may still work: revoke them first.
   */
  deleteParent(input: {
    orgId: string;
    nameHash: string;
    now: string;
  }): Promise<"deleted" | "not_found" | "live_children">;
  /** Live children (see `LIVE_MINTED_STATUSES`) not yet past their expiry, per parent id. */
  countLiveMinted(input: { orgId: string; now: string }): Promise<Map<string, number>>;

  insertMinted(input: { minted: MintedKeyRow }): Promise<void>;
  /** Moves a ledger row to a new status, recording the provider id when it is learned. */
  updateMinted(input: {
    id: string;
    status: MintedKeyStatus;
    providerKeyIdEncrypted?: string;
    revokedAt?: string;
  }): Promise<void>;
  /** Newest first. */
  listMinted(input: { parentId: string; limit: number }): Promise<MintedKeyRow[]>;
  /** The parent's children that may still work, whatever their expiry. */
  listLiveMinted(input: { parentId: string }): Promise<MintedKeyRow[]>;
  /** Children of every org that may still work but are past expiry, oldest first. */
  listDueMinted(input: { now: string; limit: number }): Promise<MintedKeyRow[]>;

  insertAudit(input: { event: AuditRow }): Promise<void>;
  /** Newest first by `(createdAt, id)`, strictly before the cursor when one is given. */
  listAudit(input: {
    orgId: string;
    limit: number;
    before: { createdAt: string; id: string } | null;
  }): Promise<AuditRow[]>;
  /** Deletes audit rows of every org created before the cutoff; returns how many. */
  pruneAudit(input: { before: string }): Promise<number>;

  /** Inserts the link and deletes links that expired before `now`. */
  insertUiLink(input: { link: UiLinkRow; now: string }): Promise<void>;
  /** Deletes the link and returns it, so a code works at most once; null if absent. */
  takeUiLink(input: { codeHash: string }): Promise<UiLinkRow | null>;
}
