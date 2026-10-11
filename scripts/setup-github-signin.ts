/**
 * Turn on "Sign in with GitHub" for a deployed vault, in one command:
 *
 *   bun run setup:github-signin https://<your vault>
 *
 * It opens GitHub with a ready-made GitHub App (only its name is yours to
 * change), so the one thing to do in the browser is click "Create". GitHub
 * hands the app's client id and secret back to this script, which never
 * prints the secret: it goes straight into Secrets Store as
 * `<prefix>_GITHUB_CLIENT_SECRET`, and the client id into `.env`. Then it
 * applies the migrations and deploys.
 *
 * Running it again after a partial failure skips the steps already done.
 *
 * @see {@link https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest}
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import { cf, production } from "./cloudflare.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

const vaultUrl = process.argv[2]?.replace(/\/+$/u, "");
if (vaultUrl == null || !/^https:\/\/[^/]+$/u.test(vaultUrl)) {
  console.error("usage: bun run setup:github-signin https://<your vault host>");
  process.exit(1);
}

const config = await production();
const storeId = config.worker.env.BOOTSTRAP_TOKEN.storeId;
const secretName = config.worker.env.BOOTSTRAP_TOKEN.secretName.replace(/BOOTSTRAP_TOKEN$/u, "GITHUB_CLIENT_SECRET");

function readEnvFile(): string {
  try {
    return readFileSync(envPath, "utf8");
  } catch {
    return "";
  }
}

async function secretExists(): Promise<boolean> {
  const out = await cf(
    config.accountId,
    Bun.$`bunx cf secrets-store secrets list --store-id ${storeId} --search ${secretName} --per-page 100`,
  );
  return v
    .parse(v.array(v.looseObject({ name: v.string() })), JSON.parse(out))
    .some((secret) => secret.name === secretName);
}

/** Opens GitHub's "create app" page with the manifest; resolves with the new app's credentials. */
async function createGithubApp(): Promise<{ clientId: string; clientSecret: string; htmlUrl: string }> {
  const conversionSchema = v.looseObject({ client_id: v.string(), client_secret: v.string(), html_url: v.string() });
  const { promise, resolve, reject } = Promise.withResolvers<v.InferOutput<typeof conversionSchema>>();
  const state = crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        const manifest = {
          name: `${new URL(vaultUrl!).hostname.split(".")[0]}-${state.slice(0, 4)}`.slice(0, 34),
          url: `${vaultUrl}/ui`,
          redirect_url: `${url.origin}/done`,
          callback_urls: [`${vaultUrl}/auth/github/callback`],
          description: "Sign in to the vault web UI.",
          public: false,
          hook_attributes: { url: `${vaultUrl}/`, active: false },
          default_permissions: {},
        };
        const json = JSON.stringify(manifest).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Create the vault's GitHub app</title>` +
            `<form id="f" method="post" action="https://github.com/settings/apps/new?state=${state}">` +
            `<input type="hidden" name="manifest" value="${json}">` +
            `<p style="font:16px system-ui;margin:2rem">Taking you to GitHub… <button>Continue</button></p></form>` +
            `<script>document.getElementById("f").submit()</script>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/done") {
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || code == null) return new Response("Unexpected request.", { status: 400 });
        const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
          method: "POST",
          headers: { Accept: "application/vnd.github+json", "User-Agent": "buildwf-vault" },
        });
        const parsed = v.safeParse(conversionSchema, await response.json().catch(() => null));
        if (!response.ok || !parsed.success) {
          reject(new Error(`GitHub did not return the app's credentials (${response.status})`));
          return new Response("GitHub did not return the app's credentials. Check the terminal.", { status: 502 });
        }
        resolve(parsed.output);
        return new Response(
          `<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;margin:2rem">Done. The GitHub app is made; the terminal finishes the rest. You can close this tab.</p>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const start = `${server.url.origin}/`;
  console.log(`Opening GitHub. Click "Create GitHub App" there.\nIf no browser opens, visit ${start}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    Bun.spawn([opener, start], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // No opener here; the printed link works.
  }
  try {
    const app = await promise;
    return { clientId: app.client_id, clientSecret: app.client_secret, htmlUrl: app.html_url };
  } finally {
    server.stop();
  }
}

const existingId = /^VAULT_GITHUB_CLIENT_ID=(.+)$/mu.exec(readEnvFile())?.[1]?.trim();
if (existingId != null && existingId !== "" && (await secretExists())) {
  console.log(`GitHub app already set up (client id ${existingId}); skipping to deploy.`);
} else {
  const app = await createGithubApp();
  console.log(`Created ${app.htmlUrl}`);
  if (await secretExists())
    throw new Error(`${secretName} already exists in Secrets Store; delete it in the Cloudflare dashboard and run this again`);
  // The secret goes in on stdin, so no argv, shell history or process listing holds it.
  // Never add --dry-run here: cf prints the body in dry-run output.
  const body = JSON.stringify([{ name: secretName, value: app.clientSecret, scopes: ["workers"], comment: "vault GitHub sign-in" }]);
  await cf(config.accountId, Bun.$`bunx cf secrets-store secrets create ${storeId} --body @/dev/stdin < ${Buffer.from(body)}`);
  console.log(`Saved the client secret in Secrets Store as ${secretName}.`);
  const env = readEnvFile();
  const line = `VAULT_GITHUB_CLIENT_ID=${app.clientId}`;
  writeFileSync(
    envPath,
    /^#?\s*VAULT_GITHUB_CLIENT_ID=.*$/mu.test(env)
      ? env.replace(/^#?\s*VAULT_GITHUB_CLIENT_ID=.*$/mu, line)
      : `${env}${env.endsWith("\n") || env === "" ? "" : "\n"}${line}\n`,
  );
  console.log(`Saved ${line} in .env.`);
}

// A stray exported API token overrides the cf login and lacks D1 access.
const { CLOUDFLARE_API_TOKEN: _, ...env } = process.env;
for (const script of ["migrations:production", "deploy"]) {
  console.log(`\nbun run ${script}`);
  const child = Bun.spawn(["bun", "run", script], { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) {
    console.error(`\n${script} failed. Fix that (often: bunx cf auth login), then run this command again; it skips what is done.`);
    process.exit(1);
  }
}
console.log(`\nDone. Add people with: vault people add GITHUB_LOGIN\nThen sign in at ${vaultUrl}/ui with GitHub.`);
