import Decimal from "decimal.js";
import { transaction } from "./db.js";

export type QuoteObservation = {
  instId: string;
  chainIndex: string;
  routeStatus: "ENABLED" | "MONITOR_ONLY" | "BLOCKED";
  direction: string;
  sizeUsdt: number;
  shares: string;
  tokenAmount: string;
  cexVwap: string;
  cexFeeRate: string;
  dexUsdtAmount: string | null;
  cexFeeUsdt: string;
  gasUsdt: string | null;
  gasNativeRaw: string | null;
  gasSource: string;
  grossProfitUsdt: string | null;
  netProfitUsdt: string | null;
  rebalanceCostUsdt: string | null;
  netProfitAfterRebalanceUsdt: string | null;
  roi: string | null;
  multiplier: string;
  multiplierRaw: string;
  cexTs: Date | null;
  cexReceivedAt: Date | null;
  dexTs: Date;
  dexRequestStartedAt: Date;
  dexQueueWaitMs: number;
  isStale: boolean;
  status: string;
  priceImpactPercent: string | null;
  dexRequestMs: number;
  fromTokenUnitPriceUsd: string | null;
  toTokenUnitPriceUsd: string | null;
  paidValueUsd: string | null;
  receivedValueUsd: string | null;
  rawResponse: string;
  nativeQuoteAmount: string;
  nativeQuoteSymbol: string;
  usdtRate: string | null;
  conversionCostUsdt: string | null;
  usdtEstimate: string | null;
  valuationStatus: "VERIFIED" | "UNKNOWN";
  priceSourceTime: Date | null;
  quoteSummary: string | null;
  valuationReasonCode: string | null;
  executionBufferUsdt: string;
  executableProfitUsdt: string | null;
  executableStatus: "NOT_EVALUATED" | "EXECUTABLE" | "NOT_EXECUTABLE";
  executionReason: string | null;
};

