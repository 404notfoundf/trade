import Decimal from "decimal.js";
import { execute, query, type Health } from "./db.js";
import type { AssetConfig } from "./config.js";
import type { DashboardState, RouteDashboardState } from "./dashboard.js";
import type { ValuationView } from "./valuation.js";

type StoredRoute = Omit<RouteDashboardState, "multiplier"> & { multiplier?: string };
type StoredState = { savedAt: number; collectorRunning: boolean; health: Health[]; routes: StoredRoute[]; valuation?: ValuationView };

export async function saveDashboardState(state: DashboardState): Promise<void> {
  const snapshot: StoredState = {
    savedAt: Date.now(),
    collectorRunning: state.collection?.running ?? true,
    health: [...state.health.values()],
    routes: state.routes.map(({ multiplier, ...route }) => ({ ...route, multiplier: multiplier?.toString() })),
    valuation: state.valuation,
  };
  await execute(
    "INSERT INTO dashboard_state (id,snapshot,updated_at) VALUES (1,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE snapshot=VALUES(snapshot),updated_at=VALUES(updated_at)",
    [JSON.stringify(snapshot)],
  );
}

export async function readDashboardState(assets: AssetConfig[]): Promise<DashboardState> {
  const rows = await query<Array<{ snapshot: unknown }>>("SELECT snapshot FROM dashboard_state WHERE id=1");
  let snapshot: StoredState | undefined;
  try {
    const raw = rows[0]?.snapshot;
    snapshot = (typeof raw === "string" ? JSON.parse(raw) : raw) as StoredState | undefined;
    if (!snapshot || !Number.isFinite(snapshot.savedAt) || !Array.isArray(snapshot.health) || !Array.isArray(snapshot.routes)) snapshot = undefined;
  } catch { snapshot = undefined; }

  const now = Date.now();
  const running = !!snapshot?.collectorRunning && now - snapshot.savedAt <= 15_000 && now >= snapshot.savedAt;
  const health = new Map<string, Health>((snapshot?.health ?? []).map((entry) => [entry.dependency, entry] as const));
  const lastUpdated = snapshot ? new Date(snapshot.savedAt).toISOString().replace("T", " ").slice(0, 23) : null;
  health.set("collector", {
    dependency: "collector",
    status: running ? "healthy" : "stopped",
    lastSuccess: running ? lastUpdated : null,
    lastError: running ? null : "采集进程已停止或状态快照超过 15 秒",
  });

  const savedRoutes = new Map<string, StoredRoute>((snapshot?.routes ?? []).map((route) => [`${route.asset.instId}:${route.asset.chainIndex}`, route] as const));
  const routes: RouteDashboardState[] = assets.map((asset) => {
    if (!asset.enabled) return { asset, status: "DISABLED", reason: "资产或链路线在配置中关闭", instrumentReady: false, feeReady: false, bookReady: false };
    const saved = savedRoutes.get(`${asset.instId}:${asset.chainIndex}`);
    if (!saved) return { asset, status: "UNKNOWN", reason: "尚无采集器状态快照", instrumentReady: false, feeReady: false, bookReady: false };
    return {
      ...saved,
      asset,
      status: running ? saved.status : "UNKNOWN",
      reason: running ? saved.reason : "采集已停止；上次路线状态不代表当前状态",
      multiplier: saved.multiplier ? new Decimal(saved.multiplier) : undefined,
      instrumentReady: running && saved.instrumentReady,
      feeReady: running && saved.feeReady,
      bookReady: running && saved.bookReady,
    };
  });

  return {
    health,
    dbOnline: true,
    routes,
    valuation: running ? snapshot?.valuation : undefined,
    collection: { running, updatedAt: snapshot?.savedAt ?? null },
  };
}
