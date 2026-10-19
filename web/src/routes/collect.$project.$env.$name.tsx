import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ErrorAlert, Page } from "@/components/vault"
import { api, enc, forgetNext } from "@/lib/vault"

/* A connected app asked for a missing secret; the user types it here, never in the chat. */
export const Route = createFileRoute("/collect/$project/$env/$name")({ component: Collect })

function Collect() {
  const { project, env, name } = Route.useParams()
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  if (saved) return <Page title="Saved" description={`${name} is in the vault. Go back to the chat and say it is done.`} />
  return (
    <Page
      title={`Add ${name}`}
      description={`An AI asked for ${name} in ${project} / ${env}. The value goes straight to the vault; the AI only learns that it is stored.`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault()
          const input = event.currentTarget.elements.namedItem("value") as HTMLInputElement
          setPending(true)
          forgetNext()
          try {
            await api("POST", `/v1/projects/${enc(project)}/environments/${enc(env)}/secrets/${enc(name)}`, {
              value: input.value,
              kind: "secret",
            })
            input.value = ""
            setSaved(true)
          } catch (e) {
            setPending(false)
            setError(e)
          }
        }}
      >
        <Field>
          <FieldLabel htmlFor="value" className="font-mono">
            {name}
          </FieldLabel>
          <Input id="value" name="value" type="password" autoComplete="off" required maxLength={16384} />
          <FieldDescription>Write-only. Nobody can read it back here.</FieldDescription>
        </Field>
        <ErrorAlert error={error} />
        <div>
          <Button type="submit" disabled={pending}>
            Save to the vault
          </Button>
        </div>
      </form>
    </Page>
  )
}
