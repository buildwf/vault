import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ErrorAlert, SubmitButton, useSubmit } from "@/components/page"
import { api, enc } from "@/lib/api"
import { forgetNext } from "@/lib/session"

/* A connected app asked for a missing secret; the person types it here, never in the chat. */
export const Route = createFileRoute("/_app/collect/$project/$env/$name")({
  component: Collect,
})

function Collect() {
  const { project, env, name } = Route.useParams()
  const [saved, setSaved] = React.useState(false)
  React.useEffect(() => {
    document.title = `Add ${name} · Vault`
  }, [name])
  const save = useSubmit(async (form) => {
    forgetNext()
    await api(
      "POST",
      `/v1/projects/${enc(project)}/environments/${enc(env)}/secrets/${enc(name)}`,
      { value: String(form.get("value") ?? ""), kind: "secret" }
    )
    setSaved(true)
  })

  if (saved)
    return (
      <Card className="mx-auto w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Saved</CardTitle>
          <CardDescription>
            {name} is in the vault. Go back to the chat and say it's done.
          </CardDescription>
        </CardHeader>
      </Card>
    )

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-base">Add {name}</CardTitle>
        <CardDescription>
          An AI asked for {name} in {project} / {env}. The value goes straight
          to the vault; the AI only learns that it's stored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save.onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="collect-value">{name}</FieldLabel>
              <Input
                id="collect-value"
                name="value"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={16384}
              />
              <FieldDescription>Write-only. Nobody can read it back here.</FieldDescription>
            </Field>
            <ErrorAlert error={save.error} />
            <SubmitButton busy={save.busy}>Save to the vault</SubmitButton>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
