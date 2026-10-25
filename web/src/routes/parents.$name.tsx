import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router"

import { useOverview } from "./__root"
import { Badge } from "@/components/ui/badge"
import { Confirm, Facts, Page, Rows, Section } from "@/components/vault"
import { api, enc, mintedFrom, when } from "@/lib/vault"

type Minted = { label: string; status: string; createdAt: string; expiresAt?: string; revokedAt?: string; keyPrefix?: string }

export const Route = createFileRoute("/parents/$name")({
  beforeLoad: ({ context, params }) => {
    if (!context.overview.parents?.some((p) => p.name === params.name)) throw notFound()
  },
  loader: ({ params }) => api<{ minted: Minted[] }>("GET", `/v1/parents/${enc(params.name)}/minted`),
  component: ParentPage,
})

function ParentPage() {
  const { name } = Route.useParams()
  const { minted } = Route.useLoaderData()
  const overview = useOverview()
  const navigate = useNavigate()
  const parent = overview.parents!.find((p) => p.name === name)!
  const uses = mintedFrom(overview, name)
  return (
    <Page
      title={name}
      crumbs={[{ label: "Parent keys", to: "/parents" }, { label: name }]}
      description={`A ${parent.provider} credential kept in the vault. Apps never see it; they get short-lived keys made from it.`}
    >
      <Section title="Details">
        <Facts
          items={[
            ["Service", parent.provider],
            ["Config", Object.entries(parent.config).map(([k, v]) => `${k}=${v}`).join(" ") || "—"],
            ["Credential", "Stored encrypted, write-only"],
            ["Live keys", parent.activeChildren],
            ["Updated", when(parent.updatedAt)],
            ["Used by", uses.length === 0 ? "No minted secrets yet" : uses.map((u) => u.join("/")).join(", ")],
          ]}
        />
      </Section>
      <Section title={`Keys made from ${name}`} description="Newest first. The key itself is never stored.">
        <Rows
          rows={minted}
          empty={`None yet. One appears the first time an app reads a minted secret that names ${name}.`}
          columns={[
            {
              label: "For",
              cell: (m) => {
                const [project, env] = m.label.split("/")
                return m.label.split("/").length === 3 ? (
                  <Link to="/projects/$project/$env" params={{ project, env }} className="font-mono underline">
                    {m.label}
                  </Link>
                ) : (
                  <span className="font-mono">{m.label}</span>
                )
              },
            },
            { label: "Status", cell: (m) => <Badge variant={m.status === "active" ? "default" : "secondary"}>{m.status}</Badge> },
            { label: "Made", cell: (m) => when(m.createdAt) },
            { label: "Expires", cell: (m) => (m.revokedAt ? `revoked ${when(m.revokedAt)}` : when(m.expiresAt)) },
          ]}
        />
      </Section>
      <Section title="If something leaks" description="Revoke every live key made from this parent. Apps get a fresh key on their next read.">
        <div className="flex flex-wrap gap-2">
          <Confirm
            label="Revoke all live keys"
            question={`Revoke every live key made from ${name} at ${parent.provider}?`}
            action={() => api("POST", `/v1/parents/${enc(name)}/revoke`)}
          />
          <Confirm
            label="Delete this parent"
            question={`Delete ${name}? Minted secrets that name it stop working.`}
            action={async () => {
              await api("DELETE", `/v1/parents/${enc(name)}`)
              await navigate({ to: "/parents" })
            }}
          />
        </div>
      </Section>
    </Page>
  )
}
