import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"

import { Pending } from "@/components/page"
import { trade } from "@/lib/api"
import { takeCode, takeNext } from "@/lib/session"

/* `vault ui` and GitHub sign-in land here with a one-time code (see lib/session.ts). */
export const Route = createFileRoute("/signing-in")({ component: SigningIn })

function SigningIn() {
  const router = useRouter()
  React.useEffect(() => {
    const code = takeCode()
    if (code == null) {
      router.history.replace("/")
      return
    }
    trade(code)
      .then(() => router.history.replace(takeNext() ?? "/"))
      .catch((error: unknown) =>
        router.navigate({
          to: "/signin",
          search: { error: error instanceof Error ? error.message : String(error) },
          replace: true,
        })
      )
  }, [router])
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Pending />
    </main>
  )
}
