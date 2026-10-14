import { closeDatabase, initDatabase } from "./db.js";
import { startDashboard } from "./dashboard.js";
import { readDashboardState } from "./dashboard-state.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  await initDatabase(config);
  const server = startDashboard(config, config.assets, () => readDashboardState(config.assets));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(async (error: unknown) => {
  logger.error("Dashboard startup failed", error);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
