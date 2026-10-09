/**
 * The `VaultBackend` operations as Convex functions, one per method in
 * `src/backend.ts`, with the same names and argument shapes.
 *
 * All of them are internal: nothing here is callable through the public
 * Convex client. The only way in is `http.ts`, which checks the Worker's
 * storage token and then runs exactly one of these.
 *
 * Each mutation is one Convex transaction, which is what keeps the guarantees
 * D1 got from constraints and triggers: the bootstrap claim and its key land
 * together, names stay unique, rotation is insert-and-revoke at once, and the
 * last active user key of an org cannot be revoked.
 *
 * Org-scoped functions take `orgId` and treat another org's row as absent.
 */
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { auditFields, keyFields, orgFields, secretFields, wrapFields } from "./schema";

/** Rows `pruneAudit` deletes per call; the Worker calls again while a call fills it. */
export const PRUNE_BATCH = 500;

type KeyDoc = Doc<"apiKeys">;

function wrapRow(doc: Doc<"masterKeyWraps">) {
  return {
    fingerprint: doc.fingerprint,
    wrappedDataKey: doc.wrappedDataKey,
    createdAt: doc.createdAt,
  };
}

function orgRow(doc: Doc<"orgs">) {
  return {
    id: doc.rowId,
    name: doc.name,
    wrappedDataKey: doc.wrappedDataKey,
    createdAt: doc.createdAt,
  };
}

function keyRow(doc: KeyDoc) {
  return {
    id: doc.rowId,
    orgId: doc.orgId,
    keyPrefix: doc.keyPrefix,
    keyHash: doc.keyHash,
    type: doc.type,
    labelEncrypted: doc.labelEncrypted,
    scopesEncrypted: doc.scopesEncrypted,
    permission: doc.permission,
    mode: doc.mode,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt,
    expiresAt: doc.expiresAt,
    revoked: doc.revoked,
    revokedAt: doc.revokedAt,
  };
}

function secretRow(doc: Doc<"secrets">) {
  return {
    id: doc.rowId,
    environmentId: doc.environmentId,
    keyEncrypted: doc.keyEncrypted,
    keyHash: doc.keyHash,
    valueEncrypted: doc.valueEncrypted,
    kind: doc.kind,
    updatedAt: doc.updatedAt,
  };
}

function auditRow(doc: Doc<"auditEvents">) {
  return {
    id: doc.rowId,
    orgId: doc.orgId,
    keyPrefix: doc.keyPrefix,
    action: doc.action,
    hostEncrypted: doc.hostEncrypted,
    secretNameEncrypted: doc.secretNameEncrypted,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

const { rowId: _keyRowId, ...keyRest } = keyFields;
const keyInput = v.object({ id: v.string(), ...keyRest });
const { rowId: _secretRowId, ...secretRest } = secretFields;
const secretInput = v.object({ id: v.string(), ...secretRest });
const { rowId: _auditRowId, ...auditRest } = auditFields;
const auditInput = v.object({ id: v.string(), ...auditRest });
const { rowId: _orgRowId, ...orgRest } = orgFields;
const orgInput = v.object({ id: v.string(), ...orgRest });
const namedInput = { id: v.string(), name: v.string() };

function keyDoc(key: { id: string } & Omit<KeyDoc, "_id" | "_creationTime" | "rowId">) {
  const { id, ...rest } = key;
  return { rowId: id, ...rest };
}

async function keyByPrefix(ctx: QueryCtx, keyPrefix: string) {
  return ctx.db
    .query("apiKeys")
    .withIndex("by_prefix", (q) => q.eq("keyPrefix", keyPrefix))
    .unique();
}

/** The org's key with this prefix, or null when it is absent or another org's. */
async function orgKeyByPrefix(ctx: QueryCtx, orgId: string, keyPrefix: string) {
  const doc = await keyByPrefix(ctx, keyPrefix);
  return doc != null && doc.orgId === orgId ? doc : null;
}

async function keyByHash(ctx: QueryCtx, keyHash: string) {
  return ctx.db
    .query("apiKeys")
    .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
}

/** The org's unrevoked user keys that have not expired at `now`. */
async function activeUserKeys(ctx: QueryCtx, orgId: string, now: string): Promise<number> {
  const keys = await ctx.db
    .query("apiKeys")
    .withIndex("by_org_type_revoked", (q) =>
      q.eq("orgId", orgId).eq("type", "user").eq("revoked", false),
    )
    .collect();
  return keys.filter((key) => key.expiresAt > now).length;
}

/** What the D1 `prevent_last_active_user_key` trigger refuses. */
function isLastActiveUserKey(key: KeyDoc, now: string, active: number): boolean {
  return key.type === "user" && !key.revoked && key.expiresAt > now && active <= 1;
}

async function assertNewKey(ctx: QueryCtx, key: { keyPrefix: string; keyHash: string }) {
  if ((await keyByPrefix(ctx, key.keyPrefix)) != null)
    throw new Error("UNIQUE constraint failed: apiKeys.keyPrefix");
  if ((await keyByHash(ctx, key.keyHash)) != null)
    throw new Error("UNIQUE constraint failed: apiKeys.keyHash");
}

async function environmentDoc(ctx: QueryCtx, projectId: string, name: string) {
  return ctx.db
    .query("environments")
    .withIndex("by_project_name", (q) => q.eq("projectId", projectId).eq("name", name))
    .unique();
}

async function secretDoc(ctx: QueryCtx, environmentId: string, keyHash: string) {
  return ctx.db
    .query("secrets")
    .withIndex("by_environment_hash", (q) =>
      q.eq("environmentId", environmentId).eq("keyHash", keyHash),
    )
    .unique();
}

export const findWrap = internalQuery({
  args: { fingerprint: v.string() },
  handler: async (ctx, { fingerprint }) => {
    const doc = await ctx.db
      .query("masterKeyWraps")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .unique();
    return doc == null ? null : wrapRow(doc);
  },
});

export const countWraps = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("masterKeyWraps").collect()).length,
});

