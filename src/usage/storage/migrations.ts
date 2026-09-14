import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const migrations = [
  {
    version: 1,
    sql: readFileSync(new URL("./schema/001_initial.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    sql: readFileSync(
      new URL("./schema/002_scrub_legacy_openrouter_key_buckets.sql", import.meta.url),
      "utf8",
    ),
  },
  {
    version: 3,
    sql: readFileSync(new URL("./schema/003_catalog_visibility.sql", import.meta.url), "utf8"),
  },
] as const;

export function applyUsageMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasVersion = database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?");
  const recordVersion = database.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (hasVersion.get(migration.version) !== undefined) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      recordVersion.run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
