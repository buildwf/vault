#!/usr/bin/env bun
/**
 * The `vault` operator CLI.
 *
 * Two argument forms are rejected rather than supported, both because they put
 * a credential into shell history: `--api-key <value>`, and `NAME=value` on
 * `secrets set`. Values come from hidden input, stdin, or the environment.
 * Destructive commands require `--yes`.
 *
 * `run` is the one command that spawns something. It injects every secret in
 * the project/env and strips `VAULT_API_KEY` from the child environment, so a
 * command given secrets cannot turn around and ask the vault for the rest.
 *
 * @see {@link https://vault.buildwithfriends.dev/reference/cli/}
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { serveAgentMcp } from "./agent/cli.ts";
import { VaultClient } from "./client.ts";
import { readVaultJson, resolveClientOptions, writeConfig } from "./config.ts";
import { generateMasterKey } from "./crypto.ts";
import { randomSecretValue } from "./keys.ts";
import { readSecretValue } from "./prompt.ts";
import { hookContext, wantsVaultNames } from "./hook.ts";
import * as v from "valibot";
import { SECRET_NAME, collectionTargetSchema } from "./collection-contract.ts";
import { startSecretCollection, openCollectionBrowser } from "./collection.ts";
import type {
  KeyType,
  Permission,
  ProcessEnvironment,
  Scope,
  SecretKind,
} from "./types.ts";

const options = {
  "api-url": { type: "string" },
  project: { type: "string" },
  env: { type: "string" },
  label: { type: "string" },
  type: { type: "string" },
  permission: { type: "string" },
  kind: { type: "string" },
  provider: { type: "string" },
  config: { type: "string", multiple: true },
  cursor: { type: "string" },
  scope: { type: "string", multiple: true },
  "expires-in-days": { type: "string" },
  limit: { type: "string" },
  yes: { type: "boolean" },
  random: { type: "boolean" },
  "include-revoked": { type: "boolean" },
  print: { type: "boolean" },
} as const;
const optionTypes = new Map<string, string>(
  Object.entries(options).map(([name, option]) => [name, option.type]),
);

type Flags = ReturnType<typeof parseArgv>["flags"];

/**
 * The first argument is the command unless it starts with `-`. Known options
 * may appear anywhere before `--`; an unknown option is an error. Positionals
 * and `-h`/`--help` land in `rest` for the subcommand, and `--` replaces `rest`
 * with the arguments after it.
 */
