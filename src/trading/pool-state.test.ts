import assert from "node:assert/strict";
import test from "node:test";
import { poolStateView, recordAdapterPoolState } from "./pool-state.js";

const healthyFixed = {
  status: "healthy" as const,
  connectionStatus: "connected" as const,
  rpcSnapshotStatus: "healthy" as const,
  marginalPrice: "1.2",
  lastError: null,
};

test("pool state view uses the adapter-owned watch when available", () => {
  assert.deepEqual(poolStateView({ adapter: { stateSource: "adapter_watch" }, watchStatus: "healthy", marginalPrice: "2.5" }, undefined), {
    source: "adapter_watch", healthy: true, marginalPrice: "2.5", error: undefined,
  });
});

test("adapter watch outage never falls back to a stale fixed-monitor snapshot", () => {
  assert.deepEqual(poolStateView({ adapter: { stateSource: "adapter_watch" }, watchStatus: "unavailable", marginalPrice: "2.5", watchError: "disconnected" }, healthyFixed), {
    source: "adapter_watch", healthy: false, marginalPrice: undefined, error: "disconnected",
  });
});

test("fixed monitor requires a connected watch and healthy RPC snapshot", () => {
  const fixed = { adapter: { stateSource: "fixed_monitor" } as const, watchStatus: "not_required" as const };
  assert.equal(poolStateView(fixed, healthyFixed).healthy, true);
  assert.equal(poolStateView(fixed, { ...healthyFixed, connectionStatus: "disconnected" }).healthy, false);
  assert.equal(poolStateView(fixed, { ...healthyFixed, rpcSnapshotStatus: "unknown" }).healthy, false);
});

test("adapter snapshots and outages normalize into the shared persisted pool state", () => {
  const initial = {
    poolId: "pool-1", instId: "XSPCX-USDT", chainIndex: "501", dex: "meteora-dlmm", address: "pool-address",
    baseTokenSymbol: "XSPCX", baseTokenAddress: "asset", quoteTokenSymbol: "USDC", quoteTokenAddress: "quote",
    status: "unknown" as const, connectionStatus: "unknown" as const, rpcSnapshotStatus: "unknown" as const,
    lastRpcSnapshotAt: null, rpcSnapshotError: null, latestHistoryGap: null, finality: null, confirmedBlockNumber: null,
    lastError: null, source: null, marginalPrice: null, sqrtPriceRaw: null, liquidityRaw: null,
    blockNumber: null, blockHash: null, slot: null, transactionHash: null, logIndex: null,
    accountDataHash: null, eventFingerprint: null, observedAt: null,
  };
  const healthy = recordAdapterPoolState(initial, { kind: "snapshot", snapshot: {
    slot: 42n, observedAt: 1_000, stateFingerprint: "fingerprint", marginalPrice: "1.25",
  } });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.connectionStatus, "connected");
  assert.equal(healthy.rpcSnapshotStatus, "healthy");
  assert.equal(healthy.marginalPrice, "1.25");
  assert.equal(healthy.accountDataHash, "fingerprint");

  const unavailable = recordAdapterPoolState(healthy, { kind: "unavailable", reason: "socket disconnected", identityMismatch: false });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.connectionStatus, "disconnected");
  assert.equal(unavailable.lastError, "socket disconnected");
  assert.equal(unavailable.marginalPrice, "1.25");
});
