import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ErrorAlert, Facts, Page, Section } from "@/components/vault"
import { api, enc, forgetNext, when } from "@/lib/vault"

type Approval = { client: string; project: string; env: string; names: string[]; host: string; expiresAt: string }

/* A connected app's use_secret needs a yes (for clients that cannot ask in the chat). */
export const Route = createFileRoute("/approve/$id")({
  loader: ({ params }) => api<Approval>("GET", `/v1/oauth/approvals/${enc(params.id)}`),
  component: Approve,
})

function Approve() {
  const a = Route.useLoaderData()
  const { id } = Route.useParams()
  const [minutes, setMinutes] = useState("15")
  const [done, setDone] = useState<boolean | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function settle(value: number) {
    forgetNext()
    try {
      await api("POST", `/v1/oauth/approvals/${enc(id)}`, { minutes: value })
      setDone(value > 0)
    } catch (e) {
      setError(e)
    }
  }

  if (done != null)
    return <Page title={done ? "Allowed" : "Not allowed"} description={`Go back to ${a.client} and tell it to try again.`} />

  return (
    <Page
      title={`Allow ${a.client} to use ${a.names.join(", ")}?`}
      description={`It asked to send ${a.names.length === 1 ? "this secret" : "these secrets"} to ${a.host}. The vault sends the request itself; ${a.client} never sees the value.`}
    >
      <Section title="Details">
        <Facts
          items={[
            ["Secrets", a.names.join(", ")],
            ["From", `${a.project} / ${a.env}`],
            ["Sent to", a.host],
            ["Answer by", when(a.expiresAt)],
          ]}
        />
      </Section>
      <Field>
        <FieldLabel htmlFor="minutes">Allow for</FieldLabel>
        <NativeSelect id="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
          <NativeSelectOption value="15">15 minutes</NativeSelectOption>
          <NativeSelectOption value="1440">1 day</NativeSelectOption>
          <NativeSelectOption value="43200">30 days</NativeSelectOption>
        </NativeSelect>
      </Field>
      <ErrorAlert error={error} />
      <div className="flex gap-2">
        <Button onClick={() => settle(Number(minutes))}>Allow</Button>
        <Button variant="outline" onClick={() => settle(0)}>
          Don't allow
        </Button>
      </div>
    </Page>
  )
}
