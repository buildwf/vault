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

export const Route = createFileRoute("/_app/projects/")({ component: Projects })

function Projects() {
  const { overview: ov } = Route.useRouteContext()
  const router = useRouter()
  const operator = ov.key.type === "user"
  const create = useSubmit(async (form) => {
    const name = String(form.get("name") ?? "").trim()
    await api("POST", "/v1/projects", { name })
    await router.navigate({ to: "/projects/$project", params: { project: name.toLowerCase() } })
  })

  return (
    <>
      <PageHeader title="Projects">
        A project is one app or service. Each has environments, like dev and
        prod, and each environment holds the secrets that app runs with.
      </PageHeader>

      <Card>
        <CardContent>
          {ov.projects.length === 0 ? (
            <EmptyState title="No projects yet">
              {ov.platform
                ? "The platform org has no projects. Orgs keep their projects to themselves."
                : "Create one below."}
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Environments</TableHead>
                  {operator ? <TableHead className="w-0" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ov.projects.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="font-medium">
                      <Link to="/projects/$project" params={{ project: p.name }} className="hover:underline">
                        {p.name}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {p.environments.length === 0 ? (
                        <span className="text-muted-foreground">none yet</span>
                      ) : (
                        p.environments.map((e, i) => (
                          <span key={e.name}>
                            {i > 0 ? ", " : ""}
                            <Link
                              to="/projects/$project/$env"
                              params={{ project: p.name, env: e.name }}
                              className="hover:underline"
                            >
                              {e.name}
                            </Link>{" "}
                            <span className="text-muted-foreground">({e.secrets.length})</span>
                          </span>
                        ))
                      )}
                    </TableCell>
                    {operator ? (
                      <TableCell>
                        <ConfirmButton
                          label="Delete"
                          title={`Delete ${p.name}?`}
                          description="This deletes the project with all its environments and secrets. It can't be undone."
                          onConfirm={async () => {
                            await api("DELETE", `/v1/projects/${enc(p.name)}`)
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
            <CardTitle>New project</CardTitle>
            <CardDescription>Name it after the app.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={create.onSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="project-name">Name</FieldLabel>
                  <Input id="project-name" name="name" required maxLength={120} autoComplete="off" placeholder="manyave-management" />
                  <FieldDescription>Saved in lowercase.</FieldDescription>
                </Field>
                <ErrorAlert error={create.error} />
                <SubmitButton busy={create.busy}>Create project</SubmitButton>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}
