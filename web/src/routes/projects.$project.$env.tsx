import { useState } from "react"
import { Link, createFileRoute, notFound } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { ActionForm, Command, Confirm, Page, Rows, Section } from "@/components/vault"
import { KINDS, api, enc, type Kind } from "@/lib/vault"

export const Route = createFileRoute("/projects/$project/$env")({
  beforeLoad: ({ context, params }) => {
    const project = context.overview.projects.find((p) => p.name === params.project)
    if (!project?.environments.some((e) => e.name === params.env)) throw notFound()
  },
  component: EnvironmentPage,
})

function EnvironmentPage() {
  const { project, env } = Route.useParams()
  const overview = useOverview()
  const secrets = overview.projects.find((p) => p.name === project)!.environments.find((e) => e.name === env)!.secrets
  const base = `/v1/projects/${enc(project)}/environments/${enc(env)}/secrets`
  const [kind, setKind] = useState<Kind>("secret")
  const [random, setRandom] = useState(false)
  return (
    <Page
      title={`${project} / ${env}`}
      crumbs={[
        { label: "Projects", to: "/projects" },
        { label: project, to: "/projects/$project", params: { project } },
        { label: env },
      ]}
      description={`The secrets ${project} runs with in ${env}. Values are encrypted and never shown here.`}
    >
      <Section title="Secrets">
        <Rows
          rows={secrets}
          empty="No secrets yet. Add one below."
          columns={[
            { label: "Name", cell: (s) => <span className="font-mono">{s.name}</span> },
            { label: "Kind", cell: (s) => <Badge variant="secondary">{s.kind}</Badge> },
            {
              label: "When an app reads it",
              className: "whitespace-normal",
              cell: (s) =>
                s.kind === "minted" && s.parent ? (
                  <>
                    Gets a fresh key from{" "}
                    <Link to="/parents/$name" params={{ name: s.parent }} className="underline">
                      {s.parent}
                    </Link>
                  </>
                ) : (
                  KINDS[s.kind]
                ),
            },
            {
              label: "",
              className: "text-right",
              cell: (s) => (
                <Confirm
                  label="Delete"
                  question={`Delete ${s.name} from ${project}/${env}?`}
                  action={() => api("PATCH", base, { delete: [s.name] })}
                />
              ),
            },
          ]}
        />
      </Section>
      <Section title="Use these secrets" description="Run your command with every secret here as an environment variable.">
        <Command>{`vault run --project ${project} --env ${env} -- your-command`}</Command>
      </Section>
      <Section title="Add or replace a secret" description="Saving a name that exists replaces its value.">
        <ActionForm
          submit="Save secret"
          onReset={() => setKind("secret")}
          onSubmit={async (data) => {
            const item: Record<string, unknown> = { name: String(data.get("name")).trim(), kind }
            if (random) item.random = true
            else item.value = String(data.get("value") ?? "")
            await api("PATCH", base, { set: [item] })
            setRandom(false)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required pattern="[A-Z_][A-Z0-9_]*" placeholder="DATABASE_URL" autoComplete="off" />
              <FieldDescription>Uppercase, as the app expects the variable.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="kind">Kind</FieldLabel>
              <NativeSelect id="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {(Object.keys(KINDS) as Kind[]).map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {k}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {KINDS[kind]}
                {kind === "minted" && ' The value is a JSON spec, like {"parent": "cloudflare", "ttlMinutes": 60}.'}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="value">Value</FieldLabel>
              {/* Masked while typing; a minted spec is JSON, not a credential, so it shows. */}
              <Textarea
                id="value"
                name="value"
                spellCheck={false}
                autoComplete="off"
                disabled={random}
                className={kind === "minted" ? undefined : "[-webkit-text-security:disc]"}
              />
              <FieldDescription>Write-only. Nobody can read it back here.</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="random" checked={random} onCheckedChange={(v) => setRandom(v === true)} />
              <FieldLabel htmlFor="random">Generate a random value instead</FieldLabel>
            </Field>
          </FieldGroup>
        </ActionForm>
      </Section>
    </Page>
  )
}
