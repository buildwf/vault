import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ErrorAlert, Facts, Page, Section } from "@/components/vault"
import { api, enc, forgetNext } from "@/lib/vault"

/* An app such as Claude asks to connect (OAuth). /oauth/authorize checked the
   client and sent the browser here; the vault checks everything again on approve. */
export const Route = createFileRoute("/connect/$request")({
  loader: ({ params }) => {
    const q = new URLSearchParams(params.request)
    return api<{ name: string; redirectUri: string }>(
      "GET",
      `/v1/oauth/client?client_id=${enc(q.get("client_id") ?? "")}&redirect_uri=${enc(q.get("redirect_uri") ?? "")}`,
    )
  },
  component: Connect,
})

function leave(url: string) {
  forgetNext()
  location.replace(url)
}

function Connect() {
  const client = Route.useLoaderData()
  const q = new URLSearchParams(Route.useParams().request)
  const envs = useOverview().projects.flatMap((p) => p.environments.map((e) => ({ project: p.name, env: e.name })))
  const [picked, setPicked] = useState(() => new Set(envs.length === 1 ? [0] : []))
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  // vault login --device: the CLI gets a read-only key, so it can read values.
  const device = client.redirectUri === `${location.origin}/oauth/device`

  async function allow() {
    const scopes = envs.filter((_, i) => picked.has(i))
    if (scopes.length === 0) return setError(new Error("Pick at least one environment."))
    setPending(true)
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
      setPending(false)
      setError(e)
    }
  }

  function deny() {
    const back = new URL(client.redirectUri)
    back.searchParams.set("error", "access_denied")
    if (q.get("state") != null) back.searchParams.set("state", q.get("state")!)
    back.searchParams.set("iss", location.origin)
    leave(back.toString())
  }

  return (
    <Page
      title={`${device ? "Sign in" : "Connect"} ${client.name}`}
      description={
        device
          ? `${client.name} wants to sign in to the vault CLI. It can read the values of every secret in the environments you pick. Approve only if you started this login.`
          : `${client.name} wants to use secrets from this vault. The vault sends each request itself, so it never sees a value. You allow each secret and site the first time it is used.`
      }
    >
      <Section title="Details">
        <Facts
          items={[
            ["Returns to", device ? "the CLI" : new URL(client.redirectUri).origin],
            ["Lasts", `${device ? "1 day" : "30 days"}. Revoke it any time on Vault keys.`],
          ]}
        />
      </Section>
      <Section title="Which environments">
        {envs.length === 0 ? (
          <p className="text-muted-foreground">No environments yet. Create a project first.</p>
        ) : (
          <FieldGroup>
            {envs.map((s, i) => (
              <Field key={i} orientation="horizontal">
                <Checkbox
                  id={`env-${i}`}
                  checked={picked.has(i)}
                  onCheckedChange={(on) =>
                    setPicked((prev) => {
                      const next = new Set(prev)
                      if (on === true) next.add(i)
                      else next.delete(i)
                      return next
                    })
                  }
                />
                <FieldLabel htmlFor={`env-${i}`} className="font-mono">
                  {s.project} / {s.env}
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        )}
      </Section>
      <ErrorAlert error={error} />
      <div className="flex gap-2">
        <Button onClick={allow} disabled={pending}>
          {device ? "Sign in" : "Connect"}
        </Button>
        <Button variant="outline" onClick={deny}>
          Cancel
        </Button>
      </div>
    </Page>
  )
}
