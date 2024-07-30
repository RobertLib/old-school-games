import { parseIntoClientConfig } from "pg-connection-string";
import type { PoolClient } from "pg";

export const DEFAULT_TEST_DATABASE_URL = "postgresql:///old_school_games_test";

function requireTestDatabaseName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(
      "TEST_DATABASE_URL names no database. The suite drops and truncates " +
        "whatever it connects to, so it will not use a server's default database.",
    );
  }

  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run the test suite against the database "${name}". ` +
        "The suite truncates tables and can drop the whole public schema, " +
        'so the database name must say "test". Point TEST_DATABASE_URL at ' +
        `a test database (default: ${DEFAULT_TEST_DATABASE_URL}).`,
    );
  }
}

/** Validate the database pg will use, without opening a connection. */
export function resolveTestDatabase(configured: string | undefined): {
  databaseUrl: string;
  databaseName: string;
} {
  // An empty URL makes pg use its defaults, including the developer's own
  // database. It must not become the target of the setup's TRUNCATE/DROP.
  if (configured !== undefined && configured.trim() === "") {
    throw new Error(
      "TEST_DATABASE_URL is set but empty. Unset it to use " +
        `${DEFAULT_TEST_DATABASE_URL}, or give it a real test database URL.`,
    );
  }

  const databaseUrl = configured ?? DEFAULT_TEST_DATABASE_URL;

  // The same parser pg uses: a socket: URL names its database in ?db=,
  // while its pathname is only the socket directory. Checking the pathname
  // accepted socket:/tmp/test-postgresql?db=old_school_games and let setup
  // empty a non-test database. A URL with no explicit database is refused
  // even if PGDATABASE or the connection's user would supply a test name.
  const databaseName = parseIntoClientConfig(databaseUrl).database;
  requireTestDatabaseName(databaseName);

  return { databaseUrl, databaseName };
}

/** Check the actual connection before setup runs any destructive SQL. */
export async function verifyTestDatabase(
  client: Pick<PoolClient, "query">,
  expectedName: string,
): Promise<void> {
  const { rows } = await client.query<{ database: string }>(
    'SELECT current_database() AS "database"',
  );
  const actualName = rows[0]?.database;
  requireTestDatabaseName(actualName);

  // A proxy or a future connection-config change must not silently send the
  // cleanup to a different database, even when both names contain "test".
  if (actualName !== expectedName) {
    throw new Error(
      `Refusing to clean database "${actualName}": TEST_DATABASE_URL names ` +
        `"${expectedName}". No test migrations or cleanup have been run.`,
    );
  }
}
