import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { ActionForm, Page, Rows, Section } from "@/components/vault"
import { api, enc, mintedFrom, when } from "@/lib/vault"

export const Route = createFileRoute("/parents/")({ component: Parents })

function Parents() {
  const overview = useOverview()
  const navigate = useNavigate()
  return (
    <Page
      title="Parent keys"
      description="One powerful credential per service, kept in the vault. When an app reads a minted secret, the vault makes a short-lived key from it and logs it."
    >
      <Section title="All parent keys">
        <Rows
          rows={overview.parents ?? []}
          empty="No parent keys yet."
          columns={[
            {
              label: "Parent",
              cell: (p) => (
                <Link to="/parents/$name" params={{ name: p.name }} className="font-mono underline">
                  {p.name}
                </Link>
              ),
            },
            { label: "Service", cell: (p) => p.provider },
            { label: "Used by", cell: (p) => mintedFrom(overview, p.name).length },
            { label: "Live keys", cell: (p) => p.activeChildren },
            { label: "Updated", cell: (p) => when(p.updatedAt) },
          ]}
        />
      </Section>
      <Section title="Add or replace a parent key" description="Saving over a name replaces its credential and keeps its history.">
        <ActionForm
          submit="Save parent key"
          onSubmit={async (data) => {
            const config: Record<string, string> = {}
            for (const line of String(data.get("config")).split("\n")) {
              const i = line.indexOf("=")
              if (i > 0) config[line.slice(0, i).trim()] = line.slice(i + 1).trim()
            }
            const name = String(data.get("name")).trim()
            await api("PUT", `/v1/parents/${enc(name)}`, {
              provider: data.get("provider"),
              config,
              value: data.get("value"),
            })
            await navigate({ to: "/parents/$name", params: { name } })
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required pattern="[a-z0-9][a-z0-9-]*" autoComplete="off" />
              <FieldDescription>Lowercase, like cloudflare.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="provider">Service</FieldLabel>
              <NativeSelect id="provider" name="provider">
                <NativeSelectOption value="cloudflare">cloudflare</NativeSelectOption>
                <NativeSelectOption value="github">github</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="config">Config</FieldLabel>
              <Textarea id="config" name="config" spellCheck={false} />
              <FieldDescription>One key=value per line: accountId for cloudflare, or appId and installationId for github.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="value">Credential</FieldLabel>
              <Textarea
                id="value"
                name="value"
                required
                spellCheck={false}
                autoComplete="off"
                className="[-webkit-text-security:disc]"
              />
              <FieldDescription>A Cloudflare API token or a GitHub App private key. Write-only.</FieldDescription>
            </Field>
          </FieldGroup>
        </ActionForm>
      </Section>
    </Page>
  )
}
