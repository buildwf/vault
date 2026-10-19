import { useState } from "react"
import { Link, useRouter } from "@tanstack/react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

/** A page: optional breadcrumbs, a title, one plain sentence, then the content. */
export function Page({
  title,
  description,
  crumbs,
  children,
}: {
  title: string
  description?: React.ReactNode
  crumbs?: { label: string; to?: string; params?: Record<string, string> }[]
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      {crumbs && (
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((c, i) => (
              <span key={i} className="contents">
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem>
                  {c.to ? (
                    <BreadcrumbLink asChild>
                      <Link to={c.to} params={c.params}>
                        {c.label}
                      </Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{c.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </span>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">{title}</h1>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

/** A titled card around one block of the page. */
export function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export type Column<T> = { label: string; cell: (row: T) => React.ReactNode; className?: string }

export function Rows<T>({ columns, rows, empty }: { columns: Column<T>[]; rows: T[]; empty: string }) {
  if (rows.length === 0)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>{empty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c, i) => (
            <TableHead key={i} className={c.className}>
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          // Keyed by content: a deleted row must take its open dialog with it.
          <TableRow key={JSON.stringify(row)}>
            {columns.map((c, i) => (
              <TableCell key={i} className={c.className}>
                {c.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (error == null) return null
  return (
    <Alert variant="destructive">
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
    </Alert>
  )
}

/**
 * Run a change against the API, then reload the route's data.
 * The action may return something to show once (a new key).
 */
export function useAction<R = unknown>() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<R | null>(null)
  async function run(action: () => Promise<R>) {
    setPending(true)
    setError(null)
    try {
      setResult(await action())
      await router.invalidate()
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      setPending(false)
    }
  }
  return { run, pending, error, result }
}

/** A form whose fields are read from FormData on submit; it resets when the action works. */
export function ActionForm<R>({
  submit,
  onSubmit,
  children,
  shown,
}: {
  submit: string
  onSubmit: (data: FormData) => Promise<R>
  children: React.ReactNode
  shown?: (result: R) => React.ReactNode
}) {
  const { run, pending, error, result } = useAction<R>()
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault()
        const form = event.currentTarget
        if (await run(() => onSubmit(new FormData(form)))) form.reset()
      }}
    >
      {result != null && shown?.(result)}
      {children}
      <ErrorAlert error={error} />
      <div>
        <Button type="submit" disabled={pending}>
          {submit}
        </Button>
      </div>
    </form>
  )
}

/** A destructive button that asks first. */
export function Confirm({
  label,
  question,
  action,
}: {
  label: string
  question: string
  action: () => Promise<unknown>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={pending}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{question}</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorAlert error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={async (event) => {
              event.preventDefault() // stay open to show an error
              setPending(true)
              setError(null)
              try {
                await action()
                setOpen(false)
                await router.invalidate()
              } catch (e) {
                setError(e)
              } finally {
                setPending(false)
              }
            }}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A value the vault shows one time only, like a new key. */
export function OnceKey({ title, value }: { title: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>Copy it now. The vault does not show it again.</span>
        <Command>{value}</Command>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigator.clipboard.writeText(value).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

export function Command({ children }: { children: React.ReactNode }) {
  return <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{children}</pre>
}

/** A label and value list, for "who you are" style facts. */
export function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
