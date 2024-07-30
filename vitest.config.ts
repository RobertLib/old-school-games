import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,

    /**
     * Longer than the connection pool is willing to wait.
     *
     * Most of this suite talks to a real Postgres through the app's own pool,
     * which waits up to ten seconds for a free connection before giving up
     * (connectionTimeoutMillis in db.ts). Vitest's default per-test budget is
     * five — under that — so any pool contention at all was reported as
     * "Test timed out in 5000ms" and never as the pool error that actually
     * caused it. The test that failed was usually not even the test that
     * exhausted anything, which left the whole class of failure with no
     * diagnostic trail: an intermittent timeout in whichever DB-backed test
     * happened to be running.
     *
     * Fifteen seconds is not a licence for slow tests — the whole suite runs
     * in about twenty — it is the budget being wider than the timeout beneath
     * it, so that a failure reports its own cause.
     */
    testTimeout: 15_000,

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
