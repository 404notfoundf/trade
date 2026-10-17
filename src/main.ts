import Decimal from "decimal.js";
import { loadConfig, type AssetConfig, type FixedPoolConfig } from "./config.js";
import { closeDatabase, execute, initDatabase, query, type Health } from "./db.js";
import type { Instrument } from "./market.js";
import { dexIndexPrices, okxPrivateGet, okxPublicGet, OkxOrderBook, type Book } from "./okx.js";
import { OpportunityCollector } from "./collector.js";
import { closeOpportunityWindow } from "./observations.js";
import { backfillReports, startReportScheduler } from "./reports.js";
import { startDashboard, type DashboardState } from "./dashboard.js";
import { saveDashboardState } from "./dashboard-state.js";
import { createTradeHandler } from "./trading/page.js";
import { createOpportunityInventoryChecker, createTradeExecutor, inspectRouteBalances, validateTradeSigners } from "./trading/executor.js";
import { logger } from "./logger.js";
import { recordBlockedObservation } from "./risk.js";
import { INDEX_TARGETS, noteIndexFailure, applyIndexTicks, snapshotRows, valuationRiskEvents, valuationView, type ValuationView } from "./valuation.js";
import { initialPoolState, startFixedPoolMonitors, type PoolMonitorState } from "./fixed-pools.js";
import { solveDirectPoolCandidates } from "./trading/market-registry.js";
import { createPoolAdapter } from "./trading/pool-adapter-factory.js";
import { DirectPoolCollector } from "./trading/direct-pool-collector.js";
import { AggregatorShadowCollector } from "./trading/aggregator-shadow.js";
import type { RegisteredPool } from "./trading/market-registry.js";
import { recordAdapterPoolState } from "./trading/pool-state.js";
import { bookStale } from "./market.js";
import { buildPreflightReport, configVersion, preflightInventoryChecks, withPreflightCheck, type PreflightCheck, type PreflightQuoteBalanceInput } from "./trading/preflight.js";
import { loadLatestPreflightReport, savePreflightReport, type PreflightRun, type PreflightTrigger } from "./trading/preflight-store.js";

Decimal.set({ precision: 60, rounding: Decimal.ROUND_DOWN });

type MultiplierResponse = { currentMultiplier?: number | string; newMultiplier?: number | string; activationDateTime?: number | string; reason?: string | null; data?: { currentMultiplier?: number | string; newMultiplier?: number | string; activationDateTime?: number | string; reason?: string | null } };
type FeeResponse = Array<{ taker: string; maker: string; category?: string }>;
type CurrencyNetwork = { ccy: string; chain: string; ctAddr?: string; canDep: boolean; canWd: boolean };
type MarketState = { instrument?: Instrument; feeRate?: Decimal; book?: Book };
type RouteRuntime = { status: "ENABLED" | "MONITOR_ONLY" | "BLOCKED"; reason: string | null; multiplier?: Decimal; multiplierRaw?: MultiplierResponse; lastGoodMultiplier?: Decimal; multiplierBaselineLoaded?: boolean; multiplierGuardReason?: string; multiplierGuardEventRecorded?: boolean };
type PreflightQuoteRow = {
  direction: string; shares: string | null; token_amount: string | null; cex_vwap: string | null; cex_fee_rate: string | null;
  cex_fee_usdt: string | null; gas_usdt: string | null; gas_native_raw: string | null; gas_source: string | null;
  native_quote_amount: string | null; native_quote_symbol: string | null; valuation_status: string; usdt_rate: string | null;
  price_source_time: Date | string | null; observed_at: Date | string; is_stale: number | boolean; status: string; route_status: string;
};

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
    else if (["stale", "insufficient_depth", "not_configured", "blocked", "degraded", "unknown", "invalid"].includes(status)) logger.warn(message);
    else logger.info(message);
    if (dbOnline) void execute("INSERT INTO health_event (dependency,status,message,observed_at) VALUES (?,?,?,UTC_TIMESTAMP(3))", [dependency, status, error?.slice(0, 500) ?? null]).catch((dbError) => logger.error("Failed to persist health event", dbError));
  }
};
const messageOf = (error: unknown) => error instanceof Error ? error.message : "unknown error";
const timestampMillis = (value: Date | string | number | null | undefined): number | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};
const healthAgeStatus = (entry: Health | undefined, maxAgeMs: number, now: number): PreflightCheck["status"] => {
  if (!entry || entry.status === "unknown" || entry.status === "not_configured") return "UNKNOWN";
  if (entry.status !== "healthy") return "BLOCKED";
  const observedAt = timestampMillis(entry.lastSuccess);
  if (observedAt === null) return "UNKNOWN";
  return now - observedAt > maxAgeMs || now < observedAt - 5_000 ? "STALE" : "PASS";
};
const routeKey = (asset: AssetConfig) => `${asset.instId}:${asset.chainIndex}`;
const assetHealthKey = (dependency: string, asset: AssetConfig) => `${dependency}_${asset.chainIndex}_${asset.instId}`;
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const sameAddress = (asset: AssetConfig, actual: string | undefined) => asset.chainIndex === "196" ? actual?.toLowerCase() === asset.tokenAddress.toLowerCase() : actual === asset.tokenAddress;
function multiplierActivationTime(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed === 0) return 0;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function poolMonitorConfig(pool: RegisteredPool, config: Awaited<ReturnType<typeof loadConfig>>): FixedPoolConfig {
  const instrument = config.marketRegistry.instruments.find((item) => item.instrument_id === pool.instrument_id)!;
  const listing = instrument.cex_listings.find((item) => item.venue === "okx")!;
  const chainAsset = instrument.chain_assets.find((item) => item.chain === pool.chain)!;
  const configuredAsset = config.assets.find((item) => item.instId === listing.symbol && item.chainIndex === config.marketRegistry.chains[pool.chain].chain_id.toString());
  const dex = config.marketRegistry.dexes[pool.dex]!;
  const chainIndex = config.marketRegistry.chains[pool.chain].chain_id.toString() as "196" | "501";
  const dexName = ({ uniswap_v3: "uniswap-v3", raydium_clmm: "raydium-clmm", orca_whirlpool: "orca-whirlpool", meteora_dlmm: "meteora-dlmm" } as const)[dex.adapter];
  return {
    enabled: pool.enabled, id: pool.id, instId: listing.symbol, chainIndex,
    dex: dexName, address: pool.address,
    baseTokenSymbol: pool.mode === "trade_candidate" ? pool.instrument_id : configuredAsset?.tokenSymbol ?? pool.token_in_out.asset_address, baseTokenAddress: pool.token_in_out.asset_address,
    baseTokenDecimals: pool.token_in_out.asset_decimals, quoteTokenSymbol: pool.mode === "trade_candidate" ? chainAsset.quote_asset.symbol : pool.token_in_out.quote_address === SOLANA_USDC_MINT ? "USDC" : pool.token_in_out.quote_address,
    quoteTokenAddress: pool.token_in_out.quote_address, quoteTokenDecimals: pool.token_in_out.quote_decimals,
    baseTokenToCexAssetRatio: "1", expectedFee: pool.expected_fee_tier,
    expectedFactory: dex.factory ?? undefined, expectedProgramId: dex.program_id ?? undefined,
  };
}

