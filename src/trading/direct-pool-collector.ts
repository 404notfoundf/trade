import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { AssetConfig, Config } from "../config.js";
import { bookStale, floorToStep, vwap, type Instrument } from "../market.js";
import type { Book } from "../okx.js";
import type { PoolMonitorState } from "../fixed-pools.js";
import { saveDirectPoolDecision, saveDirectPoolQuote } from "./direct-pool-storage.js";
import { createPoolAdapter, createXLayerWrapperAdapter, PoolIdentityMismatchError, UnsupportedTokenError, type ExactInQuote, type PoolAdapter, type XLayerWrapperAdapter } from "./pool-adapters.js";
import type { AggregatorShadowRequest } from "./aggregator-shadow.js";
import { solveDirectPoolCandidates, type MarketRegistry, type RegisteredPool } from "./market-registry.js";

type MarketSnapshot = { instrument?: Instrument; feeRate?: Decimal; multiplier?: Decimal; book?: Book; pool?: PoolMonitorState; dbOnline: boolean; quoteValuationStatus: "VERIFIED" | "UNKNOWN" };
type Route = { asset: AssetConfig; pools: RegisteredPool[]; sizeIndex: number; dueAt: number; running: boolean };
type AdapterState = { adapter: PoolAdapter; verified: boolean; identityMismatch: boolean; retryAt: number; retryDelayMs: number };
type WrapperState = { adapter: XLayerWrapperAdapter; verified: boolean; identityMismatch: boolean; retryAt: number; retryDelayMs: number };
type ScanOptions = {
  registry: MarketRegistry; assets: AssetConfig[]; guardrails: Config["runtime"]["guardrails"]; coalesceWindowMs: number;
  observationGas: Config["directPoolObservation"];
  slippageBps?: number; getState: (asset: AssetConfig, pool: RegisteredPool) => MarketSnapshot;
  onHealth: (poolId: string, status: string, reason?: string | null) => void;
  onDatabaseError: (error: unknown) => void;
  onAggregatorShadow?: (request: AggregatorShadowRequest) => void;
};
type Direction = "cex_buy_dex_sell" | "dex_buy_cex_sell";
type ObserveRoute = { asset: AssetConfig; pool: RegisteredPool; sizeIndex: number; dueAt: number; running: boolean };

const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, "[rpc endpoint]").slice(0, 500) : "unknown quote error";
const directDirection = (direction: Direction) => direction === "cex_buy_dex_sell" ? "asset_to_quote" as const : "quote_to_asset" as const;
const rawAmount = (amount: Decimal, decimals: number) => BigInt(amount.mul(new Decimal(10).pow(decimals)).floor().toFixed(0));

export class DirectPoolCollector {
  private readonly routes = new Map<string, Route>();
  private readonly observeRoutes = new Map<string, ObserveRoute>();
  private readonly adapters = new Map<string, AdapterState>();
  private readonly wrappers = new Map<string, WrapperState>();

  constructor(private readonly options: ScanOptions) {
    for (const pool of solveDirectPoolCandidates(options.registry, options.assets)) {
      const instrument = options.registry.instruments.find((item) => item.instrument_id === pool.instrument_id)!;
      const listing = instrument.cex_listings.find((item) => item.venue === "okx")!;
      const asset = options.assets.find((item) => item.instId === listing.symbol && item.okxCurrency === listing.currency && item.chainIndex === options.registry.chains[pool.chain].chain_id.toString());
      if (!asset) continue;
      const key = routeKey(asset);
      let route = this.routes.get(key);
      if (!route) { route = { asset, pools: [], sizeIndex: 0, dueAt: Date.now() + options.coalesceWindowMs, running: false }; this.routes.set(key, route); }
      route.pools.push(pool);
      this.adapters.set(pool.id, { adapter: createPoolAdapter(pool, options.registry), verified: false, identityMismatch: false, retryAt: 0, retryDelayMs: 1_000 });
    }
    for (const route of this.routes.values()) route.pools.sort((a, b) => a.priority! - b.priority!);
    for (const pool of options.registry.pools.filter((item) => item.enabled !== false && item.mode === "observe_only" && item.verified)) {
      const instrument = options.registry.instruments.find((item) => item.instrument_id === pool.instrument_id);
      const listing = instrument?.cex_listings.find((item) => item.venue === "okx");
      const asset = listing && options.assets.find((item) => item.instId === listing.symbol && item.okxCurrency === listing.currency && item.chainIndex === options.registry.chains[pool.chain].chain_id.toString());
      if (!asset) { options.onHealth(pool.id, "not_configured", "No matching configured asset route for this observe_only pool"); continue; }
      if (!this.adapters.has(pool.id)) {
        try { this.adapters.set(pool.id, { adapter: createPoolAdapter(pool, options.registry), verified: false, identityMismatch: false, retryAt: 0, retryDelayMs: 1_000 }); }
        catch (error) { options.onHealth(pool.id, "not_configured", messageOf(error)); continue; }
      }
      if (pool.reason === "wrapper_required") {
        try { this.wrappers.set(pool.id, { adapter: createXLayerWrapperAdapter(pool, options.registry), verified: false, identityMismatch: false, retryAt: 0, retryDelayMs: 1_000 }); }
        catch (error) { options.onHealth(`${pool.id}_wrapper`, "unavailable", messageOf(error)); }
      }
      this.observeRoutes.set(pool.id, { asset, pool, sizeIndex: 0, dueAt: Date.now() + options.coalesceWindowMs, running: false });
    }
  }

