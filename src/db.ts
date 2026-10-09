/**
 * `VaultStore` — the encryption boundary around a `VaultBackend`.
 *
 * Values are encrypted on the way in and decrypted on the way out here, so no
 * route handler ever holds a ciphertext and no query ever holds a plaintext
 * name. A secret's name is written twice: `key_encrypted` for retrieval and
 * `key_hash` (keyed HMAC) for lookup and uniqueness.
 *
 * The rows themselves live behind `VaultBackend` (D1 or Convex); this class
 * never builds a query.
 *
 * Failures throw `PolicyError` with the HTTP status they should surface, which
 * is what lets `app.ts` answer a refused write with a 404 or 409 without
 * re-deriving the reason.
 *
 * @see {@link https://vault.buildwithfriends.dev/reference/database/}
 */
import type { KeyRow, SecretRow, VaultBackend } from "./backend.ts";
import type { VaultCrypto } from "./crypto.ts";
import { PolicyError } from "./policy.ts";
import type {
  ApiKeyRecord,
  AuditAction,
  KeyMode,
  KeyType,
  Permission,
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
  ) {}

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
    return row == null ? null : this.toApiKey(row);
  }

  async findKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = await this.backend.findKeyByPrefix({ keyPrefix: prefix });
    return row == null ? null : this.toApiKey(row);
  }

  async listKeys(includeRevoked = false): Promise<ApiKeyRecord[]> {
    const rows = await this.backend.listKeys({ includeRevoked });
    return Promise.all(rows.map((row) => this.toApiKey(row)));
  }

  async revokeKey(prefix: string): Promise<boolean> {
    const outcome = await this.backend.revokeKey({
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
      project: { id, name: normalized, createdAt: nowIso() },
      environments: DEFAULT_ENVIRONMENTS.map((env) => ({ id: newId(), name: env })),
    });
    if (!created) throw new PolicyError(409, `project "${normalized}" already exists`);
    return { id, name: normalized };
  }

  async listProjects(): Promise<string[]> {
    return this.backend.listProjects({});
  }

  async getProject(name: string): Promise<{ id: string; name: string } | null> {
    return this.backend.getProject({ name: name.toLowerCase() });
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
      meta.push({
        name: await this.vaultCrypto.decrypt(row.keyEncrypted),
        kind: row.kind,
      });
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

  async audit(input: {
    keyPrefix: string;
    action: AuditAction;
    status: string;
    secretName?: string;
  }): Promise<void> {
    await this.backend.insertAudit({
      event: {
        id: newId(),
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

  private async toApiKey(row: KeyRow): Promise<ApiKeyRecord> {
    // SAFETY: keyRow encrypts the JSON serialization of its validated Scope[];
    // rotateKey preserves that value when issuing the replacement key.
    const scopes =
      row.scopesEncrypted != null
        ? (JSON.parse(await this.vaultCrypto.decrypt(row.scopesEncrypted)) as Scope[])
        : null;
    return {
      id: row.id,
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

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}
