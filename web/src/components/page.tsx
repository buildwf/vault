import * as React from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"

/** A page's title and one plain sentence on what it is for. */
export function PageHeader({
  title,
  children,
  action,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  React.useEffect(() => {
    document.title = `${title} · Vault`
  }, [title])
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex max-w-2xl flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {children ? (
          <p className="text-sm text-muted-foreground">{children}</p>
        ) : null}
      </div>
      {action}
    </div>
  )
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (error == null) return null
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>That didn't work</AlertTitle>
      <AlertDescription>
        {error instanceof Error ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <Empty className="border border-dashed">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {children ? <EmptyDescription>{children}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  )
}

/** A new vault key, shown the one time the vault can return it. */
export function OnceKey({
  title,
  value,
  children,
}: {
  title: string
  value: string
  children?: React.ReactNode
}) {
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{children ?? "Copy it now. The vault won't show it again."}</span>
        <code className="rounded-md bg-muted px-2 py-1 font-mono break-all text-foreground">
          {value}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            navigator.clipboard.writeText(value).then(() => toast("Copied"))
          }
        >
          Copy
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/** A command to paste into a terminal. */
export function Command({ children }: { children: string }) {
  return (
    <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
      {children}
    </code>
  )
}

/** A destructive action behind an "are you sure" dialog. */
export function ConfirmButton({
  label,
  title,
  description,
  confirm,
  onConfirm,
  size = "sm",
}: {
  label: string
  title: string
  description: string
  confirm?: string
  onConfirm: () => Promise<unknown>
  size?: "sm" | "default"
}) {
  const [busy, setBusy] = React.useState(false)
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size={size} disabled={busy}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error))
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirm ?? label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Runs a form's async submit, tracking busy and error state. */
export function useSubmit<T>(action: (form: FormData) => Promise<T>) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<unknown>(null)
  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    setBusy(true)
    setError(null)
    try {
      await action(new FormData(form))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, onSubmit }
}

export function SubmitButton({
  busy,
  children,
}: {
  busy: boolean
  children: React.ReactNode
}) {
  return (
    <Button type="submit" disabled={busy} className="self-start">
      {busy ? <Spinner data-icon="inline-start" /> : null}
      {children}
    </Button>
  )
}

export function NotFound() {
  return (
    <div className="flex flex-col items-start gap-4">
      <PageHeader title="Not found">There is no page here.</PageHeader>
      <Button variant="outline" asChild>
        <Link to="/">Back to the overview</Link>
      </Button>
    </div>
  )
}

export function Pending() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Loading…
    </div>
  )
}
