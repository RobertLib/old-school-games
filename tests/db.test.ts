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
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("should create a Pool with DATABASE_URL from environment", async () => {
    const testDatabaseUrl = "postgresql://user:pass@localhost:5432/testdb";
    process.env.DATABASE_URL = testDatabaseUrl;

    await import("../db");

    expect(mockPg.Pool).toHaveBeenCalledWith({
      connectionString: testDatabaseUrl,
    });
  });

  it("should create a Pool with undefined connectionString when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;

    await import("../db");

    expect(mockPg.Pool).toHaveBeenCalledWith({
      connectionString: undefined,
    });
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

        expect(mockPg.Pool).toHaveBeenCalledWith({
          connectionString: url,
        });
      }
    });

    it("should handle empty DATABASE_URL", async () => {
      process.env.DATABASE_URL = "";

      await import("../db");

      expect(mockPg.Pool).toHaveBeenCalledWith({
        connectionString: "",
      });
    });
  });
});
