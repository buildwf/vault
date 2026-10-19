import { Link, createFileRoute } from "@tanstack/react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
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
import { Command, EmptyState, PageHeader } from "@/components/page"
import { Facts } from "@/components/facts"
import { access, mintedFrom, plural, when } from "@/lib/api"

export const Route = createFileRoute("/_app/")({ component: Overview })

const TERMS: [string, string][] = [
  ["Org", "One team or customer. It has its own encryption key and can't see other orgs."],
  ["Project", "One app or service, like manyave-management."],
  ["Environment", "One stage of a project, like dev or prod. An app reads exactly one."],
  ["Secret", "A named value, like DATABASE_URL."],
  ["Parent key", "One powerful credential per service, like a Cloudflare token. It never leaves the vault."],
  ["Minted key", "A short-lived key the vault makes from a parent key each time an app needs one."],
  ["Vault key", "How a person, app or agent signs in to the vault."],
]

function Overview() {
  const { overview: ov } = Route.useRouteContext()
  const k = ov.key
  const rows = ov.projects.flatMap((p): { project: string; env: string | null; count: number }[] =>
    p.environments.length === 0
      ? [{ project: p.name, env: null, count: 0 }]
      : p.environments.map((e) => ({ project: p.name, env: e.name, count: e.secrets.length }))
  )

  return (
    <>
      <PageHeader title={ov.platform ? "Platform" : (ov.org ?? "Vault")}>
        This vault keeps the secrets your apps and AI agents run with. Values
        are encrypted, and this site never shows them. It shows what is stored
        and who can reach it.
      </PageHeader>

      {ov.platform ? (
        <Alert>
          <AlertTitle>You're in the platform org</AlertTitle>
          <AlertDescription>
            The platform org runs the vault and creates orgs. It can't see
            inside any org. To see an org's secrets, run vault ui with that
            org's login.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>You</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts
            items={[
              ["Signed in as", `${k.label ?? "unlabelled key"} (${k.keyPrefix})`],
              ["Org", ov.platform ? "platform" : (ov.org ?? "—")],
              ["Access", access(k)],
              ["Session ends", when(k.expiresAt)],
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What's stored</CardTitle>
          <CardDescription>
            {plural(ov.projects.length, "project")},{" "}
            {plural(rows.filter((r) => r.env).length, "environment")},{" "}
            {plural(rows.reduce((n, r) => n + r.count, 0), "secret")}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState title="Nothing yet">
              {ov.platform
                ? "The platform org has no projects of its own."
                : "Create a project, then add an environment and its secrets."}
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead className="text-right">Secrets</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.project}/${r.env}`}>
                    <TableCell className="font-medium">
                      <Link to="/projects/$project" params={{ project: r.project }} className="hover:underline">
                        {r.project}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.env ? (
                        <Link
                          to="/projects/$project/$env"
                          params={{ project: r.project, env: r.env }}
                          className="hover:underline"
                        >
                          {r.env}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">none yet</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {ov.parents && ov.parents.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Parent keys</CardTitle>
            <CardDescription>
              Root credentials the vault makes short-lived keys from. Apps never see these.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parent key</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead className="text-right">Live keys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ov.parents.map((p) => {
                  const uses = mintedFrom(ov, p.name)
                  return (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">
                        <Link to="/parents/$name" params={{ name: p.name }} className="hover:underline">
                          {p.name}
                        </Link>
                      </TableCell>
                      <TableCell>{p.provider}</TableCell>
                      <TableCell className="whitespace-normal">
                        {uses.length === 0
                          ? "no secrets yet"
                          : uses.map((u) => `${u[0]}/${u[1]} ${u[2]}`).join(", ")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.activeChildren}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Use secrets from a terminal</CardTitle>
          <CardDescription>
            Run any command with an environment's secrets as environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Command>vault run --project PROJECT --env ENV -- your-command</Command>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Words used here</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts items={TERMS} />
        </CardContent>
      </Card>
    </>
  )
}
