import * as React from "react"

/** Label and value pairs, one per row. */
export function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs/relaxed sm:grid-cols-[10rem_1fr]">
      {items.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}
