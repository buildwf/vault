import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { ErrorAlert, Page, Rows, Section } from "@/components/vault"
import { ACTIONS, api, enc, when, type VaultKey } from "@/lib/vault"

type Event = { createdAt: string; keyPrefix: string; action: string; secretName?: string; status: string }
type AuditPage = { events: Event[]; nextCursor?: string | null }

export const Route = createFileRoute("/audit")({
  loader: async () => {
    const [keys, first] = await Promise.all([
      api<{ keys: VaultKey[] }>("GET", "/v1/keys?includeRevoked=1").catch(() => ({ keys: [] })),
      api<AuditPage>("GET", "/v1/audit?limit=100"),
    ])
    return { labels: Object.fromEntries(keys.keys.map((k) => [k.keyPrefix, k.label])), first }
  },
  component: Audit,
})

function Audit() {
  const { labels, first } = Route.useLoaderData()
  const [events, setEvents] = useState(first.events)
  const [cursor, setCursor] = useState(first.nextCursor)
  const [error, setError] = useState<unknown>(null)
  async function more() {
    try {
      const page = await api<AuditPage>("GET", `/v1/audit?limit=100&cursor=${enc(cursor!)}`)
      setEvents((e) => [...e, ...page.events])
      setCursor(page.nextCursor)
    } catch (e) {
      setError(e)
    }
  }
  return (
    <Page title="Audit" description="Every read and change in this org, newest first, with the key that did it.">
      <Section title="Events">
        <div className="flex flex-col gap-4">
          <Rows
            rows={events}
            empty="Nothing has happened yet."
            columns={[
              { label: "When (UTC)", cell: (e) => when(e.createdAt) },
              { label: "Who", cell: (e) => labels[e.keyPrefix] ?? e.keyPrefix },
              { label: "Did", cell: (e) => ACTIONS[e.action] ?? e.action },
              { label: "On", cell: (e) => <span className="font-mono">{e.secretName ?? "—"}</span> },
              { label: "Result", cell: (e) => e.status },
            ]}
          />
          <ErrorAlert error={error} />
          {cursor && (
            <div>
              <Button variant="outline" onClick={more}>
                Load older
              </Button>
            </div>
          )}
        </div>
      </Section>
    </Page>
  )
}
