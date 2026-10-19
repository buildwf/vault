import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ConfirmButton,
  EmptyState,
  ErrorAlert,
  OnceKey,
  PageHeader,
  SubmitButton,
  useSubmit,
} from "@/components/page"
import { access, api, enc, when } from "@/lib/api"
import type { KeyMeta } from "@/lib/api"

type People = {
  githubSignIn: boolean
  people: { login: string; createdAt: string }[]
}

export const Route = createFileRoute("/_app/keys")({
  loader: async () => {
    const [keys, people] = await Promise.all([
      api<{ keys: KeyMeta[] }>("GET", "/v1/keys?includeRevoked=1"),
      api<People>("GET", "/v1/people"),
    ])
    return { keys: keys.keys, people }
  },
  component: Access,
})

function Access() {
  const { overview } = Route.useRouteContext()
  const { keys, people } = Route.useLoaderData()
  const router = useRouter()
  const me = overview.key.keyPrefix
  const sorted = [...keys].sort((a, b) => Number(a.revoked) - Number(b.revoked))

  return (
    <>
      <PageHeader title="Access">
        Every person, app and agent that talks to this vault uses a vault key.
        The vault keeps only a fingerprint of each key, so a lost key can't be
        shown again. Revoke it and make a new one.
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Vault keys</CardTitle>
          <CardDescription>
            Keys labelled "web ui" are sign-ins to this site. They end within 12 hours.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((k) => (
                <TableRow key={k.keyPrefix} className={k.revoked ? "text-muted-foreground" : undefined}>
                  <TableCell className="whitespace-normal">
                    {k.label ?? "—"}{" "}
                    {k.keyPrefix === me ? <Badge variant="outline">you</Badge> : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">{access(k)}</TableCell>
                  <TableCell className="font-mono">{k.keyPrefix}</TableCell>
                  <TableCell>{when(k.lastUsedAt)}</TableCell>
                  <TableCell>{k.revoked ? `revoked ${when(k.revokedAt)}` : when(k.expiresAt)}</TableCell>
                  <TableCell>
                    {k.revoked || k.keyPrefix === me ? null : (
                      <ConfirmButton
                        label="Revoke"
                        title={`Revoke ${k.label ?? k.keyPrefix}?`}
                        description="Anything using this key stops working right away."
                        onConfirm={async () => {
                          await api("DELETE", `/v1/keys/${enc(k.keyPrefix)}`)
                          await router.invalidate()
                        }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <NewKey />
      <PeopleCard people={people} />
    </>
  )
}

function NewKey() {
  const router = useRouter()
  const [type, setType] = React.useState<"system" | "user">("system")
  const [created, setCreated] = React.useState<{ prefix: string; key: string } | null>(null)
  const create = useSubmit(async (form) => {
    const body: Record<string, unknown> = {
      type,
      expiresInDays: Number(form.get("days")) || 90,
    }
    const label = String(form.get("label") ?? "").trim()
    if (label) body.label = label
    if (type === "system") {
      body.permission = form.get("permission")
      body.scopes = [{ project: String(form.get("project") ?? "").trim(), env: String(form.get("env") ?? "").trim() }]
    }
    setCreated(await api<{ prefix: string; key: string }>("POST", "/v1/keys", body))
    await router.invalidate()
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Give an app or agent access</CardTitle>
        <CardDescription>
          An app key reads one environment and nothing else. Give it to the app
          as VAULT_API_KEY. An operator key manages the whole org.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={create.onSubmit}>
          <FieldGroup>
            {created ? <OnceKey title={`New key ${created.prefix}`} value={created.key} /> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="key-type">Kind</FieldLabel>
                <NativeSelect
                  id="key-type"
                  className="w-full"
                  value={type}
                  onChange={(e) => setType(e.target.value as "system" | "user")}
                >
                  <NativeSelectOption value="system">App key (one environment)</NativeSelectOption>
                  <NativeSelectOption value="user">Operator key (the whole org)</NativeSelectOption>
                </NativeSelect>
              </Field>
              {type === "system" ? (
                <Field>
                  <FieldLabel htmlFor="key-perm">Permission</FieldLabel>
                  <NativeSelect id="key-perm" name="permission" className="w-full" defaultValue="read">
                    <NativeSelectOption value="read">Read secrets</NativeSelectOption>
                    <NativeSelectOption value="readwrite">Read and write secrets</NativeSelectOption>
                  </NativeSelect>
                </Field>
              ) : null}
              {type === "system" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="key-project">Project</FieldLabel>
                    <Input id="key-project" name="project" required autoComplete="off" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="key-env">Environment</FieldLabel>
                    <Input id="key-env" name="env" required autoComplete="off" />
                  </Field>
                </>
              ) : null}
              <Field>
                <FieldLabel htmlFor="key-label">Label</FieldLabel>
                <Input id="key-label" name="label" maxLength={120} autoComplete="off" placeholder="web prod" />
                <FieldDescription>Who holds it, so you can tell keys apart.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="key-days">Expires in days</FieldLabel>
                <Input id="key-days" name="days" type="number" min={1} max={365} defaultValue={90} />
              </Field>
            </div>
            <ErrorAlert error={create.error} />
            <SubmitButton busy={create.busy}>Create key</SubmitButton>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}

function PeopleCard({ people }: { people: People }) {
  const router = useRouter()
  const add = useSubmit(async (form) => {
    const login = String(form.get("login") ?? "").trim().replace(/^@/, "")
    await api("POST", "/v1/people", { login })
    ;(document.getElementById("person-form") as HTMLFormElement | null)?.reset()
    await router.invalidate()
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>People who sign in with GitHub</CardTitle>
        <CardDescription>
          {people.githubSignIn
            ? "Each of these GitHub accounts can sign in to this site as an operator of this org."
            : "GitHub sign-in isn't set up on this vault yet, so these accounts can't sign in until it is."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {people.people.length === 0 ? (
          <EmptyState title="Nobody yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>GitHub account</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.people.map((p) => (
                <TableRow key={p.login}>
                  <TableCell className="font-medium">@{p.login}</TableCell>
                  <TableCell className="text-muted-foreground">{when(p.createdAt)}</TableCell>
                  <TableCell>
                    <ConfirmButton
                      label="Remove"
                      title={`Remove @${p.login}?`}
                      description="They can't sign in with GitHub any more. Sessions they already have last until they end."
                      onConfirm={async () => {
                        await api("DELETE", `/v1/people/${enc(p.login)}`)
                        await router.invalidate()
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <form id="person-form" onSubmit={add.onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="person-login">GitHub username</FieldLabel>
              <Input id="person-login" name="login" required maxLength={39} autoComplete="off" />
              <FieldDescription>They become an operator: they manage everything in this org.</FieldDescription>
            </Field>
            <ErrorAlert error={add.error} />
            <SubmitButton busy={add.busy}>Add person</SubmitButton>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
