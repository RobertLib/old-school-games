import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import pg from "pg";

// Set environment variables BEFORE any database connections
process.env.DATABASE_URL =
  "postgresql://rob:randompassword@localhost:5432/old_school_games_test?schema=public";
process.env.NODE_ENV = "test";

const { Pool } = pg;

// Create a new pool specifically for tests to ensure it uses the test database
const testDb = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Clean all test data from tables (but keep schema)
async function cleanTestData(client: pg.PoolClient) {
  // Order matters due to foreign keys - delete from dependent tables first
  const tablesToClean = [
    "comments",
    "ratings",
    "game_of_the_week",
    "news",
    "analytics",
    "games",
    "users",
  ];

  for (const table of tablesToClean) {
    try {
      await client.query(`DELETE FROM "${table}"`);
    } catch {
      // Table might not exist yet, ignore
    }
  }

  // Reset sequences
  const sequences = [
    "comments_id_seq",
    "games_id_seq",
    "users_id_seq",
    "news_id_seq",
    "analytics_id_seq",
    "game_of_the_week_id_seq",
    "ratings_id_seq",
  ];

  for (const seq of sequences) {
    try {
      await client.query(`ALTER SEQUENCE "${seq}" RESTART WITH 1`);
    } catch {
      // Sequence might not exist, ignore
    }
  }
}

// Run migrations before tests (only once per database, using advisory lock)
async function runTestMigrations() {
  const client = await testDb.connect();

  try {
    // Use advisory lock to ensure only one process runs migrations
    await client.query("SELECT pg_advisory_lock(12345)");

    // Check if migrations table exists and has data
    const checkResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'migrations'
      ) as exists
    `);

    if (checkResult.rows[0].exists) {
      // Migrations already applied, but clean data for fresh test run
      await cleanTestData(client);
      // Release lock and return
      await client.query("SELECT pg_advisory_unlock(12345)");
      return;
    }

    // Clean existing tables if they exist
    try {
      // Drop all tables
      const result = await client.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `);

      for (const row of result.rows) {
        await client.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }

      // Drop all enum types
      const typeResult = await client.query(`
        SELECT typname
        FROM pg_type
        WHERE typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND typtype = 'e'
      `);

      for (const row of typeResult.rows) {
        await client.query(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`);
      }
    } catch (error) {
      // Ignore errors during cleanup - tables might not exist
    }

    // Create migrations table
    await client.query(`
      CREATE TABLE "migrations" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL UNIQUE,
        "appliedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, "../migrations");

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"));

    for (const file of migrationFiles.sort()) {
      const migrationSQL = fs.readFileSync(
        path.join(migrationsDir, file),
        "utf-8"
      );

      await client.query(migrationSQL);
      await client.query('INSERT INTO "migrations" ("name") VALUES ($1)', [
        file,
      ]);
    }

    // Release advisory lock
    await client.query("SELECT pg_advisory_unlock(12345)");
  } catch (error) {
    // Make sure to release lock on error
    try {
      await client.query("SELECT pg_advisory_unlock(12345)");
    } catch {
      // Ignore unlock errors
    }
    console.error("Test migration error:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations before any tests start
await runTestMigrations();
