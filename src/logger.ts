import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const logDirectory = fileURLToPath(new URL("../logs/", import.meta.url));
let fileLoggingWarningShown = false;

type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const detail = error instanceof Error ? error.stack ?? error.message : error === undefined ? "" : String(error);
  const entry = `${timestamp} [${level}] ${message}${detail ? `\n${detail}` : ""}\n`;
  if (level === "ERROR") process.stderr.write(entry);
  else process.stdout.write(entry);

  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(new URL(`../logs/${level.toLowerCase()}-${timestamp.slice(0, 10)}.log`, import.meta.url), entry, "utf8");
  } catch (logError) {
    if (!fileLoggingWarningShown) {
      fileLoggingWarningShown = true;
      process.stderr.write(`${timestamp} [ERROR] Could not write the daily log file: ${logError instanceof Error ? logError.message : String(logError)}\n`);
    }
  }
}

export const logger = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARN", message),
  error: (message: string, error?: unknown) => write("ERROR", message, error),
};
