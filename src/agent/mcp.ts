import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  acceptedContent,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import * as v from "valibot";
import { buildPanelHtml } from "./panel/bundle.ts" with { type: "macro" };
import { SECRET_NAME } from "../collection-contract.ts";
import { AgentRuntime } from "./runtime.ts";
import type { AgentTask } from "./tasks.ts";
import {
  browserPrompt,
  capabilitySchema,
  declined,
  elicitationModes,
  hasTaskCapability,
  secretPrompt,
  taskExtension,
  taskHandle,
  typedSecret,
} from "./task-protocol.ts";

const PANEL_URI = "ui://vault/panel.html";
const panelHtml = buildPanelHtml();
const nameSchema = z.string().regex(SECRET_NAME);
/** Model-supplied text shown in a prompt: one short, quoted line. */
const quoted = (text: string) => JSON.stringify(text.replace(/\s+/gu, " ").slice(0, 60));
const requestSchema = z.object({ requestId: z.string().uuid() }).strict();
const result = (data: z.infer<ReturnType<typeof z.json>>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const failure = (error: unknown) => ({
  isError: true,
  ...result({ error: error instanceof Error ? error.message : "Vault request failed" }),
});
const structured = (data: Record<string, unknown>) => ({
  ...result(JSON.parse(JSON.stringify(data))),
  structuredContent: data,
});
const allowSchema = v.object({ decision: v.literal("allow") });

export function createAgentMcp(runtime: AgentRuntime) {
  const server = new McpServer(
    { name: "vault", version: "1.0.0" },
    {
      instructions:
        "Use describe_context first. Ask for missing secrets with collect_secret; the user types them into a prompt, never chat. Call APIs with use_secret and {{NAME}} placeholders so you never see keys; the user approves each key/host once. Give another agent or person scoped access with share_access. open_panel shows the vault UI. Run commands that need secrets with `vault run -- CMD`. Reuse request IDs after reconnect; get_task recovers receipts without repeating effects. Unknown outcomes must be inspected, never retried automatically.",
    },
  );
  // 2026-07-28 requests carry capabilities per request; older clients declared
  // them once at initialize (Claude Code still connects that way).
  const capabilities = (ctx: ServerContext) =>
    v.parse(
      capabilitySchema,
      ctx.mcpReq.envelope ?? {
        [CLIENT_CAPABILITIES_META_KEY]: server.server.getClientCapabilities() ?? {},
      },
    );

  /** Runs `action` once the user allows `question` in an in-chat prompt. An
   * answer counts only for the question it was asked about (`state`): if
   * what needs approval changed since, the user is asked again. */
  const withApproval = async (
    ctx: ServerContext,
    question: string,
    state: string,
    action: () => Promise<z.infer<ReturnType<typeof z.json>>>,
  ) => {
    const responses = ctx.mcpReq.inputResponses;
    const answered = inputResponse(responses, "vault").kind === "elicit";
    const allowed = acceptedContent(responses, "vault", allowSchema) != null;
    if (allowed && ctx.mcpReq.requestState<string>() === state) {
      try {
        return result(await action());
      } catch (error) {
        return failure(error);
      }
    }
    if (answered && !allowed)
      return result({ denied: true, message: "The user did not allow this." });
    if (!elicitationModes(capabilities(ctx)).form)
      return failure(new Error("This client cannot show approval prompts."));
    return inputRequired({
      requestState: state,
      inputRequests: {
        vault: inputRequired.elicit({
          message: question,
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
  };

  const parsePrompt = async (task: AgentTask, ctx: ServerContext) => {
    if (declined(ctx.mcpReq.inputResponses)) return result(await runtime.cancel(task.taskId));
    const envelope = capabilities(ctx);
    if (hasTaskCapability(envelope)) return taskHandle(task);
    if (task.state !== "waiting") return result(task);
    const { form, url } = elicitationModes(envelope);
    // Prefer the in-chat prompt; the browser form is the fallback.
    if (form) return inputRequired({ inputRequests: { vault: secretPrompt(task) } });
    if (url && task.url) return inputRequired({ inputRequests: { vault: browserPrompt(task) } });
    return result(task);
  };
  const panelState = async () => ({
    ...(await runtime.context()),
    grants: runtime.activeGrants(),
  });

  server.registerTool(
    "describe_context",
    {
      description: "List secret names and kinds for the configured Vault scope. No values.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => result(await runtime.context()),
  );
  server.registerTool(
    "collect_secret",
    {
      description:
        "Ask the user for a missing secret. They type it into a prompt in this chat (or a browser form); the value goes to the vault and never to you. Generate a UUID requestId once and reuse it.",
      inputSchema: requestSchema.extend({ name: nameSchema }),
    },
    async ({ requestId, name }, ctx) => {
      const value = typedSecret(ctx.mcpReq.inputResponses);
      if (value !== undefined) return result(await runtime.store(requestId, value));
      return parsePrompt(await runtime.collect(requestId, name), ctx);
    },
  );
  server.registerTool(
    "use_secret",
    {
      description:
        "Make an HTTPS request with secrets you cannot see. Write {{NAME}} only in header values (e.g. Authorization: Bearer {{STRIPE_KEY}}); placeholders in the URL or body are refused. The vault fills them in, sends the request, and replaces the values with placeholders in the response. The user approves each secret/host pair once per 15 minutes.",
      inputSchema: z
        .object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          url: z.string().max(4000),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().max(1_000_000).optional(),
        })
        .strict(),
    },
    async (request, ctx) => {
      let pending: { host: string; names: string[] };
      try {
        pending = runtime.ungranted(request);
      } catch (error) {
        return failure(error);
      }
      if (pending.names.length === 0) {
        try {
          return result(await runtime.useSecret(request));
        } catch (error) {
          return failure(error);
        }
      }
      return withApproval(
        ctx,
        `Allow the AI to send ${pending.names.join(", ")} to ${pending.host} for the next 15 minutes? First request: ${request.method} ${new URL(request.url).pathname}. The vault adds the key to request headers; the AI never sees it.`,
        `${pending.host} ${pending.names.join(",")}`,
        async () => {
          runtime.grant(pending.names, pending.host);
          return runtime.useSecret(request);
        },
      );
    },
  );
  server.registerTool(
    "share_access",
    {
      description:
        "Create a short-lived key scoped to this project/env so another agent or person can use these secrets (via `vault run` or their own vault MCP). Needs the user's approval. Returns the key once.",
      inputSchema: z
        .object({
          permission: z.enum(["read", "readwrite"]).default("read"),
          minutes: z.number().int().min(5).max(10080).default(60),
          label: z.string().max(120).optional(),
        })
        .strict(),
    },
    async ({ permission, minutes, label }, ctx) =>
      withApproval(
        ctx,
        `Give the AI a new key that can read every value in ${runtime.project}/${runtime.env}, sealed ones included${permission === "readwrite" ? ", and add or overwrite values" : ""}, for ${minutes} minutes? It may pass the key to another agent or person.${label == null ? "" : ` Label: ${quoted(label)}.`}`,
        `${permission} ${minutes}`,
        () => runtime.share(permission, minutes, label),
      ),
  );
  server.registerTool(
    "get_task",
    {
      description:
        "Resume a request after reconnect or restart. Returns its persisted receipt without repeating it.",
      inputSchema: requestSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ requestId }) => result(runtime.tasks.get(requestId)),
  );
  server.registerTool(
    "cancel_task",
    {
      description:
        "Cancel a request before submission. An admitted save cannot be undone by cancellation.",
      inputSchema: requestSchema,
    },
    async ({ requestId }) => result(await runtime.cancel(requestId)),
  );

  registerAppResource(
    server,
    "Vault panel",
    PANEL_URI,
    { description: "Secret names, a masked box to add one, and active use_secret grants." },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: panelHtml,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  );
  registerAppTool(
    server,
    "open_panel",
    {
      description:
        "Show the Vault panel in the chat: secret names, a masked box for the user to add a secret, and active use_secret grants. Never shows values.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    async () => structured(await panelState()),
  );
  // The server cannot enforce app-only visibility, so every action here must
  // be safe if a model calls it: create-only adds and grant revocation.
  registerAppTool(
    server,
    "vault_panel",
    {
      description:
        "Panel only. Refresh; add a missing secret (create-only); revoke a use_secret grant.",
      inputSchema: z
        .object({
          add: z.object({ name: nameSchema, value: z.string().min(1).max(16384) }).strict().optional(),
          revoke: z.object({ name: z.string(), host: z.string() }).strict().optional(),
        })
        .strict(),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ add, revoke }) => {
      const added = add == null ? undefined : await runtime.add(add.name, add.value);
      if (revoke != null) runtime.revokeGrant(revoke.name, revoke.host);
      return structured({ ...(await panelState()), ...(added && { added }) });
    },
  );

  server.server.registerCapabilities({ extensions: { [taskExtension]: {} } });
  return server;
}
