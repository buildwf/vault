import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
} from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { ErrorAlert, PageHeader, Pending } from "@/components/page"
import { ApiError, api, setKey, storedKey } from "@/lib/api"
import type { Overview } from "@/lib/api"
import { rememberNext } from "@/lib/session"

/** Every page behind sign-in. One request says who you are and what you can see. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    if (storedKey() == null) {
      rememberNext(location.pathname)
      throw redirect({ to: "/signin", search: { error: undefined } })
    }
    try {
      const overview = await api<Overview>("GET", "/v1/overview")
      return { overview }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        rememberNext(location.pathname)
        throw redirect({ to: "/signin", search: { error: error.message } })
      }
      throw error
    }
  },
  pendingComponent: () => (
    <Layout>
      <Pending />
    </Layout>
  ),
  errorComponent: ({ error }) => (
    <Layout>
      <PageHeader title="Something went wrong" />
      <ErrorAlert error={error} />
    </Layout>
  ),
  component: function AppLayout() {
    const { overview } = Route.useRouteContext()
    return (
      <Layout overview={overview}>
        <Outlet />
      </Layout>
    )
  },
})

function Layout({
  overview,
  children,
}: {
  overview?: Overview
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <Header ov={overview} />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8">
        {children}
      </main>
    </div>
  )
}

function Header({ ov }: { ov?: Overview }) {
  const router = useRouter()
  const operator = ov?.key.type === "user"
  const links: { to: string; label: string }[] = [
    { to: "/", label: "Overview" },
    { to: "/projects", label: "Projects" },
  ]
  if (ov?.parents) links.push({ to: "/parents", label: "Parent keys" })
  if (operator) links.push({ to: "/keys", label: "Access" }, { to: "/audit", label: "Audit" })
  if (ov?.platform) links.push({ to: "/orgs", label: "Orgs" })

  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link to="/" className="flex items-baseline gap-2">
          <span className="font-heading text-sm font-semibold">Vault</span>
          {ov ? (
            <span className="text-xs text-muted-foreground">
              {ov.platform ? "platform" : ov.org}
            </span>
          ) : null}
        </Link>
        {ov ? (
          <nav aria-label="Sections" className="flex flex-wrap items-center gap-1">
            {links.map((link) => (
              <Button key={link.to} variant="ghost" size="sm" asChild>
                <Link
                  to={link.to as "/"}
                  activeOptions={{ exact: link.to === "/" }}
                  activeProps={{ className: "bg-muted text-foreground", "aria-current": "page" }}
                  inactiveProps={{ className: "text-muted-foreground" }}
                >
                  {link.label}
                </Link>
              </Button>
            ))}
          </nav>
        ) : null}
        {ov ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={async () => {
              setKey(null)
              await router.navigate({ to: "/signin", search: { error: undefined } })
            }}
          >
            Sign out
          </Button>
        ) : null}
      </div>
    </header>
  )
}