  markDirty(instId?: string, chainIndex?: string): void {
    const now = Date.now();
    for (const route of this.routes.values()) {
      if (instId && route.asset.instId !== instId) continue;
      if (chainIndex && route.asset.chainIndex !== chainIndex) continue;
      route.dueAt = now + this.options.coalesceWindowMs;
    }
    for (const route of this.observeRoutes.values()) {
      if (instId && route.asset.instId !== instId) continue;
      if (chainIndex && route.asset.chainIndex !== chainIndex) continue;
      route.dueAt = now + this.options.coalesceWindowMs;
    }
  }

  async runDue(now = Date.now()): Promise<void> {
    await Promise.all([
      ...[...this.routes.values()].map(async (route) => {
      if (route.running || route.dueAt > now) return;
      route.running = true;
      route.dueAt = Number.POSITIVE_INFINITY;
      try { await this.scan(route); }
      finally { route.running = false; }
      }),
      ...[...this.observeRoutes.values()].map(async (route) => {
        if (route.running || route.dueAt > now) return;
        route.running = true;
        route.dueAt = Number.POSITIVE_INFINITY;
        try { await this.scanObserveOnly(route); }
        finally { route.running = false; }
      }),
    ]);
  }

  private async scanObserveOnly(route: ObserveRoute): Promise<void> {
    const { asset, pool } = route;
    const state = this.options.getState(asset, pool);
    if (!state.dbOnline || state.pool?.status !== "healthy" || state.pool.connectionStatus !== "connected" || state.pool.rpcSnapshotStatus !== "healthy") return;
    const adapterState = this.adapters.get(pool.id)!;
    if (adapterState.identityMismatch || adapterState.retryAt > Date.now()) return;
    const size = asset.observationSizesUsdt[route.sizeIndex]!;
    route.sizeIndex = (route.sizeIndex + 1) % asset.observationSizesUsdt.length;
    const scanId = randomUUID();
    const startedAt = Date.now();
    const persist = async (row: Parameters<typeof saveDirectPoolQuote>[0]): Promise<boolean> => {
      try { await saveDirectPoolQuote(row); return true; }
      catch (error) { this.options.onDatabaseError(error); return false; }
    };
    try {
      if (!adapterState.verified) {
        await adapterState.adapter.verify(pool);
        adapterState.verified = true;
        adapterState.retryDelayMs = 1_000;
        this.options.onHealth(pool.id, "healthy");
      }
      const assetUiMultiplier = new Decimal(await adapterState.adapter.getAssetUiMultiplier(pool));
      if (!assetUiMultiplier.isFinite() || !assetUiMultiplier.gt(0)) throw new Error("Asset UI multiplier is invalid");
      const quoteAmount = new Decimal(size);
      const amountByDirection: Array<{ direction: ExactInQuote["direction"]; amountInRaw: bigint; expectedAssetUiMultiplier?: string }> = [
        { direction: "quote_to_asset", amountInRaw: rawAmount(quoteAmount, pool.token_in_out.quote_decimals) },
      ];
      const marginalPrice = state.pool.marginalPrice ? new Decimal(state.pool.marginalPrice) : null;
      let intendedAssetAmountRaw: bigint | null = null;
      const book = state.book;
      const instrument = state.instrument;
      const multiplier = state.multiplier;
      // Solana Token-2022's scaled UI amount already carries Backed's multiplier.
      const cexAssetMultiplier = pool.chain === "solana"
        ? assetUiMultiplier
        : multiplier?.isFinite() && multiplier.gt(0) ? assetUiMultiplier.mul(multiplier) : null;
      const targetShares = book?.ready && !bookStale(book) && instrument
        && book.asks[0] && book.bids[0]
        ? floorToStep(quoteAmount.div(new Decimal(book.asks[0]!.price).plus(book.bids[0]!.price).div(2)), instrument.lotSz)
        : null;
      if (targetShares?.gt(0) && cexAssetMultiplier?.gt(0)) {
        const underlyingRaw = rawAmount(targetShares.div(cexAssetMultiplier), asset.tokenDecimals);
        if (pool.reason === "wrapper_required") {
          try { intendedAssetAmountRaw = await this.previewWrapper(pool, "previewDeposit", underlyingRaw); }
          catch { /* Keep the raw pool observation independent from wrapper availability. */ }
        } else intendedAssetAmountRaw = underlyingRaw;
      }
      if (intendedAssetAmountRaw !== null) {
        amountByDirection.push({ direction: "asset_to_quote", amountInRaw: intendedAssetAmountRaw, expectedAssetUiMultiplier: assetUiMultiplier.toString() });
      } else if (marginalPrice?.isFinite() && marginalPrice.gt(0) && cexAssetMultiplier?.gt(0)) {
        amountByDirection.push({ direction: "asset_to_quote", amountInRaw: rawAmount(quoteAmount.div(marginalPrice).div(cexAssetMultiplier), pool.token_in_out.asset_decimals), expectedAssetUiMultiplier: assetUiMultiplier.toString() });
      }
      for (const input of amountByDirection) {
        const direction: Direction = input.direction === "asset_to_quote" ? "cex_buy_dex_sell" : "dex_buy_cex_sell";
        let observed: { quote: ExactInQuote; quoteId: number } | null = null;
        try {
          const quote = await adapterState.adapter.quoteExactIn(pool, { ...input, slippageBps: this.options.slippageBps ?? 50 });
          let quoteId: number;
          try { quoteId = await saveDirectPoolQuote({
            scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
            amountInRaw: quote.amountInRaw, amountOutRaw: quote.amountOutRaw, minimumAmountOutRaw: quote.minimumAmountOutRaw,
            priceImpactPercent: quote.priceImpactPercent, networkFeeNativeRaw: quote.networkFeeNativeRaw, networkFeeUsdt: quote.networkFeeUsdt,
            blockNumber: quote.version.blockNumber ?? null, blockHash: quote.version.blockHash ?? null, slot: quote.version.slot ?? null,
            poolStateFingerprint: quote.version.stateFingerprint, quotedAt: new Date(quote.quotedAt), requestMs: Date.now() - startedAt,
            status: "OK", failureCode: null, failureReason: null, rawResponse: quote.raw,
          }); } catch (error) { this.options.onDatabaseError(error); return; }
          observed = { quote, quoteId };
        } catch (error) {
          const identityMismatch = error instanceof PoolIdentityMismatchError;
          const unsupportedToken = error instanceof UnsupportedTokenError;
          const failureReason = messageOf(error);
          if (identityMismatch) adapterState.identityMismatch = true;
          else {
            adapterState.retryAt = Date.now() + adapterState.retryDelayMs;
            adapterState.retryDelayMs = Math.min(adapterState.retryDelayMs * 2, 30_000);
          }
          this.options.onHealth(pool.id, identityMismatch ? "invalid" : "unavailable", failureReason);
          if (!await persist({
            scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
            amountInRaw: input.amountInRaw, amountOutRaw: null, minimumAmountOutRaw: null, priceImpactPercent: null,
            networkFeeNativeRaw: null, networkFeeUsdt: null, blockNumber: null, blockHash: null, slot: null,
            poolStateFingerprint: null, quotedAt: new Date(), requestMs: Date.now() - startedAt, status: "FAILED",
            failureCode: identityMismatch ? "POOL_IDENTITY_MISMATCH" : unsupportedToken ? error.failureCode : "EXACT_IN_QUOTE_FAILED", failureReason, rawResponse: null,
          })) return;
          if (identityMismatch || unsupportedToken) break;
        }
        if (observed) await this.recordObserveDecision(route, scanId, size, direction, observed.quoteId, observed.quote, state);
      }
    } catch (error) {
      const identityMismatch = error instanceof PoolIdentityMismatchError;
      const unsupportedToken = error instanceof UnsupportedTokenError;
      const failureReason = messageOf(error);
      if (identityMismatch) adapterState.identityMismatch = true;
      else {
        adapterState.retryAt = Date.now() + adapterState.retryDelayMs;
        adapterState.retryDelayMs = Math.min(adapterState.retryDelayMs * 2, 30_000);
      }
      this.options.onHealth(pool.id, identityMismatch ? "invalid" : "unavailable", failureReason);
      const directions: Direction[] = ["dex_buy_cex_sell", ...(state.pool.marginalPrice ? ["cex_buy_dex_sell" as const] : [])];
      await Promise.all(directions.map((direction) => persist({
        scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
        amountInRaw: null, amountOutRaw: null, minimumAmountOutRaw: null, priceImpactPercent: null,
        networkFeeNativeRaw: null, networkFeeUsdt: null, blockNumber: null, blockHash: null, slot: null,
        poolStateFingerprint: null, quotedAt: new Date(), requestMs: Date.now() - startedAt, status: "FAILED",
        failureCode: identityMismatch ? "POOL_IDENTITY_MISMATCH" : unsupportedToken ? error.failureCode : "EXACT_IN_QUOTE_FAILED", failureReason, rawResponse: null,
      })));
    }
  }