export const insertWrap = internalMutation({
  args: { wrap: v.object(wrapFields) },
  handler: async (ctx, { wrap }) => {
    const existing = await ctx.db
      .query("masterKeyWraps")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", wrap.fingerprint))
      .unique();
    if (existing == null) await ctx.db.insert("masterKeyWraps", wrap);
    return null;
  },
});

export const listWraps = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("masterKeyWraps").withIndex("by_created").collect()).map(wrapRow),
});

export const deleteWrap = internalMutation({
  args: { fingerprint: v.string() },
  handler: async (ctx, { fingerprint }) => {
    const doc = await ctx.db
      .query("masterKeyWraps")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fingerprint))
      .unique();
    if (doc == null) return false;
    await ctx.db.delete(doc._id);
    return true;
  },
});

export const createOrg = internalMutation({
  args: { org: orgInput, key: keyInput },
  handler: async (ctx, { org, key }) => {
    if (key.orgId !== org.id) throw new Error("the first key must belong to the new org");
    const existing = await ctx.db
      .query("orgs")
      .withIndex("by_name", (q) => q.eq("name", org.name))
      .unique();
    if (existing != null) return false;
    await assertNewKey(ctx, key);
    const { id, ...rest } = org;
    await ctx.db.insert("orgs", { rowId: id, ...rest });
    await ctx.db.insert("apiKeys", keyDoc(key));
    return true;
  },
});

export const getOrg = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db
      .query("orgs")
      .withIndex("by_row", (q) => q.eq("rowId", id))
      .unique();
    return doc == null ? null : orgRow(doc);
  },
});

export const listOrgs = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("orgs").withIndex("by_name").collect()).map((doc) => doc.name),
});

export const insertKey = internalMutation({
  args: { key: keyInput },
  handler: async (ctx, { key }) => {
    await assertNewKey(ctx, key);
    await ctx.db.insert("apiKeys", keyDoc(key));
    return null;
  },
});

export const claimBootstrap = internalMutation({
  args: { claimedAt: v.string(), key: keyInput },
  handler: async (ctx, { claimedAt, key }) => {
    if ((await ctx.db.query("bootstrapState").first()) != null) return false;
    if ((await keyByPrefix(ctx, key.keyPrefix)) != null) return false;
    if ((await keyByHash(ctx, key.keyHash)) != null) return false;
    await ctx.db.insert("bootstrapState", { claimedAt, keyPrefix: key.keyPrefix });
    await ctx.db.insert("apiKeys", keyDoc(key));
    return true;
  },
});

export const isBootstrapped = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("bootstrapState").first()) != null,
});

export const findKeyByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const doc = await keyByHash(ctx, keyHash);
    return doc == null ? null : keyRow(doc);
  },
});

export const findKeyByPrefix = internalQuery({
  args: { orgId: v.string(), keyPrefix: v.string() },
  handler: async (ctx, { orgId, keyPrefix }) => {
    const doc = await orgKeyByPrefix(ctx, orgId, keyPrefix);
    return doc == null ? null : keyRow(doc);
  },
});

export const listKeys = internalQuery({
  args: { orgId: v.string(), includeRevoked: v.boolean() },
  handler: async (ctx, { orgId, includeRevoked }) => {
    const docs = await ctx.db
      .query("apiKeys")
      .withIndex("by_org_created", (q) => q.eq("orgId", orgId))
      .collect();
    return docs.filter((doc) => includeRevoked || !doc.revoked).map(keyRow);
  },
});

