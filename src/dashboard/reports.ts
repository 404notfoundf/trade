import Decimal from "decimal.js";
import { execute, query } from "../db.js";
import type { AssetConfig } from "../config.js";
import { logger } from "../logger.js";

type ValueRow = { observed_at: Date; direction: string; size_usdt: string; net_profit_usdt: string | null; status: string; route_status: string; valuation_status: string | null };
type OpportunityPeriodRow = { observed_at: Date; ended_at: Date | null; direction: string; size_usdt: string; peak_profit_usdt: string; ever_executable: number };
const dateSql = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

function percentile(values: Decimal[], fraction: number): Decimal | null {
  if (!values.length) return null;
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;
}

async function generate(type: "hourly" | "daily", start: Date, assets: AssetConfig[]): Promise<void> {
  const end = new Date(start.getTime() + (type === "hourly" ? 3_600_000 : 86_400_000));
  const startSql = dateSql(start);
  const endSql = dateSql(end);
  const existing = await query<Array<{ inst_id: string; chain_index: string; direction: string; size_usdt: string }>>(
    "SELECT inst_id,chain_index,direction,CAST(size_usdt AS CHAR) size_usdt FROM report WHERE period_type=? AND period_start=?", [type, startSql]);
  if (assets.every((asset) => ["cex_buy_dex_sell", "dex_buy_cex_sell"].every((direction) => asset.observationSizesUsdt.every((size) =>
    existing.some((row) => row.inst_id === asset.instId && row.chain_index === asset.chainIndex && row.direction === direction && new Decimal(row.size_usdt).eq(size)))))) return;
  for (const asset of assets) {
    const rowsByPeriod = await query<ValueRow[]>(
      `SELECT observed_at, direction, CAST(size_usdt AS CHAR) size_usdt, CAST(COALESCE(net_profit_after_rebalance_usdt,net_profit_usdt) AS CHAR) net_profit_usdt, status, route_status, valuation_status
       FROM quote_observation WHERE inst_id=? AND chain_index=? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at`,
      [asset.instId, asset.chainIndex, startSql, endSql]);
    const episodes = await query<OpportunityPeriodRow[]>(
      `SELECT observed_at,ended_at,direction,CAST(size_usdt AS CHAR) size_usdt,CAST(peak_profit_usdt AS CHAR) peak_profit_usdt,ever_executable FROM opportunity
       WHERE inst_id=? AND chain_index=? AND observed_at < ? AND COALESCE(ended_at,?) > ? AND legacy_sample=0`,
      [asset.instId, asset.chainIndex, endSql, endSql, startSql]);
    for (const direction of ["cex_buy_dex_sell", "dex_buy_cex_sell"]) for (const size of asset.observationSizesUsdt) {
    const rows = rowsByPeriod.filter((r) => r.direction === direction && new Decimal(r.size_usdt).eq(size));
    const legacyNominal = rows.length > 0 && rows.every((r) => (r.valuation_status ?? "LEGACY_NOMINAL") === "LEGACY_NOMINAL");
    const counted = legacyNominal ? rows : rows.filter((r) => r.valuation_status === "VERIFIED");
    const positiveRows = counted.filter((r) => r.status === "OK" && r.net_profit_usdt !== null && new Decimal(r.net_profit_usdt).gt(0));
    const overlapping = episodes.filter((episode) => episode.direction === direction && new Decimal(episode.size_usdt).eq(size));
    const scoped = overlapping.filter((episode) => new Date(episode.observed_at) >= start && new Date(episode.observed_at) < end);
    const legacyExecutable = positiveRows.filter((r) => r.route_status === "ENABLED");
    const executableCount = legacyNominal ? legacyExecutable.length : scoped.filter((episode) => episode.ever_executable === 1).length;
    const monitorOnlyCount = legacyNominal ? positiveRows.length - executableCount : scoped.length - executableCount;
    const values = (legacyNominal
      ? legacyExecutable.map((r) => new Decimal(r.net_profit_usdt!))
      : scoped.filter((episode) => episode.ever_executable === 1).map((episode) => new Decimal(episode.peak_profit_usdt))).sort((a, b) => a.comparedTo(b));
    const collected = rows.length > 0;
    const median = values.length ? (values.length % 2 ? values[(values.length - 1) / 2]! : values[values.length / 2 - 1]!.plus(values[values.length / 2]!).div(2)) : null;
    let longestPositiveSeconds = 0;
    if (legacyNominal) {
      let runStart = 0;
      let previousPositive = 0;
      const maxGapMs = asset.dexQuoteIntervalMs * 2.5;
      for (const row of counted) {
        const timestamp = new Date(row.observed_at).getTime();
        if (row.route_status === "ENABLED" && row.status === "OK" && row.net_profit_usdt !== null && new Decimal(row.net_profit_usdt).gt(0)) {
          if (!previousPositive || timestamp - previousPositive > maxGapMs) runStart = timestamp;
          longestPositiveSeconds = Math.max(longestPositiveSeconds, Math.floor((timestamp - runStart) / 1000));
          previousPositive = timestamp;
        } else previousPositive = 0;
      }
    } else for (const episode of overlapping) {
      const from = Math.max(start.getTime(), new Date(episode.observed_at).getTime());
      const to = Math.min(end.getTime(), episode.ended_at ? new Date(episode.ended_at).getTime() : end.getTime());
      longestPositiveSeconds = Math.max(longestPositiveSeconds, Math.floor(Math.max(0, to - from) / 1000));
    }
    await execute(`INSERT INTO report (period_type, period_start, inst_id, chain_index, direction, size_usdt, opportunity_count, monitor_only_count, max_profit,
      median_profit, p95_profit, average_profit, collected, longest_positive_seconds, legacy_nominal, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE opportunity_count=VALUES(opportunity_count), max_profit=VALUES(max_profit),
      monitor_only_count=VALUES(monitor_only_count),
      median_profit=VALUES(median_profit), p95_profit=VALUES(p95_profit), average_profit=VALUES(average_profit),
      collected=VALUES(collected), longest_positive_seconds=VALUES(longest_positive_seconds), legacy_nominal=VALUES(legacy_nominal), generated_at=VALUES(generated_at)`, [
      type, startSql, asset.instId, asset.chainIndex, direction, String(size), executableCount, monitorOnlyCount,
      values.length ? values[values.length - 1]!.toString() : null, median?.toString() ?? null,
      percentile(values, 0.95)?.toString() ?? null,
      values.length ? values.reduce((a, b) => a.plus(b), new Decimal(0)).div(values.length).toString() : null,
      collected, longestPositiveSeconds, legacyNominal ? 1 : 0,
    ]);
    }
  }
}

