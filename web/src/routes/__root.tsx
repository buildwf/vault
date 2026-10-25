import { useEffect, useState } from "react"
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  redirect,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router"

import appCss from "../styles.css?url"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ErrorAlert, Page } from "@/components/vault"
import {
  ApiError,
  RESUMABLE,
  api,
  rememberNext,
  setKey,
  storedKey,
  takeNext,
  trade,
  type Overview,
} from "@/lib/vault"

/* `vault ui` and GitHub sign-in open /ui#signin=CODE, or #choose=org:CODE,...
   when one GitHub account runs several orgs. A code works once, so take it out
   of the address bar and history before the router reads the hash. */
let signinCode: string | null = null
let signinError: unknown = null
let orgChoices: [string, string][] | null = null
if (typeof window !== "undefined") {
  const code = /^#signin=([0-9a-f]+)$/.exec(location.hash)
  const choose = /^#choose=([a-z0-9:,-]+)$/.exec(location.hash)
  if (code) signinCode = code[1]
  if (choose) orgChoices = choose[1].split(",").map((pair) => pair.split(":") as [string, string])
  if (code || choose) history.replaceState(null, "", `${location.pathname}#/`)
  // A sign-in link opened in a tab that already shows the page: start over.
  addEventListener("hashchange", () => /^#(signin|choose)=/.test(location.hash) && location.reload())
}

class SignInNeeded extends Error {}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "referrer", content: "no-referrer" },
      { title: "Vault" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  // One request says who you are and everything you can see; every page uses it.
  beforeLoad: async (): Promise<{ overview: Overview }> => {
    // The build prerenders an empty shell; Layout reloads in the browser.
    if (typeof window === "undefined") return { overview: null as never }
    if (orgChoices) throw new SignInNeeded()
    if (signinCode) {
      const code = signinCode
      signinCode = null
      try {
        await trade(code)
        const next = takeNext()
        if (next) throw redirect({ to: next.slice(1) })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        signinError = error
      }
    }
    if (!storedKey()) throw new SignInNeeded()
    try {
      return { overview: await api<Overview>("GET", "/v1/overview") }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        signinError = error
        throw new SignInNeeded()
      }
      throw error
    }
  },
  component: Layout,
  errorComponent: ({ error }) => {
    if (orgChoices) return <ChooseOrg choices={orgChoices} />
    if (error instanceof SignInNeeded) return <SignIn />
    return (
      <Frame>
        <Page title="Something went wrong">
          <ErrorAlert error={error} />
        </Page>
      </Frame>
    )
  },
  notFoundComponent: () => (
    <Page title="Not found">
      <div>
        <Button asChild variant="outline">
          <Link to="/">Back to the overview</Link>
        </Button>
      </div>
    </Page>
  ),
  shellComponent: RootDocument,
})

export function useOverview() {
  return useRouteContext({ from: "__root__" }).overview
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function Frame({ children, nav }: { children: React.ReactNode; nav?: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 p-4 text-sm md:p-8">
      <header className="flex flex-wrap items-center gap-2">
        <Link to="/" className="mr-4 font-medium">
          Vault
        </Link>
        {nav}
      </header>
      <Separator />
      <main>{children}</main>
    </div>
  )
}

function Layout() {
  const overview = useOverview()
  const router = useRouter()
  useEffect(() => {
    if (!overview) router.invalidate()
  }, [overview, router])
  if (!overview) return null
  const operator = overview.key.type === "user"
  const items: [string, string][] = [
    ["/", "Overview"],
    ["/projects", "Projects"],
  ]
  if (overview.parents) items.push(["/parents", "Parent keys"])
  if (operator) items.push(["/keys", "Vault keys"], ["/audit", "Audit"])
  if (overview.platform) items.push(["/orgs", "Orgs"])
  return (
    <Frame
      nav={
        <>
          {items.map(([to, label]) => (
            <Button key={to} asChild variant="ghost" size="sm">
              <Link to={to} activeOptions={{ exact: to === "/" }} activeProps={{ "aria-current": "page", className: "bg-muted" }}>
                {label}
              </Link>
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setKey(null)
              router.navigate({ to: "/" }).then(() => router.invalidate())
            }}
          >
            Sign out
          </Button>
        </>
      }
    >
      <Outlet />
    </Frame>
  )
}

function SignIn() {
  const router = useRouter()
  const [error, setError] = useState<unknown>(signinError)
  const [github, setGithub] = useState(false)
  const [resuming, setResuming] = useState(false)
  useEffect(() => {
    signinError = null
    setResuming(RESUMABLE.some((r) => location.hash.startsWith(`#/${r}/`)))
    rememberNext(location.hash)
    // The GitHub button shows only when this vault has a GitHub app set up.
    fetch("/", { cache: "no-store" })
      .then((res) => res.json())
      .then((info) => setGithub(Boolean(info?.githubSignIn)))
      .catch(() => {})
  }, [])
  return (
    <div className="flex min-h-svh items-center justify-center p-4 text-sm">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to Vault</CardTitle>
          <CardDescription>
            {resuming ? "An app is asking to use this vault. Sign in to continue." : "Secrets for your apps and agents."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {github && (
              <>
                <Button onClick={() => (location.href = "/auth/github")}>Sign in with GitHub</Button>
                <FieldSeparator>or</FieldSeparator>
              </>
            )}
            <form
              onSubmit={async (event) => {
                event.preventDefault()
                const input = event.currentTarget.elements.namedItem("key") as HTMLInputElement
                setKey(input.value.trim())
                try {
                  await api("GET", "/v1/overview")
                  await router.invalidate()
                } catch (e) {
                  setKey(null)
                  setError(e)
                }
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="key">Vault key</FieldLabel>
                  <Input id="key" name="key" type="password" autoComplete="off" required />
                  <FieldDescription>
                    Kept in this tab only. Or run <code>vault ui</code> in a terminal to open this page signed in.
                  </FieldDescription>
                </Field>
                <ErrorAlert error={error} />
                <Button type="submit" variant={github ? "outline" : "default"}>
                  Sign in
                </Button>
              </FieldGroup>
            </form>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  )
}

/* A GitHub account that operates several orgs gets one code per org. */
function ChooseOrg({ choices }: { choices: [string, string][] }) {
  const router = useRouter()
  return (
    <div className="flex min-h-svh items-center justify-center p-4 text-sm">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose an org</CardTitle>
          <CardDescription>Your GitHub account runs more than one org. These choices work for two minutes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {choices.map(([org, code]) => (
            <Button
              key={org}
              variant="outline"
              onClick={() => {
                orgChoices = null
                signinCode = code
                router.invalidate()
              }}
            >
              {org}
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
