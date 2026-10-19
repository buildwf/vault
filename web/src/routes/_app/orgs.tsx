import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  EmptyState,
  ErrorAlert,
  OnceKey,
  PageHeader,
  SubmitButton,
  useSubmit,
} from "@/components/page"
import { api } from "@/lib/api"

export const Route = createFileRoute("/_app/orgs")({
  loader: () => api<{ orgs: string[] }>("GET", "/v1/orgs"),
  component: Orgs,
})

function Orgs() {
  const { orgs } = Route.useLoaderData()
  const router = useRouter()
  const [created, setCreated] = React.useState<{ name: string; key: string } | null>(null)
  const create = useSubmit(async (form) => {
    const body: Record<string, string> = { name: String(form.get("name") ?? "").trim() }
    const label = String(form.get("label") ?? "").trim()
    if (label) body.label = label
    setCreated(await api<{ name: string; key: string }>("POST", "/v1/orgs", body))
    await router.invalidate()
  })

  return (
    <>
      <PageHeader title="Orgs">
        Each org is a separate team or customer in this vault, with its own
        encryption key and its own operators. The platform org can create orgs
        but can't read anything inside them.
      </PageHeader>
      <Card>
        <CardContent>
          {orgs.length === 0 ? (
            <EmptyState title="No orgs yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Org</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.map((o) => (
                  <TableRow key={o}>
                    <TableCell className="font-medium">{o}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New org</CardTitle>
          <CardDescription>
            Creates the org and its first operator key. Give that key to the
            org's owner; they sign in with vault login and manage the rest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create.onSubmit}>
            <FieldGroup>
              {created ? (
                <OnceKey title={`Operator key for ${created.name}`} value={created.key} />
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="org-name">Name</FieldLabel>
                  <Input id="org-name" name="name" required pattern="[a-z0-9][a-z0-9-]*" placeholder="manyave" autoComplete="off" />
                  <FieldDescription>Lowercase letters, digits and dashes.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="org-label">Operator key label</FieldLabel>
                  <Input id="org-label" name="label" maxLength={120} autoComplete="off" />
                </Field>
              </div>
              <ErrorAlert error={create.error} />
              <SubmitButton busy={create.busy}>Create org</SubmitButton>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </>
  )
}
