import * as React from "react"
import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
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
  Command,
  ConfirmButton,
  EmptyState,
  ErrorAlert,
  PageHeader,
  SubmitButton,
  useSubmit,
} from "@/components/page"
import { KINDS, api, enc, plural } from "@/lib/api"
import type { Kind } from "@/lib/api"

export const Route = createFileRoute("/_app/projects/$project/$env")({
  beforeLoad: ({ context, params }) => {
    const project = context.overview.projects.find((p) => p.name === params.project)
    const environment = project?.environments.find((e) => e.name === params.env)
    if (!environment) throw notFound()
    return { environment }
  },
  component: Environment,
})

function Environment() {
  const { overview, environment } = Route.useRouteContext()
  const { project, env } = Route.useParams()
  const router = useRouter()
  const base = `/v1/projects/${enc(project)}/environments/${enc(env)}/secrets`
  const secrets = environment.secrets
  const [kind, setKind] = React.useState<Kind>("secret")
  const [random, setRandom] = React.useState(false)

  const save = useSubmit(async (form) => {
    const name = String(form.get("name") ?? "").trim()
    const item: Record<string, unknown> = { name, kind }
    if (random) item.random = true
    else item.value = String(form.get("value") ?? "")
    await api("PATCH", base, { set: [item] })
    toast.success(`Saved ${name}`)
    ;(document.getElementById("secret-form") as HTMLFormElement | null)?.reset()
    setRandom(false)
    await router.invalidate()
  })

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/projects">Projects</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/projects/$project" params={{ project }}>
                {project}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{env}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={`${project} / ${env}`}>
        {plural(secrets.length, "secret")} that {project} runs with in {env}.
        Values are encrypted and never shown here.
      </PageHeader>

      <Card>
        <CardContent>
          {secrets.length === 0 ? (
            <EmptyState title="No secrets yet">Add one below.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>When an app reads it</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map((s) => (
                  <TableRow key={s.name}>
                    <TableCell className="font-mono">{s.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{s.kind}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">
                      {s.kind === "minted" && s.parent ? (
                        <>
                          Gets a fresh key made from{" "}
                          <Link to="/parents/$name" params={{ name: s.parent }} className="text-foreground hover:underline">
                            {s.parent}
                          </Link>
                          .
                        </>
                      ) : (
                        KINDS[s.kind]
                      )}
                    </TableCell>
                    <TableCell>
                      <ConfirmButton
                        label="Delete"
                        title={`Delete ${s.name}?`}
                        description={`Apps that read ${s.name} from ${project}/${env} stop getting it. It can't be undone.`}
                        onConfirm={async () => {
                          await api("PATCH", base, { delete: [s.name] })
                          await router.invalidate()
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add or replace a secret</CardTitle>
          <CardDescription>Saving a name that exists replaces its value.</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="secret-form" onSubmit={save.onSubmit}>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="secret-name">Name</FieldLabel>
                  <Input
                    id="secret-name"
                    name="name"
                    required
                    pattern="[A-Z_][A-Z0-9_]*"
                    placeholder="DATABASE_URL"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <FieldDescription>Uppercase, the way the app expects it.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="secret-kind">Kind</FieldLabel>
                  <NativeSelect
                    id="secret-kind"
                    className="w-full"
                    value={kind}
                    onChange={(e) => setKind(e.target.value as Kind)}
                  >
                    {(Object.keys(KINDS) as Kind[]).map((k) => (
                      <NativeSelectOption key={k} value={k}>
                        {k}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>{KINDS[kind]}</FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="secret-value">Value</FieldLabel>
                {/* Masked while typing; a minted spec is JSON, not a credential, so it shows. */}
                <Textarea
                  id="secret-value"
                  name="value"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={random}
                  className={kind === "minted" ? "font-mono" : "font-mono [-webkit-text-security:disc]"}
                  placeholder={kind === "minted" ? '{"parent": "cloudflare", "ttlMinutes": 60}' : undefined}
                />
                <FieldDescription>
                  {kind === "minted"
                    ? overview.parents?.length
                      ? "A JSON spec that names a parent key."
                      : "Minted secrets need a parent key first. Add one on Parent keys."
                    : "Write-only. Nobody can read it back here."}
                </FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="secret-random"
                  checked={random}
                  onCheckedChange={(v) => setRandom(v === true)}
                />
                <FieldLabel htmlFor="secret-random" className="font-normal">
                  Generate a random value instead
                </FieldLabel>
              </Field>
              <ErrorAlert error={save.error} />
              <SubmitButton busy={save.busy}>Save secret</SubmitButton>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Use these secrets</CardTitle>
          <CardDescription>
            Run your command with every secret here as an environment variable.
            {overview.key.type === "user" ? (
              <>
                {" "}To give an app its own access, make a key on{" "}
                <Link to="/keys" className="text-foreground hover:underline">Access</Link>.
              </>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Command>{`vault run --project ${project} --env ${env} -- your-command`}</Command>
        </CardContent>
      </Card>
    </>
  )
}
