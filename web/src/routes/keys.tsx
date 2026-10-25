import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ActionForm, Confirm, OnceKey, Page, Rows, Section } from "@/components/vault"
import { access, api, enc, when, type VaultKey } from "@/lib/vault"

type People = { githubSignIn: boolean; people: { login: string; createdAt: string }[] }

export const Route = createFileRoute("/keys")({
  loader: async () => {
    const [keys, people] = await Promise.all([
      api<{ keys: VaultKey[] }>("GET", "/v1/keys?includeRevoked=1"),
      api<People>("GET", "/v1/people"),
    ])
    return { keys: keys.keys.sort((a, b) => Number(a.revoked) - Number(b.revoked)), people }
  },
  component: Keys,
})

function Keys() {
  const { keys, people } = Route.useLoaderData()
  const me = useOverview().key.keyPrefix
  const [type, setType] = useState("system")
  return (
    <Page title="Vault keys" description="Who can reach this vault. The vault stores only a hash of each key, so a lost key cannot be shown again.">
      <Section title="All keys" description='Keys labelled "web ui" are sign-ins to this page. They expire within 12 hours.'>
        <Rows
          rows={keys}
          empty="No keys."
          columns={[
            {
              label: "Who",
              cell: (k) => (
                <span className="flex items-center gap-2">
                  {k.label ?? "—"}
                  {k.keyPrefix === me && <Badge variant="secondary">you</Badge>}
                </span>
              ),
            },
            { label: "Access", cell: access, className: "whitespace-normal" },
            { label: "Last used", cell: (k) => when(k.lastUsedAt) },
            { label: "Expires", cell: (k) => (k.revoked ? `revoked ${when(k.revokedAt)}` : when(k.expiresAt)) },
            {
              label: "",
              className: "text-right",
              cell: (k) =>
                !k.revoked &&
                k.keyPrefix !== me && (
                  <Confirm
                    label="Revoke"
                    question={`Revoke ${k.label ?? k.keyPrefix}? Anything using it stops working.`}
                    action={() => api("DELETE", `/v1/keys/${enc(k.keyPrefix)}`)}
                  />
                ),
            },
          ]}
        />
      </Section>
      <Section title="Give an app or agent access" description="A scoped key reads one environment and nothing else. Give operator keys only to people.">
        <ActionForm
          submit="Create key"
          onReset={() => setType("system")}
          shown={(created: { prefix: string; key: string }) => <OnceKey title={`New key ${created.prefix}`} value={created.key} />}
          onSubmit={(data) => {
            const body: Record<string, unknown> = { type, expiresInDays: Number(data.get("days")) || 90 }
            const label = String(data.get("label")).trim()
            if (label) body.label = label
            if (type === "system") {
              body.permission = data.get("permission")
              body.scopes = [{ project: String(data.get("project")).trim(), env: String(data.get("env")).trim() }]
            }
            return api("POST", "/v1/keys", body)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="type">Kind</FieldLabel>
              <NativeSelect id="type" value={type} onChange={(e) => setType(e.target.value)}>
                <NativeSelectOption value="system">Scoped (for an app or agent)</NativeSelectOption>
                <NativeSelectOption value="user">Operator (manages the whole org)</NativeSelectOption>
              </NativeSelect>
            </Field>
            {type === "system" && (
              <>
                <Field>
                  <FieldLabel htmlFor="permission">Permission</FieldLabel>
                  <NativeSelect id="permission" name="permission">
                    <NativeSelectOption value="read">Read</NativeSelectOption>
                    <NativeSelectOption value="readwrite">Read and write</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="project">Project</FieldLabel>
                  <Input id="project" name="project" required autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="env">Environment</FieldLabel>
                  <Input id="env" name="env" required autoComplete="off" />
                </Field>
              </>
            )}
            <Field>
              <FieldLabel htmlFor="label">Label</FieldLabel>
              <Input id="label" name="label" maxLength={120} autoComplete="off" />
              <FieldDescription>Who holds it, like "web prod".</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="days">Expires in days</FieldLabel>
              <Input id="days" name="days" type="number" min={1} max={365} defaultValue={90} />
            </Field>
          </FieldGroup>
        </ActionForm>
      </Section>
      <Section
        title="People who sign in with GitHub"
        description={
          people.githubSignIn
            ? "Each account can sign in to this page as an operator of this org."
            : "GitHub sign-in is not set up on this vault yet."
        }
      >
        <div className="flex flex-col gap-6">
          <Rows
            rows={people.people}
            empty="Nobody yet."
            columns={[
              { label: "GitHub account", cell: (p) => <span className="font-mono">@{p.login}</span> },
              { label: "Added", cell: (p) => when(p.createdAt) },
              {
                label: "",
                className: "text-right",
                cell: (p) => (
                  <Confirm
                    label="Remove"
                    question={`Remove @${p.login}? Sessions they already have last until they expire.`}
                    action={() => api("DELETE", `/v1/people/${enc(p.login)}`)}
                  />
                ),
              },
            ]}
          />
          <ActionForm
            submit="Add person"
            onSubmit={(data) => api("POST", "/v1/people", { login: String(data.get("login")).trim().replace(/^@/, "") })}
          >
            <Field>
              <FieldLabel htmlFor="login">GitHub username</FieldLabel>
              <Input id="login" name="login" required maxLength={39} autoComplete="off" />
              <FieldDescription>They become an operator of this org.</FieldDescription>
            </Field>
          </ActionForm>
        </div>
      </Section>
    </Page>
  )
}
