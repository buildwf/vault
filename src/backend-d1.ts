/**
 * `D1Backend` — the vault's rows in Cloudflare D1, through the schema in
 * `migrations/`. Constraints and the `prevent_last_active_user_key` trigger do
 * the atomic work; this file translates their failures into the outcomes
 * `VaultBackend` promises.
 *
 * Keys, projects and audit rows carry `org_id`; every org-scoped query filters
 * on it, and project names are unique per org (`migrations/0003_orgs.sql`).
 *
 * Audit paging is keyset, not offset: `(created_at DESC, id DESC)` matches the
 * index exactly, so a deep page is a range scan and a row inserted mid-scroll
 * cannot shift the window.
 */
import type {
  AuditRow,
  KeyRow,
  NamedRow,
  OrgRow,
  RevokeOutcome,
  SecretRow,
  VaultBackend,
  WrapRow,
} from "./backend.ts";
import type { AuditAction, KeyMode, KeyType, Permission, SecretKind } from "./types.ts";

type KeySqlRow = {
  id: string;
  org_id: string;
  key_prefix: string;
  key_hash: string;
  type: KeyType;
  label_encrypted: string | null;
  scopes_encrypted: string | null;
  permission: Permission;
  mode: KeyMode | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked: number;
  revoked_at: string | null;
};

type SecretSqlRow = {
  id: string;
  environment_id: string;
  key_encrypted: string;
  key_hash: string;
  value_encrypted: string;
  kind: SecretKind;
  updated_at: string;
};

type AuditSqlRow = {
  id: string;
  org_id: string;
  key_prefix: string;
  action: AuditAction;
  host_encrypted: string | null;
  secret_name_encrypted: string | null;
  status: string;
  created_at: string;
};

type OrgSqlRow = { id: string; name: string; wrapped_data_key: string; created_at: string };

type WrapSqlRow = { fingerprint: string; wrapped_data_key: string; created_at: string };

const LAST_USER_KEY = "cannot revoke the last active user key";
const INSERT_ENVIRONMENT =
  "INSERT INTO environments (id, project_id, name, created_at) VALUES (?, ?, ?, ?)";

function isUniqueConstraintFailure(cause: unknown): boolean {
  return String(cause).includes("UNIQUE constraint failed");
}

function isLastUserKeyFailure(cause: unknown): boolean {
  return String(cause).includes(LAST_USER_KEY);
}

export class D1Backend implements VaultBackend {
  constructor(private readonly db: D1Database) {}

