import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ActionForm, Confirm, Page, Rows, Section } from "@/components/vault"
import { api, enc } from "@/lib/vault"

export const Route = createFileRoute("/projects/")({ component: Projects })

function Projects() {
  const overview = useOverview()
  const navigate = useNavigate()
  const operator = overview.key.type === "user"
  return (
    <Page title="Projects" description="A project is one app. Each has environments, like dev and prod, that hold its secrets.">
      <Section title="All projects">
        <Rows
          rows={overview.projects}
          empty="No projects yet."
          columns={[
            {
              label: "Project",
              cell: (p) => (
                <Link to="/projects/$project" params={{ project: p.name }} className="font-mono underline">
                  {p.name}
                </Link>
              ),
            },
            {
              label: "Environments",
              cell: (p) => (p.environments.length === 0 ? "none yet" : p.environments.map((e) => e.name).join(", ")),
            },
            {
              label: "",
              className: "text-right",
              cell: (p) =>
                operator && (
                  <Confirm
                    label="Delete"
                    question={`Delete ${p.name} with all its environments and secrets?`}
                    action={() => api("DELETE", `/v1/projects/${enc(p.name)}`)}
                  />
                ),
            },
          ]}
        />
      </Section>
      {operator && (
        <Section title="New project">
          <ActionForm
            submit="Create project"
            onSubmit={async (data) => {
              const name = String(data.get("name")).trim()
              await api("POST", "/v1/projects", { name })
              await navigate({ to: "/projects/$project", params: { project: name.toLowerCase() } })
            }}
          >
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required maxLength={120} autoComplete="off" />
              <FieldDescription>Name it after the app.</FieldDescription>
            </Field>
          </ActionForm>
        </Section>
      )}
    </Page>
  )
}
