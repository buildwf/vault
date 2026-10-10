/**
 * The vault's shared vocabulary.
 *
 * `SecretKind` is the one type here that carries a policy decision rather than
 * a shape: `sealed` values are never shown by `get`/`show`, only exported to
 * `vault run`. `policy.ts` is where that is enforced. `config` and `secret`
 * behave the same; the label is for readers. A `minted` secret's stored value
 * is a spec naming a parent key (`parents/`); exporting it mints a fresh child key
 * from that parent, so the stored value is never the key itself.
 *
 * `keyModeSchema` keeps `broker` for existing keys, which `policy.ts` limits
 * to listing names.
 *
 * Each shape is declared once, as a valibot schema, and its TypeScript type is
 * inferred from it. The server validates requests and the client validates
 * responses against these same definitions.
 *
 * `AuditAction` is deliberately a closed union. Adding an audited operation
 * means adding a member, which makes the audit surface reviewable as a list
 * instead of discoverable by grep.
 *
 * @see {@link https://vault.buildwithfriends.dev/concepts/secret-kinds/}
 */
import * as v from "valibot";

export const keyTypeSchema = v.picklist(["user", "system"]);
export const permissionSchema = v.picklist(["read", "readwrite", "full"]);
const keyModeSchema = v.picklist(["inject", "broker"]);
export const secretKindSchema = v.picklist(["config", "secret", "sealed", "minted"]);
export const auditActionSchema = v.picklist([
  "audit_list",
  "bootstrap",
  "broker",
  "environment_create",
  "environment_delete",
  "get",
  "inject",
  "key_create",
  "key_revoke",
  "key_rotate",
  "list",
  "master_key_prepare",
  "master_key_retire",
  "mint",
  "mint_revoke",
  "org_create",
  "project_create",
  "project_delete",
  "parent_delete",
  "parent_set",
  "route_list",
  "route_put",
  "secret_delete",
  "set",
  "ui_signin",
]);

export const scopeSchema = v.object({ project: v.string(), env: v.string() });

export const apiKeyMetaSchema = v.object({
  keyPrefix: v.string(),
  type: keyTypeSchema,
  label: v.nullable(v.string()),
  permission: permissionSchema,
  mode: v.nullable(keyModeSchema),
  scopes: v.nullable(v.array(scopeSchema)),
  createdAt: v.string(),
  lastUsedAt: v.nullable(v.string()),
  expiresAt: v.string(),
  revoked: v.boolean(),
  revokedAt: v.nullable(v.string()),
});

export const secretMetaSchema = v.object({ name: v.string(), kind: secretKindSchema });

export const secretRecordSchema = v.object({
  name: v.string(),
  value: v.string(),
  kind: secretKindSchema,
});

export const auditRecordSchema = v.object({
  id: v.string(),
  keyPrefix: v.string(),
  action: auditActionSchema,
  host: v.nullable(v.string()),
  secretName: v.nullable(v.string()),
  status: v.string(),
  createdAt: v.string(),
});

export const parentMetaSchema = v.object({
  name: v.string(),
  provider: v.string(),
  config: v.record(v.string(), v.string()),
  activeChildren: v.number(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

export const mintedKeyStatusSchema = v.picklist([
  "pending",
  "active",
  "unknown",
  "failed",
  "revoked",
  "expired",
]);

export const mintedKeyMetaSchema = v.object({
  id: v.string(),
  label: v.string(),
  keyPrefix: v.string(),
  status: mintedKeyStatusSchema,
  createdAt: v.string(),
  expiresAt: v.string(),
  revokedAt: v.nullable(v.string()),
});

export const masterKeyWrapMetaSchema = v.object({
  fingerprint: v.string(),
  createdAt: v.string(),
});

export type KeyType = v.InferOutput<typeof keyTypeSchema>;
export type Permission = v.InferOutput<typeof permissionSchema>;
export type KeyMode = v.InferOutput<typeof keyModeSchema>;
export type SecretKind = v.InferOutput<typeof secretKindSchema>;
export type AuditAction = v.InferOutput<typeof auditActionSchema>;
export type Scope = v.InferOutput<typeof scopeSchema>;
export type ApiKeyMeta = v.InferOutput<typeof apiKeyMetaSchema>;
export type ApiKeyRecord = ApiKeyMeta & { id: string; orgId: string };
export type SecretMeta = v.InferOutput<typeof secretMetaSchema>;
export type SecretRecord = v.InferOutput<typeof secretRecordSchema>;
export type AuditRecord = v.InferOutput<typeof auditRecordSchema>;
export type ParentMeta = v.InferOutput<typeof parentMetaSchema>;
export type MintedKeyStatus = v.InferOutput<typeof mintedKeyStatusSchema>;
export type MintedKeyMeta = v.InferOutput<typeof mintedKeyMetaSchema>;
export type MasterKeyWrapMeta = v.InferOutput<typeof masterKeyWrapMetaSchema>;

export type ProcessEnvironment = Record<string, string | undefined>;