export function parseArgv(argv: string[]) {
  const first = argv[0];
  const command = first != null && !first.startsWith("-") ? first : null;
  const args = command == null ? argv : argv.slice(1);
  const { tokens } = parseArgs({
    args,
    options,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  let rest: string[] = [];
  let lastIndex = -1;
  const seen = new Map<string, string[]>();
  for (const token of tokens) {
    if (token.kind === "option-terminator") {
      rest = args.slice(token.index + 1);
      break;
    }
    if (token.kind === "option" && token.name === "api-key") {
      throw new Error("--api-key is not accepted; use VAULT_API_KEY or hidden input");
    }
    const type = token.kind === "option" ? optionTypes.get(token.name) : undefined;
    // A silently ignored flag (a typo, or a retired one like `--mode broker`)
    // would run the command with a meaning the caller did not ask for.
    if (token.kind === "option" && type == null && token.name !== "help" && token.name !== "h")
      throw new Error(`unknown option ${token.rawName}`);
    if (token.kind === "option" && type != null) {
      const value = token.value;
      if (token.name === "expires-in-days" || token.name === "limit") {
        if (value == null || !/^\d+$/u.test(value)) {
          throw new Error(`${token.rawName} requires a positive integer`);
        }
      } else if (token.name === "scope" && value == null) {
        throw new Error("--scope requires PROJECT/ENV");
      } else if (type === "string" && value == null) {
        throw new Error(`${token.rawName} requires a value`);
      }
      if (type === "boolean" && value != null) continue;
      seen.set(token.name, [...(seen.get(token.name) ?? []), value ?? ""]);
      continue;
    }
    // A short-option group such as `-abc` yields one token per letter.
    if (token.index !== lastIndex) rest.push(args[token.index]!);
    lastIndex = token.index;
  }
  const text = (name: keyof typeof options) => seen.get(name)?.at(-1);
  const integer = (name: "expires-in-days" | "limit") => {
    const value = text(name);
    return value == null ? undefined : Number(value);
  };
  return {
    command: command ?? "help",
    flags: {
      apiUrl: text("api-url"),
      project: text("project"),
      env: text("env"),
      label: text("label"),
      type: text("type"),
      permission: text("permission"),
      kind: text("kind"),
      provider: text("provider"),
      config: seen.get("config") ?? [],
      cursor: text("cursor"),
      scopes: seen.get("scope") ?? [],
      expiresInDays: integer("expires-in-days"),
      limit: integer("limit"),
      yes: seen.has("yes"),
      random: seen.has("random"),
      includeRevoked: seen.has("include-revoked"),
      print: seen.has("print"),
      rest,
    },
  };
}

function session(flags: Flags) {
  const repo = readVaultJson(process.cwd());
  // Precedence: flag, vault.json, VAULT_PROJECT/VAULT_ENV, stored config, default.
  const resolved = resolveClientOptions({
    apiUrl: flags.apiUrl,
    project: flags.project ?? repo.project,
    env: flags.env ?? repo.env,
  });
  return {
    client: new VaultClient(resolved.apiUrl, resolved.apiKey),
    project: resolved.project ?? "bwf",
    env: resolved.env ?? "dev",
  };
}

async function ensureProjectAndEnvironment(
  client: VaultClient,
  project: string,
  env: string,
): Promise<void> {
  const projects = await client.listProjects();
  if (!projects.projects.includes(project.toLowerCase()))
    await client.createProject(project);
  const environments = await client.listEnvironments(project);
  if (!environments.environments.includes(env.toLowerCase())) {
    await client.createEnvironment(project, env);
  }
}

function requireYes(flags: Flags, description: string): void {
  if (!flags.yes) throw new Error(`${description} requires --yes`);
}

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  const selected = value ?? fallback;
  const matched = allowed.find((candidate) => candidate === selected);
  if (matched === undefined) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return matched;
}

function parseScopes(values: string[]): Scope[] {
  return values.map((value) => {
    const match = /^([^/]+)\/([^/]+)$/u.exec(value);
    if (match?.[1] == null || match[2] == null) {
      throw new Error(`invalid scope ${value}; expected PROJECT/ENV`);
    }
    return { project: match[1], env: match[2] };
  });
}

const DEFAULT_CLI_IO = { log: console.log, error: console.error };

export async function runCli(argv: string[], io = DEFAULT_CLI_IO): Promise<number> {
  try {
    const { command, flags } = parseArgv(argv);
    switch (command) {
      case "help":
      case "-h":
      case "--help":
        io.log(helpText());
        return 0;
      case "mcp": {
        if (flags.rest.includes("--help") || flags.rest.includes("-h")) {
          io.log(
            "vault mcp [--project PROJECT --env ENV]\n\nLocal MCP: describe_context, collect_secret (in-chat prompt), use_secret (call APIs without seeing keys), share_access, open_panel (MCP Apps UI), get_task, cancel_task. Uses the operator login. Secret values are typed by the user into prompts or the panel and never returned to the model; share_access returns a new scoped key once, after approval. Supports form and URL elicitation and the MCP Tasks extension. Reuse request IDs to resume.",
          );
          return 0;
        }
        const { client, project, env } = session(flags);
        await serveAgentMcp(client, project, env);
        return 0;
      }
      case "init":
        return initializeLocalVaultAt(process.cwd(), io);
      case "hook":
        return await runHook(flags, io);
      case "login": {
        const apiUrl = flags.apiUrl ?? flags.rest[0] ?? process.env.VAULT_API_URL;
        if (apiUrl == null) throw new Error("usage: vault login --api-url URL");
        const apiKey = await readSecretValue(
          process.env.VAULT_API_KEY,
          process.stdin,
          process.stdout,
          "API key: ",
        );
        const repo = readVaultJson(process.cwd());
        writeConfig({
          apiUrl,
          apiKey,
          project: flags.project ?? repo.project,
          env: flags.env ?? repo.env,
        });
        io.log("saved credentials to ~/.config/poc-vault/config.json (mode 0600)");
        return 0;
      }
      case "bootstrap": {
        const apiUrl =
          flags.apiUrl ?? process.env.VAULT_API_URL ?? "http://127.0.0.1:8787";
        const bootstrapToken = await readSecretValue(
          process.env.VAULT_BOOTSTRAP_TOKEN,
          process.stdin,
          process.stdout,
          "Bootstrap token: ",
        );
        const temporary = await new VaultClient(apiUrl, "").bootstrap(
          bootstrapToken,
          "temporary bootstrap key",
        );
        const temporaryClient = new VaultClient(apiUrl, temporary.key);
        const durable = await temporaryClient.createKey({
          type: "user",
          label: flags.label ?? "primary operator",
          expiresInDays: flags.expiresInDays ?? 90,
        });
        await temporaryClient.revokeKey(temporary.prefix);
        const repo = readVaultJson(process.cwd());
        writeConfig({
          apiUrl,
          apiKey: durable.key,
          project: flags.project ?? repo.project,
          env: flags.env ?? repo.env,
        });
        io.log(`bootstrapped; saved operator key ${durable.prefix} (mode 0600)`);
        return 0;
      }
      case "orgs":
        return await runOrgs(flags, io);
      case "projects":
        return await runProjects(flags, io);
      case "environments":
      case "envs":
        return await runEnvironments(flags, io);
      case "ls":
      case "list":
        flags.rest.unshift("list");
        return await runSecrets(flags, io);
      case "get":
        flags.rest.unshift("get");
        return await runSecrets(flags, io);
      case "set":
        flags.rest.unshift("set");
        return await runSecrets(flags, io);
      case "secrets":
        return await runSecrets(flags, io);
      case "keys":
        return await runKeys(flags, io);
      case "parents":
        return await runParents(flags, io);
      case "audit": {
        const page = await session(flags).client.listAudit(
          flags.limit ?? 50,
          flags.cursor,
        );
        for (const event of page.events) io.log(JSON.stringify(event));
        if (page.nextCursor != null) io.log(`next cursor: ${page.nextCursor}`);
        return 0;
      }
      case "master-keys":
        return await runMasterKeys(flags, io);
      case "ui":
        return await openWebUi(flags, io);
      // `return await`, not `return`: a promise returned out of a `try` is not
      // caught by its `catch`.
      case "run":
        return await runInjected(flags, io);
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function initializeLocalVaultAt(
  cwd: string,
  io: { log: (value: string) => void },
): number {
  const varsPath = resolve(cwd, ".dev.vars");
  createPrivateFile(
    varsPath,
    [
      `MASTER_KEY_PRIMARY=${generateMasterKey()}`,
      `MASTER_KEY_SECONDARY=${generateMasterKey()}`,
      `BOOTSTRAP_TOKEN=${randomSecretValue()}`,
      "",
    ].join("\n"),
  );
  const vaultJson = resolve(cwd, "vault.json");
  try {
    writeFileSync(
      vaultJson,
      `${JSON.stringify({ project: "bwf", env: "dev" }, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  io.log(`wrote local root credentials to ${varsPath} (mode 0600)`);
  io.log(`vault configuration: ${vaultJson}`);
  return 0;
}

function createPrivateFile(path: string, contents: string): void {
  try {
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`${path} already exists`, { cause: error });
    }
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function runOrgs(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "list";
  const client = session(flags).client;
  if (sub === "list") {
    for (const name of (await client.listOrgs()).orgs) io.log(name);
    return 0;
  }
  const name = flags.rest[1];
  if (sub !== "create" || name == null) throw new Error("usage: vault orgs list|create NAME");
  const created = await client.createOrg(name, {
    label: flags.label,
    expiresInDays: flags.expiresInDays,
  });
  io.log(`org ${created.name}; operator key ${created.prefix} (shown once): ${created.key}`);
  return 0;
}

async function runProjects(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "list";
  const client = session(flags).client;
  if (sub === "list") {
    const projects = await client.listProjects();
    for (const name of projects.projects) io.log(name);
    return 0;
  }
  const name = flags.rest[1];
  if (name == null) throw new Error(`usage: vault projects ${sub} NAME`);
  if (sub === "create") {
    const created = await client.createProject(name);
    io.log(created.name);
    return 0;
  }
  if (sub === "delete") {
    requireYes(flags, `deleting project ${name}`);
    await client.deleteProject(name);
    io.log(`deleted project ${name}`);
    return 0;
  }
  throw new Error(`unknown projects command: ${sub}`);
}

async function runEnvironments(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "list";
  const { client, project } = session(flags);
  if (sub === "list") {
    const environments = await client.listEnvironments(project);
    for (const name of environments.environments) io.log(name);
    return 0;
  }
  const name = flags.rest[1];
  if (name == null) throw new Error(`usage: vault environments ${sub} NAME`);
  if (sub === "create") {
    const createdEnvironment = await client.createEnvironment(project, name);
    io.log(createdEnvironment.name);
    return 0;
  }
  if (sub === "delete") {
    requireYes(flags, `deleting environment ${project}/${name}`);
    await client.deleteEnvironment(project, name);
    io.log(`deleted environment ${project}/${name}`);
    return 0;
  }
  throw new Error(`unknown environments command: ${sub}`);
}

async function runSecrets(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "list";
  if (sub === "collect" && (flags.rest.includes("--help") || flags.rest.includes("-h"))) {
    io.log(
      "vault secrets collect NAME [--project PROJECT --env ENV] [--kind secret|sealed]\n\nAgents: run this command yourself when a required user-supplied secret is missing. Tell the user the form is ready and wait for the receipt; do not give them a command or ask for the value in chat. Opens a local browser form using your operator login. Enter the value in the browser, never in chat or command arguments. Creates one missing secret in an existing environment; never replaces a value. Waits up to ten minutes. Returns a JSON receipt without the secret. An unknown result must be inspected, not retried automatically. Requires the create-only Vault API.",
    );
    return 0;
  }
  const { client, project, env } = session(flags);
  if (sub === "list") {
    const meta = await client.listSecretMeta(project, env);
    for (const secret of meta.secrets) {
      io.log(`${secret.name}\t${secret.kind}`);
    }
    return 0;
  }
  const name = flags.rest[1];
  if (name == null) throw new Error(`usage: vault secrets ${sub} NAME`);
  if (name.includes("=")) {
    throw new Error("inline secret values are not accepted; use hidden input or stdin");
  }
  if (sub === "collect") {
    if (flags.rest.length !== 2 || flags.random || flags.yes)
      throw new Error(
        "usage: vault secrets collect NAME [--kind secret|sealed] [--project PROJECT --env ENV]",
      );
    const parsed = v.safeParse(collectionTargetSchema, {
      project,
      env,
      name,
      kind: flags.kind ?? "secret",
    });
    if (!parsed.success)
      throw new Error(
        "invalid collection destination or kind; use a secret name and kind secret or sealed",
      );
    const target = parsed.output;
    const meta = await client.listSecretMeta(project, env);
    if (meta.secrets.some((secret) => secret.name === name))
      throw new Error("secret already exists; collection never replaces a value");
    const collection = startSecretCollection({
      target,
      vaultOrigin: client.apiUrl,
      save: (value) => client.createCollectedSecret(target, value),
    });
    const interrupt = () => {
      void collection.stop();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      io.log(`Open this local Vault page to enter the secret: ${collection.url}`);
      if (!(await openCollectionBrowser(collection.url)))
        io.log("The browser could not be opened. Open the URL above on this machine.");
      const receipt = await collection.completed;
      io.log(JSON.stringify(receipt));
      // Keep the HTTP response alive long enough for the browser to render its receipt.
      await new Promise((done) => setTimeout(done, 1000));
      return receipt.state === "stored" ? 0 : 1;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await collection.stop();
    }
  }
  if (sub === "get") {
    const secret = await client.getSecret(project, env, name);
    io.log(secret.value);
    return 0;
  }
  if (sub === "set") {
    const kind = enumValue<SecretKind>(
      flags.kind,
      ["config", "secret", "sealed", "minted"],
      "secret",
      "--kind",
    );
    // Checked before the value prompt, so nobody types a secret the vault refuses.
    if (!SECRET_NAME.test(name))
      throw new Error("secret names are env var names: letters, digits, and _ (not starting with a digit)");
    await ensureProjectAndEnvironment(client, project, env);
    if (flags.random) {
      await client.patchSecrets(project, env, { set: [{ name, kind, random: true }] });
    } else {
      const value = await readSecretValue(undefined);
      await client.patchSecrets(project, env, { set: [{ name, value, kind }] });
    }
    io.log(name);
    return 0;
  }
  if (sub === "delete") {
    requireYes(flags, `deleting secret ${project}/${env}/${name}`);
    await client.patchSecrets(project, env, { delete: [name] });
    io.log(`deleted ${name}`);
    return 0;
  }
  throw new Error(`unknown secrets command: ${sub}`);
}

async function runKeys(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "list";
  const client = session(flags).client;
  if (sub === "list") {
    const keyList = await client.listKeys(flags.includeRevoked);
    for (const key of keyList.keys) io.log(JSON.stringify(key));
    return 0;
  }
  if (sub === "create") {
    const type = enumValue<KeyType>(flags.type, ["user", "system"], "system", "--type");
    const permission = enumValue<Permission>(
      flags.permission,
      ["read", "readwrite", "full"],
      type === "user" ? "full" : "read",
      "--permission",
    );
    const keyOptions: Parameters<typeof client.createKey>[0] = {
      type,
      label: flags.label,
      permission,
      expiresInDays: flags.expiresInDays,
    };
    if (type === "system") keyOptions.scopes = parseScopes(flags.scopes);
    const created = await client.createKey(keyOptions);
    io.log(`key ${created.prefix} (shown once): ${created.key}`);
    return 0;
  }
  const prefix = flags.rest[1];
  if (prefix == null) throw new Error(`usage: vault keys ${sub} PREFIX`);
  if (sub === "rotate") {
    const created = await client.rotateKey(prefix, flags.expiresInDays);
    io.log(`key ${created.prefix} (shown once): ${created.key}`);
    return 0;
  }
  if (sub === "revoke") {
    requireYes(flags, `revoking key ${prefix}`);
    await client.revokeKey(prefix);
    io.log(`revoked ${prefix}`);
    return 0;
  }
  throw new Error(`unknown keys command: ${sub}`);
}

async function runParents(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "list";
  const client = session(flags).client;
  if (sub === "list") {
    for (const parent of (await client.listParents()).parents) io.log(JSON.stringify(parent));
    return 0;
  }
  const name = flags.rest[1];
  if (name == null) throw new Error(`usage: vault parents ${sub} NAME`);
  if (sub === "set") {
    if (flags.provider == null) throw new Error("usage: vault parents set NAME --provider PROVIDER [--config KEY=VALUE]");
    const config: Record<string, string> = {};
    for (const entry of flags.config) {
      const match = /^([A-Za-z][A-Za-z0-9]*)=(.+)$/u.exec(entry);
      if (match?.[1] == null || match[2] == null)
        throw new Error(`invalid --config ${entry}; expected KEY=VALUE`);
      config[match[1]] = match[2];
    }
    const value = await readSecretValue(undefined, process.stdin, process.stdout, "parent key: ");
    await client.putParent(name, { provider: flags.provider, config, value });
    io.log(`parent ${name} stored; its value is never shown again`);
    return 0;
  }
  if (sub === "minted") {
    for (const minted of (await client.listMinted(name, flags.limit ?? 100)).minted)
      io.log(JSON.stringify(minted));
    return 0;
  }
  if (sub === "revoke") {
    requireYes(flags, `revoking every child key of parent ${name}`);
    io.log(JSON.stringify(await client.revokeParent(name)));
    return 0;
  }
  if (sub === "delete") {
    requireYes(flags, `deleting parent ${name}`);
    await client.deleteParent(name);
    io.log(`deleted parent ${name}`);
    return 0;
  }
  throw new Error(`unknown parents command: ${sub}`);
}

async function runMasterKeys(flags: Flags, io: { log: (value: string) => void }) {
  const sub = flags.rest[0] ?? "status";
  const client = session(flags).client;
  if (sub === "status") {
    const status = await client.listMasterKeys();
    io.log(`active ${status.activeFingerprint}`);
    for (const wrap of status.wraps) io.log(`${wrap.fingerprint}\t${wrap.createdAt}`);
    return 0;
  }
  if (sub === "prepare") {
    const prepared = await client.prepareMasterKey();
    io.log(`prepared ${prepared.fingerprint}`);
    return 0;
  }
  if (sub === "retire") {
    const fingerprint = flags.rest[1];
    if (fingerprint == null)
      throw new Error("usage: vault master-keys retire FINGERPRINT --yes");
    requireYes(flags, `retiring master-key wrap ${fingerprint}`);
    await client.retireMasterKey(fingerprint);
    io.log(`retired ${fingerprint}`);
    return 0;
  }
  throw new Error(`unknown master-keys command: ${sub}`);
}

// Anyone with a shared readwrite key can name a secret. These names would let
// that value run code as whoever calls `vault run`, so they are never injected.
// ponytail: denylist of known loader/exec variables; an allowlist of names in
// vault.json is the upgrade if shared write keys go to less trusted holders.
const UNSAFE_ENV_NAME =
  /^(PATH|HOME|SHELL|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|PERL5DB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GOFLAGS|SSL_CERT_FILE|SSL_CERT_DIR|(HTTP|HTTPS|ALL|NO)_PROXY|(LD|DYLD|GIT|NPM_CONFIG|VAULT)_.*)$/iu;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** The secrets safe to place in a child environment, and the names skipped. */
export function injectableEnv(secrets: { name: string; value: string }[]) {
  const values: Record<string, string> = {};
  const skipped: string[] = [];
  for (const { name, value } of secrets) {
    if (ENV_NAME.test(name) && !UNSAFE_ENV_NAME.test(name)) values[name] = value;
    else skipped.push(name);
  }
  return { values, skipped };
}

/** Claude Code hook: JSON event on stdin, context JSON on stdout. Never fails. */
async function runHook(flags: Flags, io: { log: (value: string) => void }) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    let names: string[] | null = null;
    // Most Bash calls report nothing; only ask the vault when there is something to say.
    if (wantsVaultNames(input)) {
      try {
        const { client, project, env } = session(flags);
        const meta = await Promise.race([
          client.listSecretMeta(project, env),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        names = meta.secrets.map((secret) => secret.name);
      } catch {
        // Not logged in or offline: still point at missing names, without vault state.
      }
    }
    const context = hookContext(input, names);
    if (context != null)
      io.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context },
        }),
      );
  } catch {
    // A hook must never break the session.
  }
  return 0;
}

async function runInjected(
  flags: Flags,
  io: { error: (value: string) => void },
): Promise<number> {
  const { client, project, env } = session(flags);
  if (flags.rest.length === 0) throw new Error("usage: vault run -- CMD");
  const { values, skipped } = injectableEnv((await client.exportSecrets(project, env)).secrets);
  for (const name of skipped)
    io.error(
      ENV_NAME.test(name)
        ? `vault run: not injecting ${name}`
        : "vault run: not injecting a secret whose name is not an env var name",
    );
  return spawnCommand(flags.rest, { ...process.env, ...values, VAULT_API_KEY: undefined });
}

/** The child's exit code; 1 when it cannot start or is killed by a signal. */
async function spawnCommand(argv: string[], env: ProcessEnvironment): Promise<number> {
  try {
    const child = Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] });
    await child.exited;
    return child.exitCode ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Open the web UI signed in as this login. The URL carries a one-time code,
 * not the key: the page trades it for a session key of its own, so the CLI's
 * key never reaches the browser.
 */
async function openWebUi(flags: Flags, io: typeof DEFAULT_CLI_IO): Promise<number> {
  const { client } = session(flags);
  const link = await client.createUiLink();
  const url = `${client.apiUrl}/ui#signin=${link.code}`;
  if (!flags.print && (await openCollectionBrowser(url))) {
    io.log(`opened ${client.apiUrl}/ui in your browser`);
    return 0;
  }
  io.log(`open this link within 2 minutes; it works once:\n${url}`);
  return 0;
}

function helpText(): string {
  return `vault

  vault bootstrap --api-url URL [--label LABEL] [--expires-in-days 90]
  vault login --api-url URL                 # hidden API-key prompt
  vault mcp                                # agent tools: list names, collect secrets
  vault orgs list|create NAME [--label LABEL] [--expires-in-days 90]   # platform operators
  vault projects list|create NAME|delete NAME --yes
  vault environments list|create NAME|delete NAME --yes
  vault secrets list|get NAME|set NAME [--kind config|secret|sealed|minted] [--random]
  vault secrets delete NAME --yes
  vault secrets collect NAME [--kind secret|sealed] # browser entry; create only
  vault keys list [--include-revoked]
  vault keys create --type system --scope PROJECT/ENV [--permission read|readwrite|full]
  vault keys rotate PREFIX | revoke PREFIX --yes
  vault parents list|set NAME --provider cloudflare|github --config KEY=VALUE   # value from hidden input or stdin
  vault parents minted NAME [--limit N] | revoke NAME --yes | delete NAME --yes
  vault audit [--limit N] [--cursor CURSOR]
  vault ui [--print]                       # open the web UI, signed in as this login
  vault master-keys status|prepare|retire FINGERPRINT --yes
  vault run -- CMD                          # injects every secret in project/env
  vault hook                               # Claude Code hook (see plugin/)
  vault init                               # local development only

Agents: when a user-supplied secret is missing, run secrets collect yourself on
the operator's machine, tell the user the form is ready, and wait for its receipt.
Do not ask for the value in chat or hand the user a command. Inspect names first;
continue only after stored. Cancelled/expired stops; unknown requires inspection.
See vault secrets collect --help. Existing interactive secrets set stays available.

Share access with a scoped system key: vault keys create --type system --scope P/E.

Parent keys: store one key per service with parents set. A minted secret's value is a
JSON spec, {"parent": NAME, "ttlMinutes": 60, ...provider fields}; every export
(vault run, use_secret) mints a fresh child key from the parent and records it.

Secret values and login/bootstrap credentials are read from hidden input or stdin.
VAULT_API_URL, VAULT_API_KEY, and VAULT_BOOTSTRAP_TOKEN are supported environment inputs.

Documentation: https://vault.buildwithfriends.dev/reference/cli/`;
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
