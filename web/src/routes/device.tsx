import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/* Where `vault login --device` lands after the sign-in page; the CLI picks up the answer itself. */
export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
    error_description:
      typeof search.error_description === "string" ? search.error_description : undefined,
  }),
  component: Device,
})

function Device() {
  const { error, error_description } = Route.useSearch()
  const [title, text] =
    error == null
      ? ["Signed in", "The CLI finishes signing in by itself. You can close this tab."]
      : error === "access_denied"
        ? ["Cancelled", "The CLI was not signed in."]
        : ["The CLI was not signed in", `${error_description ?? error}. Ask it for a new link.`]
  React.useEffect(() => {
    document.title = `${title} · Vault`
  }, [title])

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{text}</CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}
