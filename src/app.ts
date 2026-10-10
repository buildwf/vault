/**
 * The vault HTTP API.
 *
 * Middleware resolves the bearer token to an `ApiKeyRecord` and attaches a
 * `VaultStore` bound to that key's org before any route body runs, so every
 * route sees only its caller's org; `POST /v1/bootstrap` is the single
 * exception, authenticated instead by a constant-time comparison against the
 * Secrets Store bootstrap token.
 *
 * Every request schema is a strict object. An unknown field is a 400 rather than a
 * silently ignored key, so a caller sending a field this Worker does not
 * implement finds out immediately instead of believing it took effect.
 *
 * Authority is never decided here — routes call into `policy.ts` and let the
 * `PolicyError` it, the store, and the keyring throw carry the status out through
 * `onError`. An unrecognized error logs structurally and answers a generic 500,
 * because an internal message is a description of the vault's internals.
 *
 * Audit rows are appended on the same path as the effect they describe, so a
 * successful mutation cannot leave no trace.
 *
 * @see {@link https://vault.buildwithfriends.dev/reference/http-api/}
 */
import { Hono, type HonoRequest } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";

import { DEFAULT_ORG } from "./backend.ts";
import { Minter, PARENT_NAME, parseParent } from "./parents/minter.ts";
import { timingSafeStringEqual } from "./crypto.ts";
import { VaultStore } from "./db.ts";
import type { VaultKeyring } from "./keyring.ts";
import { bearerFrom, randomApiKey, randomSecretValue } from "./keys.ts";
import {
  PolicyError,
  assertCanReadValues,
  assertCanWrite,
  assertActiveKey,
  assertScope,
  isOperator,
  isPlatformOperator,
  valueVisibleOnGet,
} from "./policy.ts";
import {
  SECRET_NAME,
  collectedSecretSchema,
  collectionTargetSchema,
} from "./collection-contract.ts";
import {
  keyTypeSchema,
  permissionSchema,
  scopeSchema,
  secretKindSchema,
  type ApiKeyMeta,
  type ApiKeyRecord,
  type AuditAction,
  type Permission,
  type SecretKind,
} from "./types.ts";

type Variables = {
  store: VaultStore;
  key: ApiKeyRecord;
};

const nameSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
});
const createOrgSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  label: v.optional(nameSchema.entries.name),
  expiresInDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365))),
});
const bootstrapSchema = v.strictObject({
  label: v.optional(nameSchema.entries.name),
});
const expiresInDaysSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
);
const createKeySchema = v.strictObject({
  type: keyTypeSchema,
  label: v.optional(v.string()),
  permission: v.optional(permissionSchema),
  // Older CLIs send `mode: "inject"`; no new names-only (broker) keys.
  mode: v.optional(v.literal("inject")),
  scopes: v.optional(v.array(scopeSchema)),
  expiresInDays: expiresInDaysSchema,
  // Short-lived keys for agent handoff; takes precedence over days.
  expiresInMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10080)),
  ),
});
const rotateKeySchema = v.strictObject({ expiresInDays: expiresInDaysSchema });
const patchSecretsSchema = v.strictObject({
  set: v.optional(
    v.array(
      v.object({
        name: v.pipe(v.string(), v.regex(SECRET_NAME)),
        value: v.optional(v.string()),
        kind: v.optional(secretKindSchema),
        random: v.optional(v.boolean()),
      }),
    ),
  ),
  delete: v.optional(v.array(v.string())),
});
const putParentSchema = v.strictObject({
  provider: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  config: v.optional(v.record(v.string(), v.pipe(v.string(), v.maxLength(200))), {}),
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(16384)),
});
const auditCursorSchema = v.object({
  createdAt: v.string(),
  id: v.string(),
});

/**
 * Read and validate a JSON request body; any mismatch is the same generic 400.
 * With `fallback`, a missing or malformed body validates as that value instead.
 */
async function parseBody<TSchema extends v.GenericSchema>(
  schema: TSchema,
  request: HonoRequest,
  fallback?: Record<string, never>,
): Promise<v.InferOutput<TSchema>> {
  const input =
    fallback == null ? await request.json() : await request.json().catch(() => fallback);
  const result = v.safeParse(schema, input);
  if (!result.success) throw new PolicyError(400, "request body is invalid");
  return result.output;
}

type AppEnv = { Variables: Variables };