export async function saveQuoteObservations(rows: QuoteObservation[]): Promise<void> {
  await transaction(async (connection) => {
    for (const row of rows) {
      const [result] = await connection.execute<import("mysql2").ResultSetHeader>(`INSERT INTO quote_observation
        (inst_id,chain_index,direction,size_usdt,shares,token_amount,cex_vwap,cex_fee_rate,dex_usdt_amount,cex_fee_usdt,gas_usdt,gas_native_raw,gas_source,
         net_profit_usdt,gross_profit_usdt,rebalance_cost_usdt,net_profit_after_rebalance_usdt,roi,multiplier,multiplier_raw,cex_ts,dex_ts,observed_at,is_stale,status,price_impact_percent,
         route_status,from_token_unit_price_usd,to_token_unit_price_usd,paid_value_usd,received_value_usd,raw_response,native_quote_amount,native_quote_symbol,usdt_rate,conversion_cost_usdt,usdt_estimate,valuation_status,price_source_time,quote_summary,dex_request_ms,cex_received_at,dex_request_started_at,dex_queue_wait_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        row.instId, row.chainIndex, row.direction, String(row.sizeUsdt), row.shares, row.tokenAmount, row.cexVwap, row.cexFeeRate,
        row.dexUsdtAmount, row.cexFeeUsdt, row.gasUsdt, row.gasNativeRaw, row.gasSource, row.netProfitUsdt, row.grossProfitUsdt, row.rebalanceCostUsdt, row.netProfitAfterRebalanceUsdt,
        row.roi, row.multiplier, row.multiplierRaw, row.cexTs, row.dexTs, row.isStale, row.status, row.priceImpactPercent,
        row.routeStatus, row.fromTokenUnitPriceUsd, row.toTokenUnitPriceUsd, row.paidValueUsd, row.receivedValueUsd, row.rawResponse,
        row.nativeQuoteAmount, row.nativeQuoteSymbol, row.usdtRate, row.conversionCostUsdt, row.usdtEstimate, row.valuationStatus, row.priceSourceTime, row.quoteSummary, row.dexRequestMs,
        row.cexReceivedAt, row.dexRequestStartedAt, row.dexQueueWaitMs,
      ]);
      const profit = row.netProfitAfterRebalanceUsdt ?? row.netProfitUsdt;
      if (row.valuationStatus === "VERIFIED" && row.status === "OK" && profit && new Decimal(profit).gt(0)) {
        const [activeRowsResult] = await connection.execute(
          `SELECT id,CAST(peak_profit_usdt AS CHAR) peak_profit_usdt,ever_executable FROM opportunity
           WHERE inst_id=? AND chain_index=? AND direction=? AND size_usdt=? AND ended_at IS NULL AND legacy_sample=0 LIMIT 1 FOR UPDATE`,
          [row.instId, row.chainIndex, row.direction, String(row.sizeUsdt)],
        );
        const active = (activeRowsResult as Array<{ id: number; peak_profit_usdt: string; ever_executable: number }>)[0];
        if (active) {
          await connection.execute(`UPDATE opportunity SET quote_observation_id=?,net_profit_usdt=?,roi=?,peak_profit_usdt=?,consecutive_misses=0,
            executable_status=?,execution_buffer_usdt=?,executable_profit_usdt=?,execution_reason=?,ever_executable=ever_executable OR ? WHERE id=?`, [
            result.insertId, profit, row.roi, Decimal.max(new Decimal(active.peak_profit_usdt), new Decimal(profit)).toString(),
            row.executableStatus, row.executionBufferUsdt, row.executableProfitUsdt, row.executionReason,
            row.executableStatus === "EXECUTABLE" ? 1 : 0, active.id,
          ]);
        } else {
          await connection.execute(`INSERT INTO opportunity
            (quote_observation_id,inst_id,chain_index,observed_at,direction,size_usdt,net_profit_usdt,roi,peak_profit_usdt,executable_status,execution_buffer_usdt,executable_profit_usdt,execution_reason,ever_executable)
            SELECT ?,?,?,q.observed_at,?,?,?,?,?,?,?,?,?,? FROM quote_observation q WHERE q.id=?`, [
            result.insertId, row.instId, row.chainIndex, row.direction, String(row.sizeUsdt), profit, row.roi, profit,
            row.executableStatus, row.executionBufferUsdt, row.executableProfitUsdt, row.executionReason,
            row.executableStatus === "EXECUTABLE" ? 1 : 0, result.insertId,
          ]);
        }
      } else if (row.valuationStatus !== "VERIFIED" || row.status !== "OK") {
        const code = row.valuationReasonCode ?? row.status;
        await connection.execute(`UPDATE opportunity SET ended_at=UTC_TIMESTAMP(3),close_reason=?,consecutive_misses=0
          WHERE inst_id=? AND chain_index=? AND direction=? AND size_usdt=? AND ended_at IS NULL AND legacy_sample=0`, [
          code, row.instId, row.chainIndex, row.direction, String(row.sizeUsdt),
        ]);
        if (row.status === "GAS_UNKNOWN") {
          await connection.execute(`INSERT INTO risk_event (inst_id,chain_index,direction,size_usdt,decision,reason_code,reason,cex_ts,quote_response,observed_at)
            VALUES (?,?,?,?,'BLOCK','GAS_UNKNOWN','DEX quote did not provide a valid USD network fee estimate',?,?,UTC_TIMESTAMP(3))`, [
            row.instId, row.chainIndex, row.direction, String(row.sizeUsdt), row.cexTs, row.rawResponse,
          ]);
        }
      }
      if (row.valuationStatus === "VERIFIED" && row.status === "OK" && (!profit || !new Decimal(profit).gt(0))) {
        const [activeRowsResult] = await connection.execute(
          `SELECT id,consecutive_misses FROM opportunity WHERE inst_id=? AND chain_index=? AND direction=? AND size_usdt=?
           AND ended_at IS NULL AND legacy_sample=0 LIMIT 1 FOR UPDATE`,
          [row.instId, row.chainIndex, row.direction, String(row.sizeUsdt)],
        );
        const active = (activeRowsResult as Array<{ id: number; consecutive_misses: number }>)[0];
        if (active) {
          const misses = active.consecutive_misses + 1;
          await connection.execute(`UPDATE opportunity SET consecutive_misses=?,executable_status='NOT_EXECUTABLE',executable_profit_usdt=NULL,
            execution_reason='PROFIT_BELOW_ZERO',ended_at=IF(? >= 2,UTC_TIMESTAMP(3),ended_at),
            close_reason=IF(? >= 2,'PROFIT_BELOW_ZERO',close_reason) WHERE id=?`, [misses, misses, misses, active.id]);
        }
      }
    }
  });
}

export async function closeOpportunityWindow(instId: string, chainIndex: string, reason: string, direction?: string, sizeUsdt?: number): Promise<void> {
  const conditions = ["inst_id=?", "chain_index=?", "ended_at IS NULL", "legacy_sample=0"];
  const values: string[] = [instId, chainIndex];
  if (direction) { conditions.push("direction=?"); values.push(direction); }
  if (sizeUsdt !== undefined) { conditions.push("size_usdt=?"); values.push(String(sizeUsdt)); }
  await transaction(async (connection) => {
    await connection.execute(`UPDATE opportunity SET ended_at=UTC_TIMESTAMP(3),close_reason=?,consecutive_misses=0 WHERE ${conditions.join(" AND ")}`, [reason, ...values]);
  });
}
