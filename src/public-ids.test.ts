import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This repository is public. Cloudflare account, D1 and Secrets Store ids are
// deployment-specific and belong in .env (gitignored), never in a committed
// file. Tests are skipped: their fixtures use obviously fake ids.
const ID = /\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const root = join(import.meta.dir, "..");
/** Placeholders: a repeated single character, or the all-zero local D1 id. */
const placeholder = (id: string) =>
  /^(.)\1*$/u.test(id.replaceAll("-", "")) || id.startsWith("00000000-0000-4000-8000-");

test("no real Cloudflare ids in files that would be committed", () => {
  const files = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
  })
    .stdout.toString()
    .split("\n")
    .filter((path) => path !== "" && !path.endsWith(".test.ts"));
  const found = files.flatMap((path) => {
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      return []; // Deleted in the working tree.
    }
    return [...text.matchAll(ID)]
      .map((match) => match[0])
      .filter((id) => !placeholder(id))
      .map((id) => `${path}: ${id.slice(0, 4)}…`);
  });
  expect(found).toEqual([]);
});