type AppOptions = {
  bootstrapToken: string;
  /** The root-key slot that is not live; `POST /v1/master-keys/prepare` wraps for it. */
  inactiveMasterKey: string;
  /** Mints child keys from parent keys; tests pass one with a fake provider transport. */
  minter?: Minter;
};

function parentName(name: string): string {
  if (!PARENT_NAME.test(name))
    throw new PolicyError(400, "parent names are lowercase letters, digits and -");
  return name;
}

/** Refuse non-operator keys with a 403 carrying the route's own message. */
function operatorOnly(message: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isOperator(c.get("key"))) throw new PolicyError(403, message);
    await next();
  });
}

/** Refuse everything but operators of the vault's own org. */
function platformOnly(message: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isPlatformOperator(c.get("key"))) throw new PolicyError(403, message);
    await next();
  });
}

export function createApp(keyring: VaultKeyring, options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const manageProjects = operatorOnly("cannot manage projects");
  const manageKeys = operatorOnly("cannot manage keys");
  const manageMasterKeys = platformOnly("cannot manage master keys");
  const manageOrgs = platformOnly("cannot manage orgs");
  const manageParents = operatorOnly("cannot manage parent keys");
  const minter = options.minter ?? new Minter();

  app.onError((error, c) => {
    if (error instanceof PolicyError) {
      return c.json({ error: error.message }, error.status);
    }
    console.error(
      JSON.stringify({
        message: "vault request failed",
        error: error instanceof Error ? error.message : "internal error",
      }),
    );
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/", async (c) => {
    const store = new VaultStore(keyring.backend, keyring.crypto);
    return c.json({
      ok: true,
      name: "bwf-vault",
      bootstrapped: await store.isBootstrapped(),
      activeMasterKeyFingerprint: keyring.activeFingerprint,
    });
  });

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/bootstrap" && c.req.method === "POST") {
      c.set("store", new VaultStore(keyring.backend, keyring.crypto));
      const provided = c.req.header("X-Vault-Bootstrap-Token");
      if (
        provided == null ||
        !(await timingSafeStringEqual(provided, options.bootstrapToken))
      ) {
        throw new PolicyError(401, "invalid bootstrap credential");
      }
      await next();
      return;
    }
    await attachKey(c, keyring);
    await next();
  });

  app.get("/v1/orgs", manageOrgs, async (c) => {
    return c.json({ orgs: await c.get("store").listOrgs() });
  });

  app.post("/v1/orgs", manageOrgs, async (c) => {
    const body = await parseBody(createOrgSchema, c.req);
    if (body.name === DEFAULT_ORG) throw new PolicyError(409, `org "${body.name}" already exists`);
    const orgKey = await keyring.newOrgKey();
    const org = new VaultStore(keyring.backend, orgKey.crypto, crypto.randomUUID());
    const generated = randomApiKey("user");
    await org.createOrg(body.name, orgKey.wrappedDataKey, {
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      label: body.label ?? "primary operator",
      expiresAt: expiresAtFromDays(body.expiresInDays ?? 90),
    });
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "org_create",
      status: "ok",
    });
    return c.json(
      { name: body.name, key: generated.plaintext, prefix: generated.prefix },
      201,
    );
  });

  app.post("/v1/bootstrap", async (c) => {
    const store = c.get("store");
    const body = await parseBody(bootstrapSchema, c.req, {});
    const generated = randomApiKey("user");
    await store.claimBootstrapKey({
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      label: body.label ?? "bootstrap",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    await store.audit({
      keyPrefix: generated.prefix,
      action: "bootstrap",
      status: "ok",
    });
    return c.json({ key: generated.plaintext, prefix: generated.prefix });
  });

  app.get("/v1/projects", async (c) => {
    return c.json({ projects: await c.get("store").listProjects() });
  });

  app.post("/v1/projects", manageProjects, async (c) => {
    const body = await parseBody(nameSchema, c.req);
    const project = await c.get("store").createProject(body.name);
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "project_create",
      status: "ok",
    });
    return c.json(project, 201);
  });

  app.delete("/v1/projects/:project", manageProjects, async (c) => {
    const deleted = await c.get("store").deleteProject(c.req.param("project"));
    if (!deleted) throw new PolicyError(404, "project not found");
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "project_delete",
      status: "ok",
    });
    return c.json({ ok: true });
  });

  app.get("/v1/projects/:project/environments", async (c) => {
    const store = c.get("store");
    const project = await store.getProject(c.req.param("project"));
    if (project == null) throw new PolicyError(404, "project not found");
    return c.json({ environments: await store.listEnvironments(project.id) });
  });

  app.post("/v1/projects/:project/environments", manageProjects, async (c) => {
    const store = c.get("store");
    const project = await store.getProject(c.req.param("project"));
    if (project == null) throw new PolicyError(404, "project not found");
    const body = await parseBody(nameSchema, c.req);
    await store.createEnvironment(project.id, body.name);
    await store.audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "environment_create",
      status: "ok",
    });
    return c.json({ name: body.name.toLowerCase() }, 201);
  });

  app.delete("/v1/projects/:project/environments/:env", manageProjects, async (c) => {
    const store = c.get("store");
    const project = await store.getProject(c.req.param("project"));
    if (project == null) throw new PolicyError(404, "project not found");
    const deleted = await store.deleteEnvironment(project.id, c.req.param("env"));
    if (!deleted) throw new PolicyError(404, "environment not found");
    await store.audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "environment_delete",
      status: "deleted",
    });
    return c.json({ ok: true });
  });

  app.get("/v1/projects/:project/environments/:env/secrets", async (c) => {
    const key = c.get("key");
    const store = c.get("store");
    const project = c.req.param("project");
    const env = c.req.param("env");
    assertScope(key, project, env);
    const { environmentId } = await store.requireEnvironment(project, env);
    const show = c.req.query("show") === "1";
    const exporting = c.req.query("export") === "1";
    if (show || exporting) assertCanReadValues(key);
    let action: AuditAction = "list";
    if (exporting) action = "inject";
    else if (show) action = "get";
    await store.audit({ keyPrefix: key.keyPrefix, action, status: "ok" });
    if (!show && !exporting) {
      return c.json({ secrets: await store.listSecretMeta(environmentId) });
    }
    let secrets = await store.listSecrets(environmentId);
    // `names` narrows an export to the secrets a caller needs, so a brokered
    // call mints only the child keys it uses.
    const names = c.req.query("names");
    if (exporting && names != null) {
      const wanted = new Set(names.split(","));
      secrets = secrets.filter((secret) => wanted.has(secret.name));
    }
    const values = new Map<string, string | undefined>();
    for (const secret of secrets) {
      if (exporting && secret.kind === "minted") {
        const label = `${project}/${env}/${secret.name}`;
        try {
          values.set(
            secret.name,
            await minter.mint(store, { value: secret.value, label, keyPrefix: key.keyPrefix }),
          );
          await store.audit({ keyPrefix: key.keyPrefix, action: "mint", status: "ok", secretName: secret.name });
        } catch (error) {
          await store.audit({ keyPrefix: key.keyPrefix, action: "mint", status: "failed", secretName: secret.name });
          throw error;
        }
        continue;
      }
      values.set(
        secret.name,
        exporting || valueVisibleOnGet(secret.kind) ? secret.value : undefined,
      );
    }
    return c.json({
      secrets: secrets.map((secret) => ({
        name: secret.name,
        kind: secret.kind,
        value: values.get(secret.name),
      })),
    });
  });

  app.get("/v1/projects/:project/environments/:env/secrets/:name", async (c) => {
    const key = c.get("key");
    const store = c.get("store");
    const project = c.req.param("project");
    const env = c.req.param("env");
    const name = c.req.param("name");
    assertScope(key, project, env);
    assertCanReadValues(key);
    const { environmentId } = await store.requireEnvironment(project, env);
    const secret = await store.getSecretByName(environmentId, name);
    if (secret == null) throw new PolicyError(404, "secret not found");
    if (!valueVisibleOnGet(secret.kind)) {
      throw new PolicyError(403, "sealed secret values are not returned");
    }
    await store.audit({
      keyPrefix: key.keyPrefix,
      action: "get",
      status: "ok",
      secretName: name,
    });
    return c.json(secret);
  });

  app.post(
    "/v1/projects/:project/environments/:env/secrets/:name",
    bodyLimit({ maxSize: 65536 }),
    operatorOnly("secret collection requires an operator login"),
    async (c) => {
      const key = c.get("key");
      assertCanWrite(key);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new PolicyError(400, "invalid secret input");
      }
      const parsed = v.safeParse(collectedSecretSchema, body);
      if (!parsed.success) throw new PolicyError(400, "invalid secret input");
      const target = v.safeParse(collectionTargetSchema, {
        ...c.req.param(),
        kind: parsed.output.kind,
      });
      if (!target.success) throw new PolicyError(400, "invalid secret destination");
      const { project, env, name, kind } = target.output;
      const store = c.get("store");
      const { environmentId } = await store.requireEnvironment(project, env);
      await store.createSecret(environmentId, name, parsed.output.value, kind);
      await store.audit({
        keyPrefix: key.keyPrefix,
        action: "set",
        status: "ok",
        secretName: name,
      });
      return c.json({ ok: true }, 201);
    },
  );

  app.patch("/v1/projects/:project/environments/:env/secrets", async (c) => {
    const key = c.get("key");
    const store = c.get("store");
    const project = c.req.param("project");
    const env = c.req.param("env");
    assertScope(key, project, env);
    assertCanWrite(key);
    const { environmentId } = await store.requireEnvironment(project, env);
    const body = await parseBody(patchSecretsSchema, c.req);
    for (const item of body.set ?? []) {
      const kind: SecretKind = item.kind ?? "secret";
      let value = item.value;
      if (item.random === true) value = randomSecretValue();
      if (value == null) throw new PolicyError(400, `missing value for ${item.name}`);
      if (kind === "minted") {
        // A spec chooses what a parent key mints, so only operators may write one.
        if (!isOperator(key)) throw new PolicyError(403, "only operators can set minted secrets");
        if (item.random === true) throw new PolicyError(400, "minted secrets cannot be random");
        await minter.validate(store, value);
      }
      await store.setSecret(environmentId, item.name, value, kind);
      await store.audit({
        keyPrefix: key.keyPrefix,
        action: "set",
        status: "ok",
        secretName: item.name,
      });
    }
    for (const name of body.delete ?? []) {
      if (await store.deleteSecret(environmentId, name)) {
        await store.audit({
          keyPrefix: key.keyPrefix,
          action: "secret_delete",
          status: "ok",
          secretName: name,
        });
      }
    }
    return c.json({ ok: true });
  });

  app.get("/v1/parents", manageParents, async (c) => {
    return c.json({ parents: await c.get("store").listParents() });
  });

  app.put("/v1/parents/:name", bodyLimit({ maxSize: 65536 }), manageParents, async (c) => {
    const key = c.get("key");
    const store = c.get("store");
    const name = parentName(c.req.param("name"));
    const body = await parseBody(putParentSchema, c.req);
    const config = await parseParent(body.provider, body.config, body.value);
    await store.setParent({ name, provider: body.provider, config, value: body.value });
    await store.audit({ keyPrefix: key.keyPrefix, action: "parent_set", status: "ok", secretName: name });
    return c.json({ ok: true });
  });

  app.delete("/v1/parents/:name", manageParents, async (c) => {
    const key = c.get("key");
    const name = parentName(c.req.param("name"));
    await c.get("store").deleteParent(name);
    await c.get("store").audit({
      keyPrefix: key.keyPrefix,
      action: "parent_delete",
      status: "ok",
      secretName: name,
    });
    return c.json({ ok: true });
  });

  app.get("/v1/parents/:name/minted", manageParents, async (c) => {
    const store = c.get("store");
    const parent = await store.getParent(parentName(c.req.param("name")));
    if (parent == null) throw new PolicyError(404, "parent not found");
    const limit = Number(c.req.query("limit") ?? "100");
    return c.json({
      minted: await store.listMinted(parent.id, Number.isInteger(limit) ? limit : 100),
    });
  });

  app.post("/v1/parents/:name/revoke", manageParents, async (c) => {
    const key = c.get("key");
    const store = c.get("store");
    const name = parentName(c.req.param("name"));
    const counts = await minter.revokeParent(store, name);
    await store.audit({
      keyPrefix: key.keyPrefix,
      action: "mint_revoke",
      status: counts.failed + counts.untraceable === 0 ? "ok" : "partial",
      secretName: name,
    });
    return c.json(counts);
  });

  app.get("/v1/keys", manageKeys, async (c) => {
    const includeRevoked = c.req.query("includeRevoked") === "1";
    const keys = await c.get("store").listKeys(includeRevoked);
    return c.json({ keys: keys.map(publicKeyMeta) });
  });

  app.post("/v1/keys", manageKeys, async (c) => {
    const body = await parseBody(createKeySchema, c.req);
    const generated = randomApiKey(body.type);
    const permission: Permission =
      body.type === "user" ? "full" : (body.permission ?? "read");
    if (body.type === "system" && (body.scopes == null || body.scopes.length === 0)) {
      throw new PolicyError(400, "system keys require scopes");
    }
    await c.get("store").insertKey({
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      type: body.type,
      permission,
      mode: body.type === "user" ? null : "inject",
      label: body.label ?? null,
      scopes: body.type === "system" ? (body.scopes ?? []) : null,
      expiresAt:
        body.expiresInMinutes == null
          ? expiresAtFromDays(body.expiresInDays ?? 90)
          : new Date(Date.now() + body.expiresInMinutes * 60 * 1000).toISOString(),
    });
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "key_create",
      status: "ok",
    });
    return c.json({ key: generated.plaintext, prefix: generated.prefix }, 201);
  });

  app.post("/v1/keys/:prefix/rotate", manageKeys, async (c) => {
    const store = c.get("store");
    const current = await store.findKeyByPrefix(c.req.param("prefix"));
    if (current == null) throw new PolicyError(404, "key not found");
    assertActiveKey(current);
    const body = await parseBody(rotateKeySchema, c.req, {});
    const generated = randomApiKey(current.type);
    await store.rotateKey(current, {
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      expiresAt: expiresAtFromDays(body.expiresInDays ?? 90),
    });
    await store.audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "key_rotate",
      status: "ok",
    });
    return c.json({ key: generated.plaintext, prefix: generated.prefix }, 201);
  });

  app.delete("/v1/keys/:prefix", manageKeys, async (c) => {
    const revoked = await c.get("store").revokeKey(c.req.param("prefix"));
    if (!revoked) throw new PolicyError(404, "key not found");
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "key_revoke",
      status: "ok",
    });
    return c.json({ ok: true });
  });

  app.get("/v1/audit", operatorOnly("cannot read audit"), async (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new PolicyError(400, "audit limit must be an integer from 1 to 200");
    }
    const cursor = decodeAuditCursor(c.req.query("cursor"));
    const events = await c.get("store").listAudit({
      limit,
      beforeCreatedAt: cursor?.createdAt,
      beforeId: cursor?.id,
    });
    const last = events.at(-1);
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "audit_list",
      status: "ok",
    });
    return c.json({
      events,
      nextCursor:
        events.length === limit && last != null
          ? encodeAuditCursor(last.createdAt, last.id)
          : null,
    });
  });

  app.get("/v1/master-keys", manageMasterKeys, async (c) => {
    return c.json({
      activeFingerprint: keyring.activeFingerprint,
      wraps: await keyring.list(),
    });
  });

  app.post("/v1/master-keys/prepare", manageMasterKeys, async (c) => {
    const fingerprint = await keyring.prepare(options.inactiveMasterKey);
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "master_key_prepare",
      status: "ok",
    });
    return c.json({ fingerprint });
  });

  app.delete("/v1/master-keys/:fingerprint", manageMasterKeys, async (c) => {
    await keyring.retire(c.req.param("fingerprint"));
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "master_key_retire",
      status: "ok",
    });
    return c.json({ ok: true });
  });

  return app;
}

