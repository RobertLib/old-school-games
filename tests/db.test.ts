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
   * module loaded after this file got libpq's defaults instead. It happened
   * to be survivable only because vitest gives each file its own environment
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

  it("should create a Pool with DATABASE_URL from environment", async () => {
    const testDatabaseUrl = "postgresql://user:pass@localhost:5432/testdb";
    process.env.DATABASE_URL = testDatabaseUrl;

    await import("../db");

    expect(mockPg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: testDatabaseUrl }),
    );
  });

  it("should create a Pool with undefined connectionString when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;

    await import("../db");

    expect(mockPg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: undefined }),
    );
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
      const testCases = [
        "postgresql://user:pass@localhost:5432/db",
        "postgres://user:pass@host:5432/db?ssl=true",
        "postgresql://user@localhost/db",
      ];

      for (const url of testCases) {
        vi.resetModules();
        vi.clearAllMocks();

        process.env.DATABASE_URL = url;
        await import("../db");

        expect(mockPg.Pool).toHaveBeenCalledWith(
          expect.objectContaining({ connectionString: url }),
        );
      }
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

    it("should handle empty DATABASE_URL", async () => {
      process.env.DATABASE_URL = "";

      await import("../db");

      expect(mockPg.Pool).toHaveBeenCalledWith(
        expect.objectContaining({ connectionString: "" }),
      );
    });
  });
});