  private async previewWrapper(pool: RegisteredPool, method: "previewDeposit" | "previewRedeem", amountRaw: bigint): Promise<bigint> {
    const wrapper = this.wrappers.get(pool.id);
    if (!wrapper) throw new Error("X Layer wrapper adapter is unavailable");
    if (wrapper.identityMismatch) throw new PoolIdentityMismatchError("X Layer wrapper identity failed; restart after registry review");
    if (wrapper.retryAt > Date.now()) throw new Error("X Layer wrapper preview is in retry backoff");
    try {
      if (!wrapper.verified) {
        await wrapper.adapter.verify();
        wrapper.verified = true;
      }
      const result = await wrapper.adapter[method](amountRaw);
      wrapper.retryDelayMs = 1_000;
      this.options.onHealth(`${pool.id}_wrapper`, "healthy");
      return result;
    } catch (error) {
      if (error instanceof PoolIdentityMismatchError) wrapper.identityMismatch = true;
      else {
        wrapper.retryAt = Date.now() + wrapper.retryDelayMs;
        wrapper.retryDelayMs = Math.min(wrapper.retryDelayMs * 2, 30_000);
      }
      this.options.onHealth(`${pool.id}_wrapper`, error instanceof PoolIdentityMismatchError ? "invalid" : "unavailable", messageOf(error));
      throw error;
    }
  }

