/**
 * `VaultStore` — the encryption boundary around a `VaultBackend`.
 *
 * Values are encrypted on the way in and decrypted on the way out here, so no
 * route handler ever holds a ciphertext and no query ever holds a plaintext
 * name. A secret's name is written twice: `key_encrypted` for retrieval and
 * `key_hash` (keyed HMAC) for lookup and uniqueness.
 *
 * A store is bound to one org and that org's crypto: every key, project and
 * audit row it reads or writes is that org's, so a route cannot reach another
 * org by forgetting to pass one.
 *
 * The rows themselves live behind `VaultBackend` (D1); this class
 * never builds a query.
 *
 * Failures throw `PolicyError` with the HTTP status they should surface, which
 * is what lets `app.ts` answer a refused write with a 404 or 409 without
 * re-deriving the reason.
 *
 * @see {@link https://vault.buildwithfriends.dev/reference/database/}
 */
import {
  DEFAULT_ORG,
  type KeyRow,
  type MintedKeyRow,
  type ParentRow,
  type SecretRow,
  type VaultBackend,
} from "./backend.ts";
import type { VaultCrypto } from "./crypto.ts";
import { PolicyError } from "./policy.ts";
import type {
  ApiKeyRecord,
  AuditAction,
  KeyMode,
  KeyType,
  MintedKeyMeta,
  MintedKeyStatus,
  Permission,
  ParentMeta,
  Scope,
  SecretKind,
  SecretMeta,
  SecretRecord,
  AuditRecord,
} from "./types.ts";

const LAST_USER_KEY = "cannot revoke the last active user key";
const DEFAULT_ENVIRONMENTS = ["dev", "prod"];

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

type NewKey = {
  plaintext: string;
  prefix: string;
  type: KeyType;
  permission: Permission;
  mode: KeyMode | null;
  label: string | null;
  scopes: Scope[] | null;
  expiresAt: string;
};

export class VaultStore {
  constructor(
    private readonly backend: VaultBackend,
    private readonly vaultCrypto: VaultCrypto,
    readonly orgId: string = DEFAULT_ORG,
  ) {}

  /** Creates this store's org, keyed by its crypto, together with its first operator key. */
  async createOrg(
    name: string,
    wrappedDataKey: string,
    key: { plaintext: string; prefix: string; label: string; expiresAt: string },
  ): Promise<void> {
    const created = await this.backend.createOrg({
      org: { id: this.orgId, name, wrappedDataKey, createdAt: nowIso() },
      key: await this.keyRow({
        ...key,
        type: "user",
        permission: "full",
        mode: null,
        scopes: null,
      }),
    });
    if (!created) throw new PolicyError(409, `org "${name}" already exists`);
  }

  async listOrgs(): Promise<string[]> {
    return this.backend.listOrgs({});
  }

  async insertKey(input: NewKey): Promise<void> {
    await this.backend.insertKey({ key: await this.keyRow(input) });
  }

  async claimBootstrapKey(input: {
    plaintext: string;
    prefix: string;
    label: string;
    expiresAt: string;
  }): Promise<void> {
    const claimed = await this.backend.claimBootstrap({
      claimedAt: nowIso(),
      key: await this.keyRow({
        ...input,
        type: "user",
        permission: "full",
        mode: null,
        scopes: null,
      }),
    });
    if (!claimed) throw new PolicyError(409, "already bootstrapped");
  }

  async isBootstrapped(): Promise<boolean> {
    return this.backend.isBootstrapped({});
  }

  private async keyRow(input: NewKey): Promise<KeyRow> {
    return {
      id: newId(),
      orgId: this.orgId,
      keyPrefix: input.prefix,
      keyHash: await this.vaultCrypto.sha256(input.plaintext),
      type: input.type,
      labelEncrypted:
        input.label != null ? await this.vaultCrypto.encrypt(input.label) : null,
      scopesEncrypted:
        input.scopes != null
          ? await this.vaultCrypto.encrypt(JSON.stringify(input.scopes))
          : null,
      permission: input.permission,
      mode: input.mode,
      createdAt: nowIso(),
      lastUsedAt: null,
      expiresAt: input.expiresAt,
      revoked: false,
      revokedAt: null,
    };
  }

