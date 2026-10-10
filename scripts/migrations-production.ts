/**
 * Apply D1 migrations to the production database.
 *
 * The database id comes from cloudflare.config.ts in production mode, which
 * reads `.env` the same way `bun run deploy` does. A shell `$VAULT_D1_ID` in
 * package.json would see only the shell's environment, not `.env`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import config from "../cloudflare.config.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { worker } = await config({ mode: "production", isPreview: false });
const databaseId = worker.env.DB.id;
if (databaseId == null) throw new Error("cloudflare.config.ts DB binding has no id");

const child = Bun.spawn(["bunx", "cf", "d1", "migrations", "apply", databaseId], {
  cwd: packageRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
