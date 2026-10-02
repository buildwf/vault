import {
  acceptedContent,
  inputRequired,
  inputResponse,
  CLIENT_CAPABILITIES_META_KEY,
  type Transport,
} from "@modelcontextprotocol/server";
import { collectedSecretSchema } from "../collection-contract.ts";
import * as v from "valibot";
import type { AgentTask } from "./tasks.ts";
import type { AgentRuntime } from "./runtime.ts";
export const taskExtension = "io.modelcontextprotocol/tasks";
const elicitationSchema = v.optional(
  v.object({ form: v.optional(v.object({})), url: v.optional(v.object({})) }),
);
export const capabilitySchema = v.object({
  [CLIENT_CAPABILITIES_META_KEY]: v.optional(
    v.object({
      extensions: v.optional(v.record(v.string(), v.unknown())),
      elicitation: elicitationSchema,
    }),
  ),
});
/** A bare `elicitation: {}` means form only, per the spec's implied member rule. */
export function elicitationModes(envelope: v.InferOutput<typeof capabilitySchema>) {
  const elicitation = envelope[CLIENT_CAPABILITIES_META_KEY]?.elicitation;
  return {
    url: elicitation?.url != null,
    form: elicitation?.form != null || (elicitation != null && elicitation.url == null),
  };
}
/** True when the user declined or cancelled the `vault` prompt. */
export function declined(responses: Record<string, unknown> | undefined) {
  const answer = inputResponse(responses, "vault");
  return answer.kind === "elicit" && answer.action !== "accept";
}
/** The value typed into the in-chat secret prompt, if one came back. */
export function typedSecret(responses: Record<string, unknown> | undefined) {
  return acceptedContent(responses, "vault", v.pick(collectedSecretSchema, ["value"]))?.value;
}
// ponytail: no masked field exists in MCP form schemas (format: "password"
// breaks SDK clients), so the client shows what is typed; the model does not.
export const secretPrompt = (task: AgentTask) =>
  inputRequired.elicit({
    message: `Vault: enter ${task.target}. It is saved straight to the vault; the AI never sees it.`,
    requestedSchema: {
      type: "object",
      properties: {
        value: { type: "string", title: task.target, minLength: 1, maxLength: 16384 },
      },
      required: ["value"],
    },
  });
export const browserPrompt = (task: AgentTask) =>
  inputRequired.elicitUrl({
    url: task.url!,
    message: `Complete the ${task.kind} request in your browser. Return here after finishing. Request: ${task.taskId}`,
  });
export function hasTaskCapability(envelope: v.InferOutput<typeof capabilitySchema>) {
  return Object.hasOwn(
    envelope[CLIENT_CAPABILITIES_META_KEY]?.extensions ?? {},
    taskExtension,
  );
}
function taskView(task: AgentTask, modes = { url: true, form: false }) {
  const pending = task.state === "waiting" || task.state === "saving";
  const status =
    task.state === "cancelled" || task.state === "expired"
      ? "cancelled"
      : pending
        ? task.url
          ? "input_required"
          : "working"
        : "completed";
  const base = {
    taskId: task.taskId,
    status,
    createdAt: new Date(task.createdAt).toISOString(),
    lastUpdatedAt: new Date(task.updatedAt).toISOString(),
    ttlMs: null,
    pollIntervalMs: 2000,
    statusMessage: task.state,
  };
  if (status === "input_required" && task.url)
    return {
      ...base,
      inputRequests: { vault: modes.form ? secretPrompt(task) : browserPrompt(task) },
    };
  if (status === "completed")
    return {
      ...base,
      result: {
        content: [{ type: "text", text: JSON.stringify(task) }],
        isError: task.state !== "stored",
      },
    };
  return base;
}
export function taskHandle(task: AgentTask) {
  const { taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs } =
    taskView(task);
  // content satisfies the SDK's generic result envelope; task clients use the discriminator.
  return {
    resultType: "task",
    content: [],
    taskId,
    status,
    createdAt,
    lastUpdatedAt,
    ttlMs,
    pollIntervalMs,
  };
}
const taskMessageSchema = v.object({
  jsonrpc: v.literal("2.0"),
  id: v.union([v.string(), v.number()]),
  method: v.picklist(["tasks/get", "tasks/update", "tasks/cancel"]),
  params: v.object({
    taskId: v.pipe(v.string(), v.uuid()),
    _meta: v.object({
      "io.modelcontextprotocol/protocolVersion": v.literal("2026-07-28"),
      [CLIENT_CAPABILITIES_META_KEY]: v.object({
        extensions: v.record(v.string(), v.unknown()),
        elicitation: elicitationSchema,
      }),
    }),
    inputResponses: v.optional(v.record(v.string(), v.unknown())),
  }),
});
/** One Tasks call: cancel, a typed answer, a resume, or a read. */
async function dispatch(
  runtime: AgentRuntime,
  method: string,
  taskId: string,
  inputResponses: Record<string, unknown> | undefined,
) {
  if (method === "tasks/cancel") return runtime.cancel(taskId);
  if (method !== "tasks/update") return runtime.tasks.get(taskId);
  if (declined(inputResponses)) return runtime.cancel(taskId);
  const value = typedSecret(inputResponses);
  if (value !== undefined) return runtime.store(taskId, value);
  return runtime.resume(taskId);
}
/** The SDK 2.0 core rejects tasks/get as removed legacy vocabulary before
 * custom handlers run. This extension transport owns only the three modern
 * Tasks methods; the SDK still owns framing and every core method. */
export function taskTransport(inner: Transport, runtime: AgentRuntime): Transport {
  const transport: Transport = {
    async start() {
      // MCP Transport has callback properties, not EventTarget methods.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      inner.onmessage = (message, extra) => {
        if (
          !("method" in message) ||
          !["tasks/get", "tasks/update", "tasks/cancel"].includes(message.method)
        ) {
          transport.onmessage?.(message, extra);
          return;
        }
        void (async () => {
          if (!("id" in message)) return;
          const reply = (code: number, text: string) =>
            inner.send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code, message: text },
            });
          const parsed = v.safeParse(taskMessageSchema, message);
          if (!parsed.success) return reply(-32602, "Invalid MCP Tasks request");
          if (!hasTaskCapability(parsed.output.params["_meta"]))
            return reply(-32021, "MCP Tasks capability is required");
          try {
            const { taskId, inputResponses, _meta } = parsed.output.params;
            const task = await dispatch(runtime, message.method, taskId, inputResponses);
            await inner.send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                ...taskView(task, elicitationModes(_meta)),
                _meta: {
                  "io.modelcontextprotocol/serverInfo": {
                    name: "vault",
                    version: "1.0.0",
                  },
                },
              },
            });
          } catch {
            await reply(-32602, "Task unavailable");
          }
        })().catch(() => transport.onerror?.(new Error("Vault task transport failed")));
      };
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport callback API
      inner.onclose = () => transport.onclose?.();
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport callback API
      inner.onerror = (error) => transport.onerror?.(error);
      await inner.start();
    },
    send: (message) => inner.send(message),
    close: () => inner.close(),
  };
  return transport;
}
