import "dotenv/config";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import db from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS "migrations" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL UNIQUE,
        "appliedAt" TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    const appliedMigrationsResult = await db.query(
      'SELECT "name" FROM "migrations"'
    );

    const appliedMigrations = new Set(
      appliedMigrationsResult.rows.map((row) => row.name)
    );

    const migrationsDir = path.join(__dirname, "migrations");

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"));

    for (const file of migrationFiles.sort()) {
      if (!appliedMigrations.has(file)) {
        console.log(`Applying migration: ${file}`);

        const migrationSQL = fs.readFileSync(
          path.join(migrationsDir, file),
          "utf-8"
        );

        await db.query(migrationSQL);
        await db.query('INSERT INTO "migrations" ("name") VALUES ($1)', [file]);
      }
    }

    console.log("All migrations applied.");
  } catch (error) {
    console.error("Migration error:", error);
  }
}

runMigrations();
