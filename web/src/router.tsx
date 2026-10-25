import { createHashHistory, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

// Hash routes: the Worker and CLI link to /ui#/connect/..., /ui#signin=CODE and so on,
// and a sign-in code in the fragment never reaches a server log.
export function getRouter() {
  return createRouter({
    routeTree,
    history: typeof window === "undefined" ? undefined : createHashHistory(),
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
