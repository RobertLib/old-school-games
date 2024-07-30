import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("should export the pool instance", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

    const db = await import("../db");

    expect(db.default).toBeDefined();
    expect(typeof db.default).toBe("object");
  });

  it("should create only one Pool instance per import", async () => {
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

    await import("../db");
    await import("../db");

    expect(mockPg.Pool).toHaveBeenCalledTimes(1);
  });

  describe("Pool functionality", () => {
    it("should have query method available", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

      const db = await import("../db");

      expect(db.default.query).toBeDefined();
      expect(typeof db.default.query).toBe("function");
    });

    it("should have connect method available", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

      const db = await import("../db");

      expect(db.default.connect).toBeDefined();
      expect(typeof db.default.connect).toBe("function");
    });

    it("should have end method available", async () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";

      const db = await import("../db");

      expect(db.default.end).toBeDefined();
      expect(typeof db.default.end).toBe("function");
    });
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
      expect(mockPg.Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          max: expect.any(Number),
          connectionTimeoutMillis: expect.any(Number),
          idleTimeoutMillis: expect.any(Number),
          statement_timeout: expect.any(Number),
        }),
      );
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
