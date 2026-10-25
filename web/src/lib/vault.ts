// The vault's /v1 API, called with the key this tab signed in with.
// The key lives in sessionStorage only: closing the tab signs out.

const KEY = "vault.key"

export function storedKey(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setKey(value: string | null) {
  try {
    if (value == null) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, value)
  } catch {}
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${storedKey()}` }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401) setKey(null)
    throw new ApiError(res.status, data?.error ?? `request failed (${res.status})`)
  }
  return data
}

/** Trade a one-time sign-in code (from `vault ui` or GitHub) for a session key. */
export async function trade(code: string) {
  const res = await fetch("/v1/ui/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `sign-in failed (${res.status})`)
  setKey(data.key)
}

export const enc = encodeURIComponent

export type Secret = { name: string; kind: Kind; parent?: string }
export type Environment = { name: string; secrets: Secret[] }
export type Project = { name: string; environments: Environment[] }
export type Parent = {
  name: string
  provider: string
  config: Record<string, string>
  activeChildren: number
  updatedAt: string
}
export type VaultKey = {
  keyPrefix: string
  label?: string
  type: "user" | "system"
  permission?: "read" | "readwrite"
  scopes?: { project: string; env: string }[]
  expiresAt?: string
  lastUsedAt?: string
  revoked?: boolean
  revokedAt?: string
}
export type Overview = {
  key: VaultKey
  org?: string
  platform?: boolean
  projects: Project[]
  parents?: Parent[]
}

export type Kind = "secret" | "config" | "sealed" | "minted"
export const KINDS: Record<Kind, string> = {
  secret: "A credential. Apps with access read it at runtime.",
  config: "A plain setting, like a URL. Anyone with access can read it.",
  sealed: "Only injected into a process by vault run. Never returned by a read.",
  minted: "Holds no key. Each read makes a fresh short-lived key from a parent key.",
}

export const ACTIONS: Record<string, string> = {
  audit_list: "read the audit log",
  bootstrap: "bootstrapped the vault",
  broker: "used a secret through the broker",
  environment_create: "created an environment",
  environment_delete: "deleted an environment",
  get: "read secret values",
  inject: "loaded secrets into a process",
  key_create: "created a vault key",
  key_revoke: "revoked a vault key",
  key_rotate: "rotated a vault key",
  list: "listed secret names",
  master_key_prepare: "prepared a root key",
  master_key_retire: "retired a root key",
  mint: "minted a child key",
  mint_revoke: "revoked minted keys",
  org_create: "created an org",
  project_create: "created a project",
  project_delete: "deleted a project",
  parent_delete: "deleted a parent key",
  parent_set: "set a parent key",
  person_add: "added a GitHub sign-in",
  person_remove: "removed a GitHub sign-in",
  secret_delete: "deleted a secret",
  set: "wrote a secret",
  ui_signin: "signed in to this web UI",
}

export function when(value?: string | null) {
  if (value == null) return "—"
  return value.replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, "").replace(/:\d\d$/, "")
}

export function access(k: VaultKey) {
  if (k.type === "user") return "Operator (manages the whole org)"
  const verb = k.permission === "read" ? "Reads" : "Reads and writes"
  return `${verb} ${(k.scopes ?? []).map((s) => `${s.project}/${s.env}`).join(", ")}`
}

/** Every minted secret that names this parent, as [project, env, secret]. */
export function mintedFrom(overview: Overview, parent: string) {
  return overview.projects.flatMap((p) =>
    p.environments.flatMap((e) =>
      e.secrets.filter((s) => s.kind === "minted" && s.parent === parent).map((s) => [p.name, e.name, s.name] as const),
    ),
  )
}

/* Sign-in can happen in another tab (vault ui opens one), so remember for ten
   minutes where an app was sending the user, and go there after signing in. */
const NEXT = "vault.next"
export const RESUMABLE = ["connect", "approve", "collect"]

export function rememberNext(hash: string) {
  if (!RESUMABLE.some((r) => hash.startsWith(`#/${r}/`))) return
  try {
    localStorage.setItem(NEXT, JSON.stringify({ hash, at: Date.now() }))
  } catch {}
}

export function forgetNext() {
  try {
    localStorage.removeItem(NEXT)
  } catch {}
}

export function takeNext(): string | null {
  try {
    const next = JSON.parse(localStorage.getItem(NEXT) ?? "null")
    forgetNext()
    return next && Date.now() - next.at < 600_000 ? next.hash : null
  } catch {
    return null
  }
}
