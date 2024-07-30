import { describe, expect, it } from "vitest";
// The walker lives in tests/helpers/module-graph.ts rather than here, because
// tests/unit-project-isolation.test.ts asks a second question of the same
// graph and two copies of a graph builder would drift apart.
import { buildGraph, findCycles } from "./helpers/module-graph.ts";

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