export const revokeKey = internalMutation({
  args: { orgId: v.string(), keyPrefix: v.string(), revokedAt: v.string() },
  handler: async (ctx, { orgId, keyPrefix, revokedAt }) => {
    const doc = await orgKeyByPrefix(ctx, orgId, keyPrefix);
    if (doc == null || doc.revoked) return "not_found" as const;
    if (isLastActiveUserKey(doc, revokedAt, await activeUserKeys(ctx, orgId, revokedAt)))
      return "last_user_key" as const;
    await ctx.db.patch(doc._id, { revoked: true, revokedAt });
    return "revoked" as const;
  },
});

export const rotateKey = internalMutation({
  args: { key: keyInput, revokePrefix: v.string(), revokedAt: v.string() },
  handler: async (ctx, { key, revokePrefix, revokedAt }) => {
    await assertNewKey(ctx, key);
    const current = await orgKeyByPrefix(ctx, key.orgId, revokePrefix);
    // Counted as D1 counts it: after the replacement is inserted.
    const replacementActive =
      key.type === "user" && !key.revoked && key.expiresAt > revokedAt ? 1 : 0;
    if (
      current != null &&
      isLastActiveUserKey(
        current,
        revokedAt,
        (await activeUserKeys(ctx, key.orgId, revokedAt)) + replacementActive,
      )
    )
      return "last_user_key" as const;
    await ctx.db.insert("apiKeys", keyDoc(key));
    if (current != null && !current.revoked)
      await ctx.db.patch(current._id, { revoked: true, revokedAt });
    return "rotated" as const;
  },
});

export const touchKey = internalMutation({
  args: { keyPrefix: v.string(), at: v.string() },
  handler: async (ctx, { keyPrefix, at }) => {
    const doc = await keyByPrefix(ctx, keyPrefix);
    if (doc != null) await ctx.db.patch(doc._id, { lastUsedAt: at });
    return null;
  },
});

export const createProject = internalMutation({
  args: {
    project: v.object({ ...namedInput, orgId: v.string(), createdAt: v.string() }),
    environments: v.array(v.object(namedInput)),
  },
  handler: async (ctx, { project, environments }) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_org_name", (q) => q.eq("orgId", project.orgId).eq("name", project.name))
      .unique();
    if (existing != null) return false;
    await ctx.db.insert("projects", {
      rowId: project.id,
      orgId: project.orgId,
      name: project.name,
      createdAt: project.createdAt,
    });
    const names = new Set<string>();
    for (const environment of environments) {
      if (names.has(environment.name)) throw new Error("duplicate environment name");
      names.add(environment.name);
      await ctx.db.insert("environments", {
        rowId: environment.id,
        projectId: project.id,
        name: environment.name,
        createdAt: project.createdAt,
      });
    }
    return true;
  },
});

export const listProjects = internalQuery({
  args: { orgId: v.string() },
  handler: async (ctx, { orgId }) =>
    (
      await ctx.db
        .query("projects")
        .withIndex("by_org_name", (q) => q.eq("orgId", orgId))
        .collect()
    ).map((doc) => doc.name),
});

export const getProject = internalQuery({
  args: { orgId: v.string(), name: v.string() },
  handler: async (ctx, { orgId, name }) => {
    const doc = await ctx.db
      .query("projects")
      .withIndex("by_org_name", (q) => q.eq("orgId", orgId).eq("name", name))
      .unique();
    return doc == null ? null : { id: doc.rowId, name: doc.name };
  },
});

async function deleteEnvironmentDoc(ctx: MutationCtx, environment: Doc<"environments">) {
  const secrets = await ctx.db
    .query("secrets")
    .withIndex("by_environment_hash", (q) => q.eq("environmentId", environment.rowId))
    .collect();
  for (const secret of secrets) await ctx.db.delete(secret._id);
  await ctx.db.delete(environment._id);
}

export const deleteProject = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_row", (q) => q.eq("rowId", id))
      .unique();
    if (project == null) return null;
    const environments = await ctx.db
      .query("environments")
      .withIndex("by_project_name", (q) => q.eq("projectId", id))
      .collect();
    for (const environment of environments) await deleteEnvironmentDoc(ctx, environment);
    await ctx.db.delete(project._id);
    return null;
  },
});

export const createEnvironment = internalMutation({
  args: {
    environment: v.object({ ...namedInput, projectId: v.string(), createdAt: v.string() }),
  },
  handler: async (ctx, { environment }) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_row", (q) => q.eq("rowId", environment.projectId))
      .unique();
    if (project == null) throw new Error("FOREIGN KEY constraint failed: projects");
    if ((await environmentDoc(ctx, environment.projectId, environment.name)) != null)
      return false;
    await ctx.db.insert("environments", {
      rowId: environment.id,
      projectId: environment.projectId,
      name: environment.name,
      createdAt: environment.createdAt,
    });
    return true;
  },
});