/** Finds the caller's key in any org, then binds the request's store to that org. */
async function attachKey(
  c: {
    req: { header: (name: string) => string | undefined };
    set: ((key: "store", value: VaultStore) => void) &
      ((key: "key", value: ApiKeyRecord) => void);
  },
  keyring: VaultKeyring,
): Promise<void> {
  const token = bearerFrom(c.req.header("Authorization"));
  if (token == null) throw new PolicyError(401, "missing bearer token");
  const row = await keyring.backend.findKeyByHash({
    keyHash: await keyring.crypto.sha256(token),
  });
  if (row == null) throw new PolicyError(401, "invalid API key");
  const store = new VaultStore(keyring.backend, await keyring.cryptoFor(row.orgId), row.orgId);
  const key = await store.toApiKey(row);
  assertActiveKey(key);
  c.set("store", store);
  await store.touchKey(key.keyPrefix);
  c.set("key", key);
}

function expiresAtFromDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function publicKeyMeta(key: ApiKeyRecord): ApiKeyMeta {
  const { id: _id, orgId: _orgId, ...meta } = key;
  return meta;
}

function encodeAuditCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ createdAt, id }));
}

function decodeAuditCursor(
  value: string | undefined,
): { createdAt: string; id: string } | null {
  if (value == null) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    const result = v.safeParse(auditCursorSchema, parsed);
    if (result.success) return result.output;
  } catch {
    // The same generic error is returned for every malformed cursor.
  }
  throw new PolicyError(400, "invalid audit cursor");
}
