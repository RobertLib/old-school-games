import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SOURCE_DIRS = [
  "content",
  "middlewares",
  "models",
  "routes",
  "types",
  "utils",
  "validations",
];
const SOURCE_FILES = ["app.ts", "db.ts", "index.ts", "migrate.ts"];

/** Every relative `from "..."` in a file, resolved to a path under the root. */
const IMPORT_PATTERN = /from\s+"(\.[^"]+)"/g;

function collectSources(): string[] {
  const files = SOURCE_FILES.map((file) => path.join(ROOT, file)).filter(
    (file) => fs.existsSync(file),
  );

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };

  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir));

  return files;
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const file of collectSources()) {
    const source = fs.readFileSync(file, "utf-8");
    const edges: string[] = [];

    for (const match of source.matchAll(IMPORT_PATTERN)) {
      edges.push(path.resolve(path.dirname(file), match[1]!));
    }

    graph.set(path.resolve(file), edges);
  }

  return graph;
}

/** Every cycle in the graph, each rendered as a readable path chain. */
function findCycles(graph: Map<string, string[]>): string[] {
  const found = new Map<string, string>();
  const relative = (file: string) => path.relative(ROOT, file);

  const visit = (node: string, stack: string[], seen: Set<string>): void => {
    const at = stack.indexOf(node);

    if (at !== -1) {
      const cycle = [...stack.slice(at), node];
      // Keyed on the set of files, so one cycle reported from four different
      // entry points is one failure rather than four.
      const key = [...new Set(cycle)].sort().join("|");

      if (!found.has(key)) found.set(key, cycle.map(relative).join(" -> "));

      return;
    }

    if (seen.has(node)) return;

    seen.add(node);

    for (const next of graph.get(node) ?? []) visit(next, [...stack, node], seen);
  };

  for (const file of graph.keys()) visit(file, [], new Set());

  return [...found.values()].sort();
}

/**
 * The application's own modules must form a directed acyclic graph.
 *
 * This is not a style rule. Seven cycles of the shape
 *
 *   models/game.ts -> routes/sitemap.ts -> routes/lists.ts -> models/game.ts
 *
 * used to run here, because the models call the cache-clearing functions the
 * routers exported. ESM does not refuse a cycle — it hands the second
 * importer a module whose bindings are still in their temporal dead zone —
 * and every one of those edges happened to be read inside a function body at
 * request time rather than during evaluation, so nothing ever failed.
 *
 * That is the whole problem: the arrangement was one statement away from
 * breaking, and the statement would not have looked dangerous. A single
 * `Game.getGenres()` at the top level of routes/lists.ts would have taken the
 * process down at boot with "Cannot access 'Game' before initialization",
 * pointing at a file that had not changed.
 *
 * The caches now live in utils/page-cache.ts and utils/sidebar-cache.ts, so
 * routes and models both depend on utils and neither depends on the other.
 * This test is what keeps it that way, because nothing else would notice.
 */
describe("module graph", () => {
  it("has no import cycles", () => {
    expect(findCycles(buildGraph())).toEqual([]);
  });

  // Guards the test itself: a graph builder that silently resolved nothing
  // would report no cycles for the happiest of reasons.
  it("actually resolved the imports it walked", () => {
    const graph = buildGraph();
    const edges = [...graph.values()].flat();

    expect(graph.size).toBeGreaterThan(30);
    expect(edges.length).toBeGreaterThan(50);
    // Every edge names a module this graph knows about, so nothing is being
    // skipped over as unresolvable.
    expect(edges.filter((edge) => !graph.has(edge))).toEqual([]);
  });
});
