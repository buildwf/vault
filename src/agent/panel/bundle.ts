import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Build-time only (import with { type: "macro" }): one self-contained HTML string.
 * `--compile` with `--target=browser` inlines the JS and CSS into the page. */
export function buildPanelHtml() {
  const directory = mkdtempSync(join(tmpdir(), "vault-panel-"));
  try {
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(import.meta.dir, "index.html"),
        "--compile",
        "--target=browser",
        "--minify",
        "--outdir",
        directory,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (build.exitCode !== 0)
      throw new Error(`Could not bundle the Vault panel:\n${build.stderr.toString()}`);
    return readFileSync(join(directory, "index.html"), "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
