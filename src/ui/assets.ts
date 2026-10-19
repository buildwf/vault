/**
 * The operator web UI, served by the Worker at `/ui`.
 *
 * The UI is a React app in web/ (shadcn components on TanStack Start, built as
 * a single-page app). scripts/embed-ui.ts builds it and embeds the files in
 * assets.gen.ts. It talks to the `/v1` API with the vault key the operator
 * signs in with; the key stays in the tab's `sessionStorage`, and the page has
 * no cookie to steal.
 *
 * The UI never shows a secret value or a parent key. The one plaintext it
 * shows is a vault key the operator just created, once.
 */
import { UI_FILES, UI_SCRIPT_HASHES } from "./assets.gen.ts";

/**
 * Scripts come only from this origin, plus the shell's own inline bootstrap
 * scripts by hash. Styles allow inline because the dialog and toast components
 * insert style tags at runtime.
 */
export const UI_CSP = [
  "default-src 'none'",
  `script-src 'self' ${UI_SCRIPT_HASHES.join(" ")}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const decoded = new Map<string, Uint8Array>();

/** The UI file at this path, or null. */
export function uiFile(path: string): { type: string; body: string | Uint8Array; immutable: boolean } | null {
  const file = UI_FILES[path];
  if (file == null) return null;
  let body: string | Uint8Array = file.body;
  if (file.base64) {
    let bytes = decoded.get(path);
    if (bytes == null) {
      bytes = Uint8Array.from(atob(file.body), (ch) => ch.charCodeAt(0));
      decoded.set(path, bytes);
    }
    body = bytes;
  }
  // Built assets carry a content hash in their name, so they never change.
  return { type: file.type, body, immutable: path.startsWith("/ui/assets/") };
}