  private async recordObserveDecision(route: ObserveRoute, scanId: string, size: number, direction: Direction, quoteId: number, quote: ExactInQuote, initial: MarketSnapshot): Promise<void> {
    const { asset, pool } = route;
    let cexShares: Decimal | null = null;
    let cexFill: ReturnType<typeof vwap> = null;
    let cexFee: Decimal | null = null;
    let gross: Decimal | null = null;
    let net: Decimal | null = null;
    let invested: Decimal | null = null;
    const gasBudget = new Decimal(pool.chain === "solana" ? this.options.observationGas.solanaSwapGasUsdt
      : direction === "cex_buy_dex_sell" ? this.options.observationGas.xlayerWrapThenSwapGasUsdt : this.options.observationGas.xlayerSwapThenUnwrapGasUsdt);
    let conversion: Record<string, string> = {};
    let underlyingRaw = direction === "cex_buy_dex_sell" ? quote.amountInRaw : quote.amountOutRaw;
    let reason: string | null = null;
    const poolAssetRaw = underlyingRaw;
    if (pool.reason === "wrapper_required") {
      try {
        underlyingRaw = await this.previewWrapper(pool, "previewRedeem", poolAssetRaw);
        conversion = { wrapperAmountRaw: poolAssetRaw.toString(), underlyingAmountRaw: underlyingRaw.toString() };
      } catch (error) { reason = `WRAPPER_CONVERSION_UNAVAILABLE: ${messageOf(error)}`; }
    } else conversion = {
      assetAmountRaw: underlyingRaw.toString(), assetUiMultiplier: quote.assetUiMultiplier,
      assetUiAmount: new Decimal(underlyingRaw.toString()).div(new Decimal(10).pow(asset.tokenDecimals)).mul(quote.assetUiMultiplier).toString(),
    };

    // Rebase the comparison on the latest book after the slower DEX and wrapper RPC calls.
    const current = this.options.getState(asset, pool);
    const book = current.book;
    const instrument = current.instrument;
    const feeRate = current.feeRate;
    const multiplier = current.multiplier;
    const needsBackedMultiplier = pool.chain !== "solana";
    const cexShareMultiplier = needsBackedMultiplier ? multiplier : new Decimal(1);
    if (!reason) reason = !book?.ready ? "CEX_BOOK_UNAVAILABLE"
      : bookStale(book) ? "CEX_BOOK_STALE"
        : !instrument ? "CEX_INSTRUMENT_UNAVAILABLE"
          : !feeRate?.isFinite() || feeRate.lt(0) ? "CEX_FEE_UNAVAILABLE"
            : !cexShareMultiplier?.isFinite() || !cexShareMultiplier.gt(0) ? "MULTIPLIER_UNAVAILABLE"
              : initial.instrument && (current.instrument?.instId !== initial.instrument.instId || current.instrument.lotSz !== initial.instrument.lotSz || current.instrument.minSz !== initial.instrument.minSz) ? "CEX_INSTRUMENT_CHANGED"
                : initial.feeRate && !current.feeRate?.eq(initial.feeRate) ? "CEX_FEE_CHANGED"
                  : needsBackedMultiplier && initial.multiplier && !current.multiplier?.eq(initial.multiplier) ? "MULTIPLIER_CHANGED"
                    : null;
    if (!reason) {
      cexShares = floorToStep(new Decimal(underlyingRaw.toString()).div(new Decimal(10).pow(asset.tokenDecimals)).mul(quote.assetUiMultiplier).mul(cexShareMultiplier!), instrument!.lotSz);
      if (cexShares.lt(instrument!.minSz)) reason = "CEX_MINIMUM_SIZE";
      else {
        cexFill = vwap(direction === "cex_buy_dex_sell" ? book!.asks : book!.bids, cexShares);
        if (!cexFill) reason = "CEX_DEPTH_INSUFFICIENT";
        else {
          const cexFeeRate = feeRate!;
          cexFee = cexFill.notional.mul(cexFeeRate);
          const quoteAmount = direction === "cex_buy_dex_sell"
            ? new Decimal(quote.amountOutRaw.toString()).div(new Decimal(10).pow(pool.token_in_out.quote_decimals))
            : new Decimal(quote.amountInRaw.toString()).div(new Decimal(10).pow(pool.token_in_out.quote_decimals));
          gross = direction === "cex_buy_dex_sell" ? quoteAmount.minus(cexFill.notional) : cexFill.notional.minus(quoteAmount);
          net = gross.minus(cexFee).minus(gasBudget);
          invested = direction === "cex_buy_dex_sell" ? cexFill.notional : quoteAmount;
        }
      }
    }
    const highImpact = new Decimal(quote.priceImpactPercent).abs().gt(this.options.guardrails.maxDexPriceImpactPercent);
    await saveDirectPoolDecision({
      scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, direction, sizeUsdt: String(size),
      selectedQuoteId: quoteId, cexBookAt: book ? new Date(book.exchangeTime) : null, cexReceivedAt: book ? new Date(book.receivedAt) : null,
      cexSeqId: book?.seqId ?? null, cexBid: book?.bids[0]?.price ?? null, cexAsk: book?.asks[0]?.price ?? null,
      cexVwap: cexFill?.vwap.toString() ?? null, cexFeeUsdt: cexFee?.toString() ?? null,
      dexNetworkFeeUsdt: null, gasBudgetUsdt: gasBudget.toString(),
      valuationInputs: { valuation: "USDG_USDC_ASSUMED_1_TO_1_USDT", wrapper: conversion, assetUiMultiplier: quote.assetUiMultiplier, backedMultiplierApplied: cexShareMultiplier?.toString() ?? null, gasBudgetUsdt: gasBudget.toString(), gasSource: "config.direct_pool_observation", priceImpactPercent: quote.priceImpactPercent },
      grossProfitUsdt: gross?.toString() ?? null, netProfitUsdt: net?.toString() ?? null,
      roi: net && invested?.gt(0) ? net.div(invested).toString() : null,
      valuationStatus: net === null ? "UNKNOWN" : "ASSUMED_1_TO_1",
      decisionStatus: reason ? "BLOCKED" : highImpact ? "HIGH_PRICE_IMPACT" : "OBSERVED",
      blockReason: reason ?? (highImpact ? "PRICE_IMPACT_OVER_LIMIT_OBSERVATION_ONLY" : null),
    }).catch((error) => { this.options.onDatabaseError(error); });
  }

