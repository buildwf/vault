/**
 * The vault's rows in Convex. This mirrors `migrations/0001_init.sql` table for
 * table; see `src/backend.ts` for what each field holds. Every `*Encrypted`
 * field and every hash is produced by the Worker, which keeps the keys: this
 * deployment stores ciphertext only.
 *
 * Keys, projects and audit events carry `orgId`: an org's row id, or
 * `"default"` for the vault's own org (see `DEFAULT_ORG` in `src/backend.ts`).
 * Every org-scoped lookup goes through an index that starts with it.
 *
 * Row ids are the Worker's UUIDs (`rowId`), not Convex document ids, so the
 * Worker and both backends share one id space.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const nullableString = v.union(v.string(), v.null());

export const keyType = v.union(v.literal("user"), v.literal("system"));
export const permission = v.union(
  v.literal("read"),
  v.literal("readwrite"),
  v.literal("full"),
);
export const keyMode = v.union(v.literal("inject"), v.literal("broker"), v.null());
export const secretKind = v.union(
  v.literal("config"),
  v.literal("secret"),
  v.literal("sealed"),
);

export const wrapFields = {
  fingerprint: v.string(),
  wrappedDataKey: v.string(),
  createdAt: v.string(),
};

export const orgFields = {
  rowId: v.string(),
  name: v.string(),
  wrappedDataKey: v.string(),
  createdAt: v.string(),
};

export const keyFields = {
  rowId: v.string(),
  orgId: v.string(),
  keyPrefix: v.string(),
  keyHash: v.string(),
  type: keyType,
  labelEncrypted: nullableString,
  scopesEncrypted: nullableString,
  permission,
  mode: keyMode,
  createdAt: v.string(),
  lastUsedAt: nullableString,
  expiresAt: v.string(),
  revoked: v.boolean(),
  revokedAt: nullableString,
};

export const secretFields = {
  rowId: v.string(),
  environmentId: v.string(),
  keyEncrypted: v.string(),
  keyHash: v.string(),
  valueEncrypted: v.string(),
  kind: secretKind,
  updatedAt: v.string(),
};

export const auditFields = {
  rowId: v.string(),
  orgId: v.string(),
  keyPrefix: v.string(),
  // The closed action list is enforced by the Worker's own types; storage
  // keeps whatever action the Worker recorded.
  action: v.string(),
  hostEncrypted: nullableString,
  secretNameEncrypted: nullableString,
  status: v.string(),
  createdAt: v.string(),
};

export default defineSchema({
  masterKeyWraps: defineTable(wrapFields)
    .index("by_fingerprint", ["fingerprint"])
    .index("by_created", ["createdAt"]),
  orgs: defineTable(orgFields).index("by_name", ["name"]).index("by_row", ["rowId"]),
  apiKeys: defineTable(keyFields)
    .index("by_prefix", ["keyPrefix"])
    .index("by_hash", ["keyHash"])
    .index("by_org_created", ["orgId", "createdAt"])
    .index("by_org_type_revoked", ["orgId", "type", "revoked"]),
  bootstrapState: defineTable({ claimedAt: v.string(), keyPrefix: v.string() }),
  projects: defineTable({
    rowId: v.string(),
    orgId: v.string(),
    name: v.string(),
    createdAt: v.string(),
  })
    .index("by_org_name", ["orgId", "name"])
    .index("by_row", ["rowId"]),
  environments: defineTable({
    rowId: v.string(),
    projectId: v.string(),
    name: v.string(),
    createdAt: v.string(),
  })
    .index("by_project_name", ["projectId", "name"])
    .index("by_row", ["rowId"]),
  secrets: defineTable(secretFields).index("by_environment_hash", [
    "environmentId",
    "keyHash",
  ]),
  auditEvents: defineTable(auditFields)
    .index("by_created", ["createdAt", "rowId"])
    .index("by_org_created", ["orgId", "createdAt", "rowId"]),
});
