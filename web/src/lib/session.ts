/**
 * Sign-in plumbing that happens around the router.
 *
 * `vault ui` and Sign in with GitHub open /ui#signin=CODE, or #choose=org:CODE,…
 * when one GitHub account operates several orgs. A code works once, so boot()
 * takes it out of the address bar and history before the router sees it.
 */

let pendingCode: string | null = null
let pendingChoices: [string, string][] | null = null

export function boot() {
  const signin = /^#signin=([0-9a-f]+)$/.exec(location.hash)
  const choose = /^#choose=([a-z0-9:,-]+)$/.exec(location.hash)
  if (signin) pendingCode = signin[1]
  if (choose)
    pendingChoices = choose[1]
      .split(",")
      .map((pair) => pair.split(":") as [string, string])
  if (signin || choose)
    history.replaceState(null, "", location.pathname + (choose ? "#/choose" : "#/signing-in"))
}

export function takeCode(): string | null {
  const code = pendingCode
  pendingCode = null
  return code
}

export function choices(): [string, string][] {
  return pendingChoices ?? []
}

/*
 * An app (Claude, the CLI) can send someone to connect, approve or collect
 * before they are signed in, and sign-in can finish in another tab. So
 * remember where they were going for ten minutes and go there afterwards.
 */
const NEXT = "vault.next"
const RESUMABLE = ["/connect", "/approve", "/collect"]

export function rememberNext(path: string) {
  if (!RESUMABLE.some((p) => path.startsWith(p))) return
  try {
    localStorage.setItem(NEXT, JSON.stringify({ path, at: Date.now() }))
  } catch {
    // No storage: they land on the overview instead.
  }
}

export function forgetNext() {
  try {
    localStorage.removeItem(NEXT)
  } catch {
    // Nothing to forget.
  }
}

export function hasNext(): boolean {
  return peekNext() != null
}

function peekNext(): string | null {
  try {
    const next = JSON.parse(localStorage.getItem(NEXT) ?? "null") as {
      path: string
      at: number
    } | null
    return next && Date.now() - next.at < 600_000 ? next.path : null
  } catch {
    return null
  }
}

export function takeNext(): string | null {
  const next = peekNext()
  forgetNext()
  return next
}
