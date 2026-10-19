/**
 * Talks to the vault's /v1 API with the vault key this tab signed in with.
 *
 * The key lives in this tab's sessionStorage only: the page has no cookie, and
 * the key leaves the browser only in an Authorization header. The UI never asks
 * for a secret value or a parent credential back.
 */

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
  } catch {
    // Storage is off: the key lasts until the page reloads.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${storedKey()}`,
  }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  let data: { error?: string } | null = null
  try {
    data = await res.json()
  } catch {
    // Not JSON: the status says enough.
  }
  if (!res.ok) {
    if (res.status === 401) setKey(null)
    throw new ApiError(
      res.status,
      data?.error ?? `request failed (${res.status})`
    )
  }
  return data as T
}

export const enc = encodeURIComponent

/** Trade a one-time sign-in code (from `vault ui` or GitHub) for a session key. */
export async function trade(code: string) {
  const res = await fetch("/v1/ui/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    cache: "no-store",
  })
  const data = (await res.json().catch(() => null)) as {
    key?: string
    error?: string
  } | null
  if (!res.ok || !data?.key)
    throw new Error(data?.error ?? `sign-in failed (${res.status})`)
  setKey(data.key)
}

/* ---------- what the API returns ---------- */

export type Kind = "config" | "secret" | "sealed" | "minted"

export type SecretMeta = { name: string; kind: Kind; parent?: string | null }

export type KeyMeta = {
  keyPrefix: string
  label: string | null
  type: "user" | "system"
  permission: "read" | "readwrite"
  scopes: { project: string; env: string }[] | null
  expiresAt: string | null
  lastUsedAt?: string | null
  revoked?: boolean
  revokedAt?: string | null
}

export type Parent = {
  name: string
  provider: string
  config: Record<string, string>
  activeChildren: number
  updatedAt: string
}

export type Overview = {
  org: string | null
  platform: boolean
  key: KeyMeta
  projects: {
    name: string
    environments: { name: string; secrets: SecretMeta[] }[]
  }[]
  parents: Parent[] | null
}

/* ---------- words ---------- */

export const KINDS: Record<Kind, string> = {
  config: "A plain setting, like a URL. Anyone with access can read it.",
  secret: "A credential, like a database password. Apps with access read it.",
  sealed: "Only passed to a program by vault run. Nobody can read it back.",
  minted: "Holds no key. Each read makes a fresh short-lived key from a parent key.",
}

export function access(k: KeyMeta): string {
  if (k.type === "user") return "Operator: manages everything in this org"
  const verb = k.permission === "read" ? "Reads " : "Reads and writes "
  return verb + (k.scopes ?? []).map((s) => `${s.project}/${s.env}`).join(", ")
}

export function when(value: string | null | undefined): string {
  if (value == null) return "—"
  return String(value)
    .replace("T", " ")
    .replace(/\.\d+/, "")
    .replace(/Z$/, "")
    .replace(/:\d\d$/, "")
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`
}

/** Every minted secret that names this parent, as [project, env, secret]. */
export function mintedFrom(overview: Overview, parent: string) {
  const uses: [string, string, string][] = []
  for (const p of overview.projects)
    for (const e of p.environments)
      for (const s of e.secrets)
        if (s.kind === "minted" && s.parent === parent)
          uses.push([p.name, e.name, s.name])
  return uses
}
