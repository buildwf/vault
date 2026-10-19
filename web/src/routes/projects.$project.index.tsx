import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ActionForm, Confirm, Page, Rows, Section } from "@/components/vault"
import { api, enc } from "@/lib/vault"

export const Route = createFileRoute("/projects/$project/")({
  beforeLoad: ({ context, params }) => {
    if (!context.overview.projects.some((p) => p.name === params.project)) throw notFound()
  },
  component: ProjectPage,
})

function ProjectPage() {
  const { project: name } = Route.useParams()
  const overview = useOverview()
  const navigate = useNavigate()
  const project = overview.projects.find((p) => p.name === name)!
  const operator = overview.key.type === "user"
  return (
    <Page
      title={name}
      crumbs={[{ label: "Projects", to: "/projects" }, { label: name }]}
      description="Each environment is a separate set of secrets. An app gets a key for one environment and sees only that."
    >
      <Section title="Environments">
        <Rows
          rows={project.environments}
          empty="No environments yet. Most apps start with dev and prod."
          columns={[
            {
              label: "Environment",
              cell: (e) => (
                <Link to="/projects/$project/$env" params={{ project: name, env: e.name }} className="font-mono underline">
                  {e.name}
                </Link>
              ),
            },
            { label: "Secrets", cell: (e) => e.secrets.length },
            {
              label: "",
              className: "text-right",
              cell: (e) =>
                operator && (
                  <Confirm
                    label="Delete"
                    question={`Delete ${name}/${e.name} and all its secrets?`}
                    action={() => api("DELETE", `/v1/projects/${enc(name)}/environments/${enc(e.name)}`)}
                  />
                ),
            },
          ]}
        />
      </Section>
      {operator && (
        <Section title="New environment">
          <ActionForm
            submit="Create environment"
            onSubmit={async (data) => {
              const env = String(data.get("env")).trim()
              await api("POST", `/v1/projects/${enc(name)}/environments`, { name: env })
              await navigate({ to: "/projects/$project/$env", params: { project: name, env: env.toLowerCase() } })
            }}
          >
            <Field>
              <FieldLabel htmlFor="env">Name</FieldLabel>
              <Input id="env" name="env" required maxLength={120} autoComplete="off" />
              <FieldDescription>Like dev, staging or prod.</FieldDescription>
            </Field>
          </ActionForm>
        </Section>
      )}
    </Page>
  )
}
