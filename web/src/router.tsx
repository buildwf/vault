import {
  createHashHistory,
  createMemoryHistory,
  createRouter as createTanStackRouter,
} from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import { boot } from "@/lib/session"

export function getRouter() {
  // Pages live in the #fragment (/ui#/projects), so links from the CLI and
  // from AI apps never reach a server log. The build prerenders the shell
  // without a window, in memory.
  const browser = typeof window !== "undefined"
  if (browser) boot()
  const router = createTanStackRouter({
    routeTree,
    history: browser ? createHashHistory() : createMemoryHistory(),
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
