import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

type Level = "INFO" | "WARN" | "ERROR";

const logDirectory = fileURLToPath(new URL("../logs/", import.meta.url));
const maxLogFileBytes = 20 * 1024 * 1024;
let fileLoggingWarningShown = false;

function write(level: Level, message: string, error?: unknown): void {
  const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
  const detail = error instanceof Error ? error.stack ?? error.message : error === undefined ? "" : String(error);
  const entry = `${timestamp} [${level}] ${message}${detail ? `\n${detail}` : ""}\n`;
  if (level === "ERROR") process.stderr.write(entry);
  else process.stdout.write(entry);

  try {
    mkdirSync(logDirectory, { recursive: true });
    const date = timestamp.slice(0, 10);
    const entryBytes = Buffer.byteLength(entry, "utf8");
    const filename = `${level.toLowerCase()}-${date}.log`;
    const activeFile = new URL(`../logs/${filename}`, import.meta.url);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        if (statSync(activeFile).size + entryBytes > maxLogFileBytes) {
          const rotatedAt = timestamp.replace(/[:.]/g, "-");
          const archiveId = randomUUID().slice(0, 8);
          renameSync(activeFile, new URL(`../logs/${level.toLowerCase()}-${date}.${rotatedAt}-${archiveId}.log`, import.meta.url));
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      appendFileSync(activeFile, entry, "utf8");
      return;
    }
    appendFileSync(activeFile, entry, "utf8");
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
