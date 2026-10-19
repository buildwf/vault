# Vault web UI

The site the vault Worker serves at `/ui`. It is plain [shadcn/ui](https://ui.shadcn.com) on TanStack Start (zinc, Inter, Mira style), built as a single-page app.

- Pages are in `src/routes`. They live in the URL's `#fragment` (`/ui#/projects`), so links from the CLI and from AI apps never reach a server log.
- `src/lib/api.ts` talks to the `/v1` API with the vault key the tab signed in with.
- `src/components/ui` holds stock shadcn components. Add more with `bunx shadcn@latest add NAME` from this folder.

## Build

From the repository root:

```sh
bun install          # also builds the UI
bun run build:ui     # rebuild after a change
```

`scripts/embed-ui.ts` builds this folder and embeds the result in the Worker (`src/ui/assets.gen.ts`). `bun run deploy` rebuilds it first.

To try a change locally, run `bun run dev` at the root and open `/ui` on the local Worker.
