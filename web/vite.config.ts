import { defineConfig, type Plugin } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Start points the browser's router at the page's base path (/ui). Routes
// here live in the #fragment instead, so in the browser it starts from /.
function hashRoutes(): Plugin {
  return {
    name: "vault:hash-routes",
    enforce: "post",
    configEnvironment(name) {
      if (name !== "client") return
      return {
        define: {
          "process.env.TSS_ROUTER_BASEPATH": JSON.stringify("/"),
          "import.meta.env.TSS_ROUTER_BASEPATH": JSON.stringify("/"),
        },
      }
    },
  }
}

// The vault Worker serves the build at /ui (see scripts/embed-ui.ts), so this
// is a single-page app: one prerendered shell, routed by the URL's #fragment.
const config = defineConfig({
  base: "/ui/",
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
    hashRoutes(),
  ],
})

export default config
