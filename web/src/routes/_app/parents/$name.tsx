import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"

import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ConfirmButton, EmptyState, PageHeader } from "@/components/page"
import { Facts } from "@/components/facts"
import { api, enc, mintedFrom, when } from "@/lib/api"

type Minted = {
  label: string
  status: string
  createdAt: string
  expiresAt: string | null
  revokedAt: string | null
  keyPrefix: string | null
}

const STATUSES: Record<string, string> = {
  active: "Live at the service until it expires.",
  expired: "Past its lifetime; dead at the service.",
  revoked: "Killed at the service.",
  pending: "Being made; the service hasn't answered yet.",
  unknown: "The service's answer was lost. It may be live, so revoking treats it as live.",
  failed: "The service refused it; it never worked.",
}

export const Route = createFileRoute("/_app/parents/$name")({
  beforeLoad: ({ context, params }) => {
    const parent = context.overview.parents?.find((p) => p.name === params.name)
    if (!parent) throw notFound()
    return { parent }
  },
  loader: ({ params }) =>
    api<{ minted: Minted[] }>("GET", `/v1/parents/${enc(params.name)}/minted`),
  component: ParentKey,
})

function ParentKey() {
  const { overview, parent } = Route.useRouteContext()
  const { minted } = Route.useLoaderData()
  const router = useRouter()
  const name = parent.name
  const uses = mintedFrom(overview, name)
  const seen = Object.keys(STATUSES).filter((s) => minted.some((m) => m.status === s))

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/parents">Parent keys</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={name}>
        A {parent.provider} credential kept in the vault. Apps never see it;
        they get short-lived keys made from it, listed below.
      </PageHeader>

      <Card>
        <CardContent>
          <Facts
            items={[
              ["Service", parent.provider],
              [
                "Settings",
                Object.entries(parent.config).map(([k, v]) => `${k}=${v}`).join(" ") || "—",
              ],
              ["Credential", "Stored encrypted. Write-only."],
              ["Live keys now", parent.activeChildren],
              ["Updated", when(parent.updatedAt)],
              [
                "Used by",
                uses.length === 0
                  ? "No minted secrets yet"
                  : uses.map((u, i) => (
                      <span key={u.join("/")}>
                        {i > 0 ? ", " : ""}
                        <Link
                          to="/projects/$project/$env"
                          params={{ project: u[0], env: u[1] }}
                          className="hover:underline"
                        >
                          {`${u[0]}/${u[1]} ${u[2]}`}
                        </Link>
                      </span>
                    )),
              ],
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keys made from {name}</CardTitle>
          <CardDescription>
            Newest first. Each row is one key handed to an app or agent. The
            key itself is never stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {minted.length === 0 ? (
            <EmptyState title="No keys made yet">
              One shows up here the first time an app reads a minted secret
              that names {name}.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>For</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Made</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Service id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {minted.map((m, i) => (
                  <TableRow key={`${m.createdAt}-${i}`}>
                    <TableCell className="font-mono">{m.label}</TableCell>
                    <TableCell>
                      <Badge variant={m.status === "active" ? "default" : "secondary"}>{m.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{when(m.createdAt)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.revokedAt ? `revoked ${when(m.revokedAt)}` : when(m.expiresAt)}
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">{m.keyPrefix ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {seen.length > 0 ? (
            <Facts items={seen.map((s) => [s, STATUSES[s]] as [string, string])} />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>If something leaks</CardTitle>
          <CardDescription>
            Revoke every live key made from this parent at {parent.provider}.
            Apps get a fresh key on their next read.
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex flex-wrap gap-2">
          <ConfirmButton
            label="Revoke all live keys"
            title={`Revoke every live key made from ${name}?`}
            description={`Each one stops working at ${parent.provider} right away.`}
            confirm="Revoke"
            onConfirm={async () => {
              await api("POST", `/v1/parents/${enc(name)}/revoke`)
              await router.invalidate()
            }}
          />
          <ConfirmButton
            label="Delete this parent key"
            title={`Delete ${name}?`}
            description="Minted secrets that name it stop working. It can't be undone."
            confirm="Delete"
            onConfirm={async () => {
              await api("DELETE", `/v1/parents/${enc(name)}`)
              await router.navigate({ to: "/parents" })
            }}
          />
        </CardFooter>
      </Card>
    </>
  )
}
