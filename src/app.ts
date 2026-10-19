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
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono, type HonoRequest } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";

import { createHostedMcp } from "./agent/hosted.ts";
import { DEFAULT_ORG } from "./backend.ts";
import { exportSecrets } from "./export.ts";
import {
  GITHUB_LOGIN,
  githubAuthorizeUrl,
  githubUserByLogin,
  githubUserFromCode,
  type GithubFetch,
  type GithubSignInConfig,
} from "./github-signin.ts";
import { Minter, PARENT_NAME, parseParent } from "./parents/minter.ts";
import { timingSafeStringEqual } from "./crypto.ts";
import { UI_CSP, UI_FILES } from "./ui/assets.ts";
import { VaultStore } from "./db.ts";
import type { VaultKeyring } from "./keyring.ts";
import { bearerFrom, randomApiKey, randomSecretValue } from "./keys.ts";
import {
  GrantApprovals,
  approve,
  approveSchema,
  authenticate,
  bearerChallenge,
  deviceRedirect,
  oauthMetadata,
  pendingApproval,
  registerSchema,
  requireClient,
  signClient,
  token,
} from "./oauth.ts";
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
const uiSessionSchema = v.strictObject({
  code: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});
/** A `vault ui` link works once, within this window. */
const UI_LINK_TTL_MS = 2 * 60 * 1000;
/** The longest a web UI session key lives; never past the key that made it. */
const UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A sign-in link made by GitHub sign-in names the GitHub account, not a key. */
const GITHUB_LINK_PREFIX = "github:";
/** Ties GitHub's callback to the browser that started the sign-in. */
const GITHUB_STATE_COOKIE = "vault_github_state";
const addPersonSchema = v.strictObject({
  login: v.pipe(v.string(), v.regex(GITHUB_LOGIN)),
});
const settleApprovalSchema = v.strictObject({
  minutes: v.picklist([0, 15, 1440, 43200]),
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
  /** The GitHub OAuth app for web UI sign-in; without it, only `vault ui` and keys sign in. */
  github?: GithubSignInConfig;
  /** Reaches GitHub; tests pass a fake. */
  githubFetch?: GithubFetch;
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A one-line page for the browser steps that are not the UI itself. */
function plainPage(message: string, status: 200 | 400 | 403 | 404 | 502 = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vault</title>` +
      `<p style="font:16px system-ui;margin:2rem;max-width:40rem">${message}</p>` +
      `<p style="font:16px system-ui;margin:2rem"><a href="/ui">Back to the vault</a></p>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'",
        "Cache-Control": "no-store",
      },
    },
  );
}

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
  const managePeople = operatorOnly("cannot manage people");
  const minter = options.minter ?? new Minter();
  const fetcher = options.githubFetch;

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
      githubSignIn: options.github != null,
      activeMasterKeyFingerprint: keyring.activeFingerprint,
    });
  });

  // The operator UI is a static SPA built from web/ (scripts/build-ui.ts): the
  // page at /ui, its hashed files at /assets. It authenticates through the API
  // like any client.
  const uiFile = (path: string) => {
    const file = UI_FILES[path];
    if (file == null) return null;
    return new Response(file.base64 ? Uint8Array.from(atob(file.body), (ch) => ch.charCodeAt(0)) : file.body, {
      headers: {
        "Content-Type": file.type,
        "Content-Security-Policy": UI_CSP,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        // Hashed asset names never change content; the page itself always revalidates.
        "Cache-Control": path.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
  app.get("/ui", () => uiFile("index.html")!);
  app.get("/ui/", (c) => c.redirect("/ui"));
  app.get("/assets/:file", (c) => uiFile(`assets/${c.req.param("file")}`) ?? c.notFound());

  // OAuth and the hosted MCP endpoint (see oauth.ts). Clients may call these
  // from a browser; they carry bearer tokens, never cookies.
  const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;
  const open = cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name", "Mcp-Session-Id", "Last-Event-ID"],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  });
  for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/mcp"]) app.use(path, open);
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(oauthMetadata(origin(c)).resource));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(oauthMetadata(origin(c)).resource));
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauthMetadata(origin(c)).server));

  app.post("/oauth/register", bodyLimit({ maxSize: 16384 }), async (c) => {
    const parsed = v.safeParse(registerSchema, await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "invalid_client_metadata", error_description: "redirect_uris must be https (or http on localhost)" },
        400,
      );
    const { clientId, client } = await signClient(keyring.crypto, parsed.output);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // Checks the request, then hands the browser to the web UI, where an
  // operator signs in and approves. The query rides in the fragment.
  app.get("/oauth/authorize", async (c) => {
    const query = c.req.query();
    const client = await requireClient(keyring.crypto, query.client_id ?? "", query.redirect_uri ?? "");
    const fail = (error: string, description: string) => {
      const back = new URL(query.redirect_uri!);
      back.searchParams.set("error", error);
      back.searchParams.set("error_description", description);
      if (query.state != null) back.searchParams.set("state", query.state);
      back.searchParams.set("iss", origin(c));
      return c.redirect(back.toString());
    };
    if (query.response_type !== "code") return fail("unsupported_response_type", "use response_type=code");
    if (query.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/u.test(query.code_challenge ?? ""))
      return fail("invalid_request", "PKCE with S256 is required");
    if (query.resource != null && query.resource.replace(/\/$/u, "") !== `${origin(c)}/mcp`)
      return fail("invalid_target", `resource must be ${origin(c)}/mcp`);
    const request = new URLSearchParams({
      client_id: query.client_id!,
      redirect_uri: query.redirect_uri!,
      code_challenge: query.code_challenge!,
      client_name: client.name,
    });
    if (query.state != null) request.set("state", query.state);
    return c.redirect(`/ui#/connect/${encodeURIComponent(request.toString())}`);
  });

  app.post("/oauth/token", bodyLimit({ maxSize: 65536 }), (c) => token(c, keyring));

  // A device login's short link, which survives chat apps that mangle long
  // URLs. The client id is deterministic, so it matches the one the CLI polls with.
  app.get("/d/:challenge", async (c) => {
    const redirectUri = deviceRedirect(origin(c));
    const { clientId } = await signClient(keyring.crypto, {
      client_name: c.req.query("n"),
      redirect_uris: [redirectUri],
    });
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: c.req.param("challenge"),
      code_challenge_method: "S256",
    });
    return c.redirect(`/oauth/authorize?${query}`);
  });

  // Where a device login's browser lands; the CLI picks up the approval itself.
  app.get("/oauth/device", (c) => {
    const error = c.req.query("error");
    const text =
      error == null
        ? "Approved. The CLI finishes signing in by itself; you can close this tab."
        : error === "access_denied"
          ? "Cancelled. The CLI was not signed in."
          : `The CLI was not signed in: ${c.req.query("error_description") ?? error}. Ask it for a new link.`;
    const escaped = text.replace(/[&<>"]/gu, (ch) => `&#${ch.charCodeAt(0)};`);
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vault</title>` +
        `<p style="font:16px system-ui;margin:2rem">${escaped}</p>`,
    );
  });

  // Sign in with GitHub. GitHub says who the person is; `github_people` says
  // which orgs they operate. The callback hands the browser one-time sign-in
  // links, exactly like `vault ui` does, so the session key never rides a URL.
  app.get("/auth/github", (c) => {
    if (options.github == null) return plainPage("GitHub sign-in is not set up on this vault.", 404);
    const state = randomSecretValue();
    setCookie(c, GITHUB_STATE_COOKIE, state, {
      path: "/auth/github",
      maxAge: 600,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    c.header("Cache-Control", "no-store");
    return c.redirect(githubAuthorizeUrl(options.github, `${origin(c)}/auth/github/callback`, state));
  });

  app.get("/auth/github/callback", async (c) => {
    const github = options.github;
    if (github == null) return plainPage("GitHub sign-in is not set up on this vault.", 404);
    const expected = getCookie(c, GITHUB_STATE_COOKIE);
    deleteCookie(c, GITHUB_STATE_COOKIE, { path: "/auth/github", secure: true });
    const { code, state, error } = c.req.query();
    if (error != null) return plainPage("GitHub sign-in was cancelled.", 400);
    if (code == null || state == null || expected == null || !(await timingSafeStringEqual(state, expected)))
      return plainPage("This sign-in started in another browser or took too long. Start again from the vault page.", 400);
    let user;
    try {
      user = await githubUserFromCode(github, code, `${origin(c)}/auth/github/callback`, fetcher);
    } catch (failure) {
      if (failure instanceof PolicyError) return plainPage(escapeHtml(failure.message), 502);
      throw failure;
    }
    const people = await keyring.backend.findGithubPerson({ githubId: user.id });
    if (people.length === 0)
      return plainPage(
        `The GitHub account <b>@${escapeHtml(user.login)}</b> is not an operator of any org here. ` +
          `An operator of your org can add it with <code>vault people add ${escapeHtml(user.login)}</code>.`,
        403,
      );
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + UI_LINK_TTL_MS).toISOString();
    const links = [];
    for (const person of people) {
      const linkCode = randomSecretValue();
      await keyring.backend.insertUiLink({
        link: {
          codeHash: await keyring.crypto.sha256(linkCode),
          orgId: person.orgId,
          keyPrefix: `${GITHUB_LINK_PREFIX}${user.id}`,
          expiresAt,
        },
        now,
      });
      const name =
        person.orgId === DEFAULT_ORG ? "platform" : ((await keyring.backend.getOrg({ id: person.orgId }))?.name ?? person.orgId);
      links.push(`${name}:${linkCode}`);
    }
    c.header("Cache-Control", "no-store");
    // One org signs straight in; several let the person pick on the page.
    return c.redirect(links.length === 1 ? `/ui#signin=${links[0]!.split(":")[1]}` : `/ui#choose=${links.join(",")}`);
  });

  app.all("/mcp", async (c) => {
    let resolved;
    try {
      resolved = await authenticate(keyring, c.req.header("Authorization"));
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      return c.json({ error: error.message }, 401, {
        "WWW-Authenticate": bearerChallenge(origin(c), c.req.header("Authorization") ? "invalid_token" : undefined),
      });
    }
    const { grant, crypto, store, key } = resolved;
    const approvals = new GrantApprovals(keyring.backend, crypto, grant);
    const handler = createMcpHandler(() =>
      createHostedMcp({ store, key, approvals, minter, origin: origin(c) }),
    );
    return handler.fetch(c.req.raw, {
      authInfo: {
        token: bearerFrom(c.req.header("Authorization"))!,
        clientId: grant.clientId,
        scopes: ["vault:use"],
        expiresAt: Math.floor(Date.parse(grant.accessExpiresAt) / 1000),
        resource: new URL(`${origin(c)}/mcp`),
      },
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
    // The browser's half of `vault ui`: the one-time code is its credential.
    if (c.req.path === "/v1/ui/session" && c.req.method === "POST") {
      await next();
      return;
    }
    await attachKey(c, keyring);
    await next();
  });

  // `vault ui` asks for a one-time code for its own key, then opens the browser
  // on /ui with the code in the fragment, which never reaches a server log.
  app.post("/v1/ui/links", async (c) => {
    const code = randomSecretValue();
    const expiresAt = new Date(Date.now() + UI_LINK_TTL_MS).toISOString();
    await keyring.backend.insertUiLink({
      link: {
        codeHash: await keyring.crypto.sha256(code),
        orgId: c.get("store").orgId,
        keyPrefix: c.get("key").keyPrefix,
        expiresAt,
      },
      now: new Date().toISOString(),
    });
    return c.json({ code, expiresAt }, 201);
  });

  // The page trades the code for a session key with the same type, permission
  // and scopes as the key that made the link, which expires within hours.
  app.post("/v1/ui/session", async (c) => {
    const body = await parseBody(uiSessionSchema, c.req);
    const link = await keyring.backend.takeUiLink({
      codeHash: await keyring.crypto.sha256(body.code),
    });
    if (link == null || Date.parse(link.expiresAt) <= Date.now()) {
      throw new PolicyError(401, "sign-in link is used or expired; run vault ui again");
    }
    const store = new VaultStore(keyring.backend, await keyring.cryptoFor(link.orgId), link.orgId);
    if (link.keyPrefix.startsWith(GITHUB_LINK_PREFIX)) {
      // A GitHub person is an operator of the org for as long as they are listed.
      const githubId = link.keyPrefix.slice(GITHUB_LINK_PREFIX.length);
      const person = (await keyring.backend.findGithubPerson({ githubId })).find((p) => p.orgId === link.orgId);
      if (person == null) throw new PolicyError(401, "this GitHub account is no longer an operator of this org");
      const generated = randomApiKey("user");
      const expiresAt = new Date(Date.now() + UI_SESSION_TTL_MS).toISOString();
      await store.insertKey({
        plaintext: generated.plaintext,
        prefix: generated.prefix,
        type: "user",
        permission: "full",
        mode: null,
        label: `web ui (GitHub @${person.githubLogin})`,
        scopes: null,
        expiresAt,
      });
      await store.audit({ keyPrefix: generated.prefix, action: "ui_signin", status: "ok", host: `github.com/${person.githubLogin}` });
      return c.json({ key: generated.plaintext, prefix: generated.prefix, expiresAt }, 201);
    }
    const parent = await store.findKeyByPrefix(link.keyPrefix);
    if (parent == null) throw new PolicyError(401, "invalid API key");
    assertActiveKey(parent);
    const generated = randomApiKey(parent.type);
    const expiresAt = new Date(
      Math.min(Date.parse(parent.expiresAt), Date.now() + UI_SESSION_TTL_MS),
    ).toISOString();
    await store.insertKey({
      plaintext: generated.plaintext,
      prefix: generated.prefix,
      type: parent.type,
      permission: parent.permission,
      mode: parent.mode,
      label: `web ui (${parent.label ?? parent.keyPrefix})`,
      scopes: parent.scopes,
      expiresAt,
    });
    await store.audit({ keyPrefix: parent.keyPrefix, action: "ui_signin", status: "ok" });
    return c.json({ key: generated.plaintext, prefix: generated.prefix, expiresAt }, 201);
  });

  // GitHub accounts that sign in to the web UI as operators of this org.
  app.get("/v1/people", managePeople, async (c) => {
    const people = await keyring.backend.listGithubPeople({ orgId: c.get("store").orgId });
    return c.json({
      githubSignIn: options.github != null,
      people: people.map((p) => ({ login: p.githubLogin, githubId: p.githubId, addedBy: p.addedBy, createdAt: p.createdAt })),
    });
  });

  app.post("/v1/people", managePeople, async (c) => {
    const body = await parseBody(addPersonSchema, c.req);
    const user = await githubUserByLogin(body.login, fetcher);
    if (user == null) throw new PolicyError(404, `there is no GitHub account named ${body.login}`);
    const key = c.get("key");
    const store = c.get("store");
    const added = await keyring.backend.putGithubPerson({
      person: {
        orgId: store.orgId,
        githubId: user.id,
        githubLogin: user.login,
        addedBy: key.keyPrefix,
        createdAt: new Date().toISOString(),
      },
    });
    await store.audit({ keyPrefix: key.keyPrefix, action: "person_add", status: "ok", host: `github.com/${user.login}` });
    return c.json({ login: user.login, githubId: user.id }, added ? 201 : 200);
  });

  app.delete("/v1/people/:login", managePeople, async (c) => {
    const login = c.req.param("login");
    const store = c.get("store");
    if (!(await keyring.backend.deleteGithubPerson({ orgId: store.orgId, githubLogin: login })))
      throw new PolicyError(404, `${login} is not in this org`);
    await store.audit({ keyPrefix: c.get("key").keyPrefix, action: "person_remove", status: "ok", host: `github.com/${login}` });
    return c.json({ removed: login });
  });

  // Everything the UI's home page explains: who the caller is, and every
  // project, environment and secret name it can see. Never a value.
  app.get("/v1/overview", async (c) => {
    const key = c.get("key");
    const store = c.get("store");
    const org =
      store.orgId === DEFAULT_ORG ? null : ((await keyring.backend.getOrg({ id: store.orgId }))?.name ?? null);
    const projects = [];
    for (const name of await store.listProjects()) {
      const project = await store.getProject(name);
      if (project == null) continue;
      const environments = [];
      for (const env of await store.listEnvironments(project.id)) {
        if (!inScope(key, name, env)) continue;
        const { environmentId } = await store.requireEnvironment(name, env);
        environments.push({ name: env, secrets: await store.listSecretMeta(environmentId) });
      }
      if (isOperator(key) || environments.length > 0) projects.push({ name, environments });
    }
    await store.audit({ keyPrefix: key.keyPrefix, action: "list", status: "ok" });
    return c.json({
      org,
      platform: isPlatformOperator(key),
      key: publicKeyMeta(key),
      projects,
      parents: isOperator(key) ? await store.listParents() : null,
    });
  });

  // The web UI's half of OAuth: who is asking, then the operator's answer.
  const manageConnections = operatorOnly("only operators can connect apps");
  app.get("/v1/oauth/client", manageConnections, async (c) => {
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const client = await requireClient(keyring.crypto, c.req.query("client_id") ?? "", redirectUri);
    return c.json({ name: client.name, redirectUri });
  });

  app.post("/v1/oauth/approve", manageConnections, async (c) => {
    const body = await parseBody(approveSchema, c.req);
    return c.json({ redirect: await approve(keyring, c.get("store"), c.get("key"), origin(c), body) });
  });

  app.get("/v1/oauth/approvals/:id", manageConnections, async (c) => {
    const { pending, client } = await pendingApproval(keyring, c.get("store").orgId, c.req.param("id"));
    return c.json({
      client,
      project: pending.project,
      env: pending.env,
      names: pending.names,
      host: pending.host,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    });
  });

  app.post("/v1/oauth/approvals/:id", manageConnections, async (c) => {
    const body = await parseBody(settleApprovalSchema, c.req);
    const { approvals } = await pendingApproval(keyring, c.get("store").orgId, c.req.param("id"));
    await approvals.settle(c.req.param("id"), body.minutes);
    await c.get("store").audit({
      keyPrefix: c.get("key").keyPrefix,
      action: "oauth_approve",
      status: body.minutes > 0 ? "ok" : "denied",
    });
    return c.json({ ok: true });
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
    // `names` narrows an export to the secrets a caller needs, so a brokered
    // call mints only the child keys it uses.
    const names = c.req.query("names");
    const secrets = exporting
      ? await exportSecrets(store, minter, key, project, env, names?.split(","))
      : (await store.listSecrets(environmentId)).map((secret) => ({
          ...secret,
          value: valueVisibleOnGet(secret.kind) ? secret.value : undefined,
        }));
    return c.json({
      secrets: secrets.map(({ name, kind, value }) => ({ name, kind, value })),
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

function inScope(key: ApiKeyRecord, project: string, env: string): boolean {
  try {
    assertScope(key, project, env);
    return true;
  } catch {
    return false;
  }
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
