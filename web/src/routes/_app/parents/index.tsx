import { Link, createFileRoute, useRouter } from "@tanstack/react-router"

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
import { Textarea } from "@/components/ui/textarea"
import {
  EmptyState,
  ErrorAlert,
  PageHeader,
  SubmitButton,
  useSubmit,
} from "@/components/page"
import { api, enc, mintedFrom, when } from "@/lib/api"

export const Route = createFileRoute("/_app/parents/")({ component: Parents })

function Parents() {
  const { overview: ov } = Route.useRouteContext()
  const router = useRouter()
  const parents = ov.parents ?? []
  const save = useSubmit(async (form) => {
    const config: Record<string, string> = {}
    for (const line of String(form.get("config") ?? "").split("\n")) {
      const i = line.indexOf("=")
      if (i > 0) config[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    const name = String(form.get("name") ?? "").trim()
    await api("PUT", `/v1/parents/${enc(name)}`, {
      provider: form.get("provider"),
      config,
      value: form.get("value"),
    })
    await router.navigate({ to: "/parents/$name", params: { name } })
  })

  return (
    <>
      <PageHeader title="Parent keys">
        A parent key is one powerful credential for one service, like a
        Cloudflare token or a GitHub App. It stays in the vault. When an app
        reads a minted secret, the vault uses it to make a fresh key that
        expires by itself. So there is one real credential to rotate, and you
        can see and kill every key made from it.
      </PageHeader>

      <Card>
        <CardContent>
          {parents.length === 0 ? (
            <EmptyState title="No parent keys yet">
              Add one below, then make a minted secret that names it.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parent key</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead className="text-right">Live keys</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parents.map((p) => {
                  const uses = mintedFrom(ov, p.name)
                  return (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">
                        <Link to="/parents/$name" params={{ name: p.name }} className="hover:underline">
                          {p.name}
                        </Link>
                      </TableCell>
                      <TableCell>{p.provider}</TableCell>
                      <TableCell className="whitespace-normal">
                        {uses.length === 0
                          ? "no secrets yet"
                          : uses.map((u) => `${u[0]}/${u[1]} ${u[2]}`).join(", ")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.activeChildren}</TableCell>
                      <TableCell className="text-muted-foreground">{when(p.updatedAt)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add or replace a parent key</CardTitle>
          <CardDescription>
            Saving over a name that exists replaces its credential and keeps
            its history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save.onSubmit}>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="parent-name">Name</FieldLabel>
                  <Input id="parent-name" name="name" required pattern="[a-z0-9][a-z0-9-]*" placeholder="cloudflare" autoComplete="off" />
                  <FieldDescription>Lowercase letters, digits and dashes.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="parent-provider">Service</FieldLabel>
                  <NativeSelect id="parent-provider" name="provider" className="w-full" defaultValue="cloudflare">
                    <NativeSelectOption value="cloudflare">cloudflare</NativeSelectOption>
                    <NativeSelectOption value="github">github</NativeSelectOption>
                  </NativeSelect>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="parent-config">Settings</FieldLabel>
                <Textarea id="parent-config" name="config" spellCheck={false} className="font-mono" placeholder="accountId=…" />
                <FieldDescription>
                  One key=value per line: accountId=… for cloudflare, or appId=…
                  and installationId=… for github.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="parent-value">Credential</FieldLabel>
                <Textarea
                  id="parent-value"
                  name="value"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono [-webkit-text-security:disc]"
                />
                <FieldDescription>
                  A Cloudflare API token that can create tokens, or a GitHub
                  App private key. Write-only: nobody can read it back.
                </FieldDescription>
              </Field>
              <ErrorAlert error={save.error} />
              <SubmitButton busy={save.busy}>Save parent key</SubmitButton>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </>
  )
}
