/**
 * The operator's stored credential at `~/.config/poc-vault/config.json`.
 *
 * Written with mode 0600 inside a directory forced to 0700, and `chmod`ed after
 * writing rather than trusting the create mode, since `writeFileSync`'s mode is
 * masked by the process umask.
 *
 * `resolveClientOptions` fixes the precedence every command shares: explicit
 * flags, then environment, then this file. A missing URL or key is an error
 * here rather than a request that fails later with a less useful message.
 *
 * `readVaultJson` finds the nearest `vault.json` walking up from a directory;
 * it only supplies the default `project` and `env`.
 *
 * @see {@link https://vault.buildwithfriends.dev/start/install/}
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as v from "valibot";

import { stripJsonComments } from "./jsonc.ts";

const vaultConfigSchema = v.looseObject({
  apiUrl: v.optional(v.string()),
  apiKey: v.optional(v.string()),
  project: v.optional(v.string()),
  env: v.optional(v.string()),
});
export type VaultConfig = v.InferOutput<typeof vaultConfigSchema>;

function configPath(): string {
  return join(homedir(), ".config", "poc-vault", "config.json");
}

export function readConfig(): VaultConfig {
  return readConfigAt(configPath());
}

/** Read a config file, treating absent or malformed operator state as empty. */
export function readConfigAt(path: string): VaultConfig {
  try {
    const parsed = v.safeParse(vaultConfigSchema, JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.output : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: VaultConfig): void {
  writeConfigAt(configPath(), config);
}

export function writeConfigAt(path: string, config: VaultConfig): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

type ResolveClientOptionsResult = {
  apiUrl: string;
  apiKey: string;
  project?: string;
  env?: string;
};

export function resolveClientOptions(flags: VaultConfig): ResolveClientOptionsResult {
  const stored = readConfig();
  const apiUrl = flags.apiUrl ?? process.env.VAULT_API_URL ?? stored.apiUrl;
  const apiKey = flags.apiKey ?? process.env.VAULT_API_KEY ?? stored.apiKey;
  if (apiUrl == null || apiUrl.length === 0)
    throw new Error("missing API URL (login or --api-url)");
  if (apiKey == null || apiKey.length === 0)
    throw new Error("missing API key (login or --api-key)");
  return {
    apiUrl,
    apiKey,
    project: flags.project ?? process.env.VAULT_PROJECT ?? stored.project,
    env: flags.env ?? process.env.VAULT_ENV ?? stored.env,
  };
}

const vaultJsonSchema = v.object({
  project: v.optional(v.string()),
  env: v.optional(v.string()),
});

export function readVaultJson(cwd: string): v.InferOutput<typeof vaultJsonSchema> {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const path = join(directory, "vault.json");
    if (existsSync(path)) {
      const parsed = v.safeParse(
        vaultJsonSchema,
        JSON.parse(stripJsonComments(readFileSync(path, "utf8"))),
      );
      if (!parsed.success) throw new Error(`${path} must hold string project/env`);
      return parsed.output;
    }
    if (dirname(directory) === directory) return {};
  }
}
