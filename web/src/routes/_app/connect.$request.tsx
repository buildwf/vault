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
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { EmptyState, ErrorAlert } from "@/components/page"
import { Facts } from "@/components/facts"
import { api, enc } from "@/lib/api"
import { forgetNext } from "@/lib/session"

/*
 * An app such as Claude asks to connect (OAuth). /oauth/authorize checked the
 * client and sent the browser here; the vault checks everything again on approve.
 */
export const Route = createFileRoute("/_app/connect/$request")({
  loader: async ({ params }) => {
    const q = new URLSearchParams(params.request)
    const client = await api<{ name: string; redirectUri: string }>(
      "GET",
      `/v1/oauth/client?client_id=${enc(q.get("client_id") ?? "")}&redirect_uri=${enc(q.get("redirect_uri") ?? "")}`
    )
    return { q, client }
  },
  component: Connect,
})

function leave(url: string) {
  forgetNext()
  location.replace(url)
}

function Connect() {
  const { overview } = Route.useRouteContext()
  const { q, client } = Route.useLoaderData()
  const envs = overview.projects.flatMap((p) =>
    p.environments.map((e) => ({ project: p.name, env: e.name }))
  )
  const [picked, setPicked] = React.useState<Set<number>>(
    () => new Set(envs.length === 1 ? [0] : [])
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  // vault login --device: the CLI gets a read-only key, so it can read values.
  const device = client.redirectUri === `${location.origin}/oauth/device`
  React.useEffect(() => {
    document.title = `${device ? "Sign in" : "Connect"} ${client.name} · Vault`
  }, [device, client.name])

  const allow = async () => {
    const scopes = envs.filter((_, i) => picked.has(i))
    if (scopes.length === 0) {
      setError(new Error("Pick at least one environment."))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        client_id: q.get("client_id"),
        redirect_uri: q.get("redirect_uri"),
        code_challenge: q.get("code_challenge"),
        scopes,
      }
      if (q.get("state") != null) body.state = q.get("state")
      leave((await api<{ redirect: string }>("POST", "/v1/oauth/approve", body)).redirect)
    } catch (e) {
      setBusy(false)
      setError(e)
    }
  }

  const deny = () => {
    const back = new URL(client.redirectUri)
    back.searchParams.set("error", "access_denied")
    const state = q.get("state")
    if (state != null) back.searchParams.set("state", state)
    back.searchParams.set("iss", location.origin)
    leave(back.toString())
  }

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">
          {device ? "Sign in" : "Connect"} {client.name}
        </CardTitle>
        <CardDescription>
          {device
            ? `${client.name} wants to sign in to the vault CLI. It can read the values of every secret in the environments you pick. Approve only if you started this sign-in.`
            : `${client.name} wants to use secrets from this vault. It sees secret names and can call APIs with them, but the vault sends each request itself, so it never sees a value. You allow each secret and site the first time it's used.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Facts
            items={[
              ["Goes back to", device ? "the CLI" : new URL(client.redirectUri).origin],
              [
                "Lasts",
                device
                  ? `1 day. Revoke it any time on Access, where it's listed as ${client.name} (CLI login).`
                  : `30 days. Revoke it any time on Access, where it's listed as ${client.name} (MCP connector).`,
              ],
            ]}
          />
          <FieldSet>
            <FieldLegend variant="label">Which environments</FieldLegend>
            {envs.length === 0 ? (
              <EmptyState title="No environments yet">Create a project first.</EmptyState>
            ) : (
              <FieldGroup className="gap-3">
                {envs.map((s, i) => (
                  <Field key={`${s.project}/${s.env}`} orientation="horizontal">
                    <Checkbox
                      id={`connect-${i}`}
                      checked={picked.has(i)}
                      onCheckedChange={(v) =>
                        setPicked((prev) => {
                          const next = new Set(prev)
                          if (v === true) next.add(i)
                          else next.delete(i)
                          return next
                        })
                      }
                    />
                    <FieldLabel htmlFor={`connect-${i}`} className="font-normal">
                      {s.project} / {s.env}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            )}
          </FieldSet>
          <ErrorAlert error={error} />
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex gap-2">
        <Button onClick={allow} disabled={busy}>
          {device ? "Sign in" : "Connect"}
        </Button>
        <Button variant="outline" onClick={deny} disabled={busy}>
          Cancel
        </Button>
      </CardFooter>
    </Card>
  )
}
