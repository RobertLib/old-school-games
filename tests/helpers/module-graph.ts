import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Reading the import graph off disk, for the two tests that assert something
 * about the shape of it.
 *
 * tests/import-cycles.test.ts wants the application's own modules and whether
 * they form a cycle; tests/unit-project-isolation.test.ts wants what a test
 * file reaches and whether db.ts is in it. Both are the same walk, and it
 * lives here rather than in either file so the second one did not arrive as a
 * second copy of the first — two walkers would drift, and a walker that
 * quietly resolves nothing reports the happiest possible answer.
 *
 * Text, not the module loader. Actually importing a file to see what it
 * imports would open a pool (db.ts does at import time) and listen on a port
 * (index.ts does), which is the very thing the isolation test exists to keep
 * out of the unit project.
 */

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const SOURCE_DIRS = [
  "content",
  "middlewares",
  "models",
  "routes",
  "types",
  "utils",
  "validations",
];

export const SOURCE_FILES = ["app.ts", "db.ts", "index.ts", "migrate.ts"];

/** Every static relative `from "..."` in a file. */
const STATIC_IMPORT_PATTERN = /from\s+"(\.[^"]+)"/g;

/**
 * Every way a test file can name a relative module: a static import, a
 * dynamic one, and a vi.mock() specifier.
 *
 * The last two matter only on the test side, and they matter a lot there:
 * tests/utils/logger.test.ts reaches its module through `await import(...)`
 * alone, and a vi.mock() of "../../db" is a file vitest resolves and loads
 * the mock factory in place of — but a specifier that no longer resolves is
 * an error at run time, so it counts as reaching the module too.
 */
const ANY_IMPORT_PATTERN =
  /(?:from\s+|import\s*\(\s*|vi\.(?:mock|doMock)\s*\(\s*)"(\.[^"]+)"/g;

function specifiers(file: string, pattern: RegExp): string[] {
  const source = fs.readFileSync(file, "utf-8");

  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

/**
 * The file a specifier names, or undefined when nothing is there.
 *
 * The sources all carry ".ts" — the runtime strips types from the file it is
 * handed and has no resolver of its own — but the suite is type-checked
 * bundler-style (see tsconfig.tests.json) and its imports are extensionless,
 * so both spellings have to resolve.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);

  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return undefined;
}

/** Every source file of the application itself. */
export function collectSources(): string[] {
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

/**
 * The application's own modules and the edges between them.
 *
 * Deliberately *not* filtered by what exists on disk: an edge naming a file
 * this graph does not know about is how import-cycles.test.ts catches a
 * walker that has stopped resolving anything.
 */
export function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const file of collectSources()) {
    const edges = specifiers(file, STATIC_IMPORT_PATTERN).map((specifier) =>
      path.resolve(path.dirname(file), specifier),
    );

    graph.set(path.resolve(file), edges);
  }

  return graph;
}

/** Every cycle in the graph, each rendered as a readable path chain. */
export function findCycles(graph: Map<string, string[]>): string[] {
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
 * Every file reachable from `entry`, following relative imports transitively.
 *
 * Unlike buildGraph above this resolves against disk and drops what is not
 * there, because the question it answers is "what would loading this file
 * pull in" — and it is asked of a test file, whose imports are extensionless
 * and whose specifiers include vi.mock()'s.
 */
export function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;

    if (seen.has(file)) continue;

    seen.add(file);

    for (const specifier of specifiers(file, ANY_IMPORT_PATTERN)) {
      const resolved = resolveImport(file, specifier);

      if (resolved !== undefined) queue.push(resolved);
    }
  }

  seen.delete(path.resolve(entry));

  return seen;
}

/** The chain from `entry` to `target`, for a failure that says why. */
export function pathTo(entry: string, target: string): string[] | undefined {
  const goal = path.resolve(target);
  const seen = new Set<string>();
  const queue: string[][] = [[path.resolve(entry)]];

  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;

    if (file === goal) return chain.map((step) => path.relative(ROOT, step));

    if (seen.has(file)) continue;

    seen.add(file);

    for (const specifier of specifiers(file, ANY_IMPORT_PATTERN)) {
      const resolved = resolveImport(file, specifier);

      if (resolved !== undefined) queue.push([...chain, resolved]);
    }
  }

  return undefined;
}
