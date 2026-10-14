import { execute } from "./db.js";

export type BlockedObservation = {
  instId: string;
  chainIndex: string;
  direction?: string;
  sizeUsdt: number;
  reasonCode: string;
  reason: string;
  cexTs?: Date | null;
  quoteResponse?: unknown;
};

export async function recordBlockedObservation(event: BlockedObservation): Promise<void> {
  await execute(`INSERT INTO risk_event (inst_id,chain_index,direction,size_usdt,decision,reason_code,reason,cex_ts,quote_response,observed_at)
    VALUES (?,?,?,?,'BLOCK', ?,?,?,?,UTC_TIMESTAMP(3))`, [
    event.instId, event.chainIndex, event.direction ?? null, String(event.sizeUsdt), event.reasonCode, event.reason.slice(0, 500), event.cexTs ?? null,
    event.quoteResponse === undefined ? null : JSON.stringify(event.quoteResponse),
  ]);
}
