import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VIEWS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../views",
);

function ejsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return ejsFiles(full);

    return entry.name.endsWith(".ejs") ? [full] : [];
  });
}

/** The template with every EJS tag — scriptlets and comments alike — blanked. */
function outsideEjs(source: string): string {
  return source.replace(/<%[\s\S]*?%>/g, "");
}

/**
 * Reasoning in a view goes in an EJS comment, never an HTML one.
 *
 * `<!-- -->` is copied into the response, so every word of it is shipped to
 * every visitor and every crawler on every page view. The views had sixty of
 * them: 10.8 KB of the game page's 50.9 KB was developer notes, and stripping
 * them took the gzipped page from 14.0 KB to 10.1 KB. head.ejs's opened with
 * one, above the <meta charset> it said must come first — competing for the
 * very byte budget it described. `<%# %>` says the same to whoever edits the
 * file and nothing to anyone else.
 */
describe("views", () => {
  const files = ejsFiles(VIEWS);

  it("finds the templates", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [path.relative(VIEWS, file), file]))(
    "%s ships no HTML comments",
    (_name, file) => {
      expect(outsideEjs(readFileSync(file, "utf8"))).not.toContain("<!--");
    },
  );
});
