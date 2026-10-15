import { execute } from "../db.js";

export type DirectPoolQuoteRecord = {
  scanId: string; instrumentId: string; chainIndex: string; poolId: string; dex: string; direction: string;
  amountInRaw: bigint | null; amountOutRaw: bigint | null; minimumAmountOutRaw: bigint | null;
  priceImpactPercent: string | null; networkFeeNativeRaw: bigint | null; networkFeeUsdt: string | null;
  blockNumber: bigint | null; blockHash: string | null; slot: bigint | null; poolStateFingerprint: string | null;
  quotedAt: Date | null; requestMs: number | null; status: string; failureCode: string | null; failureReason: string | null; rawResponse: unknown;
};

export type DirectPoolDecisionRecord = {
  scanId: string; instrumentId: string; chainIndex: string; poolId: string | null; direction: string; sizeUsdt: string;
  selectedQuoteId: number | null; cexBookAt: Date | null; cexReceivedAt: Date | null; cexSeqId: number | null;
  cexBid: string | null; cexAsk: string | null; cexVwap: string | null; cexFeeUsdt: string | null;
  dexNetworkFeeUsdt: string | null; gasBudgetUsdt: string | null; valuationInputs: unknown; grossProfitUsdt: string | null; netProfitUsdt: string | null;
  roi: string | null; valuationStatus: string; decisionStatus: string; blockReason: string | null;
};

export type AggregatorShadowRecord = {
  scanId: string; instrumentId: string; chainIndex: string; direction: string; sizeUsdt: string;
  cexBookAt: Date; cexReceivedAt: Date; cexSeqId: number; fromToken: string; toToken: string;
  amountInRaw: string; amountOutRaw: string | null; priceImpactPercent: string | null;
  quotedAt: Date | null; requestMs: number | null; queueWaitMs: number | null;
  status: string; failureCode: string | null; failureReason: string | null; rawResponse: unknown;
};

export async function saveDirectPoolQuote(row: DirectPoolQuoteRecord): Promise<number> {
  const result = await execute(`INSERT INTO direct_pool_quote
    (scan_id,instrument_id,chain_index,pool_id,dex,direction,amount_in_raw,amount_out_raw,minimum_amount_out_raw,price_impact_percent,
     network_fee_native_raw,network_fee_usdt,block_number,block_hash,slot,pool_state_fingerprint,quoted_at,request_ms,status,failure_code,failure_reason,raw_response)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    row.scanId, row.instrumentId, row.chainIndex, row.poolId, row.dex, row.direction,
    row.amountInRaw?.toString() ?? null, row.amountOutRaw?.toString() ?? null, row.minimumAmountOutRaw?.toString() ?? null,
    row.priceImpactPercent, row.networkFeeNativeRaw?.toString() ?? null, row.networkFeeUsdt, row.blockNumber?.toString() ?? null,
    row.blockHash, row.slot?.toString() ?? null, row.poolStateFingerprint, row.quotedAt, row.requestMs, row.status,
    row.failureCode, row.failureReason?.slice(0, 500) ?? null, row.rawResponse === null ? null : JSON.stringify(row.rawResponse),
  ]);
  return result.insertId;
}

export async function saveDirectPoolDecision(row: DirectPoolDecisionRecord): Promise<void> {
  await execute(`INSERT INTO direct_pool_decision
    (scan_id,instrument_id,chain_index,pool_id,direction,size_usdt,selected_quote_id,cex_book_at,cex_received_at,cex_seq_id,cex_bid,cex_ask,
     cex_vwap,cex_fee_usdt,dex_network_fee_usdt,gas_budget_usdt,valuation_inputs,gross_profit_usdt,net_profit_usdt,roi,valuation_status,decision_status,block_reason,execution_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NOT_EXECUTABLE')`, [
    row.scanId, row.instrumentId, row.chainIndex, row.poolId, row.direction, row.sizeUsdt, row.selectedQuoteId,
    row.cexBookAt, row.cexReceivedAt, row.cexSeqId, row.cexBid, row.cexAsk, row.cexVwap, row.cexFeeUsdt,
    row.dexNetworkFeeUsdt, row.gasBudgetUsdt, row.valuationInputs === null ? null : JSON.stringify(row.valuationInputs), row.grossProfitUsdt,
    row.netProfitUsdt, row.roi, row.valuationStatus, row.decisionStatus, row.blockReason?.slice(0, 500) ?? null,
  ]);
}

export async function saveAggregatorShadowQuote(row: AggregatorShadowRecord): Promise<void> {
  await execute(`INSERT INTO aggregator_shadow_quote
    (scan_id,instrument_id,chain_index,direction,size_usdt,cex_book_at,cex_received_at,cex_seq_id,from_token,to_token,
     amount_in_raw,amount_out_raw,price_impact_percent,quoted_at,request_ms,queue_wait_ms,status,failure_code,failure_reason,raw_response)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    row.scanId, row.instrumentId, row.chainIndex, row.direction, row.sizeUsdt, row.cexBookAt, row.cexReceivedAt,
    row.cexSeqId, row.fromToken, row.toToken, row.amountInRaw, row.amountOutRaw, row.priceImpactPercent,
    row.quotedAt, row.requestMs, row.queueWaitMs, row.status, row.failureCode,
    row.failureReason?.slice(0, 500) ?? null, row.rawResponse === null ? null : JSON.stringify(row.rawResponse),
  ]);
}
