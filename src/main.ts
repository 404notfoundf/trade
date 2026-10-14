import Decimal from "decimal.js";
import { loadConfig, type AssetConfig } from "./config.js";
import { closeDatabase, execute, initDatabase, query, type Health } from "./db.js";
import type { Instrument } from "./market.js";
import { dexIndexPrices, okxPrivateGet, okxPublicGet, OkxOrderBook, type Book } from "./okx.js";
import { OpportunityCollector } from "./collector.js";
import { closeOpportunityWindow } from "./observations.js";
import { backfillReports, startReportScheduler } from "./reports.js";
import { startDashboard, type DashboardState } from "./dashboard.js";
import { saveDashboardState } from "./dashboard-state.js";
import { createTradeHandler } from "./trading/page.js";
import { createOpportunityInventoryChecker, createTradeExecutor, validateTradeSigners } from "./trading/executor.js";
import { logger } from "./logger.js";
import { recordBlockedObservation } from "./risk.js";
import { INDEX_TARGETS, noteIndexFailure, applyIndexTicks, snapshotRows, valuationRiskEvents, valuationView, type ValuationView } from "./valuation.js";

Decimal.set({ precision: 60, rounding: Decimal.ROUND_DOWN });

type MultiplierResponse = { currentMultiplier?: number | string; multiplier?: number | string; latestMultiplier?: number | string; data?: { currentMultiplier?: number | string; multiplier?: number | string; latestMultiplier?: number | string } };
type FeeResponse = Array<{ taker: string; maker: string; category?: string }>;
type CurrencyNetwork = { ccy: string; chain: string; ctAddr?: string; canDep: boolean; canWd: boolean };
type MarketState = { instrument?: Instrument; feeRate?: Decimal; book?: Book };
type RouteRuntime = { status: "ENABLED" | "MONITOR_ONLY" | "BLOCKED"; reason: string | null; multiplier?: Decimal; multiplierRaw?: MultiplierResponse; lastGoodMultiplier?: Decimal; multiplierBaselineLoaded?: boolean; multiplierGuardReason?: string; multiplierGuardEventRecorded?: boolean };

const health = new Map<string, Health>();
let dbOnline = false;
let stopping = false;
const nowUtc = () => new Date().toISOString().replace("T", " ").slice(0, 23);
const setHealth = (dependency: string, status: string, error: string | null = null) => {
  const previous = health.get(dependency);
  const entry = { dependency, status, lastSuccess: status === "healthy" ? nowUtc() : previous?.lastSuccess ?? null, lastError: error };
  health.set(dependency, entry);
  if (!previous || previous.status !== status || previous.lastError !== error) {
    const message = `${dependency}: ${error ?? status}`;
    if (status === "unavailable") logger.error(message);
    else if (["stale", "insufficient_depth", "not_configured", "blocked", "degraded", "unknown"].includes(status)) logger.warn(message);
    else logger.info(message);
    if (dbOnline) void execute("INSERT INTO health_event (dependency,status,message,observed_at) VALUES (?,?,?,UTC_TIMESTAMP(3))", [dependency, status, error?.slice(0, 500) ?? null]).catch((dbError) => logger.error("Failed to persist health event", dbError));
  }
};
const messageOf = (error: unknown) => error instanceof Error ? error.message : "unknown error";
const routeKey = (asset: AssetConfig) => `${asset.instId}:${asset.chainIndex}`;
const assetHealthKey = (dependency: string, asset: AssetConfig) => `${dependency}_${asset.chainIndex}_${asset.instId}`;
const sameAddress = (asset: AssetConfig, actual: string | undefined) => asset.chainIndex === "196" ? actual?.toLowerCase() === asset.tokenAddress.toLowerCase() : actual === asset.tokenAddress;