  async findKeyByPlaintext(plaintext: string): Promise<ApiKeyRecord | null> {
    const keyHash = await this.vaultCrypto.sha256(plaintext);
    const row = await this.backend.findKeyByHash({ keyHash });
    return row == null || row.orgId !== this.orgId ? null : this.toApiKey(row);
  }

  async findKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = await this.backend.findKeyByPrefix({ orgId: this.orgId, keyPrefix: prefix });
    return row == null ? null : this.toApiKey(row);
  }

  async listKeys(includeRevoked = false): Promise<ApiKeyRecord[]> {
    const rows = await this.backend.listKeys({ orgId: this.orgId, includeRevoked });
    return Promise.all(rows.map((row) => this.toApiKey(row)));
  }

  async revokeKey(prefix: string): Promise<boolean> {
    const outcome = await this.backend.revokeKey({
      orgId: this.orgId,
      keyPrefix: prefix,
      revokedAt: nowIso(),
    });
    if (outcome === "last_user_key") throw new PolicyError(409, LAST_USER_KEY);
    return outcome === "revoked";
  }

  async rotateKey(
    current: ApiKeyRecord,
    replacement: {
      plaintext: string;
      prefix: string;
      expiresAt: string;
    },
  ): Promise<void> {
    const outcome = await this.backend.rotateKey({
      key: await this.keyRow({
        ...replacement,
        type: current.type,
        permission: current.permission,
        mode: current.mode,
        label: current.label,
        scopes: current.scopes,
      }),
      revokePrefix: current.keyPrefix,
      revokedAt: nowIso(),
    });
    if (outcome === "last_user_key") throw new PolicyError(409, LAST_USER_KEY);
  }

  async touchKey(prefix: string): Promise<void> {
    await this.backend.touchKey({ keyPrefix: prefix, at: nowIso() });
  }

  async createProject(name: string): Promise<{ id: string; name: string }> {
    const id = newId();
    const normalized = name.toLowerCase();
    const created = await this.backend.createProject({
      project: { id, orgId: this.orgId, name: normalized, createdAt: nowIso() },
      environments: DEFAULT_ENVIRONMENTS.map((env) => ({ id: newId(), name: env })),
    });
    if (!created) throw new PolicyError(409, `project "${normalized}" already exists`);
    return { id, name: normalized };
  }

  async listProjects(): Promise<string[]> {
    return this.backend.listProjects({ orgId: this.orgId });
  }

  async getProject(name: string): Promise<{ id: string; name: string } | null> {
    return this.backend.getProject({ orgId: this.orgId, name: name.toLowerCase() });
  }

  async deleteProject(name: string): Promise<boolean> {
    const project = await this.getProject(name);
    if (project == null) return false;
    await this.backend.deleteProject({ id: project.id });
    return true;
  }

  async createEnvironment(projectId: string, name: string): Promise<void> {
    const normalized = name.toLowerCase();
    const created = await this.backend.createEnvironment({
      environment: { id: newId(), projectId, name: normalized, createdAt: nowIso() },
    });
    if (!created) throw new PolicyError(409, `environment "${normalized}" already exists`);
  }

  async deleteEnvironment(projectId: string, name: string): Promise<boolean> {
    return this.backend.deleteEnvironment({ projectId, name: name.toLowerCase() });
  }

  async listEnvironments(projectId: string): Promise<string[]> {
    return this.backend.listEnvironments({ projectId });
  }

  async getEnvironment(
    projectId: string,
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    return this.backend.getEnvironment({ projectId, name: name.toLowerCase() });
  }

  async requireEnvironment(
    projectName: string,
    envName: string,
  ): Promise<{ projectId: string; environmentId: string }> {
    const project = await this.getProject(projectName);
    if (project == null) throw new PolicyError(404, "project not found");
    const environment = await this.getEnvironment(project.id, envName);
    if (environment == null) throw new PolicyError(404, "environment not found");
    return { projectId: project.id, environmentId: environment.id };
  }

  async listSecretRows(environmentId: string): Promise<SecretRow[]> {
    return this.backend.listSecretRows({ environmentId });
  }

  /** Names and kinds only; values stay encrypted. */
  async listSecretMeta(environmentId: string): Promise<SecretMeta[]> {
    const rows = await this.listSecretRows(environmentId);
    const meta: SecretMeta[] = [];
    for (const row of rows) {
      const item: SecretMeta = {
        name: await this.vaultCrypto.decrypt(row.keyEncrypted),
        kind: row.kind,
      };
      // A minted value is a spec naming its parent, not a credential, so the
      // parent's name is safe to list.
      if (row.kind === "minted") {
        const parent = mintedParent(await this.vaultCrypto.decrypt(row.valueEncrypted));
        if (parent != null) item.parent = parent;
      }
      meta.push(item);
    }
    return meta.sort(byName);
  }

  async listSecrets(environmentId: string): Promise<SecretRecord[]> {
    const rows = await this.listSecretRows(environmentId);
    const secrets: SecretRecord[] = [];
    for (const row of rows) secrets.push(await this.decryptSecret(row));
    return secrets.sort(byName);
  }

  private async decryptSecret(row: SecretRow): Promise<SecretRecord> {
    return {
      name: await this.vaultCrypto.decrypt(row.keyEncrypted),
      value: await this.vaultCrypto.decrypt(row.valueEncrypted),
      kind: row.kind,
    };
  }

  private async secretRow(
    environmentId: string,
    name: string,
    value: string,
    kind: SecretKind,
  ): Promise<SecretRow> {
    if (value.length === 0) throw new PolicyError(400, "secret value must not be empty");
    return {
      id: newId(),
      environmentId,
      keyEncrypted: await this.vaultCrypto.encrypt(name),
      keyHash: await this.vaultCrypto.lookupHash(name),
      valueEncrypted: await this.vaultCrypto.encrypt(value),
      kind,
      updatedAt: nowIso(),
    };
  }

  async createSecret(
    environmentId: string,
    name: string,
    value: string,
    kind: SecretKind,
  ): Promise<void> {
    const secret = await this.secretRow(environmentId, name, value, kind);
    if (!(await this.backend.insertSecret({ secret })))
      throw new PolicyError(409, "secret already exists; no value was changed");
  }

  async setSecret(
    environmentId: string,
    name: string,
    value: string,
    kind: SecretKind,
  ): Promise<void> {
    const secret = await this.secretRow(environmentId, name, value, kind);
    await this.backend.upsertSecret({ secret });
  }

  async deleteSecret(environmentId: string, name: string): Promise<boolean> {
    const keyHash = await this.vaultCrypto.lookupHash(name);
    return this.backend.deleteSecret({ environmentId, keyHash });
  }

  async getSecretByName(
    environmentId: string,
    name: string,
  ): Promise<SecretRecord | null> {
    const keyHash = await this.vaultCrypto.lookupHash(name);
    const row = await this.backend.getSecretRow({ environmentId, keyHash });
    return row == null ? null : this.decryptSecret(row);
  }

  /** A parent's name is hashed apart from secret names, which live in another table. */
  private parentNameHash(name: string): Promise<string> {
    return this.vaultCrypto.lookupHash(`parent:${name}`);
  }

  /** Creates the parent, or replaces its provider, config and value. */
  async setParent(input: {
    name: string;
    provider: string;
    config: Record<string, string>;
    value: string;
  }): Promise<void> {
    if (input.value.length === 0) throw new PolicyError(400, "parent value must not be empty");
    const now = nowIso();
    await this.backend.upsertParent({
      parent: {
        id: newId(),
        orgId: this.orgId,
        nameHash: await this.parentNameHash(input.name),
        nameEncrypted: await this.vaultCrypto.encrypt(input.name),
        provider: input.provider,
        configEncrypted: await this.vaultCrypto.encrypt(JSON.stringify(input.config)),
        valueEncrypted: await this.vaultCrypto.encrypt(input.value),
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  /** The parent with its decrypted value. Only the minting path may call this. */
  async getParent(name: string): Promise<Parent | null> {
    const row = await this.backend.getParent({
      orgId: this.orgId,
      nameHash: await this.parentNameHash(name),
    });
    return row == null ? null : this.decryptParent(row);
  }

  async getParentById(id: string): Promise<Parent | null> {
    const row = await this.backend.getParentById({ id });
    return row == null || row.orgId !== this.orgId ? null : this.decryptParent(row);
  }

  private async decryptParent(row: ParentRow): Promise<Parent> {
    // SAFETY: setParent encrypts the JSON of a validated string record.
    const config = JSON.parse(await this.vaultCrypto.decrypt(row.configEncrypted)) as Record<
      string,
      string
    >;
    return {
      id: row.id,
      name: await this.vaultCrypto.decrypt(row.nameEncrypted),
      provider: row.provider,
      config,
      value: await this.vaultCrypto.decrypt(row.valueEncrypted),
    };
  }

  /** Names, providers and configs; never values. */
  async listParents(): Promise<ParentMeta[]> {
    const [rows, live] = await Promise.all([
      this.backend.listParents({ orgId: this.orgId }),
      this.backend.countLiveMinted({ orgId: this.orgId, now: nowIso() }),
    ]);
    const parents: ParentMeta[] = [];
    for (const row of rows) {
      const { name, provider, config } = await this.decryptParent(row);
      parents.push({
        name,
        provider,
        config,
        activeChildren: live.get(row.id) ?? 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return parents.sort(byName);
  }

  async deleteParent(name: string): Promise<void> {
    const outcome = await this.backend.deleteParent({
      orgId: this.orgId,
      nameHash: await this.parentNameHash(name),
      now: nowIso(),
    });
    if (outcome === "not_found") throw new PolicyError(404, "parent not found");
    if (outcome === "live_children")
      throw new PolicyError(409, "parent has child keys that may still work; revoke them first");
  }

  /** Writes the ledger row before the provider is called; returns its id. */
  async recordMint(input: {
    parentId: string;
    keyPrefix: string;
    label: string;
    expiresAt: string;
  }): Promise<string> {
    const id = newId();
    await this.backend.insertMinted({
      minted: {
        id,
        orgId: this.orgId,
        parentId: input.parentId,
        providerKeyIdEncrypted: null,
        keyPrefix: input.keyPrefix,
        labelEncrypted: await this.vaultCrypto.encrypt(input.label),
        status: "pending",
        createdAt: nowIso(),
        expiresAt: input.expiresAt,
        revokedAt: null,
      },
    });
    return id;
  }

  async updateMint(
    id: string,
    status: MintedKeyStatus,
    providerKeyId?: string,
  ): Promise<void> {
    await this.backend.updateMinted({
      id,
      status,
      providerKeyIdEncrypted:
        providerKeyId == null ? undefined : await this.vaultCrypto.encrypt(providerKeyId),
      revokedAt: status === "revoked" || status === "expired" ? nowIso() : undefined,
    });
  }

  async listMinted(parentId: string, limit: number): Promise<MintedKeyMeta[]> {
    const rows = await this.backend.listMinted({ parentId, limit: Math.max(1, Math.min(limit, 500)) });
    return Promise.all(rows.map((row) => this.mintedMeta(row)));
  }

  /** The parent's children that may still work, with their provider ids. */
  async listLiveMinted(parentId: string): Promise<LiveMint[]> {
    const rows = await this.backend.listLiveMinted({ parentId });
    return Promise.all(rows.map((row) => this.liveMint(row)));
  }

  async liveMint(row: MintedKeyRow): Promise<LiveMint> {
    return {
      ...(await this.mintedMeta(row)),
      providerKeyId:
        row.providerKeyIdEncrypted == null
          ? null
          : await this.vaultCrypto.decrypt(row.providerKeyIdEncrypted),
    };
  }

  private async mintedMeta(row: MintedKeyRow): Promise<MintedKeyMeta> {
    return {
      id: row.id,
      label: await this.vaultCrypto.decrypt(row.labelEncrypted),
      keyPrefix: row.keyPrefix,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async audit(input: {
    keyPrefix: string;
    action: AuditAction;
    status: string;
    secretName?: string;
  }): Promise<void> {
    await this.backend.insertAudit({
      event: {
        id: newId(),
        orgId: this.orgId,
        keyPrefix: input.keyPrefix,
        action: input.action,
        hostEncrypted: null,
        secretNameEncrypted:
          input.secretName != null
            ? await this.vaultCrypto.encrypt(input.secretName)
            : null,
        status: input.status,
        createdAt: nowIso(),
      },
    });
  }

  async listAudit(input: {
    limit: number;
    beforeCreatedAt?: string;
    beforeId?: string;
  }): Promise<AuditRecord[]> {
    const rows = await this.backend.listAudit({
      orgId: this.orgId,
      limit: Math.max(1, Math.min(input.limit, 200)),
      before:
        input.beforeCreatedAt != null && input.beforeId != null
          ? { createdAt: input.beforeCreatedAt, id: input.beforeId }
          : null,
    });
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        keyPrefix: row.keyPrefix,
        action: row.action,
        host:
          row.hostEncrypted == null
            ? null
            : await this.vaultCrypto.decrypt(row.hostEncrypted),
        secretName:
          row.secretNameEncrypted == null
            ? null
            : await this.vaultCrypto.decrypt(row.secretNameEncrypted),
        status: row.status,
        createdAt: row.createdAt,
      })),
    );
  }

  async pruneAudit(before: string): Promise<number> {
    return this.backend.pruneAudit({ before });
  }

  /** Decrypts a key row of this store's org. */
  async toApiKey(row: KeyRow): Promise<ApiKeyRecord> {
    if (row.orgId !== this.orgId) throw new Error("key belongs to another org");
    // SAFETY: keyRow encrypts the JSON serialization of its validated Scope[];
    // rotateKey preserves that value when issuing the replacement key.
    const scopes =
      row.scopesEncrypted != null
        ? (JSON.parse(await this.vaultCrypto.decrypt(row.scopesEncrypted)) as Scope[])
        : null;
    return {
      id: row.id,
      orgId: row.orgId,
      keyPrefix: row.keyPrefix,
      type: row.type,
      label:
        row.labelEncrypted == null
          ? null
          : await this.vaultCrypto.decrypt(row.labelEncrypted),
      permission: row.permission,
      mode: row.mode,
      scopes,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revoked: row.revoked,
      revokedAt: row.revokedAt,
    };
  }
}

export type Parent = {
  id: string;
  name: string;
  provider: string;
  config: Record<string, string>;
  value: string;
};

export type LiveMint = MintedKeyMeta & { providerKeyId: string | null };

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function mintedParent(spec: string): string | null {
  try {
    const parsed: unknown = JSON.parse(spec);
    if (typeof parsed === "object" && parsed != null && "parent" in parsed) {
      return typeof parsed.parent === "string" ? parsed.parent : null;
    }
  } catch {
    // A spec is validated on write; an unreadable one just lists no parent.
  }
  return null;
}
