/**
 * The hosted MCP server at `/mcp`: the vault's agent tools for clients that
 * cannot run `vault mcp` (claude.ai, Claude Desktop chat, Cowork, Managed
 * Agents). One fresh server per request, built for the caller's OAuth grant.
 *
 * Unlike `vault mcp`, values never leave the Worker: `use_secret` sends the
 * request from here, and new values are typed into the web UI, not the chat.
 * Approvals for `use_secret` come from the user, either in the chat (clients
 * with form elicitation) or on an approval page in the web UI that only a
 * signed-in operator can use, so the agent cannot approve itself.
 */
import {
  McpServer,
  acceptedContent,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as v from "valibot";
import { z } from "zod";

import { SECRET_NAME } from "../collection-contract.ts";
import type { VaultStore } from "../db.ts";
import { exportSecrets } from "../export.ts";
import { approvalKey, type GrantApprovals } from "../oauth.ts";
import type { Minter } from "../parents/minter.ts";
import { PolicyError, assertScope } from "../policy.ts";
import type { ApiKeyRecord, Scope } from "../types.ts";
import { brokeredFetch, placeholderNames, requestHost } from "./broker.ts";
import { capabilitySchema, elicitationModes } from "./task-protocol.ts";

export type HostedContext = {
  store: VaultStore;
  key: ApiKeyRecord;
  approvals: GrantApprovals;
  minter: Minter;
  origin: string;
};

type Json = z.infer<ReturnType<typeof z.json>>;
const result = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const failure = (error: unknown) => ({
  isError: true,
  ...result({ error: error instanceof Error ? error.message : "Vault request failed" }),
});
const allowSchema = v.object({ decision: v.literal("allow") });
const scopeArgs = {
  project: z.string().max(120).optional(),
  env: z.string().max(120).optional(),
};
const enc = encodeURIComponent;

export function createHostedMcp(ctx: HostedContext) {
  const scopes = ctx.key.scopes ?? [];
  const list = scopes.map((s) => `${s.project}/${s.env}`).join(", ");
  const server = new McpServer(
    { name: "vault", version: "1.0.0" },
    {
      instructions: `Secrets for ${list}. Call describe_context first. Call HTTP APIs with use_secret and {{NAME}} placeholders in headers; the vault sends the request, so you never see a key. Ask for a missing secret with collect_secret; the user types it into the vault, never the chat. Never ask the user to paste a secret.`,
    },
  );
  const capabilities = (c: ServerContext) => v.parse(capabilitySchema, c.mcpReq.envelope ?? {});

  /** The project/env a call names, or the only one this connection has. */
  const target = (project?: string, env?: string): Scope => {
    if (project == null && env == null && scopes.length === 1) return scopes[0]!;
    if (project == null || env == null)
      throw new PolicyError(400, `Pass project and env. This connection has: ${list}`);
    assertScope(ctx.key, project, env);
    return { project, env };
  };
  const names = async (scope: Scope) => {
    const { environmentId } = await ctx.store.requireEnvironment(scope.project, scope.env);
    // Older rows may predate the name rule; never echo them into agent context.
    return (await ctx.store.listSecretMeta(environmentId))
      .filter(({ name }) => SECRET_NAME.test(name))
      .map(({ name, kind }) => ({ name, kind }));
  };

  server.registerTool(
    "describe_context",
    {
      description: "List the project/environments this connection can use and their secret names and kinds. No values.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const environments = [];
      for (const scope of scopes) {
        try {
          environments.push({ ...scope, secrets: await names(scope) });
        } catch {
          // A deleted environment just drops out.
        }
      }
      await ctx.store.audit({ keyPrefix: ctx.key.keyPrefix, action: "list", status: "ok" });
      return result({
        environments,
        message:
          "Call APIs with use_secret and {{NAME}} placeholders so keys never reach you. Ask for missing values with collect_secret.",
      });
    },
  );

  server.registerTool(
    "use_secret",
    {
      description:
        "Make an HTTPS request with secrets you cannot see. Write {{NAME}} only in header values (e.g. Authorization: Bearer {{STRIPE_KEY}}). The vault fills them in, sends the request from its own server, and replaces the values with placeholders in the response. The user approves each secret/host pair first. Pass project and env when the connection has more than one.",
      inputSchema: z
        .object({
          ...scopeArgs,
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          url: z.string().max(4000),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().max(1_000_000).optional(),
        })
        .strict(),
    },
    async ({ project, env, ...request }, c) => {
      let scope: Scope, host: string, wanted: string[];
      try {
        scope = target(project, env);
        host = requestHost(request);
        wanted = placeholderNames(request);
        if (wanted.length === 0) throw new Error("use_secret needs at least one {{NAME}} placeholder");
      } catch (error) {
        return failure(error);
      }
      const send = async () => {
        try {
          const secrets = await exportSecrets(ctx.store, ctx.minter, ctx.key, scope.project, scope.env, wanted);
          const values = Object.fromEntries(secrets.map((s) => [s.name, s.value]));
          const missing = wanted.filter((name) => !(name in values));
          if (missing.length > 0)
            return result({ missing, message: "Ask the user for these with collect_secret, then retry." });
          const response = await brokeredFetch(request, values);
          for (const name of wanted)
            await ctx.store.audit({
              keyPrefix: ctx.key.keyPrefix,
              action: "broker",
              status: String(response.status),
              secretName: name,
              host,
            });
          return result(response);
        } catch (error) {
          return failure(error);
        }
      };

      const granted = (await ctx.approvals.read()).granted;
      const now = Date.now();
      const pending = wanted.filter(
        (name) => (granted[approvalKey(scope, name, host)] ?? 0) <= now,
      );
      if (pending.length === 0) return send();

      // In the chat, when the client can ask: the same question `vault mcp` asks.
      const responses = c.mcpReq.inputResponses;
      const state = `${scope.project}/${scope.env} ${host} ${pending.join(",")}`;
      const answered = inputResponse(responses, "vault").kind === "elicit";
      if (acceptedContent(responses, "vault", allowSchema) != null && c.mcpReq.requestState<string>() === state) {
        await ctx.approvals.allow(scope, pending, host, 15);
        return send();
      }
      if (answered) return result({ denied: true, message: "The user did not allow this." });
      if (elicitationModes(capabilities(c)).form)
        return inputRequired({
          requestState: state,
          inputRequests: {
            vault: inputRequired.elicit({
              message: `Allow the AI to send ${pending.join(", ")} (${scope.project}/${scope.env}) to ${host} for the next 15 minutes? First request: ${request.method} ${new URL(request.url).pathname}. The vault sends the request; the AI never sees the key.`,
              requestedSchema: {
                type: "object",
                properties: {
                  decision: { type: "string", title: "Decision", enum: ["allow", "deny"] },
                },
                required: ["decision"],
              },
            }),
          },
        });
      // Otherwise on a page only a signed-in operator can use.
      const id = await ctx.approvals.request(scope, pending, host);
      return result({
        approvalRequired: true,
        url: `${ctx.origin}/ui#/approve/${enc(id)}`,
        message: `Ask the user to open this link and allow ${pending.join(", ")} for ${host}, then call use_secret again. Do not open it yourself.`,
      });
    },
  );

  server.registerTool(
    "collect_secret",
    {
      description:
        "Ask the user for a missing secret. They type it into the vault's web page, never this chat, and you get only whether it is stored. Pass project and env when the connection has more than one.",
      inputSchema: z.object({ ...scopeArgs, name: z.string().regex(SECRET_NAME) }).strict(),
    },
    async ({ project, env, name }, c) => {
      let scope: Scope;
      try {
        scope = target(project, env);
      } catch (error) {
        return failure(error);
      }
      const stored = async () => (await names(scope)).some((secret) => secret.name === name);
      if (await stored()) return result({ name, state: "stored" });
      const url = `${ctx.origin}/ui#/collect/${enc(scope.project)}/${enc(scope.env)}/${enc(name)}`;
      const answered = inputResponse(c.mcpReq.inputResponses, "vault").kind === "elicit";
      if (!answered && elicitationModes(capabilities(c)).url)
        return inputRequired({
          inputRequests: {
            vault: inputRequired.elicitUrl({
              url,
              message: `Enter ${name} for ${scope.project}/${scope.env} in the vault. It is saved there; the AI never sees it.`,
            }),
          },
        });
      return result({
        name,
        state: "waiting",
        url,
        message: `Ask the user to open this link and enter ${name} there; it goes straight to the vault. Then call collect_secret again to check. Never ask for the value in chat.`,
      });
    },
  );

  return server;
}
