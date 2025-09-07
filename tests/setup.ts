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

// Flag to track if migrations have been run
let migrationsApplied = false;

// Run migrations before tests (only once)
async function runTestMigrations() {
  if (migrationsApplied) {
    return;
  }

  try {
    // First, try to clean existing tables if they exist
    try {
      // Get all table names and drop them
      const result = await testDb.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `);

      // Drop all tables
      for (const row of result.rows) {
        await testDb.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }

      // Drop all types
      const typeResult = await testDb.query(`
        SELECT typname
        FROM pg_type
        WHERE typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND typtype = 'e'
      `);

      for (const row of typeResult.rows) {
        await testDb.query(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`);
      }
    } catch (error) {
      // Ignore errors during cleanup - tables might not exist
    }

    // Create migrations table
    await testDb.query(`
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

      await testDb.query(migrationSQL);
      await testDb.query('INSERT INTO "migrations" ("name") VALUES ($1)', [
        file,
      ]);
    }

    migrationsApplied = true;
  } catch (error) {
    console.error("Test migration error:", error);
    throw error;
  }
}

// Run migrations before any tests start
await runTestMigrations();
