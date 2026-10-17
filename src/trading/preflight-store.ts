import { execute, query } from "../db.js";
import type { PreflightReport } from "./preflight.js";

export type PreflightTrigger = "arm" | "manual_check";
export type PreflightPersistence = "database" | "log";
export type PreflightRun = {
  id: number | null;
  trigger: PreflightTrigger;
  persistence: PreflightPersistence;
  report: PreflightReport;
};

export async function savePreflightReport(report: PreflightReport, trigger: PreflightTrigger): Promise<number> {
  const result = await execute(
    "INSERT INTO trade_preflight_report (schema_version,config_version,trigger_source,overall_status,report_json,checked_at) VALUES (?,?,?,?,?,?)",
    [report.schemaVersion, report.configVersion, trigger, report.overall, JSON.stringify(report), new Date(report.generatedAt)],
  );
  return result.insertId;
}

export async function loadLatestPreflightReport(): Promise<{ id: number; trigger: PreflightTrigger; report: PreflightReport } | null> {
  const rows = await query<Array<{ id: number; trigger_source: string; report_json: string | PreflightReport }>>(
    "SELECT id,trigger_source,report_json FROM trade_preflight_report ORDER BY id DESC LIMIT 1",
  );
  const row = rows[0];
  if (!row) return null;
  const report = typeof row.report_json === "string" ? JSON.parse(row.report_json) as PreflightReport : row.report_json;
  if (!report || report.schemaVersion !== 1 || typeof report.generatedAt !== "string"
    || typeof report.configVersion !== "string" || (report.overall !== "PASS" && report.overall !== "BLOCKED")
    || !Array.isArray(report.checks) || !Array.isArray(report.routes) || !Array.isArray(report.blockers)) {
    throw new Error("Stored trade preflight report has an invalid format");
  }
  return { id: row.id, trigger: row.trigger_source === "arm" ? "arm" : "manual_check", report };
}
