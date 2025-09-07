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

// Run migrations before tests
async function runTestMigrations() {
  try {
    // Create migrations table if it doesn't exist
    await testDb.query(`
      CREATE TABLE IF NOT EXISTS "migrations" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL UNIQUE,
        "appliedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    const appliedMigrationsResult = await testDb.query(
      'SELECT "name" FROM "migrations"'
    );

    const appliedMigrations = new Set(
      appliedMigrationsResult.rows.map((row) => row.name)
    );

    const migrationsDir = path.join(__dirname, "../migrations");

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"));

    for (const file of migrationFiles.sort()) {
      if (!appliedMigrations.has(file)) {
        console.log(`Applying test migration: ${file}`);

        const migrationSQL = fs.readFileSync(
          path.join(migrationsDir, file),
          "utf-8"
        );

        await testDb.query(migrationSQL);
        await testDb.query('INSERT INTO "migrations" ("name") VALUES ($1)', [
          file,
        ]);
      }
    }

    console.log("All test migrations applied.");
  } catch (error) {
    console.error("Test migration error:", error);
    throw error;
  }
}

// Run migrations before any tests start
await runTestMigrations();