export async function backfillReports(assets: AssetConfig[]): Promise<void> {
  const lastHour = new Date(); lastHour.setUTCMinutes(0, 0, 0);
  const lastDay = new Date(); lastDay.setUTCHours(0, 0, 0, 0);
  for (const asset of assets) {
    const earliest = await query<Array<{ first_seen: Date | null }>>("SELECT MIN(observed_at) first_seen FROM quote_observation WHERE inst_id=? AND chain_index=?", [asset.instId, asset.chainIndex]);
    if (!earliest[0]?.first_seen) continue;
    const firstHour = new Date(earliest[0].first_seen); firstHour.setUTCMinutes(0, 0, 0);
    for (let cursor = firstHour; cursor < lastHour; cursor = new Date(cursor.getTime() + 3_600_000)) await generate("hourly", cursor, [asset]);
    const firstDay = new Date(earliest[0].first_seen); firstDay.setUTCHours(0, 0, 0, 0);
    for (let cursor = firstDay; cursor < lastDay; cursor = new Date(cursor.getTime() + 86_400_000)) await generate("daily", cursor, [asset]);
  }
}

export function startReportScheduler(assets: AssetConfig[]): void {
  const schedule = (next: () => Date, run: () => Promise<void>, label: string) => {
    const when = next();
    setTimeout(() => { void run().catch((error) => logger.error(`${label} report failed`, error)).finally(() => schedule(next, run, label)); }, Math.max(1000, when.getTime() - Date.now()));
  };
  const nextHour = () => { const date = new Date(); date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0); return date; };
  const nextDay = () => { const date = new Date(); date.setUTCDate(date.getUTCDate() + 1); date.setUTCHours(0, 5, 0, 0); return date; };
  schedule(nextHour, async () => { const start = new Date(); start.setUTCHours(start.getUTCHours() - 1, 0, 0, 0); await generate("hourly", start, assets); }, "hourly");
  schedule(nextDay, async () => { const start = new Date(); start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(0, 0, 0, 0); await generate("daily", start, assets); }, "daily");
}
