import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  ConfirmButton,
  EmptyState,
  ErrorAlert,
  PageHeader,
  SubmitButton,
  useSubmit,
} from "@/components/page"
import { api, enc } from "@/lib/api"

export const Route = createFileRoute("/_app/projects/$project/")({
  beforeLoad: ({ context, params }) => {
    const project = context.overview.projects.find((p) => p.name === params.project)
    if (!project) throw notFound()
    return { project }
  },
  component: Project,
})

function Project() {
  const { overview, project } = Route.useRouteContext()
  const router = useRouter()
  const operator = overview.key.type === "user"
  const name = project.name
  const create = useSubmit(async (form) => {
    const env = String(form.get("name") ?? "").trim()
    await api("POST", `/v1/projects/${enc(name)}/environments`, { name: env })
    await router.navigate({
      to: "/projects/$project/$env",
      params: { project: name, env: env.toLowerCase() },
    })
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
            <BreadcrumbPage>{name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={name}>
        Each environment is a separate set of secrets for this app, like dev
        and prod. An app gets a key for one environment and sees only that.
      </PageHeader>

      <Card>
        <CardContent>
          {project.environments.length === 0 ? (
            <EmptyState title="No environments yet">Most apps start with dev and prod.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Environment</TableHead>
                  <TableHead className="text-right">Secrets</TableHead>
                  {operator ? <TableHead className="w-0" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {project.environments.map((e) => (
                  <TableRow key={e.name}>
                    <TableCell className="font-medium">
                      <Link
                        to="/projects/$project/$env"
                        params={{ project: name, env: e.name }}
                        className="hover:underline"
                      >
                        {e.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{e.secrets.length}</TableCell>
                    {operator ? (
                      <TableCell>
                        <ConfirmButton
                          label="Delete"
                          title={`Delete ${name}/${e.name}?`}
                          description="This deletes the environment and all its secrets. It can't be undone."
                          onConfirm={async () => {
                            await api("DELETE", `/v1/projects/${enc(name)}/environments/${enc(e.name)}`)
                            await router.invalidate()
                          }}
                        />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {operator ? (
        <Card>
          <CardHeader>
            <CardTitle>New environment</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={create.onSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="env-name">Name</FieldLabel>
                  <Input id="env-name" name="name" required maxLength={120} autoComplete="off" placeholder="dev" />
                  <FieldDescription>Like dev, staging or prod.</FieldDescription>
                </Field>
                <ErrorAlert error={create.error} />
                <SubmitButton busy={create.busy}>Create environment</SubmitButton>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
