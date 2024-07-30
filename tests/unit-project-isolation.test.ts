import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
// The real list, imported rather than restated. A copy of it here would agree
// with vitest.config.ts on the day it was written and never again — and the
// one thing this test cannot afford is to be asserting about a set of files
// that is no longer the set the runner uses.
import { UNIT_TESTS } from "../vitest.config.ts";
import { ROOT, pathTo, reachableFrom } from "./helpers/module-graph.ts";

/**
 * The "unit" project's one promise, kept by something other than care.
 *
 * That project has no setup file, which means nothing has pointed
 * DATABASE_URL at the test database by the time its files load. db.ts builds
 * its pool at import time, so a unit test that reaches it — directly, or
 * through a model, a route, or app.ts — opens a pool against whatever
 * DATABASE_URL happens to say: nothing on a clean checkout, and a
 * *developer's own* database if their shell exports one. That is the failure
 * mode worth spending a test on. It does not look like a broken import; it
 * looks like the suite passing, or like rows appearing somewhere they should
 * not.
 *
 * It also protects the claim the split was made for: `npx vitest run --project
 * unit` runs on a checkout with no Postgres at all. One accidental import puts
 * that back to needing a database and nobody would notice until a fresh clone.
 *
 * The rule written in vitest.config.ts — "anything new goes in integration
 * unless it is checked and found not to import db.ts" — is a rule a person has
 * to remember. This is the check.
 */

const DB = path.join(ROOT, "db.ts");

/** The three modules that do something the moment they are imported. */
const ENTRY_POINTS = ["app.ts", "index.ts", "migrate.ts"].map((file) =>
  path.join(ROOT, file),
);

/** The files the UNIT_TESTS patterns actually match, on disk. */
function unitTestFiles(): string[] {
  const files = UNIT_TESTS.flatMap((pattern) =>
    fs.globSync(pattern, { cwd: ROOT }),
  ).map((file) => path.resolve(ROOT, file));

  return [...new Set(files)].sort();
}

describe("the unit vitest project", () => {
  /**
   * Guards the guard. A pattern list that matched nothing — a directory
   * renamed, a glob implementation that wants a different spelling — would
   * report a clean bill of health for the worst possible reason, which is the
   * same trap the second case in tests/import-cycles.test.ts exists for.
   */
  it("resolves its include patterns to real files", () => {
    // Per pattern, not in total. The count used to be compared against
    // UNIT_TESTS.length, which sounds like "every entry matched something" and
    // is not: "tests/js/**\/*.test.ts" alone expands to eight files, so the
    // total cleared the bar with seven entries' worth of slack — a renamed or
    // deleted file behind any one of the other patterns matched nothing and
    // the assertion still passed. Vitest does not complain about an include
    // that matches no file either, so the test it was meant to run simply
    // stops running.
    const matchedNothing = UNIT_TESTS.filter(
      (pattern) => fs.globSync(pattern, { cwd: ROOT }).length === 0,
    );

    expect(matchedNothing).toEqual([]);

    for (const file of unitTestFiles()) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  /**
   * And the other half of the same guard: that the walker resolves what it
   * reads. One that quietly resolved nothing would find no db.ts for the
   * happiest of reasons.
   *
   * Asserted over tests/utils/ rather than over everything, because tests/js/
   * genuinely imports nothing: those files read a script out of public/js and
   * run it through an indirect eval, so reaching nothing is the right answer
   * for them. Every file in tests/utils/ is about a module it imports.
   */
  it("resolves the imports it walks", () => {
    const UTILS = path.join(ROOT, "utils") + path.sep;
    const utilTests = unitTestFiles().filter((file) =>
      file.startsWith(path.join(ROOT, "tests", "utils") + path.sep),
    );

    expect(utilTests.length).toBeGreaterThan(5);

    const reachingNothing = utilTests
      .filter(
        (file) =>
          ![...reachableFrom(file)].some((reached) =>
            reached.startsWith(UTILS),
          ),
      )
      .map((file) => path.relative(ROOT, file));

    expect(reachingNothing).toEqual([]);
  });

  it("has no test that reaches db.ts", () => {
    const offenders = unitTestFiles()
      .filter((file) => reachableFrom(file).has(DB))
      // The chain, not just the file: "tests/utils/x.test.ts imports db.ts"
      // is almost never what happened — it is four modules away, through a
      // model or a route, and the name of the middle one is the whole answer.
      .map((file) => pathTo(file, DB)?.join(" -> ") ?? path.relative(ROOT, file));

    expect(offenders).toEqual([]);
  });

  /**
   * The mirror of the check above, and the reason the list is worth keeping
   * accurate in both directions.
   *
   * A unit test that reaches db.ts is a correctness problem; an *integration*
   * test that reaches nothing is only a cost, but it is a cost every run pays
   * and nobody sees. Each of those files is loaded behind tests/setup.ts,
   * which connects, takes the migration advisory lock, truncates nine tables
   * and applies any pending migration before its first test — and the
   * integration project runs one file at a time on purpose, so the wait is
   * serial. Twenty-three files were sitting there when this was written, all
   * of them reading text off disk or exercising a pure function.
   *
   * Listed rather than counted, so a failure names what to move. The
   * exceptions below are for the case the walk cannot see: a file that reaches
   * no module of ours but still depends on what setup.ts puts in
   * process.env — NODE_ENV=test is the one that has bitten, because
   * utils/logger.ts reads it once at import (see vitest.config.ts on
   * logger.test.ts). Add a file here with the reason, or move it.
   */
  it("has no integration test that reaches nothing", () => {
    const NEEDS_SETUP_ANYWAY: string[] = [];

    const unit = new Set(unitTestFiles());

    const stragglers = fs
      .globSync("tests/**/*.test.ts", { cwd: ROOT })
      .map((file) => path.resolve(ROOT, file))
      .filter((file) => !unit.has(file))
      .filter((file) => {
        const reached = reachableFrom(file);

        return ![DB, ...ENTRY_POINTS].some((module) => reached.has(module));
      })
      .map((file) => path.relative(ROOT, file))
      .filter((file) => !NEEDS_SETUP_ANYWAY.includes(file))
      .sort();

    expect(
      stragglers,
      "these integration tests reach no db.ts, app.ts, index.ts or " +
        "migrate.ts, so they are waiting on tests/setup.ts for nothing: add " +
        "them to UNIT_TESTS in vitest.config.ts, or to NEEDS_SETUP_ANYWAY " +
        "here with the reason they still need the setup",
    ).toEqual([]);
  });

  /**
   * The same thing said from the other side, and the one a reader can check
   * by eye: nothing in the unit project may reach the two modules that run on
   * import.
   */
  it("has no test that reaches an entry point", () => {
    const offenders = unitTestFiles().flatMap((file) => {
      const reached = reachableFrom(file);

      return ENTRY_POINTS
        .filter((entry) => reached.has(entry))
        .map((entry) => `${path.relative(ROOT, file)} -> ${path.relative(ROOT, entry)}`);
    });

    expect(offenders).toEqual([]);
  });
});
