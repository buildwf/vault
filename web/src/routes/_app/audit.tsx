import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState, ErrorAlert, PageHeader } from "@/components/page"
import { api, enc, when } from "@/lib/api"
import type { KeyMeta } from "@/lib/api"

type Event = {
  createdAt: string
  keyPrefix: string
  action: string
  secretName: string | null
  status: string
}
type Page = { events: Event[]; nextCursor: string | null }

const ACTIONS: Record<string, string> = {
  audit_list: "read the audit log",
  bootstrap: "set up the vault",
  broker: "used a secret through the broker",
  environment_create: "created an environment",
  environment_delete: "deleted an environment",
  get: "read secret values",
  inject: "loaded secrets into a program",
  key_create: "created a vault key",
  key_revoke: "revoked a vault key",
  key_rotate: "rotated a vault key",
  list: "listed secret names",
  master_key_prepare: "prepared a root key",
  master_key_retire: "retired a root key",
  mint: "minted a key",
  mint_revoke: "revoked minted keys",
  oauth_approve: "answered an app's request",
  org_create: "created an org",
  project_create: "created a project",
  project_delete: "deleted a project",
  parent_delete: "deleted a parent key",
  parent_set: "set a parent key",
  person_add: "added a GitHub sign-in",
  person_remove: "removed a GitHub sign-in",
  secret_delete: "deleted a secret",
  set: "wrote a secret",
  ui_signin: "signed in to this site",
}

const page = (cursor: string | null) =>
  api<Page>("GET", `/v1/audit?limit=100${cursor ? `&cursor=${enc(cursor)}` : ""}`)

export const Route = createFileRoute("/_app/audit")({
  loader: async () => {
    const [keys, first] = await Promise.all([
      api<{ keys: KeyMeta[] }>("GET", "/v1/keys?includeRevoked=1").catch(() => ({ keys: [] })),
      page(null),
    ])
    return { labels: Object.fromEntries(keys.keys.map((k) => [k.keyPrefix, k.label])), first }
  },
  component: Audit,
})

function Audit() {
  const { labels, first } = Route.useLoaderData()
  const [events, setEvents] = React.useState(first.events)
  const [cursor, setCursor] = React.useState(first.nextCursor)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  React.useEffect(() => {
    setEvents(first.events)
    setCursor(first.nextCursor)
  }, [first])

  return (
    <>
      <PageHeader title="Audit">
        Every read and change in this org, newest first, with the key that did
        it. Each row is written in the same step as the change, so nothing
        happens without a trace.
      </PageHeader>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {events.length === 0 ? (
            <EmptyState title="Nothing has happened yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When (UTC)</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Did</TableHead>
                  <TableHead>On</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e, i) => (
                  <TableRow key={`${e.createdAt}-${i}`}>
                    <TableCell className="text-muted-foreground">{when(e.createdAt)}</TableCell>
                    <TableCell>{labels[e.keyPrefix] ?? e.keyPrefix}</TableCell>
                    <TableCell>{ACTIONS[e.action] ?? e.action}</TableCell>
                    <TableCell className="font-mono">{e.secretName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={e.status === "ok" ? "secondary" : "destructive"}>{e.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <ErrorAlert error={error} />
          {cursor ? (
            <Button
              variant="outline"
              className="self-start"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const next = await page(cursor)
                  setEvents((all) => all.concat(next.events))
                  setCursor(next.nextCursor)
                } catch (e) {
                  setError(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Load older
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}
