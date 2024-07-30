import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

vi.mock("pg", () => {
  const mockPool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };

  // Use a class instead of arrow function for proper constructor behavior
  const MockPool = vi.fn(function () {
    return mockPool;
  });

  return {
    default: {
      Pool: MockPool,
    },
  };
});

const mockPg = vi.mocked(pg);

describe("Database Connection", () => {
  /**
   * What tests/setup.ts put there, put back afterwards.
   *
   * Every case here deletes or rewrites DATABASE_URL to see what db.ts makes
   * of it, and nothing used to restore it — so the variable setup.ts points
   * at the test database stayed deleted for the rest of the process, and any
   * module loaded after this file got node-postgres's defaults instead. It
   * happened to be survivable only because vitest gives each file its own environment
   * and this suite does not share one; it is a trap for the first change
   * that makes it do so, and it makes this file's own ordering load-bearing
   * for no reason.
   */
  let databaseUrl: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    databaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (databaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = databaseUrl;
    }

    vi.resetModules();
  });

  /** What db.ts handed the pool, the one time it constructed one. */
  function poolConfig(): Record<string, unknown> {
    expect(mockPg.Pool).toHaveBeenCalledTimes(1);

    return vi.mocked(mockPg.Pool).mock.calls[0]![0] as Record<string, unknown>;
  }

  /**
   * The fields rather than the string: pg lays a connection string's fields
   * over the rest of its config, so the threshold in `options` could not
   * survive a URL carrying options of its own. db.ts parses the URL with pg's
   * own parser and hands the pool what it would have found there.
   */
  it("connects where DATABASE_URL says", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

    await import("../db");

    expect(poolConfig()).toEqual(
      expect.objectContaining({
        user: "user",
        password: "pass",
        host: "localhost",
        port: 5432,
        database: "testdb",
      }),
    );
    expect(poolConfig()).not.toHaveProperty("connectionString");
  });

  // node-postgres's defaults and the PG* variables, which tests/setup.ts
  // relies on; a stock createdb uses libpq's socket default instead.
  it("names nowhere to connect when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;

    await import("../db");

    for (const field of ["host", "user", "database", "connectionString"]) {
      expect(poolConfig()).not.toHaveProperty(field);
    }
  });

  describe("the session's startup options", () => {
    it("sets the search threshold on every connection", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

      await import("../db");

      expect(poolConfig().options).toBe(
        "-c pg_trgm.similarity_threshold=0.28",
      );
    });

    /**
     * A URL's own "?options=" used to replace the threshold outright — pg
     * lets the connection string win — so search matched at Postgres's 0.3.
     * Both now, the threshold last: with repeated "-c" the last one of a name
     * is the one that holds, so the URL cannot undo it either.
     */
    it("keeps a URL's own options and puts the threshold after them", async () => {
      process.env.DATABASE_URL =
        "postgresql://user:pass@localhost:5432/testdb?options=" +
        encodeURIComponent(
          "-c search_path=app -c pg_trgm.similarity_threshold=0.5",
        );

      await import("../db");

      expect(poolConfig().options).toBe(
        "-c search_path=app -c pg_trgm.similarity_threshold=0.5 " +
          "-c pg_trgm.similarity_threshold=0.28",
      );
    });
  });

  /*
   * Four cases used to sit here: one asserting that db.ts's default export is
   * an object, and three asserting that it has a query, a connect and an end
   * method. Every one of them was checking the mock at the top of this file.
   * `vi.mock("pg")` returns an object literal with those three properties on
   * it, so all four passed whatever db.ts did — they would have gone on
   * passing with the file emptied out. A test that cannot fail is worse than
   * no test: it counts as coverage of the thing it does not check.
   *
   * What is left below is the part the mock genuinely reports on: which
   * arguments db.ts constructed the pool with, how many times, and what it
   * attached to "error".
   */
  it("should create only one Pool instance per import", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

    await import("../db");
    await import("../db");

    expect(mockPg.Pool).toHaveBeenCalledTimes(1);
  });

  describe("Environment configuration", () => {
    it("should work with different DATABASE_URL formats", async () => {
      const testCases: [string, Record<string, unknown>][] = [
        [
          "postgresql://user:pass@localhost:5432/db",
          { user: "user", host: "localhost", port: 5432, database: "db" },
        ],
        [
          "postgres://user:pass@host:5432/db?ssl=true",
          { host: "host", database: "db", ssl: true },
        ],
        ["postgresql://user@localhost/db", { user: "user", database: "db" }],
        // The database-only URL, which TEST_DATABASE_URL's
        // default is.
        ["postgresql:///old_school_games_test", { database: "old_school_games_test" }],
      ];

      for (const [url, fields] of testCases) {
        vi.resetModules();
        vi.clearAllMocks();

        process.env.DATABASE_URL = url;
        await import("../db");

        expect(poolConfig(), url).toEqual(expect.objectContaining(fields));
      }
    });

    /**
     * The URL still wins every key it shares with the pool's own settings,
     * as it did when pg did the parsing. Only `options` is combined.
     */
    it("lets the URL override the pool's own settings, as pg would", async () => {
      process.env.DATABASE_URL =
        "postgresql://user:pass@localhost:5432/testdb?application_name=osg";

      await import("../db");

      expect(poolConfig()).toEqual(
        expect.objectContaining({ application_name: "osg", max: 10 }),
      );
    });

    it("bounds the pool and caps how long one statement may run", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

      await import("../db");

      // Left to the defaults, `pool.connect()` waits forever for a free
      // client, so a few slow queries piled requests up without limit
      // instead of failing a handful of them fast.
      //
      // The values, not expect.any(Number). Every one of these numbers is
      // load-bearing and each has a paragraph in db.ts saying what it costs to
      // get wrong — but `expect.any(Number)` passes for all of them, so the
      // connection timeout could go back to the ten seconds it was moved away
      // from, or `max` could drift out of step with the concurrency limits in
      // fly.toml (see the case below), and this file would stay green. It was
      // asserting that four settings had been *mentioned*.
      expect(mockPg.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          max: 10,
          // Two seconds rather than ten: the wait is paid per query and a page
          // renders several.
          connectionTimeoutMillis: 2_000,
          idleTimeoutMillis: 30_000,
          // Server-side, so a session can lift it — which is what migrate.ts
          // does for an index build.
          statement_timeout: 15_000,
        }),
      );
    });

    /**
     * The pool size and the proxy's concurrency limits, which are one decision
     * written in two files.
     *
     * fly.toml caps requests per machine "just under what the process can
     * actually serve", and the number it is derived from is `max` here: ten
     * connections, several queries per page. Its comment ends "Raise these
     * together with `max` in db.ts, not on their own" — which is a sentence
     * nobody reads while editing the other file. Raising `max` alone leaves
     * the proxy shedding load the machine could now take; raising the limits
     * alone points more traffic at a pool that has not grown, and the surplus
     * arrives as connectionTimeoutMillis expiring — which every caller renders
     * as a blank widget rather than an error. Neither failure looks like a
     * configuration change.
     *
     * Read out of the two files as text, because that is the only way to
     * compare them: fly.toml is consumed by flyctl and never imported here,
     * and db.ts's `max` is an object literal rather than an export.
     *
     * The ratios are the ones the pair was written at — soft at 2x the pool,
     * hard at 4x. They are not a law of nature, and moving them deliberately
     * is a one-line change here. The point is that moving one side by accident
     * is not.
     */
    it("keeps fly.toml's concurrency limits in step with the pool size", () => {
      const root = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
      );

      const dbSource = readFileSync(path.join(root, "db.ts"), "utf-8");
      const flyToml = readFileSync(path.join(root, "fly.toml"), "utf-8");

      const max = Number(/^\s*max:\s*(\d+),/m.exec(dbSource)?.[1]);
      const soft = Number(/^\s*soft_limit\s*=\s*(\d+)/m.exec(flyToml)?.[1]);
      const hard = Number(/^\s*hard_limit\s*=\s*(\d+)/m.exec(flyToml)?.[1]);

      // A regex that stopped matching would compare NaN with NaN and report
      // the happiest possible answer, which is the trap
      // tests/unit-project-isolation.test.ts spends its first case on.
      expect({ max, soft, hard }).toEqual({
        max: expect.any(Number),
        soft: expect.any(Number),
        hard: expect.any(Number),
      });
      expect(Number.isNaN(max + soft + hard)).toBe(false);

      expect(soft).toBe(max * 2);
      expect(hard).toBe(max * 4);
    });

    it("listens for idle client errors rather than letting them crash", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

      const db = await import("../db");

      const calls = (
        db.default.on as unknown as {
          mock: { calls: [string, (error: Error) => void][] };
        }
      ).mock.calls;

      const handler = calls.find(([event]) => event === "error")?.[1];

      // pg's Pool emits "error" when an idle client fails — a Postgres
      // restart, a failover. An EventEmitter with no "error" listener makes
      // Node throw, which took the whole process down.
      expect(handler).toBeDefined();

      // pg discards the broken client itself; the listener only has to say so
      // without rethrowing.
      expect(() =>
        handler!(new Error("connection terminated unexpectedly")),
      ).not.toThrow();
    });

    // Empty is unset, as it always was to pg: it ignored a falsy string.
    it("should handle empty DATABASE_URL", async () => {
      process.env.DATABASE_URL = "";

      await import("../db");

      for (const field of ["host", "user", "database", "connectionString"]) {
        expect(poolConfig()).not.toHaveProperty(field);
      }
    });

    // At import, rather than as every query's 500 — and without the URL,
    // password and all, in the message.
    it("refuses a URL it cannot parse at boot, without echoing it", async () => {
      process.env.DATABASE_URL = "postgresql://user:secret@localhost:notaport/db";

      const failure = await import("../db").then(
        () => null,
        (error: Error) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).not.toContain("secret");
    });
  });
});
