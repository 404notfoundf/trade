import assert from "node:assert/strict";
import test from "node:test";
import { recoverCycle, type CexOrderIntent, type RecoveryCycle, type RecoveryOrder, type RecoveryPorts } from "./recovery.js";

const intent: CexOrderIntent = {
  instId: "XNVDA-USDT", clOrdId: "xa-test-1", side: "buy" as const, sz: "1", px: "100",
  dexAssetDeltaRaw: "-10", dexQuoteDeltaRaw: "1000",
};
const baseCycle: RecoveryCycle = {
  id: 1, status: "CEX_SUBMITTED", instId: "XNVDA-USDT", chainIndex: "196",
  direction: "cex_buy_dex_sell", chainTxHash: "0xswap", clientOrderId: intent.clOrdId, cexOrderIntent: intent,
};
const fullOrder: RecoveryOrder = {
  ordId: "order-1", clOrdId: intent.clOrdId, instId: intent.instId, side: intent.side,
  sz: intent.sz, px: intent.px, state: "filled", accFillSz: intent.sz, avgPx: "99.5",
};

function fakePorts(overrides: Partial<RecoveryPorts> = {}) {
  const calls = { chain: 0, deltas: 0, order: 0 };
  const ports: RecoveryPorts = {
    chainStatus: async () => { calls.chain++; return "confirmed"; },
    swapDeltas: async () => { calls.deltas++; return { assetDelta: -10n, quoteDelta: 1000n }; },
    cexOrder: async () => { calls.order++; return fullOrder; },
    ...overrides,
  };
  return { ports, calls };
}

test("PREPARING cycle without a recorded transaction is safely abandoned", async () => {
  const { ports, calls } = fakePorts();
  const result = await recoverCycle({ ...baseCycle, status: "PREPARING", chainTxHash: null }, ports);
  assert.equal(result.status, "FAILED");
  assert.deepEqual(calls, { chain: 0, deltas: 0, order: 0 });
});

test("restart verifies an accepted CEX order from the persisted intent", async () => {
  const { ports } = fakePorts();
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.order?.ordId, "order-1");
});

test("unknown chain status remains unresolved without reading deltas or querying CEX", async () => {
  const { ports, calls } = fakePorts({ chainStatus: async () => { calls.chain++; return "unknown"; } });
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(result.chainStatus, "unknown");
  assert.deepEqual(calls, { chain: 1, deltas: 0, order: 0 });
});

test("broadcast timeout with a confirmed chain transaction stops before any resubmission", async () => {
  const { ports, calls } = fakePorts();
  const result = await recoverCycle({ ...baseCycle, status: "DEX_SUBMITTED", cexOrderIntent: null }, ports);
  assert.equal(result.status, "HEDGE_REQUIRED");
  assert.match(result.reason, /no CEX order intent/);
  assert.deepEqual(calls, { chain: 1, deltas: 1, order: 0 });
});

test("confirmed DEX swap with a partial CEX fill requires a hedge", async () => {
  const { ports } = fakePorts({
    cexOrder: async () => ({ ...fullOrder, state: "canceled", accFillSz: "0.4" }),
  });
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "HEDGE_REQUIRED");
});

test("chain deltas must match the exact DEX amounts attached to the CEX intent", async () => {
  const { ports } = fakePorts({ swapDeltas: async () => ({ assetDelta: -9n, quoteDelta: 1000n }) });
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "HEDGE_REQUIRED");
  assert.match(result.reason, /deltas differ/);
});

test("missing CEX order stays unresolved and recovery never submits another order", async () => {
  const { ports, calls } = fakePorts({ cexOrder: async () => { calls.order++; return null; } });
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.match(result.reason, /must not be retried/);
  assert.deepEqual(calls, { chain: 1, deltas: 1, order: 1 });
});

test("CEX order that differs from the persisted intent stays unresolved", async () => {
  const { ports, calls } = fakePorts();
  ports.cexOrder = async () => { calls.order++; return { ...fullOrder, px: "101" }; };
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.match(result.reason, /does not match the persisted order intent/);
  assert.deepEqual(calls, { chain: 1, deltas: 1, order: 1 });
});

test("failed chain transaction with a persisted CEX intent remains unresolved", async () => {
  const { ports, calls } = fakePorts({ chainStatus: async () => { calls.chain++; return "failed"; } });
  const result = await recoverCycle(baseCycle, ports);
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(result.chainStatus, "failed");
  assert.deepEqual(calls, { chain: 1, deltas: 0, order: 0 });
});
