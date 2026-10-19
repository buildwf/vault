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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Command, ErrorAlert, SubmitButton, useSubmit } from "@/components/page"
import { api, setKey } from "@/lib/api"
import { hasNext, takeNext } from "@/lib/session"

export const Route = createFileRoute("/signin")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: SignIn,
})

function SignIn() {
  const { error } = Route.useSearch()
  const router = useRouter()
  const [github, setGithub] = React.useState(false)
  React.useEffect(() => {
    document.title = "Sign in · Vault"
    // The GitHub button shows only when this vault has a GitHub app set up.
    fetch("/", { cache: "no-store" })
      .then((res) => res.json())
      .then((info: { githubSignIn?: boolean }) => setGithub(!!info.githubSignIn))
      .catch(() => {})
  }, [])

  const paste = useSubmit(async (form) => {
    setKey(String(form.get("key") ?? "").trim())
    try {
      await api("GET", "/v1/overview")
    } catch (e) {
      setKey(null)
      throw e
    }
    router.history.push(takeNext() ?? "/")
  })

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-base">Sign in to Vault</CardTitle>
          <CardDescription>
            {hasNext()
              ? "An app is asking to use this vault. Sign in to continue."
              : "The vault keeps the secrets your apps and AI agents run with."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <ErrorAlert error={error} />
            {github ? (
              <Field>
                <Button asChild>
                  <a href="/auth/github">Sign in with GitHub</a>
                </Button>
                <FieldDescription>
                  For GitHub accounts an operator added to the org.
                </FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel>{github ? "Or, from a terminal where you're logged in" : "From a terminal where you're logged in"}</FieldLabel>
              <Command>vault ui</Command>
              <FieldDescription>It opens this page signed in as you.</FieldDescription>
            </Field>
            <FieldSeparator>or paste a vault key</FieldSeparator>
            <form onSubmit={paste.onSubmit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="key">Vault key</FieldLabel>
                  <Input
                    id="key"
                    name="key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <FieldDescription>
                    Kept in this tab only, and cleared when you close it.
                  </FieldDescription>
                </Field>
                <ErrorAlert error={paste.error} />
                <SubmitButton busy={paste.busy}>Sign in</SubmitButton>
              </FieldGroup>
            </form>
          </FieldGroup>
        </CardContent>
      </Card>
    </main>
  )
}
