import type { PoolMonitorState } from "../fixed-pools.js";
import type { AdapterPoolState } from "./pool-adapters.js";

type AdapterWatchState = {
  adapter: { stateSource: "fixed_monitor" | "adapter_watch" };
  watchStatus: "not_required" | "healthy" | "unavailable";
  marginalPrice?: string;
  watchError?: string;
};

type FixedPoolState = Pick<PoolMonitorState, "status" | "connectionStatus" | "rpcSnapshotStatus" | "marginalPrice" | "lastError">;

export type PoolStateView = {
  source: "adapter_watch" | "fixed_monitor";
  healthy: boolean;
  marginalPrice?: string;
  error?: string | null;
};

export type AdapterPoolStateEvent =
  | { kind: "snapshot"; snapshot: AdapterPoolState }
  | { kind: "unavailable"; reason: string; identityMismatch: boolean };

export function poolStateView(adapter: AdapterWatchState, fixed?: FixedPoolState): PoolStateView {
  if (adapter.adapter.stateSource === "adapter_watch") {
    return {
      source: "adapter_watch",
      healthy: adapter.watchStatus === "healthy",
      marginalPrice: adapter.watchStatus === "healthy" ? adapter.marginalPrice : undefined,
      error: adapter.watchError,
    };
  }

  return {
    source: "fixed_monitor",
    healthy: fixed?.status === "healthy" && fixed.connectionStatus === "connected" && fixed.rpcSnapshotStatus === "healthy",
    marginalPrice: fixed?.marginalPrice ?? undefined,
    error: fixed?.lastError,
  };
}

export function recordAdapterPoolState(previous: PoolMonitorState, event: AdapterPoolStateEvent): PoolMonitorState {
  if (event.kind === "unavailable") {
    return {
      ...previous,
      status: event.identityMismatch ? "invalid" : "unavailable",
      connectionStatus: "disconnected",
      rpcSnapshotStatus: "unavailable",
      rpcSnapshotError: event.reason,
      lastError: event.reason,
      source: "adapter_watch",
    };
  }

  const slot = Number(event.snapshot.slot);
  if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isFinite(event.snapshot.observedAt)) {
    throw new Error(`Pool ${previous.poolId} adapter watch returned an invalid snapshot version`);
  }
  return {
    ...previous,
    status: "healthy",
    connectionStatus: "connected",
    rpcSnapshotStatus: "healthy",
    lastRpcSnapshotAt: event.snapshot.observedAt,
    rpcSnapshotError: null,
    source: "adapter_watch",
    marginalPrice: event.snapshot.marginalPrice ?? null,
    slot,
    accountDataHash: event.snapshot.stateFingerprint,
    lastError: null,
    observedAt: event.snapshot.observedAt,
  };
}