  async findWrap({ fingerprint }: { fingerprint: string }): Promise<WrapRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM master_key_wraps WHERE fingerprint = ?")
      .bind(fingerprint)
      .first<WrapSqlRow>();
    return row == null ? null : toWrap(row);
  }

  async countWraps(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM master_key_wraps")
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async insertWrap({ wrap }: { wrap: WrapRow }): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO master_key_wraps (
          fingerprint, wrapped_data_key, created_at
        ) VALUES (?, ?, ?)`,
      )
      .bind(wrap.fingerprint, wrap.wrappedDataKey, wrap.createdAt)
      .run();
  }

  async listWraps(): Promise<WrapRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM master_key_wraps ORDER BY created_at")
      .all<WrapSqlRow>();
    return (result.results ?? []).map(toWrap);
  }

  async deleteWrap({ fingerprint }: { fingerprint: string }): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM master_key_wraps WHERE fingerprint = ?")
      .bind(fingerprint)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async createOrg({ org, key }: { org: OrgRow; key: KeyRow }): Promise<boolean> {
    if (key.orgId !== org.id) throw new Error("the first key must belong to the new org");
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO orgs (id, name, wrapped_data_key, created_at) VALUES (?, ?, ?, ?)")
          .bind(org.id, org.name, org.wrappedDataKey, org.createdAt),
        this.insertKeyStatement(key),
      ]);
      return true;
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: orgs.name")) return false;
      throw error;
    }
  }

  async getOrg({ id }: { id: string }): Promise<OrgRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM orgs WHERE id = ?")
      .bind(id)
      .first<OrgSqlRow>();
    return row == null
      ? null
      : {
          id: row.id,
          name: row.name,
          wrappedDataKey: row.wrapped_data_key,
          createdAt: row.created_at,
        };
  }

  async listOrgs(): Promise<string[]> {
    const result = await this.db
      .prepare("SELECT name FROM orgs ORDER BY name")
      .all<{ name: string }>();
    return (result.results ?? []).map((row) => row.name);
  }

  async insertKey({ key }: { key: KeyRow }): Promise<void> {
    await this.insertKeyStatement(key).run();
  }

  async claimBootstrap({
    claimedAt,
    key,
  }: {
    claimedAt: string;
    key: KeyRow;
  }): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO bootstrap_state (singleton, claimed_at, key_prefix)
             VALUES (1, ?, ?)`,
          )
          .bind(claimedAt, key.keyPrefix),
        this.insertKeyStatement(key),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async isBootstrapped(): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT singleton FROM bootstrap_state WHERE singleton = 1")
      .first<{ singleton: number }>();
    return row != null;
  }

  async findKeyByHash({ keyHash }: { keyHash: string }): Promise<KeyRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ?")
      .bind(keyHash)
      .first<KeySqlRow>();
    return row == null ? null : toKey(row);
  }

  async findKeyByPrefix({
    orgId,
    keyPrefix,
  }: {
    orgId: string;
    keyPrefix: string;
  }): Promise<KeyRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM api_keys WHERE org_id = ? AND key_prefix = ?")
      .bind(orgId, keyPrefix)
      .first<KeySqlRow>();
    return row == null ? null : toKey(row);
  }

  async listKeys({
    orgId,
    includeRevoked,
  }: {
    orgId: string;
    includeRevoked: boolean;
  }): Promise<KeyRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM api_keys WHERE org_id = ?
         ${includeRevoked ? "" : "AND revoked = 0"}
         ORDER BY created_at`,
      )
      .bind(orgId)
      .all<KeySqlRow>();
    return (result.results ?? []).map(toKey);
  }

  async revokeKey({
    orgId,
    keyPrefix,
    revokedAt,
  }: {
    orgId: string;
    keyPrefix: string;
    revokedAt: string;
  }): Promise<RevokeOutcome> {
    try {
      const result = await this.revokeStatement(orgId, keyPrefix, revokedAt).run();
      return (result.meta.changes ?? 0) > 0 ? "revoked" : "not_found";
    } catch (error) {
      if (isLastUserKeyFailure(error)) return "last_user_key";
      throw error;
    }
  }

  async rotateKey({
    key,
    revokePrefix,
    revokedAt,
  }: {
    key: KeyRow;
    revokePrefix: string;
    revokedAt: string;
  }): Promise<"rotated" | "last_user_key"> {
    try {
      await this.db.batch([
        this.insertKeyStatement(key),
        this.revokeStatement(key.orgId, revokePrefix, revokedAt),
      ]);
      return "rotated";
    } catch (error) {
      if (isLastUserKeyFailure(error)) return "last_user_key";
      throw error;
    }
  }

  async touchKey({ keyPrefix, at }: { keyPrefix: string; at: string }): Promise<void> {
    await this.db
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE key_prefix = ?")
      .bind(at, keyPrefix)
      .run();
  }

  async createProject({
    project,
    environments,
  }: {
    project: NamedRow & { orgId: string; createdAt: string };
    environments: NamedRow[];
  }): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, ?)")
          .bind(project.id, project.orgId, project.name, project.createdAt),
        ...environments.map((environment) =>
          this.db
            .prepare(INSERT_ENVIRONMENT)
            .bind(environment.id, project.id, environment.name, project.createdAt),
        ),
      ]);
      return true;
    } catch (error) {
      if (isUniqueConstraintFailure(error)) return false;
      throw error;
    }
  }

  async listProjects({ orgId }: { orgId: string }): Promise<string[]> {
    const result = await this.db
      .prepare("SELECT name FROM projects WHERE org_id = ? ORDER BY name")
      .bind(orgId)
      .all<{ name: string }>();
    return (result.results ?? []).map((row) => row.name);
  }

  async getProject({ orgId, name }: { orgId: string; name: string }): Promise<NamedRow | null> {
    return this.db
      .prepare("SELECT id, name FROM projects WHERE org_id = ? AND name = ?")
      .bind(orgId, name)
      .first<NamedRow>();
  }

  async deleteProject({ id }: { id: string }): Promise<void> {
    await this.db.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
  }

  async createEnvironment({
    environment,
  }: {
    environment: NamedRow & { projectId: string; createdAt: string };
  }): Promise<boolean> {
    try {
      await this.db
        .prepare(INSERT_ENVIRONMENT)
        .bind(
          environment.id,
          environment.projectId,
          environment.name,
          environment.createdAt,
        )
        .run();
      return true;
    } catch (error) {
      if (isUniqueConstraintFailure(error)) return false;
      throw error;
    }
  }

  async deleteEnvironment({
    projectId,
    name,
  }: {
    projectId: string;
    name: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM environments WHERE project_id = ? AND name = ?")
      .bind(projectId, name)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async listEnvironments({ projectId }: { projectId: string }): Promise<string[]> {
    const result = await this.db
      .prepare("SELECT name FROM environments WHERE project_id = ? ORDER BY name")
      .bind(projectId)
      .all<{ name: string }>();
    return (result.results ?? []).map((row) => row.name);
  }

  async getEnvironment({
    projectId,
    name,
  }: {
    projectId: string;
    name: string;
  }): Promise<NamedRow | null> {
    return this.db
      .prepare("SELECT id, name FROM environments WHERE project_id = ? AND name = ?")
      .bind(projectId, name)
      .first<NamedRow>();
  }

  async listSecretRows({ environmentId }: { environmentId: string }): Promise<SecretRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM secrets WHERE environment_id = ?")
      .bind(environmentId)
      .all<SecretSqlRow>();
    return (result.results ?? []).map(toSecret);
  }

  async insertSecret({ secret }: { secret: SecretRow }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO secrets (id, environment_id, key_encrypted, key_hash, value_encrypted, kind, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(environment_id, key_hash) DO NOTHING RETURNING id`,
      )
      .bind(...secretValues(secret))
      .first<{ id: string }>();
    return row != null;
  }

  async upsertSecret({ secret }: { secret: SecretRow }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO secrets (
          id, environment_id, key_encrypted, key_hash, value_encrypted, kind, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(environment_id, key_hash) DO UPDATE SET
          key_encrypted = excluded.key_encrypted,
          value_encrypted = excluded.value_encrypted,
          kind = excluded.kind,
          updated_at = excluded.updated_at`,
      )
      .bind(...secretValues(secret))
      .run();
  }

  async deleteSecret({
    environmentId,
    keyHash,
  }: {
    environmentId: string;
    keyHash: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM secrets WHERE environment_id = ? AND key_hash = ?")
      .bind(environmentId, keyHash)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async getSecretRow({
    environmentId,
    keyHash,
  }: {
    environmentId: string;
    keyHash: string;
  }): Promise<SecretRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM secrets WHERE environment_id = ? AND key_hash = ?")
      .bind(environmentId, keyHash)
      .first<SecretSqlRow>();
    return row == null ? null : toSecret(row);
  }

  async insertAudit({ event }: { event: AuditRow }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_events (
          id, org_id, key_prefix, action, host_encrypted, secret_name_encrypted,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.orgId,
        event.keyPrefix,
        event.action,
        event.hostEncrypted,
        event.secretNameEncrypted,
        event.status,
        event.createdAt,
      )
      .run();
  }

  async listAudit({
    orgId,
    limit,
    before,
  }: {
    orgId: string;
    limit: number;
    before: { createdAt: string; id: string } | null;
  }): Promise<AuditRow[]> {
    const cursorClause =
      before != null ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
    const statement = this.db.prepare(
      `SELECT * FROM audit_events
       WHERE org_id = ? ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    );
    const result =
      before != null
        ? await statement
            .bind(orgId, before.createdAt, before.createdAt, before.id, limit)
            .all<AuditSqlRow>()
        : await statement.bind(orgId, limit).all<AuditSqlRow>();
    return (result.results ?? []).map(toAudit);
  }

  async pruneAudit({ before }: { before: string }): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM audit_events WHERE created_at < ?")
      .bind(before)
      .run();
    return result.meta.changes ?? 0;
  }

  private insertKeyStatement(key: KeyRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO api_keys (
          id, org_id, key_prefix, key_hash, type, label_encrypted, scopes_encrypted,
          permission, mode, created_at, expires_at, revoked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .bind(
        key.id,
        key.orgId,
        key.keyPrefix,
        key.keyHash,
        key.type,
        key.labelEncrypted,
        key.scopesEncrypted,
        key.permission,
        key.mode,
        key.createdAt,
        key.expiresAt,
      );
  }

  private revokeStatement(
    orgId: string,
    keyPrefix: string,
    revokedAt: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE api_keys SET revoked = 1, revoked_at = ?
         WHERE org_id = ? AND key_prefix = ? AND revoked = 0`,
      )
      .bind(revokedAt, orgId, keyPrefix);
  }
}

function secretValues(secret: SecretRow) {
  return [
    secret.id,
    secret.environmentId,
    secret.keyEncrypted,
    secret.keyHash,
    secret.valueEncrypted,
    secret.kind,
    secret.updatedAt,
  ];
}

function toWrap(row: WrapSqlRow): WrapRow {
  return {
    fingerprint: row.fingerprint,
    wrappedDataKey: row.wrapped_data_key,
    createdAt: row.created_at,
  };
}

function toKey(row: KeySqlRow): KeyRow {
  return {
    id: row.id,
    orgId: row.org_id,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    type: row.type,
    labelEncrypted: row.label_encrypted,
    scopesEncrypted: row.scopes_encrypted,
    permission: row.permission,
    mode: row.mode,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revoked: row.revoked === 1,
    revokedAt: row.revoked_at,
  };
}

function toSecret(row: SecretSqlRow): SecretRow {
  return {
    id: row.id,
    environmentId: row.environment_id,
    keyEncrypted: row.key_encrypted,
    keyHash: row.key_hash,
    valueEncrypted: row.value_encrypted,
    kind: row.kind,
    updatedAt: row.updated_at,
  };
}

function toAudit(row: AuditSqlRow): AuditRow {
  return {
    id: row.id,
    orgId: row.org_id,
    keyPrefix: row.key_prefix,
    action: row.action,
    hostEncrypted: row.host_encrypted,
    secretNameEncrypted: row.secret_name_encrypted,
    status: row.status,
    createdAt: row.created_at,
  };
}