async function main(): Promise<void> {
  const collectorOnly = process.argv.includes("--collector-only");
  logger.info(collectorOnly ? "Starting opportunity collector without dashboard" : "Starting multi-chain opportunity observer");
  const config = await loadConfig();
  const directPoolCandidates = solveDirectPoolCandidates(config.marketRegistry, config.assets);
  const aggregatorSelected = config.marketdata.quoteProvider === "aggregator";
  const tradingConfig = aggregatorSelected ? config.trading : { ...config.trading, enabled: false };
  const configuredAssets = config.assets;
  const assets = config.assets.filter((asset) => asset.enabled);
  const disabledRegistryPoolIds = new Set(config.marketRegistry.pools.filter((pool) => !pool.enabled).map((pool) => pool.id));
  const observeOnlyPools = config.marketdata.quoteProvider === "direct_pool"
    ? config.marketRegistry.pools.filter((pool) => pool.enabled && pool.mode === "observe_only" && pool.verified) : [];
  const registeredPools = [...new Map([...directPoolCandidates, ...observeOnlyPools].map((pool) => [pool.id, pool] as const)).values()];
  const adapterWatchPools = registeredPools.filter((pool) => createPoolAdapter(pool, config.marketRegistry).stateSource === "adapter_watch");
  const adapterWatchPoolIds = new Set(adapterWatchPools.map((pool) => pool.id));
  const registryPoolsToMonitor = registeredPools
    .filter((pool) => !adapterWatchPoolIds.has(pool.id));
  const registryMonitorConfigs = registryPoolsToMonitor.map((pool) => {
    const configured = config.fixedPools.find((item) => item.id === pool.id);
    return configured ? { ...configured, enabled: pool.enabled } : poolMonitorConfig(pool, config);
  });
  const monitorPools = [...new Map([...config.fixedPools.filter((pool) => !disabledRegistryPoolIds.has(pool.id) && !adapterWatchPoolIds.has(pool.id)), ...registryMonitorConfigs].map((pool) => [pool.id, pool] as const)).values()];
  const adapterWatchStateConfigs = adapterWatchPools.map((pool) => poolMonitorConfig(pool, config));
  const directRpcEndpoints = new Map(registryPoolsToMonitor.map((pool) => [pool.id, {
    http: pool.rpc_http, ws: pool.rpc_ws,
  }] as const));
  const poolMonitorStates = new Map([
    ...monitorPools.map((pool) => [pool.id, initialPoolState(pool)] as const),
    ...adapterWatchStateConfigs.map((pool) => [pool.id, initialPoolState(pool, "unavailable", "Waiting for adapter-owned pool watch")] as const),
  ]);
  const poolStateWrites = new Map<string, Promise<void>>();
  const poolStateTimers = new Map<string, NodeJS.Timeout>();
  const poolStateDirty = new Set<string>();
  const poolEventPending = new Set<string>();
  const lastPoolEventFingerprint = new Map<string, string>();
  const lastPoolStateWriteAt = new Map<string, number>();
  const lastPoolSamplePersistedAt = new Map<string, number>();
  const lastPoolEventWriteAt = new Map<string, number>();
  let databaseUnavailableAt: number | null = null;
  // shortcut: history is sampled at 10s per pool; use an event archive only if per-swap audit is needed.
  const poolStateWriteIntervalMs = 5000;
  const poolEventSampleIntervalMs = 10_000;
  let directPoolCollector: DirectPoolCollector | undefined;
  let stopAdapterWatches: () => Promise<void> = async () => undefined;
  let aggregatorShadowCollector: AggregatorShadowCollector | undefined;
  const markDatabaseUnavailable = (error: unknown) => {
    dbOnline = false;
    databaseUnavailableAt ??= Date.now();
    setHealth("mysql", "unavailable", messageOf(error));
  };
  async function recordFixedPoolHistoryGap(poolId: string, startedAt: number, recoveredAt: number, reason: "websocket_disconnect" | "database_unavailable"): Promise<void> {
    if (!dbOnline) throw new Error("MySQL is unavailable while recording a fixed-pool history gap");
    try {
      await execute("INSERT IGNORE INTO dex_pool_history_gap (pool_id,started_at,recovered_at,reason) VALUES (?,?,?,?)", [poolId, new Date(startedAt), new Date(recoveredAt), reason]);
      const state = poolMonitorStates.get(poolId);
      if (state) poolMonitorStates.set(poolId, { ...state, latestHistoryGap: { startedAt, recoveredAt, reason } });
    } catch (error) { markDatabaseUnavailable(error); throw error; }
  }
  async function markDatabaseRecovered(): Promise<void> {
    const startedAt = databaseUnavailableAt;
    dbOnline = true;
    setHealth("mysql", "healthy");
    if (startedAt === null) return;
    const recoveredAt = Date.now();
    for (const [poolId, persistedAt] of lastPoolSamplePersistedAt) {
      if (persistedAt <= startedAt) await recordFixedPoolHistoryGap(poolId, startedAt, recoveredAt, "database_unavailable");
    }
    databaseUnavailableAt = null;
  }
  if (tradingConfig.enabled) validateTradeSigners(assets, config.signers);
  const markets = new Map<string, MarketState>();
  const routes = new Map<string, RouteRuntime>(assets.map((asset) => [routeKey(asset), { status: "MONITOR_ONLY", reason: "Waiting for startup verification" }]));
  let lastPoolRetentionCleanup = 0;
  async function persistPoolState(state: PoolMonitorState, recordEvent: boolean): Promise<void> {
    poolMonitorStates.set(state.poolId, state);
    setHealth("pool_" + state.poolId, state.status, state.lastError);
    if (!dbOnline) return;
    try {
      if (recordEvent && state.eventFingerprint && state.source && state.sqrtPriceRaw && state.liquidityRaw && state.observedAt !== null) {
        await execute("INSERT IGNORE INTO dex_pool_event (pool_id,source,marginal_price,sqrt_price_raw,liquidity_raw,block_number,block_hash,slot,transaction_hash,log_index,account_data_hash,event_fingerprint,finality_status,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
          state.poolId, state.source, state.marginalPrice, state.sqrtPriceRaw, state.liquidityRaw, state.blockNumber, state.blockHash, state.slot,
          state.transactionHash, state.logIndex, state.accountDataHash, state.eventFingerprint, state.finality ?? "confirmed", new Date(state.observedAt),
        ]);
        lastPoolSamplePersistedAt.set(state.poolId, Date.now());
      }
      await execute("INSERT INTO dex_pool_state (pool_id,inst_id,chain_index,dex,pool_address,base_token_symbol,base_token_address,quote_token_symbol,quote_token_address,marginal_price,sqrt_price_raw,liquidity_raw,source,block_number,block_hash,slot,transaction_hash,log_index,account_data_hash,event_fingerprint,finality_status,confirmed_block_number,observed_at,status,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE marginal_price=COALESCE(VALUES(marginal_price),marginal_price),sqrt_price_raw=COALESCE(VALUES(sqrt_price_raw),sqrt_price_raw),liquidity_raw=COALESCE(VALUES(liquidity_raw),liquidity_raw),source=COALESCE(VALUES(source),source),block_number=COALESCE(VALUES(block_number),block_number),block_hash=COALESCE(VALUES(block_hash),block_hash),slot=COALESCE(VALUES(slot),slot),transaction_hash=COALESCE(VALUES(transaction_hash),transaction_hash),log_index=COALESCE(VALUES(log_index),log_index),account_data_hash=COALESCE(VALUES(account_data_hash),account_data_hash),event_fingerprint=COALESCE(VALUES(event_fingerprint),event_fingerprint),finality_status=COALESCE(VALUES(finality_status),finality_status),confirmed_block_number=COALESCE(VALUES(confirmed_block_number),confirmed_block_number),observed_at=COALESCE(VALUES(observed_at),observed_at),status=VALUES(status),last_error=VALUES(last_error),updated_at=VALUES(updated_at)", [
        state.poolId, state.instId, state.chainIndex, state.dex, state.address, state.baseTokenSymbol, state.baseTokenAddress, state.quoteTokenSymbol, state.quoteTokenAddress,
        state.marginalPrice, state.sqrtPriceRaw, state.liquidityRaw, state.source, state.blockNumber, state.blockHash, state.slot, state.transactionHash, state.logIndex,
        state.accountDataHash, state.eventFingerprint, state.finality, state.confirmedBlockNumber,
        state.observedAt === null ? null : new Date(state.observedAt), state.status, state.lastError?.slice(0, 500) ?? null,
      ]);
      if (state.chainIndex === "196" && state.confirmedBlockNumber !== null) {
        await execute("UPDATE dex_pool_event SET finality_status='confirmed' WHERE pool_id=? AND block_number<=?", [state.poolId, state.confirmedBlockNumber]);
      }
    } catch (error) {
      markDatabaseUnavailable(error);
    }
  }
  function schedulePoolStateFlush(poolId: string): void {
    if (poolStateTimers.has(poolId)) return;
    const now = Date.now();
    const stateDelay = poolStateDirty.has(poolId)
      ? Math.max(0, poolStateWriteIntervalMs - (now - (lastPoolStateWriteAt.get(poolId) ?? 0))) : Infinity;
    const eventDelay = poolEventPending.has(poolId)
      ? Math.max(0, poolEventSampleIntervalMs - (now - (lastPoolEventWriteAt.get(poolId) ?? 0))) : Infinity;
    const delay = Math.min(stateDelay, eventDelay);
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => {
      poolStateTimers.delete(poolId);
      void flushPoolState(poolId).catch((error) => logger.error("Failed to persist fixed-pool state", error));
    }, delay);
    poolStateTimers.set(poolId, timer);
  }
  async function flushPoolState(poolId: string, forceState = false): Promise<void> {
    const timer = poolStateTimers.get(poolId);
    if (timer) clearTimeout(timer);
    poolStateTimers.delete(poolId);
    const activeWrite = poolStateWrites.get(poolId);
    if (activeWrite) {
      await activeWrite.catch(() => undefined);
      return flushPoolState(poolId, forceState);
    }
    const now = Date.now();
    const stateDue = poolStateDirty.has(poolId) && (forceState || now - (lastPoolStateWriteAt.get(poolId) ?? 0) >= poolStateWriteIntervalMs);
    const eventDue = poolEventPending.has(poolId) && now - (lastPoolEventWriteAt.get(poolId) ?? 0) >= poolEventSampleIntervalMs;
    if (!stateDue && !eventDue) { schedulePoolStateFlush(poolId); return; }
    const state = poolMonitorStates.get(poolId);
    if (!state) return;
    poolStateDirty.delete(poolId);
    if (eventDue) {
      poolEventPending.delete(poolId);
      lastPoolEventWriteAt.set(poolId, now);
    }
    lastPoolStateWriteAt.set(poolId, now);
    const write = persistPoolState(state, eventDue);
    poolStateWrites.set(poolId, write);
    void write.finally(() => {
      if (poolStateWrites.get(poolId) === write) poolStateWrites.delete(poolId);
      schedulePoolStateFlush(poolId);
    }).catch((error) => logger.error("Failed to persist fixed-pool state", error));
    await write;
  }
  const flushPoolStateWrites = async (poolId: string, forceState = false): Promise<void> => {
    if (forceState) poolStateDirty.add(poolId);
    await flushPoolState(poolId, forceState);
  };
  const enqueuePoolState = (state: PoolMonitorState): void => {
    state = { ...state, latestHistoryGap: state.latestHistoryGap ?? poolMonitorStates.get(state.poolId)?.latestHistoryGap ?? null };
    poolMonitorStates.set(state.poolId, state);
    directPoolCollector?.markDirty(state.instId, state.chainIndex);
    setHealth("pool_" + state.poolId, state.status, state.lastError);
    poolStateDirty.add(state.poolId);
    if (state.eventFingerprint && lastPoolEventFingerprint.get(state.poolId) !== state.eventFingerprint) {
      lastPoolEventFingerprint.set(state.poolId, state.eventFingerprint);
      poolEventPending.add(state.poolId);
    }
    schedulePoolStateFlush(state.poolId);
  };
  let tradingArmed = false;
  let latestPreflight: PreflightRun | null = null;
  const credentialsReady = (values: string[]) => values.every(Boolean);
  const cexReady = credentialsReady([config.okx.key, config.okx.secret, config.okx.passphrase]);
  const dexReady = credentialsReady([config.dex.key, config.dex.secret, config.dex.passphrase]);

  try {
    await initDatabase(config); dbOnline = true; setHealth("mysql", "healthy");
    try {
      const saved = await loadLatestPreflightReport();
      if (saved) latestPreflight = { ...saved, persistence: "database" };
    } catch (error) {
      logger.warn(`Latest preflight report is unavailable: ${messageOf(error)}`);
    }
    if (aggregatorSelected) for (const asset of assets) await closeOpportunityWindow(asset.instId, asset.chainIndex, "COLLECTOR_RESTART");
    await backfillReports(assets);
  }
  catch (error) { markDatabaseUnavailable(error); }
  if (!cexReady) setHealth("okx_fee", "not_configured", "Set OKX_API_KEY, OKX_API_SECRET and OKX_API_PASSPHRASE; live trading also requires Trade permission");
  if (aggregatorSelected && !dexReady) setHealth("dex_quote", "not_configured", "Set OKX_DEX_API_KEY, OKX_DEX_API_SECRET and OKX_DEX_API_PASSPHRASE");
  if (config.marketdata.quoteProvider === "direct_pool") {
    setHealth("quote_provider", directPoolCandidates.length ? "unavailable" : "not_configured",
      directPoolCandidates.length ? "Direct-pool scan routes require a verified runtime state; Aggregator fallback is disabled" : "No verified direct asset/pinned-quote pool is registered");
  } else setHealth("quote_provider", "healthy");

  async function probe(): Promise<void> {
    if (dbOnline) {
      try { await query<Array<{ ok: number }>>("SELECT 1 ok"); }
      catch (error) { markDatabaseUnavailable(error); }
    }
    if (!dbOnline) {
      try {
        await initDatabase(config); await markDatabaseRecovered();
        if (aggregatorSelected) for (const asset of assets) await closeOpportunityWindow(asset.instId, asset.chainIndex, "DATABASE_RECONNECTED");
        await backfillReports(assets);
        for (const state of poolMonitorStates.values()) {
          if (state.eventFingerprint) poolEventPending.add(state.poolId);
          poolStateDirty.add(state.poolId);
          await flushPoolStateWrites(state.poolId, true);
        }
      }
      catch (error) { markDatabaseUnavailable(error); }
    }
    if (dbOnline && Date.now() - lastPoolRetentionCleanup > 3_600_000) {
      lastPoolRetentionCleanup = Date.now();
      try {
        await execute("DELETE FROM dex_pool_event WHERE observed_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY");
        await execute("DELETE FROM dex_pool_history_gap WHERE recovered_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY");
        const directQuotes = await execute(`DELETE FROM direct_pool_quote WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL ${config.marketdata.directQuoteRetentionDays} DAY`);
        const directDecisions = await execute(`DELETE FROM direct_pool_decision WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL ${config.marketdata.directDecisionRetentionDays} DAY`);
        const shadowQuotes = await execute(`DELETE FROM aggregator_shadow_quote WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL ${config.marketdata.directQuoteRetentionDays} DAY`);
        if (directQuotes.affectedRows || directDecisions.affectedRows || shadowQuotes.affectedRows) logger.info(`Direct-pool retention removed ${directQuotes.affectedRows} quotes, ${directDecisions.affectedRows} decisions and ${shadowQuotes.affectedRows} shadow quotes`);
        setHealth("direct_pool_retention", "healthy");
      } catch (error) { markDatabaseUnavailable(error); }
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
        } catch (error) { markDatabaseUnavailable(error); }
      }
      try {
        const network = asset.network === "Solana" ? "Solana" : "XLayer";
        const response = await fetch(`https://api.backed.fi/api/v2/public/assets/${encodeURIComponent(asset.tokenSymbol)}/multiplier?network=${network}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Backed multiplier HTTP ${response.status}`);
        const raw = await response.json() as MultiplierResponse;
        const payload = raw.data ?? raw;
        const value = payload.currentMultiplier;
        const pendingValue = new Decimal(payload.newMultiplier ?? "0");
        const activationAt = multiplierActivationTime(payload.activationDateTime);
        if (value === undefined || !new Decimal(value).isFinite() || new Decimal(value).lte(0)
          || !pendingValue.isFinite() || pendingValue.lt(0) || activationAt === null
          || pendingValue.gt(0) !== (activationAt > 0)) throw new Error("Backed v2 multiplier response is missing valid current or scheduled multiplier fields");
        const candidate = new Decimal(value);
        const previous = route.lastGoodMultiplier;
        const approved = asset.approvedMultiplier !== undefined && candidate.eq(asset.approvedMultiplier);
        const inActivationWindow = pendingValue.gt(0) && activationAt !== 0 && Math.abs(Date.now() - activationAt) <= 15 * 60_000;
        const changePercent = previous ? candidate.minus(previous).abs().div(previous).mul(100) : new Decimal(0);
        const exceeded = !!previous && changePercent.gt(config.runtime.guardrails.maxMultiplierChangePercent) && !candidate.eq(previous);
        if (inActivationWindow) {
          route.multiplier = undefined;
          route.multiplierGuardReason = `Backed multiplier activation is within 15 minutes (${new Date(activationAt!).toISOString()}); observation paused around the scheduled change`;
          setHealth(assetHealthKey("multiplier_guard", asset), "blocked", route.multiplierGuardReason);
        } else if (exceeded && !approved) {
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
        catch (error) { markDatabaseUnavailable(error); }
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
      directPoolCollector?.markDirty(asset.instId, asset.chainIndex);
    }
    if (aggregatorSelected && dexReady) setHealth("dex_quote", "waiting_for_quote");
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
      markDatabaseUnavailable(error);
    } finally {
      refreshingValuation = false;
    }
  }

  if (config.marketdata.quoteProvider === "direct_pool") {
    if (config.marketdata.aggregatorShadow && directPoolCandidates.length) {
      aggregatorShadowCollector = new AggregatorShadowCollector(config.dex, {
        onHealth: (status, reason) => setHealth("aggregator_shadow", status, reason ?? null),
        onDatabaseError: markDatabaseUnavailable,
      });
    } else if (config.marketdata.aggregatorShadow) {
      setHealth("aggregator_shadow", "not_configured", "No verified direct-pool route is available to trigger shadow quotes");
    }
  }
  directPoolCollector = new DirectPoolCollector({
    registry: config.marketRegistry, assets: config.assets, guardrails: config.runtime.guardrails,
    observeOnlyPoolIds: observeOnlyPools.map((pool) => pool.id),
    coalesceWindowMs: config.marketdata.coalesceWindowMs,
    observationGas: config.directPoolObservation,
    solanaSimulationPrivateKey: config.signers.solanaSimulationPrivateKey,
    getState: (asset, pool) => {
      const market = markets.get(asset.instId) ?? {};
      const route = routes.get(routeKey(asset));
      return {
        ...market, multiplier: route?.multiplier, pool: poolMonitorStates.get(pool.id), dbOnline,
        // The peg gate is not a conversion quote or a verified inventory exit path.
        quoteValuationStatus: "UNKNOWN",
      };
    },
    onHealth: (poolId, status, reason) => setHealth(`direct_pool_${poolId}`, status, reason ?? null),
    onPoolState: (poolId, event) => {
      const state = poolMonitorStates.get(poolId);
      if (state) enqueuePoolState(recordAdapterPoolState(state, event));
    },
    onDatabaseError: markDatabaseUnavailable,
    onAggregatorShadow: (request) => aggregatorShadowCollector?.request(request),
  });
  stopAdapterWatches = await directPoolCollector.startAdapterWatches();
  if (config.marketdata.quoteProvider === "direct_pool") {
    if (directPoolCandidates.length) setHealth("quote_provider", "healthy", null);
    if (observeOnlyPools.length) setHealth("direct_pool_observer", "observing", "Observe-only pools record Exact-In quotes and assumed 1:1 profit estimates; results remain NOT_EXECUTABLE");
  }

  const books: OkxOrderBook[] = [];
  for (const instId of new Set(assets.map((asset) => asset.instId))) {
    const market = markets.get(instId) ?? {}; markets.set(instId, market);
    const client = new OkxOrderBook(instId, (book) => { market.book = book; setHealth(`okx_websocket_${instId}`, "healthy"); directPoolCollector?.markDirty(instId); }, (error) => { market.book = undefined; setHealth(`okx_websocket_${instId}`, "unavailable", error); directPoolCollector?.markDirty(instId); });
    books.push(client); client.start();
  }
  const checkOpportunityInventory = tradingConfig.enabled ? createOpportunityInventoryChecker(config.okx, config.signers, assets, tradingConfig.tradeSizeUsdt, tradingConfig.maxTradeSizeUsdt) : undefined;
  const collectors = aggregatorSelected ? assets.map((asset, index) => new OpportunityCollector({
    asset, initialDelayMs: Math.floor(asset.dexQuoteIntervalMs * index / assets.length),
    guardrails: config.runtime.guardrails, dexCredentials: config.dex,
    tradingStatus: () => !tradingConfig.enabled ? "DISABLED" : tradingArmed ? "ARMED" : "UNARMED",
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
    onDatabaseError: markDatabaseUnavailable,
  })) : [];
  const getTradeState = (asset: AssetConfig) => {
    const market = markets.get(asset.instId);
    const route = routes.get(routeKey(asset));
    return { routeStatus: route?.status ?? "BLOCKED", instrument: market?.instrument, feeRate: market?.feeRate, multiplier: route?.multiplier, book: market?.book };
  };
  const tradeExecutor = createTradeExecutor({
    enabled: tradingConfig.enabled,
    armed: () => tradingArmed,
    tradeSizeUsdt: config.trading.tradeSizeUsdt,
    maxTradeSizeUsdt: config.trading.maxTradeSizeUsdt,
    assets,
    recoveryAssets: configuredAssets,
    okx: config.okx,
    dex: config.dex,
    signers: config.signers,
    guardrails: config.runtime.guardrails,
    dbReady: () => dbOnline,
    getState: getTradeState,
    pause: () => { tradingArmed = false; },
    setHealth,
  });
  await tradeExecutor.recover();

  async function runPreflight(trigger: PreflightTrigger): Promise<PreflightRun> {
    const generatedAt = new Date().toISOString();
    const now = Date.now();
    const healthMaxAgeMs = Math.max(60_000, config.runtime.healthProbeIntervalSeconds * 3_000);
    const configFingerprint = configVersion({
      quoteProvider: config.marketdata.quoteProvider,
      tradingEnabled: config.trading.enabled,
      healthProbeIntervalSeconds: config.runtime.healthProbeIntervalSeconds,
      tradeSizeUsdt: config.trading.tradeSizeUsdt,
      maxTradeSizeUsdt: config.trading.maxTradeSizeUsdt,
      credentialsConfigured: { cex: cexReady, dex: dexReady },
      signersConfigured: { xlayer: !!config.signers.xlayerPrivateKey, solana: !!config.signers.solanaPrivateKey },
      guardrails: {
        maxDexPriceImpactPercent: config.runtime.guardrails.maxDexPriceImpactPercent,
        maxMultiplierChangePercent: config.runtime.guardrails.maxMultiplierChangePercent,
        indexPriceMaxAgeSeconds: config.runtime.guardrails.indexPriceMaxAgeSeconds,
        maxUsdtUsdDeviationPercent: config.runtime.guardrails.maxUsdtUsdDeviationPercent,
        maxUsdt0UsdtDeviationPercent: config.runtime.guardrails.maxUsdt0UsdtDeviationPercent,
      },
      routes: configuredAssets.map((asset) => ({ enabled: asset.enabled, instId: asset.instId, chainIndex: asset.chainIndex,
        tokenAddress: asset.tokenAddress, tokenDecimals: asset.tokenDecimals, quoteTokenAddress: asset.quoteTokenAddress,
        quoteTokenDecimals: asset.quoteTokenDecimals, gasSafetyBufferPercent: asset.gasSafetyBufferPercent,
        dexQuoteIntervalMs: asset.dexQuoteIntervalMs, okxCurrency: asset.okxCurrency, okxChain: asset.okxChain,
        approvedMultiplier: asset.approvedMultiplier, rebalanceCostUsdtPerTrade: asset.rebalanceCostUsdtPerTrade })),
      pools: config.marketRegistry.pools.map((pool) => ({ id: pool.id, enabled: pool.enabled, chain: pool.chain, dex: pool.dex,
        address: pool.address, assetAddress: pool.token_in_out.asset_address, quoteAddress: pool.token_in_out.quote_address })),
    });
    const globalChecks: PreflightCheck[] = [];
    const addGlobal = (key: string, status: PreflightCheck["status"], reason: string, source?: string, details?: PreflightCheck["details"]) => {
      globalChecks.push({ key, status, reason, source, observedAt: generatedAt, details });
    };
    const addRoute = (checks: PreflightCheck[], key: string, status: PreflightCheck["status"], reason: string,
      source?: string, observedAt?: string, details?: PreflightCheck["details"], required?: boolean) => {
      checks.push({ key, status, reason, source, observedAt, details, required });
    };
    const positiveNumber = (value: string | null | undefined) => {
      if (value === null || value === undefined || value.trim() === "") return false;
      const number = Number(value);
      return Number.isFinite(number) && number > 0;
    };
    const nonNegativeNumber = (value: string | null | undefined) => {
      if (value === null || value === undefined || value.trim() === "") return false;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0;
    };
    addGlobal("trading_enabled", config.trading.enabled ? "PASS" : "BLOCKED",
      config.trading.enabled ? "Trading master switch is enabled" : "config.trading.enabled is false", "config.yaml");
    addGlobal("quote_provider", tradingConfig.enabled ? "PASS" : "BLOCKED",
      tradingConfig.enabled ? "Aggregator execution is selected" : "Current quote provider is observe-only or trading is disabled", "runtime config");

    let databaseReady = false;
    try {
      if (!dbOnline) throw new Error("MySQL is unavailable");
      const rows = await query<Array<{ ok: number }>>("SELECT 1 ok");
      databaseReady = rows[0]?.ok === 1;
      if (!databaseReady) throw new Error("MySQL probe returned no result");
      addGlobal("database", "PASS", "MySQL and migrated schema are available", "SELECT 1");
    } catch (error) {
      markDatabaseUnavailable(error);
      addGlobal("database", "BLOCKED", messageOf(error), "MySQL");
    }

    let recoveryReady = health.get("trade_execution")?.status === "healthy";
    if (trigger === "arm" && databaseReady && tradingConfig.enabled) recoveryReady = await tradeExecutor.recover();
    let activeCycle: { id: number; status: string } | undefined;
    if (databaseReady) {
      try {
        activeCycle = (await query<Array<{ id: number; status: string }>>(
          "SELECT id,status FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id LIMIT 1",
        ))[0];
      } catch (error) {
        databaseReady = false;
        markDatabaseUnavailable(error);
        addGlobal("cycle_state", "UNKNOWN", messageOf(error), "trade_cycle");
      }
    }
    const recoveryStatus = !databaseReady ? "UNKNOWN" : activeCycle ? "BLOCKED" : recoveryReady ? "PASS" : "BLOCKED";
    addGlobal("recovery", recoveryStatus, activeCycle
      ? `Trade cycle ${activeCycle.id} remains ${activeCycle.status}`
      : recoveryReady ? "No unresolved cycle remains after recovery" : "Recovery is incomplete or blocked", "trade_cycle recovery");
    if (!activeCycle && databaseReady) addGlobal("open_cycles", "PASS", "No non-terminal trade cycle exists", "trade_cycle");

    addGlobal("okx_credentials", cexReady ? "PASS" : "BLOCKED",
      cexReady ? "OKX private credentials are configured; account access is checked below" : "OKX private credentials are incomplete", "environment presence only");
    addGlobal("dex_credentials", dexReady || !tradingConfig.enabled ? "PASS" : "BLOCKED",
      dexReady || !tradingConfig.enabled ? (tradingConfig.enabled ? "OKX DEX credentials are configured" : "Not required while execution is disabled") : "OKX DEX credentials are incomplete",
      "environment presence only");

    const preflightRoutes: Array<{ instId: string; chainIndex: string; enabled: boolean; checks: PreflightCheck[] }> = [];
    const activeAssets = assets.filter((asset) => asset.enabled);
    const mayProbeReadiness = tradingConfig.enabled && databaseReady && recoveryReady && !activeCycle && cexReady && dexReady;
    const needsXlayerAllowance = activeAssets.some((asset) => asset.chainIndex === "196"
      && routes.get(routeKey(asset))?.status === "ENABLED");
    if (mayProbeReadiness && needsXlayerAllowance) await tradeExecutor.checkApprovals();

    for (const asset of configuredAssets) {
      const routeEnabled = asset.enabled && tradingConfig.enabled;
      const checks: PreflightCheck[] = [];
      preflightRoutes.push({ instId: asset.instId, chainIndex: asset.chainIndex, enabled: routeEnabled, checks });
      if (!asset.enabled) {
        addRoute(checks, "route_enabled", "NOT_APPLICABLE", "Asset route is disabled in configuration", "config.yaml", undefined, undefined, false);
        continue;
      }
      if (!tradingConfig.enabled) {
        addRoute(checks, "route_enabled", "NOT_APPLICABLE", "Preflight does not activate observation-only routes", "runtime config", undefined, undefined, false);
        continue;
      }

      const route = routes.get(routeKey(asset));
      const market = markets.get(asset.instId);
      const routeHealth = health.get(assetHealthKey("route", asset));
      const routeHealthStatus = healthAgeStatus(routeHealth, healthMaxAgeMs, now);
      const routeReady = route?.status === "ENABLED" && routeHealthStatus === "PASS";
      addRoute(checks, "venue_route", routeReady ? "PASS" : routeHealthStatus === "STALE" ? "STALE" : routeHealthStatus === "UNKNOWN" ? "UNKNOWN" : "BLOCKED",
        routeReady ? "OKX deposit/withdraw network identity is enabled" : route?.reason ?? "Venue route is not ENABLED",
        "OKX currencies API + runtime health", routeHealth?.lastSuccess ?? undefined);

      const instrumentHealth = healthAgeStatus(health.get(`okx_instrument_${asset.instId}`), healthMaxAgeMs, now);
      const feeHealth = healthAgeStatus(health.get(`okx_fee_${asset.instId}`), healthMaxAgeMs, now);
      const instrumentReady = market?.instrument?.state === "live" && positiveNumber(market.instrument.lotSz)
        && positiveNumber(market.instrument.minSz) && instrumentHealth === "PASS";
      const feeReady = !!market?.feeRate?.isFinite() && market.feeRate.gte(0) && feeHealth === "PASS";
      const marketStatus = instrumentReady && feeReady ? "PASS"
        : instrumentHealth === "STALE" || feeHealth === "STALE" ? "STALE"
          : instrumentHealth === "UNKNOWN" || feeHealth === "UNKNOWN" ? "UNKNOWN" : "BLOCKED";
      addRoute(checks, "instrument_and_cex_fee", marketStatus,
        instrumentReady && feeReady ? "OKX instrument and taker fee are valid and recent" : "OKX instrument or taker fee is unavailable, invalid or stale",
        "OKX public instruments + account trade-fee API", health.get(`okx_fee_${asset.instId}`)?.lastSuccess ?? undefined,
        { takerFeeRate: market?.feeRate?.toString() ?? null });

      const multiplierHealth = healthAgeStatus(health.get(assetHealthKey("multiplier", asset)), healthMaxAgeMs, now);
      const multiplierReady = !!route?.multiplier?.isFinite() && route.multiplier.gt(0) && multiplierHealth === "PASS";
      addRoute(checks, "multiplier", multiplierReady ? "PASS" : multiplierHealth,
        multiplierReady ? "Multiplier is positive and recent" : route?.multiplierGuardReason ?? "Multiplier is unavailable, invalid or stale",
        "Backed multiplier API + runtime health", health.get(assetHealthKey("multiplier", asset))?.lastSuccess ?? undefined,
        { multiplier: route?.multiplier?.toString() ?? null });

      const book = market?.book;
      const bookReady = !!book?.ready && !bookStale(book) && !!book.asks.length && !!book.bids.length;
      const bookAge = book ? Math.max(now - book.receivedAt, now - book.exchangeTime) : null;
      addRoute(checks, "okx_book", bookReady ? "PASS" : book?.ready ? "STALE" : "UNKNOWN",
        bookReady ? "Order book is ready and within the 2-second execution limit" : "Order book is missing, incomplete or stale",
        "OKX WebSocket", book ? new Date(book.receivedAt).toISOString() : undefined,
        { ageMs: bookAge, seqId: book?.seqId ?? null, bestBid: book?.bids[0]?.price ?? null, bestAsk: book?.asks[0]?.price ?? null });

      const priceGates = asset.chainIndex === "196" ? [valuation.usdtUsd, valuation.usdt0, valuation.parity] : [valuation.usdtUsd, valuation.solUsdt];
      const badPriceGate = priceGates.find((gate) => gate.status !== "healthy");
      const priceStatus: PreflightCheck["status"] = !badPriceGate ? "PASS"
        : badPriceGate.status === "stale" ? "STALE" : badPriceGate.status === "unknown" || badPriceGate.status === "unavailable" ? "UNKNOWN" : "BLOCKED";
      addRoute(checks, "quote_asset_valuation", priceStatus,
        badPriceGate?.reason ?? "Quote asset valuation and parity checks are fresh", "OKX DEX index-price snapshots",
        priceGates.map((gate) => gate.sourceTime).filter((time): time is number => time !== null).sort((a, b) => a - b)[0]
          ? new Date(priceGates.map((gate) => gate.sourceTime).filter((time): time is number => time !== null).sort((a, b) => a - b)[0]!).toISOString() : undefined,
        { sources: priceGates.map((gate) => gate.code || "healthy").join(",") });

      const instrumentRegistration = config.marketRegistry.instruments.find((item) => item.cex_listings.some((listing) => listing.symbol === asset.instId));
      const chainName = asset.chainIndex === "196" ? "xlayer" : "solana";
      const pool = directPoolCandidates.find((candidate) => candidate.instrument_id === instrumentRegistration?.instrument_id && candidate.chain === chainName);
      const poolState = pool ? poolMonitorStates.get(pool.id) : undefined;
      const addressMatches = (left: string, right: string) => asset.chainIndex === "196" ? left.toLowerCase() === right.toLowerCase() : left === right;
      const poolIdentityMatches = !!pool && pool.enabled && pool.verified && pool.mode === "trade_candidate"
        && pool.chain === chainName && addressMatches(pool.token_in_out.asset_address, asset.tokenAddress)
        && addressMatches(pool.token_in_out.quote_address, asset.quoteTokenAddress);
      addRoute(checks, "pool_identity", poolIdentityMatches ? "PASS" : "UNKNOWN",
        poolIdentityMatches ? "A verified trade-candidate pool matches the configured chain and token pair" : "No verified trade-candidate pool matches this configured route",
        "market-registry.yaml", undefined,
        { poolId: pool?.id ?? null, dex: pool?.dex ?? null, address: pool?.address ?? null });
      const poolObservedAt = poolState?.lastRpcSnapshotAt ?? poolState?.observedAt ?? null;
      const poolAge = poolObservedAt === null ? null : now - poolObservedAt;
      const poolVersion = !poolState ? null : poolState.slot !== null
        ? `slot:${poolState.slot};account:${poolState.accountDataHash ?? "unknown"}`
        : poolState.blockNumber !== null ? `block:${poolState.blockNumber};hash:${poolState.blockHash ?? "unknown"}` : null;
      const poolHealthy = !!poolIdentityMatches && !!poolState && poolState.status === "healthy"
        && poolState.connectionStatus === "connected" && poolState.rpcSnapshotStatus === "healthy" && poolAge !== null
        && poolAge >= -5_000 && poolAge <= Math.max(60_000, config.runtime.healthProbeIntervalSeconds * 3_000) && !!poolVersion;
      const poolStatus: PreflightCheck["status"] = poolHealthy ? "PASS"
        : poolAge === null || !poolVersion ? "UNKNOWN"
          : poolAge > Math.max(60_000, config.runtime.healthProbeIntervalSeconds * 3_000) ? "STALE" : "BLOCKED";
      addRoute(checks, "pool_state_version", poolStatus,
        poolHealthy ? "Registered pool state is healthy, connected and recent" : poolState?.lastError ?? "Registered pool state or version is unavailable/stale",
        poolState?.source ?? "pool monitor", poolObservedAt === null ? undefined : new Date(poolObservedAt).toISOString(),
        { version: poolVersion, ageMs: poolAge, status: poolState?.status ?? "unknown" });

      let quoteRows: PreflightQuoteRow[] = [];
      try {
        if (!databaseReady) throw new Error("Database is unavailable; quote observations cannot be checked");
        quoteRows = await query<PreflightQuoteRow[]>(
          `SELECT direction,CAST(shares AS CHAR) shares,CAST(token_amount AS CHAR) token_amount,CAST(cex_vwap AS CHAR) cex_vwap,
             CAST(cex_fee_rate AS CHAR) cex_fee_rate,CAST(cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(gas_usdt AS CHAR) gas_usdt,
             gas_native_raw,gas_source,CAST(native_quote_amount AS CHAR) native_quote_amount,native_quote_symbol,valuation_status,
             CAST(usdt_rate AS CHAR) usdt_rate,price_source_time,observed_at,is_stale,status,route_status
           FROM quote_observation WHERE inst_id=? AND chain_index=? AND size_usdt=?
           ORDER BY observed_at DESC LIMIT 20`, [asset.instId, asset.chainIndex, String(config.trading.tradeSizeUsdt)],
        );
      } catch (error) {
        addRoute(checks, "quote_observations", "UNKNOWN", messageOf(error), "quote_observation");
      }
      const latestQuotes = new Map<string, PreflightQuoteRow>();
      for (const row of quoteRows) if (!latestQuotes.has(row.direction)) latestQuotes.set(row.direction, row);
      const quoteMaxAgeMs = Math.min(30_000, Math.max(5_000, asset.dexQuoteIntervalMs * 3));
      const directionQuotes = ["cex_buy_dex_sell", "dex_buy_cex_sell"] as const;
      const balanceQuotes: PreflightQuoteBalanceInput[] = [];
      let allQuotesReady = quoteRows.length > 0;
      for (const direction of directionQuotes) {
        const quote = latestQuotes.get(direction);
        const quoteAt = timestampMillis(quote?.observed_at);
        const quoteAge = quoteAt === null ? null : now - quoteAt;
        const quoteStatus: PreflightCheck["status"] = !quote ? "UNKNOWN"
          : quote.is_stale === true || Number(quote.is_stale) === 1 || quoteAge === null || quoteAge > quoteMaxAgeMs || quoteAge < -5_000 ? "STALE"
            : quote.status !== "OK" || quote.route_status !== "ENABLED" ? "BLOCKED" : "PASS";
        if (quoteStatus !== "PASS") allQuotesReady = false;
        addRoute(checks, `quote_${direction}`, quoteStatus,
          !quote ? `No observation exists at configured size ${config.trading.tradeSizeUsdt} USDT`
            : quoteStatus === "PASS" ? "Latest quote is executable-quality and fresh at configured size"
              : quoteStatus === "STALE" ? "Latest quote is marked stale or exceeds its freshness limit" : `Latest quote status is ${quote.status}/${quote.route_status}`,
          "persisted quote_observation", quoteAt === null ? undefined : new Date(quoteAt).toISOString(),
          { ageMs: quoteAge, sizeUsdt: config.trading.tradeSizeUsdt, cexBookAt: quote?.observed_at ? new Date(quoteAt ?? now).toISOString() : null });

        const sourceAt = timestampMillis(quote?.price_source_time);
        const sourceAge = sourceAt === null ? null : now - sourceAt;
        const valuationReady = !!quote && quote.valuation_status === "VERIFIED" && sourceAge !== null
          && sourceAge >= -5_000 && sourceAge <= config.runtime.guardrails.indexPriceMaxAgeSeconds * 1000;
        const valuationStatus: PreflightCheck["status"] = valuationReady ? "PASS"
          : quote?.valuation_status === "VERIFIED" && sourceAge !== null && sourceAge > config.runtime.guardrails.indexPriceMaxAgeSeconds * 1000 ? "STALE" : "UNKNOWN";
        if (valuationStatus !== "PASS") allQuotesReady = false;
        addRoute(checks, `valuation_${direction}`, valuationStatus,
          valuationReady ? "Quote-asset valuation is VERIFIED and within its age limit" : quote?.valuation_status === "VERIFIED" ? "Quote-asset price source is stale or invalid" : "Quote-asset valuation is unknown",
          "OKX DEX index-price snapshot", sourceAt === null ? undefined : new Date(sourceAt).toISOString(),
          { valuationStatus: quote?.valuation_status ?? "unknown", quoteSymbol: quote?.native_quote_symbol ?? null, usdtRate: quote?.usdt_rate ?? null, ageMs: sourceAge });

        const feeReady = !!quote && nonNegativeNumber(quote.cex_fee_rate) && nonNegativeNumber(quote.cex_fee_usdt)
          && nonNegativeNumber(quote.gas_usdt) && !!quote.gas_source && /^\d+$/.test(quote.gas_native_raw ?? "")
          && BigInt(quote.gas_native_raw ?? "0") > 0n;
        if (!feeReady) allQuotesReady = false;
        addRoute(checks, `fee_sources_${direction}`, feeReady ? "PASS" : "UNKNOWN",
          feeReady ? "CEX fee and DEX network-fee estimates have valid values and sources" : "CEX fee or DEX network-fee amount/source is missing or invalid",
          "OKX account trade-fee API + DEX quote observation", quoteAt === null ? undefined : new Date(quoteAt).toISOString(),
          { cexFeeSource: "cex_fee_rate", cexFeeRate: quote?.cex_fee_rate ?? null, networkFeeSource: quote?.gas_source ?? null,
            networkFeeUsdt: quote?.gas_usdt ?? null, networkFeeNativeRaw: quote?.gas_native_raw ?? null });
        balanceQuotes.push({ direction, shares: quote?.shares ?? null, tokenAmount: quote?.token_amount ?? null,
          cexVwap: quote?.cex_vwap ?? null, cexFeeUsdt: quote?.cex_fee_usdt ?? null,
          gasNativeRaw: quote?.gas_native_raw ?? null, nativeQuoteAmount: quote?.native_quote_amount ?? null });
      }

      const allowanceStatus = (symbol: string): PreflightCheck => {
        const key = `approval_xlayer_${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        const entry = health.get(key);
        const status = healthAgeStatus(entry, healthMaxAgeMs, now);
        return { key: `allowance_${symbol}`, status,
          reason: status === "PASS" ? "Current X Layer spender and non-zero allowance were verified; exact trade amount is rechecked before execution" : entry?.lastError ?? `Allowance check is ${entry?.status ?? "unknown"}`,
          source: "OKX approval endpoint + X Layer eth_call", observedAt: entry?.lastSuccess ?? undefined };
      };
      if (asset.chainIndex === "196") {
        checks.push(allowanceStatus(asset.tokenSymbol), allowanceStatus(asset.quoteTokenSymbol));
      } else {
        addRoute(checks, "allowance", "NOT_APPLICABLE", "Solana swaps do not use ERC-20 allowance", "Solana transaction model", undefined, undefined, false);
      }

      const routePrerequisitesReady = checks.every((check) => check.required === false || check.status === "PASS" || check.status === "NOT_APPLICABLE");
      if (mayProbeReadiness && routePrerequisitesReady && allQuotesReady) {
        try {
          const balances = await inspectRouteBalances(asset, config.okx, config.signers);
          addRoute(checks, "balance_snapshot", "PASS", "OKX and chain balances were read; exact holdings are not persisted", "OKX private balance API + chain RPC", generatedAt,
            { wallet: `${balances.walletAddress.slice(0, 6)}…${balances.walletAddress.slice(-4)}` });
          checks.push(...preflightInventoryChecks({ quotes: balanceQuotes,
            balances: { cexUsdt: balances.cexUsdt, cexAsset: balances.cexAsset, chainAssetRaw: balances.chainAssetRaw,
              chainQuoteRaw: balances.chainQuoteRaw, chainNativeRaw: balances.chainNativeRaw },
            assetDecimals: asset.tokenDecimals, quoteDecimals: asset.quoteTokenDecimals, gasSafetyBufferPercent: asset.gasSafetyBufferPercent }));
        } catch (error) {
          addRoute(checks, "balance_snapshot", "UNKNOWN", messageOf(error), "OKX private balance API + chain RPC");
        }
      } else {
        addRoute(checks, "balance_snapshot", "NOT_APPLICABLE", "Balance RPC was skipped because a required route, quote or fee check did not pass", "fail-closed short circuit", undefined, undefined, false);
      }
    }

    let report = buildPreflightReport({ generatedAt, configVersion: configFingerprint, checks: globalChecks, routes: preflightRoutes });
    try {
      if (!databaseReady) throw new Error("MySQL is unavailable; report cannot be saved to the report table");
      const id = await savePreflightReport(report, trigger);
      latestPreflight = { id, trigger, persistence: "database", report };
    } catch (error) {
      report = withPreflightCheck(report, { key: "report_persistence", status: "BLOCKED", reason: messageOf(error), source: "trade_preflight_report" });
      logger.warn(`Trade preflight report saved to local log fallback: ${JSON.stringify(report)}`);
      latestPreflight = { id: null, trigger, persistence: "log", report };
    }
    return latestPreflight;
  }

  const tradeHandler = createTradeHandler(() => ({
    trading: tradingConfig,
    guardrails: config.runtime.guardrails,
    routes: configuredAssets.map((asset) => {
      if (!asset.enabled) return { asset, routeStatus: "DISABLED", multiplierReady: false, marketReady: false };
      const route = routes.get(routeKey(asset));
      const market = markets.get(asset.instId);
      return { asset, routeStatus: route?.status ?? "BLOCKED", multiplierReady: !!route?.multiplier, marketReady: !!market?.instrument && !!market.feeRate && !!market.book?.ready };
    }),
    executionStatus: health.get("trade_execution")?.lastError ?? health.get("trade_execution")?.status ?? "disarmed",
    preflight: latestPreflight,
  }), (armed) => {
    tradingArmed = armed;
    if (!armed && dbOnline) void execute("UPDATE opportunity SET executable_status='NOT_EVALUATED',executable_profit_usdt=NULL,execution_reason='Automatic trading is not armed' WHERE ended_at IS NULL AND legacy_sample=0")
      .catch(markDatabaseUnavailable);
  }, runPreflight);
  const getDashboardState = (): DashboardState => ({
    health, dbOnline, valuation, fixedPools: [...monitorPools, ...adapterWatchStateConfigs].map((pool) => poolMonitorStates.get(pool.id) ?? initialPoolState(pool)),
    collection: { running: !stopping, updatedAt: Date.now() },
    routes: configuredAssets.map((asset) => {
      if (!asset.enabled) return { asset, status: "DISABLED", reason: "资产或链路线在配置中关闭", instrumentReady: false, feeReady: false, bookReady: false };
      return { asset, ...routes.get(routeKey(asset))!, instrumentReady: !!markets.get(asset.instId)?.instrument, feeReady: !!markets.get(asset.instId)?.feeRate, bookReady: !!markets.get(asset.instId)?.book?.ready };
    }),
  });
  const server = collectorOnly ? undefined : startDashboard(config, configuredAssets, getDashboardState, tradeHandler);
  await probe();
  if (dbOnline && poolMonitorStates.size) {
    const poolIds = [...poolMonitorStates.keys()];
    try {
      const gaps = await query<Array<{ pool_id: string; started_at: Date; recovered_at: Date; reason: string }>>(
        `SELECT pool_id,started_at,recovered_at,reason FROM dex_pool_history_gap WHERE pool_id IN (${poolIds.map(() => "?").join(",")}) ORDER BY recovered_at DESC,id DESC`,
        poolIds,
      );
      for (const gap of gaps) {
        const state = poolMonitorStates.get(gap.pool_id);
        if (state && state.latestHistoryGap === null) {
          poolMonitorStates.set(gap.pool_id, { ...state, latestHistoryGap: { startedAt: gap.started_at.getTime(), recoveredAt: gap.recovered_at.getTime(), reason: gap.reason } });
        }
      }
    } catch (error) { markDatabaseUnavailable(error); }
  }
  const checkpointBlocks = new Map<string, number>();
  if (dbOnline) {
    try {
      const checkpoints = await query<Array<{ pool_id: string; confirmed_block_number: string }>>("SELECT pool_id,CAST(confirmed_block_number AS CHAR) confirmed_block_number FROM dex_pool_state WHERE chain_index='196' AND confirmed_block_number IS NOT NULL");
      for (const row of checkpoints) checkpointBlocks.set(row.pool_id, Number(row.confirmed_block_number));
    } catch (error) { markDatabaseUnavailable(error); }
  }
  const stopFixedPoolMonitors = await startFixedPoolMonitors(monitorPools, {
    checkpointBlocks,
    rpcEndpoints: directRpcEndpoints,
    onState: enqueuePoolState,
    onHistoryGap: recordFixedPoolHistoryGap,
    onRevert: async (poolId, fingerprint) => {
      await flushPoolStateWrites(poolId, true);
      if (!dbOnline) throw new Error("MySQL is unavailable while reverting a fixed-pool event");
      try { await execute("DELETE FROM dex_pool_event WHERE pool_id=? AND event_fingerprint=?", [poolId, fingerprint]); }
      catch (error) { markDatabaseUnavailable(error); throw error; }
      if (lastPoolEventFingerprint.get(poolId) === fingerprint) {
        lastPoolEventFingerprint.delete(poolId);
        poolEventPending.delete(poolId);
      }
    },
    onRevertAfter: async (poolId, blockNumber) => {
      await flushPoolStateWrites(poolId, true);
      if (!dbOnline) throw new Error("MySQL is unavailable while restoring fixed-pool history");
      try {
        await execute("UPDATE dex_pool_event SET finality_status='confirmed' WHERE pool_id=? AND block_number<=?", [poolId, blockNumber]);
        await execute("DELETE FROM dex_pool_event WHERE pool_id=? AND finality_status='provisional' AND block_number>?", [poolId, blockNumber]);
      } catch (error) { markDatabaseUnavailable(error); throw error; }
      lastPoolEventFingerprint.delete(poolId);
      poolEventPending.delete(poolId);
    },
  });
  if (tradingConfig.enabled) await tradeExecutor.checkApprovals();
  startReportScheduler(assets);
  setInterval(() => void probe().catch((error) => logger.error("Health probe failed", error)), config.runtime.healthProbeIntervalSeconds * 1000);
  const poolRetentionTimer = setInterval(() => {
    if (!dbOnline) return;
    lastPoolRetentionCleanup = Date.now();
    void execute("DELETE FROM dex_pool_event WHERE observed_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY")
      .then(() => execute("DELETE FROM dex_pool_history_gap WHERE recovered_at < UTC_TIMESTAMP(3) - INTERVAL 7 DAY"))
      .then(() => execute(`DELETE FROM direct_pool_quote WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL ${config.marketdata.directQuoteRetentionDays} DAY`))
      .then(() => execute(`DELETE FROM direct_pool_decision WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL ${config.marketdata.directDecisionRetentionDays} DAY`))
      .then(() => execute(`DELETE FROM aggregator_shadow_quote WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL ${config.marketdata.directQuoteRetentionDays} DAY`))
      .then(() => setHealth("direct_pool_retention", "healthy"))
      .catch(markDatabaseUnavailable);
  }, 3_600_000);
  await refreshValuation();
  const persistDashboardState = async () => {
    if (!dbOnline) return;
    try { await saveDashboardState(getDashboardState()); }
    catch (error) { logger.error("Failed to persist dashboard state", error); }
  };
  await persistDashboardState();
  const dashboardStateTimer = setInterval(() => void persistDashboardState(), 5000);
  setInterval(() => void refreshValuation().catch((error) => setHealth("index_price", "unavailable", messageOf(error))), config.runtime.guardrails.indexPriceRefreshSeconds * 1000);
  setInterval(() => {
    for (const collector of collectors) void collector.collect().catch((error) => setHealth("collector", "unavailable", messageOf(error)));
    if (config.marketdata.quoteProvider === "direct_pool") void directPoolCollector.runDue().catch((error) => setHealth("direct_pool", "unavailable", messageOf(error)));
  }, 250);
  setInterval(() => void tradeExecutor.tick(), 1000);
  const shutdown = async () => {
    if (stopping) return; stopping = true; logger.info("Stopping opportunity observer"); clearInterval(dashboardStateTimer); clearInterval(poolRetentionTimer); books.forEach((book) => book.stop()); await stopAdapterWatches(); await stopFixedPoolMonitors(); await Promise.all([...poolMonitorStates.keys()].map((poolId) => flushPoolStateWrites(poolId, true))); await persistDashboardState(); if (server) server.close(); await closeDatabase().catch((error) => logger.error("Failed to close MySQL connection", error)); process.exit(0);
  };
  process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => { logger.error("Startup failed", error); process.exitCode = 1; });