async function main(): Promise<void> {
  const collectorOnly = process.argv.includes("--collector-only");
  logger.info(collectorOnly ? "Starting opportunity collector without dashboard" : "Starting multi-chain opportunity observer");
  const config = await loadConfig();
  const configuredAssets = config.assets;
  const assets = config.assets.filter((asset) => asset.enabled);
  if (config.trading.enabled) validateTradeSigners(assets, config.signers);
  const markets = new Map<string, MarketState>();
  const routes = new Map<string, RouteRuntime>(assets.map((asset) => [routeKey(asset), { status: "MONITOR_ONLY", reason: "Waiting for startup verification" }]));
  let tradingArmed = false;
  const credentialsReady = (values: string[]) => values.every(Boolean);
  const cexReady = credentialsReady([config.okx.key, config.okx.secret, config.okx.passphrase]);
  const dexReady = credentialsReady([config.dex.key, config.dex.secret, config.dex.passphrase]);

  try {
    await initDatabase(config); dbOnline = true; setHealth("mysql", "healthy");
    for (const asset of assets) await closeOpportunityWindow(asset.instId, asset.chainIndex, "COLLECTOR_RESTART");
    await backfillReports(assets);
  }
  catch (error) { dbOnline = false; setHealth("mysql", "unavailable", messageOf(error)); }
  if (!cexReady) setHealth("okx_fee", "not_configured", "Set OKX_API_KEY, OKX_API_SECRET and OKX_API_PASSPHRASE; live trading also requires Trade permission");
  if (!dexReady) setHealth("dex_quote", "not_configured", "Set OKX_DEX_API_KEY, OKX_DEX_API_SECRET and OKX_DEX_API_PASSPHRASE");

  async function probe(): Promise<void> {
    if (dbOnline) {
      try { await query<Array<{ ok: number }>>("SELECT 1 ok"); }
      catch (error) { dbOnline = false; setHealth("mysql", "unavailable", messageOf(error)); }
    }
    if (!dbOnline) {
      try {
        await initDatabase(config); dbOnline = true; setHealth("mysql", "healthy");
        for (const asset of assets) await closeOpportunityWindow(asset.instId, asset.chainIndex, "DATABASE_RECONNECTED");
        await backfillReports(assets);
      }
      catch (error) { setHealth("mysql", "unavailable", messageOf(error)); }
    }

    for (const instId of new Set(assets.map((asset) => asset.instId))) {
      const market = markets.get(instId) ?? {};
      try {
        const rows = await okxPublicGet<Instrument[]>(`/api/v5/public/instruments?instType=SPOT&instId=${encodeURIComponent(instId)}`);
        market.instrument = rows.find((row) => row.instId === instId);
        if (!market.instrument || market.instrument.state !== "live") throw new Error(`${instId} is not live on OKX`);
        if (!new Decimal(market.instrument.lotSz).gt(0) || !new Decimal(market.instrument.minSz).gt(0)) throw new Error("OKX instrument returned invalid lotSz/minSz");
        setHealth(`okx_instrument_${instId}`, "healthy");
      } catch (error) { market.instrument = undefined; setHealth(`okx_instrument_${instId}`, "unavailable", messageOf(error)); }
      if (cexReady) {
        try {
          const rows = await okxPrivateGet<FeeResponse>(`/api/v5/account/trade-fee?instType=SPOT&instId=${encodeURIComponent(instId)}`, config.okx);
          const raw = rows[0]?.taker;
          if (!raw) throw new Error("OKX trade fee response has no taker rate");
          market.feeRate = new Decimal(raw).abs();
          if (!market.feeRate.isFinite()) throw new Error("OKX trade fee response is not numeric");
          setHealth(`okx_fee_${instId}`, "healthy");
        } catch (error) { market.feeRate = undefined; setHealth(`okx_fee_${instId}`, "unavailable", messageOf(error)); }
      }
      markets.set(instId, market);
    }

    for (const asset of assets) {
      const key = routeKey(asset);
      const route = routes.get(key)!;
      if (!route.multiplierBaselineLoaded && dbOnline) {
        try {
          const snapshots = await query<Array<{ multiplier: string }>>("SELECT CAST(multiplier AS CHAR) multiplier FROM asset_config_snapshot WHERE inst_id=? AND chain_index=? ORDER BY observed_at DESC LIMIT 1", [asset.instId, asset.chainIndex]);
          route.lastGoodMultiplier = snapshots[0] ? new Decimal(snapshots[0].multiplier) : undefined;
          route.multiplierBaselineLoaded = true;
        } catch (error) { dbOnline = false; setHealth("mysql", "unavailable", messageOf(error)); }
      }
      try {
        const network = asset.network === "Solana" ? "Solana" : "XLayer";
        const response = await fetch(`https://api.backed.fi/api/v1/token/${encodeURIComponent(asset.tokenSymbol)}/multiplier?network=${network}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Backed multiplier HTTP ${response.status}`);
        const raw = await response.json() as MultiplierResponse;
        const value = raw.currentMultiplier ?? raw.multiplier ?? raw.latestMultiplier ?? raw.data?.currentMultiplier ?? raw.data?.multiplier ?? raw.data?.latestMultiplier;
        if (value === undefined || !new Decimal(value).isFinite() || new Decimal(value).lte(0)) throw new Error("Backed response has no positive multiplier");
        const candidate = new Decimal(value);
        const previous = route.lastGoodMultiplier;
        const approved = asset.approvedMultiplier !== undefined && candidate.eq(asset.approvedMultiplier);
        const changePercent = previous ? candidate.minus(previous).abs().div(previous).mul(100) : new Decimal(0);
        const exceeded = !!previous && changePercent.gt(config.runtime.guardrails.maxMultiplierChangePercent) && !candidate.eq(previous);
        if (exceeded && !approved) {
          route.multiplier = undefined;
          route.multiplierGuardReason = `Multiplier changed ${changePercent.toFixed(4)}% from ${previous!.toString()} to ${candidate.toString()}; review and set approvedMultiplier to acknowledge`;
          setHealth(assetHealthKey("multiplier_guard", asset), "blocked", route.multiplierGuardReason);
          if (dbOnline && !route.multiplierGuardEventRecorded) {
            await recordBlockedObservation({ instId: asset.instId, chainIndex: asset.chainIndex, direction: "multiplier_check", sizeUsdt: asset.observationSizesUsdt[0]!, reasonCode: "MULTIPLIER_JUMP", reason: route.multiplierGuardReason, quoteResponse: { previous: previous!.toString(), current: candidate.toString(), limitPercent: config.runtime.guardrails.maxMultiplierChangePercent, raw } });
            route.multiplierGuardEventRecorded = true;
          }
        } else if (route.multiplierGuardReason && !approved && previous && !candidate.eq(previous)) {
          route.multiplier = undefined;
          setHealth(assetHealthKey("multiplier_guard", asset), "blocked", route.multiplierGuardReason);
        } else {
          route.multiplierGuardReason = undefined;
          route.multiplierGuardEventRecorded = false;
          route.lastGoodMultiplier = candidate;
          route.multiplier = candidate;
          setHealth(assetHealthKey("multiplier_guard", asset), "healthy");
        }
        route.multiplierRaw = raw;
        setHealth(assetHealthKey("multiplier", asset), route.multiplier ? "healthy" : "blocked", route.multiplierGuardReason ?? null);
      } catch (error) { route.multiplier = undefined; setHealth(assetHealthKey("multiplier", asset), "unavailable", messageOf(error)); }
      if (route.multiplier && dbOnline) {
        try { await execute("INSERT INTO asset_config_snapshot (inst_id,chain_index,token_address,multiplier,multiplier_raw,observed_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))", [asset.instId, asset.chainIndex, asset.tokenAddress, route.multiplier.toString(), JSON.stringify(route.multiplierRaw)]); }
        catch (error) { dbOnline = false; setHealth("mysql", "unavailable", messageOf(error)); }
      }

      if (!cexReady) {
        route.status = "MONITOR_ONLY"; route.reason = route.multiplierGuardReason ?? "Read-only OKX account credentials are unavailable";
        continue;
      }
      try {
        const rows = await okxPrivateGet<CurrencyNetwork[]>(`/api/v5/asset/currencies?ccy=${encodeURIComponent(asset.okxCurrency)}`, config.okx);
        const row = rows.find((entry) => entry.chain === asset.okxChain);
        if (!row) { route.status = "MONITOR_ONLY"; route.reason = `OKX account has no ${asset.okxChain} network record`; }
        else if (!sameAddress(asset, row.ctAddr)) { route.status = "BLOCKED"; route.reason = "OKX network token address does not match pinned config"; }
        else if (row.canDep && row.canWd) { route.status = "ENABLED"; route.reason = null; }
        else { route.status = "MONITOR_ONLY"; route.reason = "OKX network deposits or withdrawals are disabled"; }
        setHealth(assetHealthKey("route", asset), route.status === "BLOCKED" ? "unavailable" : "healthy", route.reason);
      } catch (error) {
        route.status = "MONITOR_ONLY"; route.reason = `OKX network verification unavailable: ${messageOf(error)}`;
        setHealth(assetHealthKey("route", asset), "unavailable", route.reason);
      }
      if (route.multiplierGuardReason && route.status !== "BLOCKED") { route.status = "MONITOR_ONLY"; route.reason = route.multiplierGuardReason; }
    }
    if (dexReady) setHealth("dex_quote", "waiting_for_quote");
  }

  const limits = () => ({
    maxUsdtUsdDeviationPercent: config.runtime.guardrails.maxUsdtUsdDeviationPercent,
    maxUsdt0UsdtDeviationPercent: config.runtime.guardrails.maxUsdt0UsdtDeviationPercent,
    indexPriceMaxAgeMs: config.runtime.guardrails.indexPriceMaxAgeSeconds * 1000,
  });
  let valuation: ValuationView = valuationView(Date.now(), limits());
  const valuationEventAt = new Map<string, number>();
  let refreshingValuation = false;
  const gateStatus = (status: string) => status === "healthy" ? "healthy" : status === "blocked" ? "blocked" : status === "stale" ? "stale" : "unknown";
  async function refreshValuation(): Promise<void> {
    if (refreshingValuation) return;
    refreshingValuation = true;
    const maxAgeMs = limits().indexPriceMaxAgeMs;
    try {
      const now = Date.now();
      if (!dexReady) {
        noteIndexFailure("DEX index credentials are not configured", now, maxAgeMs);
        setHealth("index_price", "not_configured", "Set OKX_DEX_API_KEY, OKX_DEX_API_SECRET and OKX_DEX_API_PASSPHRASE");
      } else {
        try {
          const ticks = await dexIndexPrices(INDEX_TARGETS.map(({ chainIndex, tokenContractAddress }) => ({ chainIndex, tokenContractAddress })), config.dex);
          applyIndexTicks(ticks, Date.now(), maxAgeMs);
          setHealth("index_price", "healthy");
        } catch (error) {
          noteIndexFailure(messageOf(error), Date.now(), maxAgeMs);
          setHealth("index_price", "unavailable", messageOf(error));
        }
      }
      const viewedAt = Date.now();
      valuation = valuationView(viewedAt, limits());
      setHealth("usdt_usd", gateStatus(valuation.usdtUsd.status), valuation.usdtUsd.reason || null);
      setHealth("sol_usdt", gateStatus(valuation.solUsdt.status), valuation.solUsdt.reason || null);
      setHealth("usdt0_usdt", gateStatus(valuation.parity.status), valuation.parity.reason || null);
      if (!dbOnline) return;
      for (const row of snapshotRows(viewedAt, maxAgeMs)) {
        await execute("INSERT INTO stablecoin_price_snapshot (chain_index,token_address,symbol,usd_price,source,source_time,fetched_at,status,diagnostic) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),?,?)", [
          row.chainIndex, row.tokenAddress, row.symbol, row.usdPrice, row.source, row.sourceTime, row.status, row.diagnostic,
        ]);
      }
      for (const event of valuationRiskEvents(valuation, assets)) {
        const key = `${event.chainIndex}:${event.reasonCode}`;
        if (viewedAt - (valuationEventAt.get(key) ?? 0) < 60_000) continue;
        valuationEventAt.set(key, viewedAt);
        await recordBlockedObservation({ instId: event.instId, chainIndex: event.chainIndex, direction: event.direction, sizeUsdt: event.sizeUsdt, reasonCode: event.reasonCode, reason: event.reason, quoteResponse: { status: event.reasonCode, source: "okx_index" } });
      }
    } catch (error) {
      dbOnline = false;
      setHealth("mysql", "unavailable", messageOf(error));
    } finally {
      refreshingValuation = false;
    }
  }

  const books: OkxOrderBook[] = [];
  for (const instId of new Set(assets.map((asset) => asset.instId))) {
    const market = markets.get(instId) ?? {}; markets.set(instId, market);
    const client = new OkxOrderBook(instId, (book) => { market.book = book; setHealth(`okx_websocket_${instId}`, "healthy"); }, (error) => { market.book = undefined; setHealth(`okx_websocket_${instId}`, "unavailable", error); });
    books.push(client); client.start();
  }
  const checkOpportunityInventory = config.trading.enabled ? createOpportunityInventoryChecker(config.okx, config.signers, assets, config.trading.tradeSizeUsdt, config.trading.maxTradeSizeUsdt) : undefined;
  const collectors = assets.map((asset, index) => new OpportunityCollector({
    asset, initialDelayMs: Math.floor(asset.dexQuoteIntervalMs * index / assets.length),
    guardrails: config.runtime.guardrails, dexCredentials: config.dex,
    tradingStatus: () => !config.trading.enabled ? "DISABLED" : tradingArmed ? "ARMED" : "UNARMED",
    checkInventory: checkOpportunityInventory ? (row) => checkOpportunityInventory(asset, row) : undefined,
    getState: () => {
      const market = markets.get(asset.instId)!;
      const route = routes.get(routeKey(asset))!;
      return { ...market, multiplier: route.multiplier, multiplierRaw: route.multiplierRaw, dbOnline, routeStatus: route.status, routeReason: route.reason };
    },
    setHealth,
    onRouteBlocked: (reason) => {
      const route = routes.get(routeKey(asset))!;
      route.status = "BLOCKED"; route.reason = reason;
      setHealth(assetHealthKey("route", asset), "unavailable", reason);
    },
    onDatabaseError: (error) => { dbOnline = false; setHealth("mysql", "unavailable", messageOf(error)); },
  }));
  const getTradeState = (asset: AssetConfig) => {
    const market = markets.get(asset.instId);
    const route = routes.get(routeKey(asset));
    return { routeStatus: route?.status ?? "BLOCKED", instrument: market?.instrument, feeRate: market?.feeRate, multiplier: route?.multiplier, book: market?.book };
  };
  const tradeExecutor = createTradeExecutor({
    enabled: config.trading.enabled,
    armed: () => tradingArmed,
    tradeSizeUsdt: config.trading.tradeSizeUsdt,
    maxTradeSizeUsdt: config.trading.maxTradeSizeUsdt,
    assets,
    okx: config.okx,
    dex: config.dex,
    signers: config.signers,
    guardrails: config.runtime.guardrails,
    dbReady: () => dbOnline,
    getState: getTradeState,
    pause: () => { tradingArmed = false; },
    setHealth,
  });
  const tradeHandler = createTradeHandler(() => ({
    trading: config.trading,
    guardrails: config.runtime.guardrails,
    routes: configuredAssets.map((asset) => {
      if (!asset.enabled) return { asset, routeStatus: "DISABLED", multiplierReady: false, marketReady: false };
      const route = routes.get(routeKey(asset));
      const market = markets.get(asset.instId);
      return { asset, routeStatus: route?.status ?? "BLOCKED", multiplierReady: !!route?.multiplier, marketReady: !!market?.instrument && !!market.feeRate && !!market.book?.ready };
    }),
    executionStatus: health.get("trade_execution")?.lastError ?? health.get("trade_execution")?.status ?? "disarmed",
  }), (armed) => {
    tradingArmed = armed;
    if (!armed && dbOnline) void execute("UPDATE opportunity SET executable_status='NOT_EVALUATED',executable_profit_usdt=NULL,execution_reason='Automatic trading is not armed' WHERE ended_at IS NULL AND legacy_sample=0")
      .catch((error) => { dbOnline = false; setHealth("mysql", "unavailable", messageOf(error)); });
  });
  const getDashboardState = (): DashboardState => ({
    health, dbOnline, valuation,
    collection: { running: !stopping, updatedAt: Date.now() },
    routes: configuredAssets.map((asset) => {
      if (!asset.enabled) return { asset, status: "DISABLED", reason: "资产或链路线在配置中关闭", instrumentReady: false, feeReady: false, bookReady: false };
      return { asset, ...routes.get(routeKey(asset))!, instrumentReady: !!markets.get(asset.instId)?.instrument, feeReady: !!markets.get(asset.instId)?.feeRate, bookReady: !!markets.get(asset.instId)?.book?.ready };
    }),
  });
  const server = collectorOnly ? undefined : startDashboard(config, configuredAssets, getDashboardState, tradeHandler);
  await probe();
  if (config.trading.enabled) await tradeExecutor.checkApprovals();
  startReportScheduler(assets);
  setInterval(() => void probe().catch((error) => logger.error("Health probe failed", error)), config.runtime.healthProbeIntervalSeconds * 1000);
  await refreshValuation();
  const persistDashboardState = async () => {
    if (!dbOnline) return;
    try { await saveDashboardState(getDashboardState()); }
    catch (error) { logger.error("Failed to persist dashboard state", error); }
  };
  await persistDashboardState();
  const dashboardStateTimer = setInterval(() => void persistDashboardState(), 5000);
  setInterval(() => void refreshValuation().catch((error) => setHealth("index_price", "unavailable", messageOf(error))), config.runtime.guardrails.indexPriceRefreshSeconds * 1000);
  setInterval(() => { for (const collector of collectors) void collector.collect().catch((error) => setHealth("collector", "unavailable", messageOf(error))); }, 250);
  setInterval(() => void tradeExecutor.tick(), 1000);
  const shutdown = async () => {
    if (stopping) return; stopping = true; logger.info("Stopping opportunity observer"); clearInterval(dashboardStateTimer); books.forEach((book) => book.stop()); await persistDashboardState(); if (server) server.close(); await closeDatabase().catch((error) => logger.error("Failed to close MySQL connection", error)); process.exit(0);
  };
  process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => { logger.error("Startup failed", error); process.exitCode = 1; });
