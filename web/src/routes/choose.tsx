import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ErrorAlert } from "@/components/page"
import { trade } from "@/lib/api"
import { choices, takeNext } from "@/lib/session"

/* A GitHub account that operates several orgs gets one sign-in code per org. */
export const Route = createFileRoute("/choose")({ component: Choose })

function Choose() {
  const router = useRouter()
  const options = choices()
  const [error, setError] = React.useState<unknown>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    document.title = "Choose an org · Vault"
  }, [])

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">Choose an org</CardTitle>
          <CardDescription>
            {options.length > 0
              ? "Your GitHub account operates more than one org on this vault. Pick one. You can sign out and pick another later. These choices work for two minutes."
              : "These choices have expired. Sign in again."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {options.map(([org, code]) => (
            <Button
              key={org}
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await trade(code)
                  router.history.push(takeNext() ?? "/")
                } catch (e) {
                  setError(e)
                  setBusy(false)
                }
              }}
            >
              {org}
            </Button>
          ))}
          {options.length === 0 ? (
            <Button onClick={() => router.navigate({ to: "/signin", search: { error: undefined } })}>
              Sign in
            </Button>
          ) : null}
          <ErrorAlert error={error} />
        </CardContent>
      </Card>
    </main>
  )
}
