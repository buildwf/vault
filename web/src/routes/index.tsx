import { Link, createFileRoute } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Command, Facts, Page, Rows, Section } from "@/components/vault"
import { access, mintedFrom, when } from "@/lib/vault"

export const Route = createFileRoute("/")({ component: Overview })

const GLOSSARY: [string, string][] = [
  ["Project", "One app or service."],
  ["Environment", "The secrets for one stage of a project, like dev or prod. An app reads one environment."],
  ["Secret", "A named value, like DATABASE_URL. Values are encrypted and never shown here."],
  ["Parent key", "One powerful credential per service. It never leaves the vault."],
  ["Minted key", "A short-lived key the vault makes from a parent each time an app reads it."],
  ["Vault key", "How a person, app or agent talks to the vault."],
]

function Overview() {
  const overview = useOverview()
  const rows = overview.projects.flatMap((p) =>
    p.environments.length === 0
      ? [{ project: p.name, env: null as string | null, count: 0 }]
      : p.environments.map((e) => ({ project: p.name, env: e.name as string | null, count: e.secrets.length })),
  )
  return (
    <Page
      title={overview.platform ? "Platform" : (overview.org ?? "Vault")}
      description="The secrets your apps and agents run with. This page shows what is stored and who can reach it, never a value."
    >
      <Section title="You">
        <Facts
          items={[
            ["Signed in as", `${overview.key.label ?? "unlabelled key"} (${overview.key.keyPrefix})`],
            ["Org", overview.platform ? "platform (the vault's own org)" : (overview.org ?? "—")],
            ["Access", access(overview.key)],
            ["Key expires", when(overview.key.expiresAt)],
          ]}
        />
      </Section>
      {overview.platform && (
        <Section title="You are in the platform org">
          It creates <Link to="/orgs" className="underline">orgs</Link> but cannot see inside them. To see an org's
          secrets, run <code>vault ui</code> with that org's login.
        </Section>
      )}
      <Section title="What is stored">
        <Rows
          rows={rows}
          empty={overview.platform ? "The platform org has no projects." : "Nothing yet. Create a project to start."}
          columns={[
            {
              label: "Project",
              cell: (r) => (
                <Link to="/projects/$project" params={{ project: r.project }} className="font-mono underline">
                  {r.project}
                </Link>
              ),
            },
            {
              label: "Environment",
              cell: (r) =>
                r.env ? (
                  <Link to="/projects/$project/$env" params={{ project: r.project, env: r.env }} className="font-mono underline">
                    {r.env}
                  </Link>
                ) : (
                  "—"
                ),
            },
            { label: "Secrets", cell: (r) => r.count, className: "text-right" },
          ]}
        />
      </Section>
      {overview.parents && overview.parents.length > 0 && (
        <Section title="Parent keys" description="Root credentials the vault makes short-lived keys from.">
          <Rows
            rows={overview.parents}
            empty=""
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
              { label: "Live keys", cell: (p) => p.activeChildren, className: "text-right" },
            ]}
          />
        </Section>
      )}
      <Section title="How it fits together">
        <Facts items={GLOSSARY} />
      </Section>
      <Section title="From a terminal" description="Run a command with an environment's secrets as variables.">
        <Command>vault run --project PROJECT --env ENV -- your-command</Command>
      </Section>
    </Page>
  )
}