export const deleteEnvironment = internalMutation({
  args: { projectId: v.string(), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    const doc = await environmentDoc(ctx, projectId, name);
    if (doc == null) return false;
    await deleteEnvironmentDoc(ctx, doc);
    return true;
  },
});

export const listEnvironments = internalQuery({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) =>
    (
      await ctx.db
        .query("environments")
        .withIndex("by_project_name", (q) => q.eq("projectId", projectId))
        .collect()
    ).map((doc) => doc.name),
});

export const getEnvironment = internalQuery({
  args: { projectId: v.string(), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    const doc = await environmentDoc(ctx, projectId, name);
    return doc == null ? null : { id: doc.rowId, name: doc.name };
  },
});

export const listSecretRows = internalQuery({
  args: { environmentId: v.string() },
  handler: async (ctx, { environmentId }) =>
    (
      await ctx.db
        .query("secrets")
        .withIndex("by_environment_hash", (q) => q.eq("environmentId", environmentId))
        .collect()
    ).map(secretRow),
});

async function assertEnvironmentExists(ctx: QueryCtx, environmentId: string) {
  const environment = await ctx.db
    .query("environments")
    .withIndex("by_row", (q) => q.eq("rowId", environmentId))
    .unique();
  if (environment == null) throw new Error("FOREIGN KEY constraint failed: environments");
}

export const insertSecret = internalMutation({
  args: { secret: secretInput },
  handler: async (ctx, { secret }) => {
    await assertEnvironmentExists(ctx, secret.environmentId);
    if ((await secretDoc(ctx, secret.environmentId, secret.keyHash)) != null) return false;
    const { id, ...rest } = secret;
    await ctx.db.insert("secrets", { rowId: id, ...rest });
    return true;
  },
});

export const upsertSecret = internalMutation({
  args: { secret: secretInput },
  handler: async (ctx, { secret }) => {
    await assertEnvironmentExists(ctx, secret.environmentId);
    const existing = await secretDoc(ctx, secret.environmentId, secret.keyHash);
    if (existing == null) {
      const { id, ...rest } = secret;
      await ctx.db.insert("secrets", { rowId: id, ...rest });
    } else {
      await ctx.db.patch(existing._id, {
        keyEncrypted: secret.keyEncrypted,
        valueEncrypted: secret.valueEncrypted,
        kind: secret.kind,
        updatedAt: secret.updatedAt,
      });
    }
    return null;
  },
});

export const deleteSecret = internalMutation({
  args: { environmentId: v.string(), keyHash: v.string() },
  handler: async (ctx, { environmentId, keyHash }) => {
    const doc = await secretDoc(ctx, environmentId, keyHash);
    if (doc == null) return false;
    await ctx.db.delete(doc._id);
    return true;
  },
});

export const getSecretRow = internalQuery({
  args: { environmentId: v.string(), keyHash: v.string() },
  handler: async (ctx, { environmentId, keyHash }) => {
    const doc = await secretDoc(ctx, environmentId, keyHash);
    return doc == null ? null : secretRow(doc);
  },
});

export const insertAudit = internalMutation({
  args: { event: auditInput },
  handler: async (ctx, { event }) => {
    const { id, ...rest } = event;
    await ctx.db.insert("auditEvents", { rowId: id, ...rest });
    return null;
  },
});

export const listAudit = internalQuery({
  args: {
    orgId: v.string(),
    limit: v.number(),
    before: v.union(v.object({ createdAt: v.string(), id: v.string() }), v.null()),
  },
  handler: async (ctx, { orgId, limit, before }) => {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
    if (before == null) {
      return (
        await ctx.db
          .query("auditEvents")
          .withIndex("by_org_created", (q) => q.eq("orgId", orgId))
          .order("desc")
          .take(bounded)
      ).map(auditRow);
    }
    const sameInstant = await ctx.db
      .query("auditEvents")
      .withIndex("by_org_created", (q) =>
        q.eq("orgId", orgId).eq("createdAt", before.createdAt).lt("rowId", before.id),
      )
      .order("desc")
      .take(bounded);
    const earlier =
      sameInstant.length < bounded
        ? await ctx.db
            .query("auditEvents")
            .withIndex("by_org_created", (q) =>
              q.eq("orgId", orgId).lt("createdAt", before.createdAt),
            )
            .order("desc")
            .take(bounded - sameInstant.length)
        : [];
    return [...sameInstant, ...earlier].map(auditRow);
  },
});

export const pruneAudit = internalMutation({
  args: { before: v.string() },
  handler: async (ctx, { before }) => {
    const docs = await ctx.db
      .query("auditEvents")
      .withIndex("by_created", (q) => q.lt("createdAt", before))
      .take(PRUNE_BATCH);
    for (const doc of docs) await ctx.db.delete(doc._id);
    return docs.length;
  },
});
