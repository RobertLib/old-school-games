import { defineConfig } from "vitest/config";

/**
 * The test files that need nothing but the module under test.
 *
 * Every other file in the suite is loaded with ./tests/setup.ts in front of
 * it, and that file is not cheap: it points DATABASE_URL at the test
 * database, opens a pool, takes the migration advisory lock, truncates every
 * table and runs any pending migration — before a single test in the file
 * runs. For tests/js/, which read a file out of public/js and eval it into a
 * jsdom window, and for the pure-function utilities below, all of that is
 * setup for a database none of them ever touches. It also means the whole
 * suite could only ever run against a live Postgres, so `npx vitest run
 * --project unit` had no meaning.
 *
 * Membership is decided by what a file reaches, not by where it lives:
 * tests/utils/ is split across both projects. cache-epoch, rate-limit-store
 * and reserved-slugs import db.ts (the last of them transitively, through
 * models/ and routes/), so they stay on the integration side even though two
 * of them mostly assert on mocks — a module that opens a pool at import time
 * belongs behind the setup that decides which database that pool points at.
 *
 * logger.test.ts is the other one that stayed behind, and for a different
 * reason: it re-imports utils/logger.ts under a stubbed NODE_ENV in each
 * block, and two of its cases depend on the value the module saw the *first*
 * time it was loaded — which setup.ts pins to "test". Run without that it
 * fails. Worth untangling in the test rather than working around here, but
 * it is a behaviour change to that file, not a configuration one.
 *
 * Anything new goes in integration unless it is checked and found not to
 * import db.ts, directly or through a model, a route or app.ts.
 */
const UNIT_TESTS = [
  // Client-side scripts: read from public/js and eval'd into a jsdom window.
  "tests/js/**/*.test.ts",
  // Pure functions.
  "tests/utils/assets.test.ts",
  "tests/utils/breadcrumbs.test.ts",
  "tests/utils/cache.test.ts",
  "tests/utils/cookies.test.ts",
  "tests/utils/expects-json.test.ts",
  "tests/utils/html-text.test.ts",
  "tests/utils/ids.test.ts",
  "tests/utils/pagination.test.ts",
  "tests/utils/password.test.ts",
  "tests/utils/query.test.ts",
  "tests/utils/slug.test.ts",
  "tests/utils/xml.test.ts",
];

export default defineConfig({
  test: {
    /**
     * Two projects, one command.
     *
     * `npm test`, `npm run test:coverage` and CI still run everything; the
     * split is about what each half is allowed to assume. "unit" has no
     * setup file and no database, so it runs in parallel and on a checkout
     * with no Postgres at all (`npx vitest run --project unit`).
     * "integration" keeps exactly the configuration the whole suite used to
     * have.
     *
     * sequence.groupOrder runs unit to completion first. Without it the two
     * projects' files share one pool, and "unit" running in parallel would
     * be interleaved with integration files that must not run concurrently
     * with each other.
     */
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: UNIT_TESTS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          setupFiles: ["./tests/setup.ts"],
          include: ["tests/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...UNIT_TESTS],
          sequence: { groupOrder: 1 },

          /**
           * One file at a time. These share a database, and setup.ts
           * truncates every table as it loads — two files loading at once
           * means one of them has its fixtures deleted out from under it.
           */
          fileParallelism: false,

          /**
           * Longer than the connection pool is willing to wait.
           *
           * Most of this suite talks to a real Postgres through the app's
           * own pool, which waits for a free connection before giving up
           * (connectionTimeoutMillis in db.ts). Vitest's default per-test
           * budget is five seconds, and any pool contention at all was
           * reported as "Test timed out in 5000ms" and never as the pool
           * error that actually caused it. The test that failed was usually
           * not even the test that exhausted anything, which left the whole
           * class of failure with no diagnostic trail: an intermittent
           * timeout in whichever DB-backed test happened to be running.
           *
           * Fifteen seconds is not a licence for slow tests — the whole
           * suite runs in about twenty — it is the budget being wider than
           * the timeout beneath it, so that a failure reports its own cause.
           */
          testTimeout: 15_000,
        },
      },
    ],

    /**
     * Coverage is measured across both projects at once.
     *
     * It belongs here at the root rather than in either project: the
     * thresholds are a statement about the codebase, and a file exercised by
     * a unit test and a route test has to count both. `npm run
     * test:coverage` runs every project, so the figures — and the floors
     * below — mean what they meant before the split.
     */
    coverage: {
      /**
       * Floors, not targets.
       *
       * `npm run test:coverage` reported a number and did nothing with it, so
       * coverage could only be watched by hand — and a number nobody is
       * obliged to read is a number that drifts down. These sit a couple of
       * points under what the suite covers today (95.3% of statements, 90.3%
       * of branches, 96.8% of functions, 95.7% of lines), which leaves room
       * for an ordinary change to add a line or two it does not reach while
       * still failing on a real regression.
       *
       * Raise them when the real figures move up; do not lower them to make a
       * run pass.
       */
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 95,
        lines: 93,
      },

      /**
       * The files the thresholds are measured over.
       *
       * Without this, coverage is reported only for modules some test
       * happened to import, so a file with no tests at all counts as neither
       * covered nor uncovered — it simply does not appear, and the percentage
       * above stays comfortable while a whole module goes unexercised.
       *
       * The excludes are the two entry points that run on import — index.ts
       * listens on a port, migrate.ts applies migrations — plus the suite and
       * config themselves.
       *
       * "content" and "types" were the two source directories left out, which
       * is the very gap this list exists to close: content/blurbs.ts is the
       * copy every genre, studio and year page renders its intro from, and a
       * file that no test imports counts as neither covered nor uncovered —
       * it simply does not appear, and the percentage stays comfortable.
       *
       * public/js is the one source directory still missing, and it is
       * missing because listing it would not work rather than because nobody
       * thought of it. Those files are not modules: they are IIFEs and bare
       * globals meant to be dropped into a page by a <script> tag, so
       * tests/js/ exercises them by reading each file and running it through
       * an indirect eval. v8 attributes nothing it reaches that way back to
       * the file on disk — adding "public/js/**\/*.js" here reports all seven
       * at 0% and fails the thresholds outright, and a "//# sourceURL" on the
       * eval'd string does not change that. Both were tried.
       *
       * So roughly two thousand lines of tested client script are measured by
       * nothing. Closing it properly means making those files importable —
       * an ES module each, with the page-level wiring split from the logic —
       * which is a refactor of the scripts, not a change to this list. Until
       * then the gap is here in writing rather than hidden behind a number
       * that looks fine.
       */
      include: [
        "app.ts",
        "content/**/*.ts",
        "create-admin.ts",
        "db.ts",
        "middlewares/**/*.ts",
        "models/**/*.ts",
        "routes/**/*.ts",
        "types/**/*.ts",
        "utils/**/*.ts",
        "validations/**/*.ts",
      ],
    },
  },
});
