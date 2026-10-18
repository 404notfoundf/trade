import type Decimal from "decimal.js";
import type { AssetConfig, Config } from "../config.js";
import { query, type Health } from "../db.js";
import { bookStale, type Instrument } from "../market/market.js";
import type { Book } from "../market/okx.js";
import type { ValuationView } from "../market/valuation.js";
import type { PoolMonitorState } from "../market/fixed-pools.js";
import type { RegisteredPool } from "../direct-pool/market-registry.js";
import { inspectRouteBalances } from "./balance-reader.js";
import { buildPreflightReport, configVersion, preflightInventoryChecks, withPreflightCheck, type PreflightCheck, type PreflightQuoteBalanceInput } from "./preflight.js";
import { savePreflightReport, type PreflightRun, type PreflightTrigger } from "./preflight-store.js";
import { logger } from "../logger.js";

type PreflightMarket = { instrument?: Instrument; feeRate?: Decimal; book?: Book };
type PreflightRoute = { status: "ENABLED" | "MONITOR_ONLY" | "BLOCKED"; reason: string | null; multiplier?: Decimal; multiplierGuardReason?: string };
type PreflightQuoteRow = {
  direction: string; shares: string | null; token_amount: string | null; cex_vwap: string | null; cex_fee_rate: string | null;
  cex_fee_usdt: string | null; gas_usdt: string | null; gas_native_raw: string | null; gas_source: string | null;
  native_quote_amount: string | null; native_quote_symbol: string | null; valuation_status: string; usdt_rate: string | null;
  price_source_time: Date | string | null; observed_at: Date | string; is_stale: number | boolean; status: string; route_status: string;
};
type PreflightTradeExecutor = { recover: () => Promise<boolean>; checkApprovals: () => Promise<void> };
type PreflightRunnerOptions = {
  config: Config;
  tradingEnabled: boolean;
  cexReady: boolean;
  dexReady: boolean;
  directPoolCandidates: RegisteredPool[];
  poolMonitorStates: Map<string, PoolMonitorState>;
  routes: Map<string, PreflightRoute>;
  markets: Map<string, PreflightMarket>;
  health: Map<string, Health>;
  tradeExecutor: PreflightTradeExecutor;
  getValuation: () => ValuationView;
  isDatabaseOnline: () => boolean;
  markDatabaseUnavailable: (error: unknown) => void;
};

const messageOf = (error: unknown) => error instanceof Error ? error.message : "unknown error";
const routeKey = (asset: AssetConfig) => asset.instId + ":" + asset.chainIndex;
const assetHealthKey = (dependency: string, asset: AssetConfig) => dependency + "_" + asset.chainIndex + "_" + asset.instId;
const timestampMillis = (value: Date | string | number | null | undefined): number | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : value.replace(" ", "T") + "Z";
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

export function createPreflightRunner(options: PreflightRunnerOptions): (trigger: PreflightTrigger) => Promise<PreflightRun> {
  return (trigger) => runPreflight(trigger, options);
}

async function runPreflight(trigger: PreflightTrigger, options: PreflightRunnerOptions): Promise<PreflightRun> {
    const { config, directPoolCandidates, poolMonitorStates, routes, markets, health, tradeExecutor, cexReady, dexReady, tradingEnabled, getValuation, isDatabaseOnline, markDatabaseUnavailable } = options;
    const configuredAssets = config.assets;
    const assets = configuredAssets.filter((asset) => asset.enabled);
    const tradingConfig = { enabled: tradingEnabled };
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
      if (!isDatabaseOnline()) throw new Error("MySQL is unavailable");
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

      const valuation = getValuation();
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
             AND direction IN ('cex_buy_dex_sell','dex_buy_cex_sell')
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
      return { id, trigger, persistence: "database", report };
    } catch (error) {
      report = withPreflightCheck(report, { key: "report_persistence", status: "BLOCKED", reason: messageOf(error), source: "trade_preflight_report" });
      logger.warn(`Trade preflight report saved to local log fallback: ${JSON.stringify(report)}`);
      return { id: null, trigger, persistence: "log", report };
    }
  }
