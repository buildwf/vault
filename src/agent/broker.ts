/**
 * `use_secret`: the vault makes an HTTP call for the agent.
 *
 * The agent writes `{{NAME}}` in a header value (`Authorization: Bearer
 * {{KEY}}`). Only headers: a key placed in a URL or body can be stored by the
 * approved host and read back in an encoding the scrub cannot recognize. The
 * vault fills the values in, sends the request without following redirects,
 * and replaces each value (raw, URL-encoded, base64) in the response with its
 * placeholder again. Scrubbing is best effort; the approval prompt is the gate.
 */
import * as v from "valibot";

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/gu;
const PLACEHOLDER_TEST = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/u;
const MAX_BODY = 65536;

export const brokeredRequestSchema = v.strictObject({
  method: v.picklist(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: v.pipe(v.string(), v.maxLength(4000)),
  headers: v.optional(v.record(v.string(), v.string())),
  body: v.optional(v.pipe(v.string(), v.maxLength(1_000_000))),
});
export type BrokeredRequest = v.InferOutput<typeof brokeredRequestSchema>;

/** The destination host. Placeholders outside header values are refused. */
export function requestHost(request: BrokeredRequest): string {
  if (PLACEHOLDER_TEST.test(request.url) || PLACEHOLDER_TEST.test(request.body ?? ""))
    throw new Error("Put {{NAME}} only in header values, e.g. Authorization: Bearer {{KEY}}");
  const url = new URL(request.url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("use_secret only calls https:// URLs");
  return url.host;
}

/** Secret names referenced by `{{NAME}}` in header values. */
export function placeholderNames(request: BrokeredRequest): string[] {
  return [
    ...new Set(
      Object.values(request.headers ?? {}).flatMap((value) =>
        [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!),
      ),
    ),
  ];
}

/** The forms a value commonly comes back in. */
function encodings(value: string): string[] {
  const forms = [value, encodeURIComponent(value)];
  try {
    forms.push(btoa(value), btoa(value).replace(/=+$/u, ""));
  } catch {
    // Not Latin-1; no base64 form to scrub.
  }
  return forms;
}

export async function brokeredFetch(
  request: BrokeredRequest,
  values: Record<string, string>,
  send: typeof fetch = fetch,
) {
  requestHost(request);
  const fill = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => values[name] ?? "");
  // Longest value first, so a secret that contains another is replaced whole.
  const forms = Object.entries(values)
    .filter(([, value]) => value.length >= 4)
    .sort(([, a], [, b]) => b.length - a.length)
    .flatMap(([name, value]) => encodings(value).map((form) => [form, `{{${name}}}`] as const));
  const scrub = (text: string) =>
    forms.reduce((out, [form, placeholder]) => out.replaceAll(form, placeholder), text);
  let response: Response;
  try {
    response = await send(new URL(request.url), {
      method: request.method,
      // The host is the one the user approved; the model may not override it.
      headers: Object.fromEntries(
        Object.entries(request.headers ?? {})
          .filter(([name]) => name.toLowerCase() !== "host")
          .map(([name, value]) => [name, fill(value)]),
      ),
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    // fetch errors quote invalid header values verbatim, filled-in secret included.
    throw new Error("use_secret request failed: network error or an invalid header value");
  }
  // Read only what is returned (plus room to scrub a value cut at the end).
  const limit = MAX_BODY + Math.max(0, ...forms.map(([form]) => form.length));
  const raw = await readUpTo(response, limit);
  const body = scrub(raw.text);
  return {
    status: response.status,
    contentType: scrub(response.headers.get("content-type") ?? "") || null,
    location: scrub(response.headers.get("location") ?? "") || null,
    body: body.slice(0, MAX_BODY),
    truncated: raw.truncated || body.length > MAX_BODY,
  };
}

/** At most `limit` characters of the body; the rest is never downloaded. */
async function readUpTo(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (reader == null) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      await reader.cancel();
      return { text: text.slice(0, limit), truncated: true };
    }
  }
}
