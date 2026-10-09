/**
 * The vault Worker's single entry into this deployment: `POST /vault/rpc`.
 *
 * The body names one `VaultBackend` operation and its arguments, and the
 * request must carry `Authorization: Bearer <VAULT_STORAGE_TOKEN>`, the shared
 * secret set both here (`npx convex env set VAULT_STORAGE_TOKEN ...`) and in
 * the Worker's Secrets Store. Anything else is a 401 or 404 before a function
 * runs. An unset or short token refuses every request rather than accepting
 * an empty one.
 */
import { httpRouter } from "convex/server";
import type { FunctionReference } from "convex/server";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const MIN_TOKEN_LENGTH = 32;

type Operation =
  | { kind: "query"; ref: FunctionReference<"query", "internal"> }
  | { kind: "mutation"; ref: FunctionReference<"mutation", "internal"> };

const query = (ref: FunctionReference<"query", "internal">): Operation => ({
  kind: "query",
  ref,
});
const mutation = (ref: FunctionReference<"mutation", "internal">): Operation => ({
  kind: "mutation",
  ref,
});

const operations = new Map<string, Operation>([
  ["findWrap", query(internal.vault.findWrap)],
  ["countWraps", query(internal.vault.countWraps)],
  ["insertWrap", mutation(internal.vault.insertWrap)],
  ["listWraps", query(internal.vault.listWraps)],
  ["deleteWrap", mutation(internal.vault.deleteWrap)],
  ["insertKey", mutation(internal.vault.insertKey)],
  ["claimBootstrap", mutation(internal.vault.claimBootstrap)],
  ["isBootstrapped", query(internal.vault.isBootstrapped)],
  ["findKeyByHash", query(internal.vault.findKeyByHash)],
  ["findKeyByPrefix", query(internal.vault.findKeyByPrefix)],
  ["listKeys", query(internal.vault.listKeys)],
  ["revokeKey", mutation(internal.vault.revokeKey)],
  ["rotateKey", mutation(internal.vault.rotateKey)],
  ["touchKey", mutation(internal.vault.touchKey)],
  ["createProject", mutation(internal.vault.createProject)],
  ["listProjects", query(internal.vault.listProjects)],
  ["getProject", query(internal.vault.getProject)],
  ["deleteProject", mutation(internal.vault.deleteProject)],
  ["createEnvironment", mutation(internal.vault.createEnvironment)],
  ["deleteEnvironment", mutation(internal.vault.deleteEnvironment)],
  ["listEnvironments", query(internal.vault.listEnvironments)],
  ["getEnvironment", query(internal.vault.getEnvironment)],
  ["listSecretRows", query(internal.vault.listSecretRows)],
  ["insertSecret", mutation(internal.vault.insertSecret)],
  ["upsertSecret", mutation(internal.vault.upsertSecret)],
  ["deleteSecret", mutation(internal.vault.deleteSecret)],
  ["getSecretRow", query(internal.vault.getSecretRow)],
  ["insertAudit", mutation(internal.vault.insertAudit)],
  ["listAudit", query(internal.vault.listAudit)],
  ["pruneAudit", mutation(internal.vault.pruneAudit)],
]);

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Compares SHA-256 digests in full, so timing does not depend on where they differ. */
async function tokenMatches(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(provided), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const http = httpRouter();

http.route({
  path: "/vault/rpc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.VAULT_STORAGE_TOKEN ?? "";
    if (expected.length < MIN_TOKEN_LENGTH)
      return json({ error: "vault storage token is not configured" }, 500);
    const header = request.headers.get("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!(await tokenMatches(provided, expected))) return json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid request" }, 400);
    }
    if (typeof body !== "object" || body == null) return json({ error: "invalid request" }, 400);
    const { op, args } = body as { op?: unknown; args?: unknown };
    const operation = typeof op === "string" ? operations.get(op) : undefined;
    if (operation == null) return json({ error: "unknown operation" }, 404);
    if (typeof args !== "object" || args == null || Array.isArray(args))
      return json({ error: "invalid request" }, 400);

    try {
      const result =
        operation.kind === "query"
          ? await ctx.runQuery(operation.ref, args as Record<string, unknown>)
          : await ctx.runMutation(operation.ref, args as Record<string, unknown>);
      return json({ result: result ?? null });
    } catch (error) {
      console.error("vault storage operation failed", op, String(error));
      return json({ error: "storage operation failed" }, 500);
    }
  }),
});

export default http;
