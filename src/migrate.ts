import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  // Keep JS Date values aligned with the application pool; CURRENT_TIMESTAMP remains the server's configured clock.
  const pool = mysql.createPool({ ...config.mysql, waitForConnections: true, connectionLimit: 1, multipleStatements: true, timezone: "Z" });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const [rows] = await pool.execute("SELECT version FROM schema_migrations WHERE version = ?", [version]);
      if ((rows as unknown[]).length) continue;
      await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      await pool.execute("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      logger.info(`Applied migration ${version}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  logger.error("Database migration failed", error);
  process.exitCode = 1;
});
