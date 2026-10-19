import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ErrorAlert } from "@/components/page"
import { Facts } from "@/components/facts"
import { api, enc, when } from "@/lib/api"
import { forgetNext } from "@/lib/session"

type Approval = {
  client: string
  project: string
  env: string
  names: string[]
  host: string
  expiresAt: string
}

/* A connected app's use_secret needs the person's yes (for apps that can't ask in the chat). */
export const Route = createFileRoute("/_app/approve/$id")({
  loader: ({ params }) => api<Approval>("GET", `/v1/oauth/approvals/${enc(params.id)}`),
  component: Approve,
})

const DURATIONS = { "15": "15 minutes", "1440": "1 day", "43200": "30 days" }

function Approve() {
  const a = Route.useLoaderData()
  const { id } = Route.useParams()
  const [minutes, setMinutes] = React.useState("15")
  const [done, setDone] = React.useState<boolean | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const one = a.names.length === 1
  React.useEffect(() => {
    document.title = `Allow ${a.client} · Vault`
  }, [a.client])

  const settle = async (value: number) => {
    forgetNext()
    setBusy(true)
    setError(null)
    try {
      await api("POST", `/v1/oauth/approvals/${enc(id)}`, { minutes: value })
      setDone(value > 0)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (done != null)
    return (
      <Card className="mx-auto w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">{done ? "Allowed" : "Not allowed"}</CardTitle>
          <CardDescription>Go back to {a.client} and tell it to try again.</CardDescription>
        </CardHeader>
      </Card>
    )

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">
          Allow {a.client} to use {a.names.join(", ")}?
        </CardTitle>
        <CardDescription>
          It asked to send {one ? "this secret" : "these secrets"} to {a.host}.
          The vault adds {one ? "it" : "them"} to the request and sends it
          itself, so {a.client} never sees the value.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Facts
            items={[
              ["Secrets", a.names.join(", ")],
              ["From", `${a.project} / ${a.env}`],
              ["Sent to", a.host],
              ["Answer by", when(a.expiresAt)],
            ]}
          />
          <Field>
            <FieldLabel htmlFor="approve-for">Allow for</FieldLabel>
            <NativeSelect id="approve-for" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              {Object.entries(DURATIONS).map(([value, label]) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <ErrorAlert error={error} />
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex gap-2">
        <Button onClick={() => settle(Number(minutes))} disabled={busy}>
          Allow
        </Button>
        <Button variant="outline" onClick={() => settle(0)} disabled={busy}>
          Don't allow
        </Button>
      </CardFooter>
    </Card>
  )
}
