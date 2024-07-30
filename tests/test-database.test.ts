import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  DEFAULT_TEST_DATABASE_URL,
  resolveTestDatabase,
  verifyTestDatabase,
} from "./helpers/test-database.ts";

describe("test database configuration", () => {
  it("uses the explicitly named default when TEST_DATABASE_URL is unset", () => {
    expect(resolveTestDatabase(undefined)).toEqual({
      databaseUrl: DEFAULT_TEST_DATABASE_URL,
      databaseName: "old_school_games_test",
    });
  });

  it.each(["", " ", "\t\n"])("refuses an empty override %j", (url) => {
    expect(() => resolveTestDatabase(url)).toThrow("set but empty");
  });

  it.each([
    "postgresql:///old_school_games_test",
    "postgres://user:password@localhost:5432/review_test?sslmode=verify-full",
    "postgresql:///review%5Ftest?host=/var/run/postgresql",
    "socket:/tmp/postgresql?db=review_test",
    "/tmp/postgresql review_test",
  ])("checks the same database as pg for %s", (databaseUrl) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    // Constructing a client resolves pg's defaults and connection string but
    // opens no socket. This catches future drift between the guard and pg.
    expect(resolveTestDatabase(databaseUrl)).toEqual({
      databaseUrl,
      databaseName: client.database,
    });
  });

  it.each([
    "postgresql:///old_school_games",
    "socket:/tmp/test-postgresql?db=old_school_games",
    "/tmp/test-postgresql old_school_games",
  ])("refuses a non-test database for %s", (url) => {
    expect(() => resolveTestDatabase(url)).toThrow("Refusing to run");
  });

  it.each([
    "postgresql://test-user@localhost",
    "socket:/tmp/test-postgresql",
    "/tmp/test-postgresql",
  ])("refuses a connection with no explicit database for %s", (url) => {
    expect(() => resolveTestDatabase(url)).toThrow("names no database");
  });
});

describe("the connected database guard", () => {
  function clientFor(database: string | undefined) {
    return {
      query: vi.fn().mockResolvedValue({
        rows: database === undefined ? [] : [{ database }],
      }),
    };
  }

  it("accepts the configured test database after asking the server", async () => {
    const client = clientFor("review_test");
    await expect(verifyTestDatabase(client, "review_test")).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledExactlyOnceWith(
      'SELECT current_database() AS "database"',
    );
  });

  it("refuses a connection routed to a non-test database", async () => {
    const client = clientFor("old_school_games");
    await expect(verifyTestDatabase(client, "review_test")).rejects.toThrow(
      'Refusing to run the test suite against the database "old_school_games"',
    );
  });

  it("refuses a different test database than the one requested", async () => {
    await expect(
      verifyTestDatabase(clientFor("another_test"), "review_test"),
    ).rejects.toThrow('TEST_DATABASE_URL names "review_test"');
  });

  it("refuses a missing server result", async () => {
    await expect(
      verifyTestDatabase(clientFor(undefined), "review_test"),
    ).rejects.toThrow("names no database");
  });

  it("does not continue when the server lookup fails", async () => {
    const error = new Error("connection lost");
    const client = { query: vi.fn().mockRejectedValue(error) };
    await expect(verifyTestDatabase(client, "review_test")).rejects.toBe(error);
  });
});