  private async scan(route: Route): Promise<void> {
    const { asset } = route;
    const size = asset.observationSizesUsdt[route.sizeIndex]!;
    route.sizeIndex = (route.sizeIndex + 1) % asset.observationSizesUsdt.length;
    const scanId = randomUUID();
    const initial = route.pools.length ? this.options.getState(asset, route.pools[0]!) : undefined;
    const book = initial?.book;
    const instrument = initial?.instrument;
    const feeRate = initial?.feeRate;
    const multiplier = initial?.multiplier;
    const reason = !initial?.dbOnline ? "DATABASE_UNAVAILABLE"
      : !book?.ready ? "CEX_BOOK_UNAVAILABLE"
        : bookStale(book) ? "CEX_BOOK_STALE"
          : !instrument ? "CEX_INSTRUMENT_UNAVAILABLE"
            : !feeRate ? "CEX_FEE_UNAVAILABLE"
              : !multiplier?.isFinite() || !multiplier.gt(0) ? "MULTIPLIER_UNAVAILABLE"
                : null;
    if (reason || !initial || !book || !instrument || !feeRate || !multiplier) {
      await this.recordBlockedDirections(route, scanId, size, initial, reason ?? "MARKET_STATE_UNAVAILABLE");
      return;
    }

    const midpoint = new Decimal(book.asks[0]!.price).plus(book.bids[0]!.price).div(2);
    const targetShares = floorToStep(new Decimal(size).div(midpoint), instrument.lotSz);
    const askFill = vwap(book.asks, targetShares);
    const bidFill = vwap(book.bids, targetShares);
    if (targetShares.lt(instrument.minSz) || !askFill || !bidFill) {
      await this.recordBlockedDirections(route, scanId, size, initial, "CEX_DEPTH_INSUFFICIENT");
      return;
    }
    const assetAmountRaw = rawAmount(targetShares.div(multiplier), asset.tokenDecimals).toString();
    const quoteAmountRaw = rawAmount(new Decimal(size), asset.quoteTokenDecimals).toString();
    this.options.onAggregatorShadow?.({ scanId, asset, sizeUsdt: size, book, assetAmountRaw, quoteAmountRaw });

    for (const direction of ["cex_buy_dex_sell", "dex_buy_cex_sell"] as const) {
      let selected: { quoteId: number; poolId: string; quote: ExactInQuote; gross: Decimal; net: Decimal; cexVwap: Decimal; cexFee: Decimal; invested: Decimal } | undefined;
      let blockReason = "NO_VALID_POOL_QUOTE";
      const attempts: string[] = [];
      for (const pool of route.pools) {
        const adapterState = this.adapters.get(pool.id)!;
        const state = this.options.getState(asset, pool);
        const poolHealthy = state.pool?.status === "healthy" && state.pool.connectionStatus === "connected" && state.pool.rpcSnapshotStatus === "healthy";
        if (adapterState.identityMismatch) { blockReason = "POOL_IDENTITY_MISMATCH_REARM_REQUIRED"; attempts.push(`${pool.id}:identity_mismatch`); continue; }
        if (!poolHealthy) { blockReason = state.pool?.lastError ? "POOL_STATE_UNHEALTHY" : "POOL_NOT_READY"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
        const currentBook = state.book;
        if (!currentBook?.ready || bookStale(currentBook) || currentBook.seqId !== book.seqId) { blockReason = "CEX_BOOK_CHANGED_OR_STALE"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
        const notional = direction === "cex_buy_dex_sell" ? askFill.notional : new Decimal(size);
        if (pool.max_notional_usdt && notional.gt(pool.max_notional_usdt)) { blockReason = "POOL_NOTIONAL_LIMIT"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
        if (adapterState.retryAt > Date.now()) { blockReason = "POOL_QUOTE_BACKOFF"; attempts.push(`${pool.id}:backoff`); continue; }
        const startedAt = Date.now();
        try {
          if (!adapterState.verified) {
            await adapterState.adapter.verify(pool);
            adapterState.verified = true;
            adapterState.retryDelayMs = 1_000;
            this.options.onHealth(pool.id, "healthy");
          }
          const amountInRaw = direction === "cex_buy_dex_sell"
            ? BigInt(assetAmountRaw)
            : BigInt(quoteAmountRaw);
          const quote = await adapterState.adapter.quoteExactIn(pool, { direction: directDirection(direction), amountInRaw, slippageBps: this.options.slippageBps ?? 50 });
          const requestMs = Date.now() - startedAt;
          let quoteId: number;
          try {
            quoteId = await saveDirectPoolQuote({
              scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
              amountInRaw: quote.amountInRaw, amountOutRaw: quote.amountOutRaw, minimumAmountOutRaw: quote.minimumAmountOutRaw,
              priceImpactPercent: quote.priceImpactPercent, networkFeeNativeRaw: quote.networkFeeNativeRaw, networkFeeUsdt: quote.networkFeeUsdt,
              blockNumber: quote.version.blockNumber ?? null, blockHash: quote.version.blockHash ?? null, slot: quote.version.slot ?? null,
              poolStateFingerprint: quote.version.stateFingerprint, quotedAt: new Date(quote.quotedAt), requestMs, status: "OK",
              failureCode: null, failureReason: null, rawResponse: quote.raw,
            });
          } catch (error) { this.options.onDatabaseError(error); throw error; }
          const latest = this.options.getState(asset, pool);
          if (!latest.book?.ready || bookStale(latest.book) || latest.book.seqId !== book.seqId) { blockReason = "CEX_BOOK_CHANGED_OR_STALE"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          if (latest.quoteValuationStatus !== "VERIFIED") { blockReason = "QUOTE_VALUATION_UNKNOWN"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          if (new Decimal(quote.priceImpactPercent).abs().gt(this.options.guardrails.maxDexPriceImpactPercent)) { blockReason = "PRICE_IMPACT_LIMIT"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          if (quote.networkFeeUsdt === null) { blockReason = "NETWORK_FEE_UNKNOWN"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          const quoteAmount = new Decimal(quote.amountOutRaw.toString()).div(new Decimal(10).pow(direction === "cex_buy_dex_sell" ? asset.quoteTokenDecimals : asset.tokenDecimals));
          const cexShares = direction === "cex_buy_dex_sell" ? targetShares : floorToStep(quoteAmount.mul(multiplier), instrument.lotSz);
          const fill = direction === "cex_buy_dex_sell" ? askFill : vwap(book.bids, cexShares);
          if (!fill || cexShares.lt(instrument.minSz)) { blockReason = "CEX_DEPTH_INSUFFICIENT"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          const cexFee = fill.notional.mul(feeRate);
          const gross = direction === "cex_buy_dex_sell" ? quoteAmount.minus(fill.notional) : fill.notional.minus(new Decimal(size));
          const net = gross.minus(cexFee).minus(quote.networkFeeUsdt);
          if (net.gt(0)) { selected = { quoteId, poolId: pool.id, quote, gross, net, cexVwap: fill.vwap, cexFee, invested: direction === "cex_buy_dex_sell" ? fill.notional : new Decimal(size) }; blockReason = "SELECTED"; break; }
          blockReason = "NO_NET_OPPORTUNITY";
          attempts.push(`${pool.id}:no_net_opportunity`);
        } catch (error) {
          const identityMismatch = error instanceof PoolIdentityMismatchError;
          const unsupportedToken = error instanceof UnsupportedTokenError;
          const failureReason = messageOf(error);
          if (identityMismatch) {
            adapterState.identityMismatch = true;
            blockReason = "POOL_IDENTITY_MISMATCH_REARM_REQUIRED";
            this.options.onHealth(pool.id, "invalid", failureReason);
          } else {
            adapterState.retryAt = Date.now() + adapterState.retryDelayMs;
            adapterState.retryDelayMs = Math.min(adapterState.retryDelayMs * 2, 30_000);
            blockReason = unsupportedToken ? error.failureCode : "EXACT_IN_QUOTE_FAILED";
            this.options.onHealth(pool.id, "unavailable", failureReason);
          }
          attempts.push(`${pool.id}:${blockReason.toLowerCase()}`);
          try {
            await saveDirectPoolQuote({
              scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
              amountInRaw: null, amountOutRaw: null, minimumAmountOutRaw: null, priceImpactPercent: null,
              networkFeeNativeRaw: null, networkFeeUsdt: null, blockNumber: null, blockHash: null, slot: null,
              poolStateFingerprint: null, quotedAt: new Date(), requestMs: Date.now() - startedAt, status: "FAILED",
              failureCode: identityMismatch ? "POOL_IDENTITY_MISMATCH" : unsupportedToken ? error.failureCode : "EXACT_IN_QUOTE_FAILED", failureReason, rawResponse: null,
            });
          } catch (dbError) { this.options.onDatabaseError(dbError); throw dbError; }
        }
      }
      const current = this.options.getState(asset, route.pools[0]!);
      const selectedId = selected?.quoteId ?? null;
      const shares = selected ? (direction === "cex_buy_dex_sell" ? targetShares : new Decimal(selected.quote.amountOutRaw.toString()).div(new Decimal(10).pow(asset.tokenDecimals)).mul(multiplier)) : direction === "cex_buy_dex_sell" ? targetShares : null;
      const cexFill = shares === null ? null : vwap(direction === "cex_buy_dex_sell" ? book.asks : book.bids, shares);
      const cexFee = cexFill && feeRate ? cexFill.notional.mul(feeRate) : null;
      try {
        await saveDirectPoolDecision({
          scanId, instrumentId: route.pools[0]!.instrument_id, chainIndex: asset.chainIndex, poolId: selected?.poolId ?? (route.pools.length === 1 ? route.pools[0]!.id : null), direction, sizeUsdt: String(size),
          selectedQuoteId: selectedId, cexBookAt: new Date(book.exchangeTime), cexReceivedAt: new Date(book.receivedAt), cexSeqId: book.seqId,
          cexBid: book.bids[0]?.price ?? null, cexAsk: book.asks[0]?.price ?? null, cexVwap: selected?.cexVwap.toString() ?? cexFill?.vwap.toString() ?? null,
          cexFeeUsdt: selected?.cexFee.toString() ?? cexFee?.toString() ?? null, dexNetworkFeeUsdt: selected?.quote.networkFeeUsdt ?? null, gasBudgetUsdt: null,
          valuationInputs: { quoteValuationStatus: current.quoteValuationStatus, attempts }, grossProfitUsdt: selected?.gross.toString() ?? null,
          netProfitUsdt: selected?.net.toString() ?? null, roi: selected?.invested.gt(0) ? selected.net.div(selected.invested).toString() : null,
          valuationStatus: current.quoteValuationStatus, decisionStatus: selected ? "SELECTED" : blockReason === "NO_NET_OPPORTUNITY" ? "NO_OPPORTUNITY" : "BLOCKED",
          blockReason: selected ? null : attempts.length ? `${blockReason}: ${attempts.join(", ")}` : blockReason,
        });
      } catch (error) { this.options.onDatabaseError(error); throw error; }
    }
  }

  private async recordBlockedDirections(route: Route, scanId: string, size: number, state: MarketSnapshot | undefined, reason: string): Promise<void> {
    if (!state?.dbOnline) return;
    for (const direction of ["cex_buy_dex_sell", "dex_buy_cex_sell"] as const) {
      await saveDirectPoolDecision({
        scanId, instrumentId: route.pools[0]!.instrument_id, chainIndex: route.asset.chainIndex, poolId: route.pools.length === 1 ? route.pools[0]!.id : null, direction, sizeUsdt: String(size),
        selectedQuoteId: null, cexBookAt: state?.book ? new Date(state.book.exchangeTime) : null,
        cexReceivedAt: state?.book ? new Date(state.book.receivedAt) : null, cexSeqId: state?.book?.seqId ?? null,
        cexBid: state?.book?.bids[0]?.price ?? null, cexAsk: state?.book?.asks[0]?.price ?? null, cexVwap: null, cexFeeUsdt: null,
        dexNetworkFeeUsdt: null, gasBudgetUsdt: null, valuationInputs: { quoteValuationStatus: state?.quoteValuationStatus ?? "UNKNOWN" },
        grossProfitUsdt: null, netProfitUsdt: null, roi: null, valuationStatus: state?.quoteValuationStatus ?? "UNKNOWN",
        decisionStatus: "BLOCKED", blockReason: reason,
      }).catch((error) => { this.options.onDatabaseError(error); throw error; });
    }
  }
}

function routeKey(asset: AssetConfig): string { return `${asset.instId}:${asset.chainIndex}`; }
