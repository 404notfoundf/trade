import Decimal from "decimal.js";

export type CexOrderIntent = {
  instId: string;
  clOrdId: string;
  side: "buy" | "sell";
  sz: string;
  px: string;
  dexAssetDeltaRaw: string;
  dexQuoteDeltaRaw: string;
  preparedAt?: string;
};

export type RecoveryCycle = {
  id: number;
  status: string;
  instId: string;
  chainIndex: string;
  direction: "cex_buy_dex_sell" | "dex_buy_cex_sell";
  chainTxHash: string | null;
  clientOrderId: string | null;
  cexOrderIntent: CexOrderIntent | null;
};

export type RecoveryOrder = {
  ordId?: string;
  clOrdId?: string;
  instId?: string;
  side?: string;
  sz?: string;
  px?: string;
  state?: string;
  accFillSz?: string;
  avgPx?: string;
};

export type RecoveryDecision = {
  status: "COMPLETE" | "FAILED" | "HEDGE_REQUIRED" | "RECOVERY_REQUIRED";
  reason: string;
  chainStatus?: "confirmed" | "failed" | "pending" | "unknown";
  order?: RecoveryOrder;
  assetDeltaRaw?: string;
  quoteDeltaRaw?: string;
};

export type RecoveryPorts = {
  chainStatus: (chainIndex: string, txHash: string) => Promise<"confirmed" | "failed" | "pending" | "unknown">;
  swapDeltas: (cycle: RecoveryCycle) => Promise<{ assetDelta: bigint; quoteDelta: bigint }>;
  cexOrder: (cycle: RecoveryCycle) => Promise<RecoveryOrder | null>;
};

function decimalEquals(left: string | undefined, right: string): boolean {
  try { const value = new Decimal(left ?? "NaN"); return value.isFinite() && value.eq(right); }
  catch { return false; }
}

function decimalPositive(value: string | undefined): boolean {
  try { const amount = new Decimal(value ?? "NaN"); return amount.isFinite() && amount.gt(0); }
  catch { return false; }
}

export async function recoverCycle(cycle: RecoveryCycle, ports: RecoveryPorts): Promise<RecoveryDecision> {
  if (!cycle.chainTxHash) {
    return cycle.status === "PREPARING"
      ? { status: "FAILED", reason: "Process stopped before a chain transaction was recorded" }
      : { status: "RECOVERY_REQUIRED", reason: "Cycle has no recorded chain transaction hash" };
  }

  const chainStatus = await ports.chainStatus(cycle.chainIndex, cycle.chainTxHash);
  if (chainStatus === "failed") {
    return cycle.cexOrderIntent
      ? { status: "RECOVERY_REQUIRED", reason: "Chain transaction failed but a CEX order intent exists", chainStatus }
      : { status: "FAILED", reason: "Recorded chain transaction reverted", chainStatus };
  }
  if (chainStatus !== "confirmed") {
    return { status: "RECOVERY_REQUIRED", reason: `Chain transaction status is ${chainStatus}`, chainStatus };
  }

  const { assetDelta, quoteDelta } = await ports.swapDeltas(cycle);
  const deltasMatchDirection = cycle.direction === "cex_buy_dex_sell"
    ? assetDelta < 0n && quoteDelta > 0n
    : assetDelta > 0n && quoteDelta < 0n;
  if (!deltasMatchDirection) {
    return {
      status: "HEDGE_REQUIRED",
      reason: "Confirmed chain transaction has unexpected asset balance deltas",
      chainStatus,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  if (cycle.cexOrderIntent && (BigInt(cycle.cexOrderIntent.dexAssetDeltaRaw) !== assetDelta
    || BigInt(cycle.cexOrderIntent.dexQuoteDeltaRaw) !== quoteDelta)) {
    return {
      status: "HEDGE_REQUIRED",
      reason: "Confirmed chain transaction deltas differ from the amounts recorded before the CEX hedge",
      chainStatus,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  const cexSubmissionMayHaveStarted = cycle.cexOrderIntent !== null
    || cycle.status === "CEX_SUBMITTED" || cycle.status === "CEX_SUBMITTING" || cycle.status === "RECOVERY_REQUIRED";
  if (!cexSubmissionMayHaveStarted) {
    return {
      status: "HEDGE_REQUIRED",
      reason: "DEX swap is confirmed but no CEX order intent was recorded",
      chainStatus,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  const order = await ports.cexOrder(cycle);
  if (!order) {
    return {
      status: "RECOVERY_REQUIRED",
      reason: "CEX order was not found; submission outcome remains unknown and must not be retried",
      chainStatus,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  if (!cycle.cexOrderIntent) {
    return {
      status: "HEDGE_REQUIRED",
      reason: "Legacy CEX order was found but its exact submitted size and limit were not persisted",
      chainStatus,
      order,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  const intent = cycle.cexOrderIntent;
  const orderMatchesIntent = order.clOrdId === intent.clOrdId && order.instId === intent.instId
    && order.side === intent.side && decimalEquals(order.sz, intent.sz)
    && decimalEquals(order.px, intent.px);
  if (!orderMatchesIntent) {
    return {
      status: "RECOVERY_REQUIRED",
      reason: "CEX order does not match the persisted order intent",
      chainStatus,
      order,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  if (order.state === "filled" && decimalEquals(order.accFillSz, intent.sz) && decimalPositive(order.avgPx)) {
    return {
      status: "COMPLETE",
      reason: "Chain swap and full CEX hedge were verified during recovery",
      chainStatus,
      order,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }
  if (order.state === "canceled" || order.state === "mmp_canceled" || order.state === "filled") {
    return {
      status: "HEDGE_REQUIRED",
      reason: `CEX order ended ${order.state} with ${order.accFillSz ?? "0"} of ${intent.sz} shares filled`,
      chainStatus,
      order,
      assetDeltaRaw: assetDelta.toString(),
      quoteDeltaRaw: quoteDelta.toString(),
    };
  }

  return {
    status: "RECOVERY_REQUIRED",
    reason: `CEX order state is ${order.state ?? "unknown"}; no recovery order was submitted`,
    chainStatus,
    order,
    assetDeltaRaw: assetDelta.toString(),
    quoteDeltaRaw: quoteDelta.toString(),
  };
}
