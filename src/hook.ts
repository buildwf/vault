/**
 * `vault hook`: Claude Code hook handler.
 *
 * SessionStart tells the agent which secret names exist. PostToolUse on Bash
 * reads the command's error output (stderr, or the failure message) for
 * "missing environment variable" errors and tells the agent how to fix each
 * one: collect it, or rerun under `vault run`. Stdout is ignored: a `grep` or
 * `cat` of docs that mention "X is not set" is not an error.
 *
 * A hook must never break the session, so every failure is silent.
 */
import { SECRET_NAME } from "./collection-contract.ts";

const NAME = "[A-Z][A-Z0-9_]{2,}";
// Patterns with the `i` flag (for their keywords) also match lowercase words
// in the NAME group, so every capture is re-checked case-sensitively.
const UPPER_NAME = /^[A-Z][A-Z0-9_]{2,}$/u;
// ponytail: regexes for the common error shapes (dotenv/zod/t3-env, Node,
// Python, shell); add a shape when a real error slips through.
const PATTERNS = [
  // A bare "X is required" names a secret only when X looks like one (has an
  // underscore); "URL is required" or "JSON is empty" are ordinary messages.
  new RegExp(`\\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\\b[\`'"]?\\s+(?:is|was|are)\\s+(?:not set|not defined|undefined|missing|required|empty|unset)`, "gu"),
  new RegExp(`\\b(${NAME})\\s+(?:env(?:ironment)?\\s+)?var(?:iable)?\\s+(?:is|was)\\s+(?:not set|missing|undefined|empty|required)`, "gu"),
  new RegExp(`(?:missing|required|undefined|unset|no)\\s+(?:required\\s+)?(?:env(?:ironment)?\\s+var(?:iable)?s?|secrets?|keys?)[\\s:]*[\`'"]?(${NAME})\\b`, "giu"),
  new RegExp(`(?:env(?:ironment)?\\s+var(?:iable)?|secret)\\s+[\`'"]?(${NAME})\\b[\`'"]?\\s+(?:is\\s+)?(?:not set|not found|missing|undefined|required)`, "giu"),
  new RegExp(`KeyError:\\s*'(${NAME})'`, "gu"),
  new RegExp(`\\b(${NAME})\\b["']?:\\s*\\[\\s*["']Required["']`, "gu"),
  new RegExp(`process\\.env\\.(${NAME})\\b[^\\n]{0,40}\\bundefined`, "gu"),
  new RegExp(`\\b(${NAME})\\}?:\\s*(?:parameter (?:null or )?not set|unbound variable)`, "gu"),
];
const NOT_SECRETS = new Set(["ERROR", "WARN", "WARNING", "INFO", "DEBUG", "NODE_ENV", "PATH", "HOME"]);

/** Env-var names an error message says are missing, in first-seen order. */
export function missingEnvNames(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name != null && UPPER_NAME.test(name) && !NOT_SECRETS.has(name)) found.add(name);
    }
  return [...found];
}

/** Every string inside a hook payload, one per line. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object")
    return Object.values(value).map(textOf).join("\n");
  return "";
}

/** The error text of a Bash call: its stderr and any failure message. */
function errorText(input: HookInput): string {
  const response = input.tool_response;
  const stderr =
    response != null && typeof response === "object" && "stderr" in response
      ? response.stderr
      : undefined;
  return textOf([stderr, input.error]);
}

/** True when the hook has something to say that depends on vault state. */
export function wantsVaultNames(input: HookInput): boolean {
  if (input.hook_event_name === "SessionStart") return true;
  return input.tool_name === "Bash" && missingEnvNames(errorText(input)).length > 0;
}

/** `vault run -- CMD`, wrapped in `bash -c` when CMD uses shell syntax
 * (operators, newlines, or a leading `VAR=value`). */
function underVault(command: string): string {
  return /[;&|<>`$()\n]|^\s*[A-Za-z_][A-Za-z0-9_]*=/u.test(command)
    ? `vault run -- bash -c '${command.replaceAll("'", "'\\''")}'`
    : `vault run -- ${command}`;
}

/** What to tell the agent about one missing variable. */
function missingLine(
  name: string,
  vaultNames: string[] | null,
  command: string,
): string {
  if (vaultNames == null)
    return `- ${name}: if it is in the vault, rerun under \`vault run --\`; otherwise call collect_secret with name "${name}".`;
  if (!vaultNames.includes(name))
    return `- ${name} is not in the vault: call collect_secret with name "${name}" (the user types it in a prompt), then rerun under \`vault run --\`.`;
  if (/\bvault run\b/u.test(command))
    return `- ${name} is in the vault but was not injected (unsafe name, or a different --project/--env).`;
  return `- ${name} is in the vault: rerun as \`${underVault(command)}\`.`;
}

type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
  tool_response?: unknown;
  error?: unknown;
};

/** The context to inject for one hook event, or null for none. */
export function hookContext(input: HookInput, names: string[] | null): string | null {
  // A name is text a shared write key controls; only env-var-shaped names reach the agent.
  const vaultNames = names?.filter((name) => SECRET_NAME.test(name)) ?? null;
  if (input.hook_event_name === "SessionStart") {
    if (vaultNames == null) return null;
    return vaultNames.length === 0
      ? "Vault: no secrets stored for this project/env yet. Ask for missing ones with the vault collect_secret tool; never ask for values in chat."
      : `Vault secrets available (names only): ${vaultNames.join(", ")}. Run commands that need them with \`vault run -- CMD\`, or call APIs without seeing keys via the vault use_secret tool. Ask for missing ones with collect_secret; never ask for values in chat.`;
  }
  if (input.tool_name !== "Bash") return null;
  const missing = missingEnvNames(errorText(input));
  if (missing.length === 0) return null;
  const command = input.tool_input?.command ?? "";
  const lines = missing.map((name) => missingLine(name, vaultNames, command));
  return `Vault noticed missing environment variables:\n${lines.join("\n")}`;
}
