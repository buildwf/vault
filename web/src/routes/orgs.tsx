import { createFileRoute } from "@tanstack/react-router"

import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ActionForm, OnceKey, Page, Rows, Section } from "@/components/vault"
import { api } from "@/lib/vault"

export const Route = createFileRoute("/orgs")({
  loader: () => api<{ orgs: string[] }>("GET", "/v1/orgs"),
  component: Orgs,
})

function Orgs() {
  const { orgs } = Route.useLoaderData()
  return (
    <Page title="Orgs" description="Each org is a separate team with its own encryption key. The platform org can create orgs but cannot read inside them.">
      <Section title="All orgs">
        <Rows rows={orgs} empty="No orgs yet." columns={[{ label: "Org", cell: (o) => <span className="font-mono">{o}</span> }]} />
      </Section>
      <Section title="New org" description="Creates the org and its first operator key. Give that key to the org's owner.">
        <ActionForm
          submit="Create org"
          shown={(created: { name: string; key: string }) => <OnceKey title={`Operator key for ${created.name}`} value={created.key} />}
          onSubmit={(data) => {
            const body: Record<string, string> = { name: String(data.get("name")).trim() }
            const label = String(data.get("label")).trim()
            if (label) body.label = label
            return api("POST", "/v1/orgs", body)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required pattern="[a-z0-9][a-z0-9-]*" autoComplete="off" />
              <FieldDescription>Lowercase, like manyave.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="label">Operator label</FieldLabel>
              <Input id="label" name="label" maxLength={120} autoComplete="off" />
            </Field>
          </FieldGroup>
        </ActionForm>
      </Section>
    </Page>
  )
}
