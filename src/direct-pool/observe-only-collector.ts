import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import Decimal from "decimal.js";
import { Keypair } from "@solana/web3.js";
import type { AssetConfig, Config } from "../config.js";
import { bookObservationStale, floorToStep, vwap, type Instrument } from "../market/market.js";
import type { Book } from "../market/okx.js";
import type { PoolMonitorState } from "../market/fixed-pools.js";
import { logger } from "../logger.js";
import { calculateProfit } from "../market/profit-calculation.js";
import { saveDirectPoolDecision, saveDirectPoolQuote } from "./storage.js";
import { createPoolAdapter } from "./pool-adapter-factory.js";
import { createXLayerWrapperAdapter, PoolIdentityMismatchError, UnsupportedTokenError, type ExactInQuote, type PoolAdapter, type XLayerWrapperAdapter } from "./pool-adapters.js";
import type { AggregatorShadowRequest } from "./aggregator-shadow.js";
import { netMarginOk } from "../trading/gates.js";
import type { MarketRegistry, RegisteredPool } from "./market-registry.js";
import { poolStateView, type AdapterPoolStateEvent } from "./pool-state.js";

export type MarketSnapshot = { instrument?: Instrument; feeRate?: Decimal; multiplier?: Decimal; book?: Book; pool?: PoolMonitorState; dbOnline: boolean; quoteValuationStatus: "VERIFIED" | "UNKNOWN" };
export type AdapterState = { adapter: PoolAdapter; verified: boolean; identityMismatch: boolean; retryAt: number; retryDelayMs: number; watchStatus: "not_required" | "healthy" | "unavailable"; watchGeneration: number; marginalPrice?: string; watchError?: string };
type WrapperState = { adapter: XLayerWrapperAdapter; verified: boolean; identityMismatch: boolean; retryAt: number; retryDelayMs: number };
export type ScanOptions = {
  registry: MarketRegistry; assets: AssetConfig[]; guardrails: Config["runtime"]["guardrails"]; coalesceWindowMs: number;
  observeOnlyPoolIds: string[];
  observationGas: Config["directPoolObservation"];
  solanaSimulationPrivateKey: string;
  slippageBps?: number; getState: (asset: AssetConfig, pool: RegisteredPool) => MarketSnapshot;
  onHealth: (poolId: string, status: string, reason?: string | null) => void;
  onPoolState: (poolId: string, event: AdapterPoolStateEvent) => void;
  onDatabaseError: (error: unknown) => void;
  onAggregatorShadow?: (request: AggregatorShadowRequest) => void;
};
type Direction = "cex_buy_dex_sell" | "dex_buy_cex_sell";
export type ObserveRoute = { asset: AssetConfig; pool: RegisteredPool; sizeIndex: number; dueAt: number; lastScanAt: number; running: boolean };
type SimulationStatus = "NOT_APPLICABLE" | "DISABLED" | "NOT_QUALIFIED" | "COOLDOWN" | "SKIPPED" | "PASSED" | "FAILED";
type SimulationOutcome = { status: SimulationStatus; reason: string | null; at: Date | null; inputDebitedRaw?: string; outputCreditedRaw?: string; networkFeeNativeRaw?: string; computeUnits?: number };

export const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, "[rpc endpoint]").slice(0, 500) : "unknown quote error";
export const directDirection = (direction: Direction) => direction === "cex_buy_dex_sell" ? "asset_to_quote" as const : "quote_to_asset" as const;
export const rawAmount = (amount: Decimal, decimals: number) => BigInt(amount.mul(new Decimal(10).pow(decimals)).floor().toFixed(0));
const solanaQuoteLogHeartbeatMs = 60_000;
const lastSolanaQuoteLogs = new Map<string, { signature: string; loggedAt: number; suppressed: number; changed: boolean }>();

export class ObserveOnlyCollector {
  private readonly routes = new Map<string, ObserveRoute>();
  private readonly wrappers = new Map<string, WrapperState>();
  private readonly lastSimulationAt = new Map<string, number>();

  constructor(private readonly options: ScanOptions, private readonly adapters: Map<string, AdapterState>) {}

  registerRoutes(): ObserveRoute[] {
    const observeOnlyPoolIds = new Set(this.options.observeOnlyPoolIds);
    for (const pool of this.options.registry.pools.filter((item) => observeOnlyPoolIds.has(item.id) && item.enabled !== false && item.mode === "observe_only" && item.verified)) {
      const instrument = this.options.registry.instruments.find((item) => item.instrument_id === pool.instrument_id);
      const listing = instrument?.cex_listings.find((item) => item.venue === "okx");
      const asset = listing && this.options.assets.find((item) => item.instId === listing.symbol && item.okxCurrency === listing.currency && item.chainIndex === this.options.registry.chains[pool.chain].chain_id.toString());
      if (!asset) { this.options.onHealth(pool.id, "not_configured", "No matching configured asset route for this observe_only pool"); continue; }
      if (!this.adapters.has(pool.id)) {
        try {
          const adapter = createPoolAdapter(pool, this.options.registry);
          this.adapters.set(pool.id, { adapter, verified: false, identityMismatch: false, retryAt: 0, retryDelayMs: 1_000, watchStatus: adapter.stateSource === "adapter_watch" ? "unavailable" : "not_required", watchGeneration: 0 });
        } catch (error) { this.options.onHealth(pool.id, "not_configured", messageOf(error)); continue; }
      }
      if (pool.reason === "wrapper_required") {
        try { this.wrappers.set(pool.id, { adapter: createXLayerWrapperAdapter(pool, this.options.registry), verified: false, identityMismatch: false, retryAt: 0, retryDelayMs: 1_000 }); }
        catch (error) { this.options.onHealth(pool.id + "_wrapper", "unavailable", messageOf(error)); }
      }
      this.routes.set(pool.id, { asset, pool, sizeIndex: 0, dueAt: Date.now() + this.options.coalesceWindowMs, lastScanAt: Number.NEGATIVE_INFINITY, running: false });
    }
    return [...this.routes.values()];
  }

  markDirty(instId: string | undefined, chainIndex: string | undefined, now = Date.now()): void {
    for (const route of this.routes.values()) {
      if (instId && route.asset.instId !== instId) continue;
      if (chainIndex && route.asset.chainIndex !== chainIndex) continue;
      route.dueAt = Math.min(route.dueAt, Math.max(now + this.options.coalesceWindowMs, route.lastScanAt + route.asset.dexQuoteIntervalMs));
    }
  }

  async runDue(now: number): Promise<void> {
    await Promise.all([...this.routes.values()].map(async (route) => {
      if (route.running || route.dueAt > now) return;
      route.running = true;
      route.lastScanAt = now;
      route.dueAt = Number.POSITIVE_INFINITY;
      try { await this.scanObserveOnly(route); }
      finally { route.running = false; }
    }));
  }

  private async scanObserveOnly(route: ObserveRoute): Promise<void> {
    const { asset, pool } = route;
    const state = this.options.getState(asset, pool);
    const adapterState = this.adapters.get(pool.id)!;
    const poolStatus = poolStateView(adapterState, state.pool);
    const adapterOwnsPoolState = poolStatus.source === "adapter_watch";
    if (!state.dbOnline || !poolStatus.healthy) return;
    if (adapterState.identityMismatch || adapterState.retryAt > Date.now()) return;
    const watchGeneration = adapterState.watchGeneration;
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
      const marginalPrice = poolStatus.marginalPrice ? new Decimal(poolStatus.marginalPrice) : null;
      let intendedAssetAmountRaw: bigint | null = null;
      const book = state.book;
      const instrument = state.instrument;
      // Solana supplies its scaled UI multiplier with the quote; EVM balances are already adjusted.
      const cexAssetMultiplier = pool.chain === "solana"
        ? assetUiMultiplier
        : new Decimal(1);
      const targetShares = book?.ready && !bookObservationStale(book) && instrument
        && book.asks[0] && book.bids[0]
        ? floorToStep(quoteAmount.div(new Decimal(book.asks[0]!.price).plus(book.bids[0]!.price).div(2)), instrument.lotSz)
        : null;
      if (targetShares?.gt(0) && cexAssetMultiplier.gt(0)) {
        const underlyingRaw = rawAmount(targetShares.div(cexAssetMultiplier), asset.tokenDecimals);
        if (pool.reason === "wrapper_required") {
          try { intendedAssetAmountRaw = await this.previewWrapper(pool, "previewDeposit", underlyingRaw); }
          catch { /* Keep the raw pool observation independent from wrapper availability. */ }
        } else intendedAssetAmountRaw = underlyingRaw;
      }
      if (intendedAssetAmountRaw !== null) {
        amountByDirection.push({ direction: "asset_to_quote", amountInRaw: intendedAssetAmountRaw, expectedAssetUiMultiplier: assetUiMultiplier.toString() });
      } else if (marginalPrice?.isFinite() && marginalPrice.gt(0) && cexAssetMultiplier.gt(0)) {
        amountByDirection.push({ direction: "asset_to_quote", amountInRaw: rawAmount(quoteAmount.div(marginalPrice).div(cexAssetMultiplier), pool.token_in_out.asset_decimals), expectedAssetUiMultiplier: assetUiMultiplier.toString() });
      }
      for (const input of amountByDirection) {
        const direction: Direction = input.direction === "asset_to_quote" ? "cex_buy_dex_sell" : "dex_buy_cex_sell";
        let observed: { quote: ExactInQuote; quoteId: number } | null = null;
        try {
          const quote = await adapterState.adapter.quoteExactIn(pool, {
            ...input, slippageBps: this.options.slippageBps ?? 50,
            xlayerSnapshot: pool.chain === "xlayer" && state.pool ? state.pool : undefined,
          });
          if (adapterOwnsPoolState && (adapterState.watchStatus !== "healthy" || adapterState.watchGeneration !== watchGeneration)) {
            return;
          }
          const requestMs = Date.now() - startedAt;
          let quoteId: number;
          try { quoteId = await saveDirectPoolQuote({
            scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
            amountInRaw: quote.amountInRaw, amountOutRaw: quote.amountOutRaw, minimumAmountOutRaw: quote.minimumAmountOutRaw,
            priceImpactPercent: quote.priceImpactPercent, networkFeeNativeRaw: quote.networkFeeNativeRaw, networkFeeUsdt: quote.networkFeeUsdt,
            blockNumber: quote.version.blockNumber ?? null, blockHash: quote.version.blockHash ?? null, slot: quote.version.slot ?? null,
            poolStateFingerprint: quote.version.stateFingerprint, quotedAt: new Date(quote.quotedAt), requestMs,
            status: "OK", failureCode: null, failureReason: null, rawResponse: quote.raw,
          }); } catch (error) { this.options.onDatabaseError(error); return; }
          logSolanaQuote(pool, scanId, quoteId, direction, quote, requestMs);
          observed = { quote, quoteId };
        } catch (error) {
          const identityMismatch = error instanceof PoolIdentityMismatchError;
          const unsupportedToken = error instanceof UnsupportedTokenError;
          const failureReason = messageOf(error);
          if (identityMismatch) adapterState.identityMismatch = true;
          else {
            adapterState.retryAt = Date.now() + adapterState.retryDelayMs;
            adapterState.retryDelayMs = Math.min(adapterState.retryDelayMs * 2, 30_000);
            route.dueAt = Math.min(route.dueAt, adapterState.retryAt);
          }
          this.options.onHealth(pool.id, identityMismatch ? "invalid" : "unavailable", failureReason);
          if (!await persist({
            scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
            amountInRaw: input.amountInRaw, amountOutRaw: null, minimumAmountOutRaw: null, priceImpactPercent: null,
            networkFeeNativeRaw: null, networkFeeUsdt: null, blockNumber: null, blockHash: null, slot: null,
            poolStateFingerprint: null, quotedAt: new Date(), requestMs: Date.now() - startedAt, status: "FAILED",
            failureCode: identityMismatch ? "POOL_IDENTITY_MISMATCH" : unsupportedToken ? error.failureCode : "EXACT_IN_QUOTE_FAILED", failureReason, rawResponse: null,
          })) return;
          if (identityMismatch || unsupportedToken || Date.now() < adapterState.retryAt) break;
        }
        if (observed && (!adapterOwnsPoolState || (adapterState.watchStatus === "healthy" && adapterState.watchGeneration === watchGeneration))) {
          await this.recordObserveDecision(route, scanId, size, direction, observed.quoteId, observed.quote, state, targetShares, watchGeneration);
        }
      }
    } catch (error) {
      const identityMismatch = error instanceof PoolIdentityMismatchError;
      const unsupportedToken = error instanceof UnsupportedTokenError;
      const failureReason = messageOf(error);
      if (identityMismatch) adapterState.identityMismatch = true;
      else {
        adapterState.retryAt = Date.now() + adapterState.retryDelayMs;
        adapterState.retryDelayMs = Math.min(adapterState.retryDelayMs * 2, 30_000);
        route.dueAt = Math.min(route.dueAt, adapterState.retryAt);
      }
      this.options.onHealth(pool.id, identityMismatch ? "invalid" : "unavailable", failureReason);
      const hasMarginalPrice = !!poolStatus.marginalPrice;
      const directions: Direction[] = ["dex_buy_cex_sell", ...(hasMarginalPrice ? ["cex_buy_dex_sell" as const] : [])];
      await Promise.all(directions.map((direction) => persist({
        scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, dex: pool.dex, direction,
        amountInRaw: null, amountOutRaw: null, minimumAmountOutRaw: null, priceImpactPercent: null,
        networkFeeNativeRaw: null, networkFeeUsdt: null, blockNumber: null, blockHash: null, slot: null,
        poolStateFingerprint: null, quotedAt: new Date(), requestMs: Date.now() - startedAt, status: "FAILED",
        failureCode: identityMismatch ? "POOL_IDENTITY_MISMATCH" : unsupportedToken ? error.failureCode : "EXACT_IN_QUOTE_FAILED", failureReason, rawResponse: null,
      })));
    }
  }


  private async previewWrapper(
    pool: RegisteredPool, method: "previewDeposit" | "previewMint" | "previewRedeem", amountRaw: bigint, blockNumber?: bigint,
  ): Promise<bigint> {
    const wrapper = this.wrappers.get(pool.id);
    if (!wrapper) throw new Error("X Layer wrapper adapter is unavailable");
    if (wrapper.identityMismatch) throw new PoolIdentityMismatchError("X Layer wrapper identity failed; restart after registry review");
    if (wrapper.retryAt > Date.now()) throw new Error("X Layer wrapper preview is in retry backoff");
    try {
      if (!wrapper.verified) {
        await wrapper.adapter.verify();
        wrapper.verified = true;
      }
      const result = await wrapper.adapter[method](amountRaw, blockNumber);
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


  private async recordObserveDecision(route: ObserveRoute, scanId: string, size: number, direction: Direction, quoteId: number, quote: ExactInQuote, initial: MarketSnapshot, intendedCexShares: Decimal | null, watchGeneration: number): Promise<void> {
    const { asset, pool } = route;
    const adapterState = this.adapters.get(pool.id)!;
    const adapterOwnsPoolState = adapterState.adapter.stateSource === "adapter_watch";
    if (adapterOwnsPoolState && (adapterState.watchStatus !== "healthy" || adapterState.watchGeneration !== watchGeneration)) return;
    let cexShares: Decimal | null = null;
    let cexFill: ReturnType<typeof vwap> = null;
    let cexFee: Decimal | null = null;
    let gross: Decimal | null = null;
    let net: Decimal | null = null;
    let invested: Decimal | null = null;
    let calculation: ReturnType<typeof calculateProfit> | null = null;
    const gasBudget = new Decimal(pool.chain === "solana" ? this.options.observationGas.solanaSwapGasUsdt
      : direction === "cex_buy_dex_sell" ? this.options.observationGas.xlayerWrapThenSwapGasUsdt : this.options.observationGas.xlayerSwapThenUnwrapGasUsdt);
    const rebalanceCost = asset.rebalanceCostUsdtPerTrade === undefined ? null : new Decimal(asset.rebalanceCostUsdtPerTrade);
    let conversion: Record<string, string> = {};
    let underlyingRaw = direction === "cex_buy_dex_sell" ? quote.amountInRaw : quote.amountOutRaw;
    let reason: string | null = null;
    const poolAssetRaw = underlyingRaw;
    if (pool.reason === "wrapper_required") {
      const wrapperMethod = direction === "cex_buy_dex_sell" ? "previewMint" : "previewRedeem";
      try {
        underlyingRaw = await this.previewWrapper(pool, wrapperMethod, poolAssetRaw, quote.version.blockNumber);
        conversion = { method: wrapperMethod, wrapperAmountRaw: poolAssetRaw.toString(), underlyingAmountRaw: underlyingRaw.toString() };
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
    if (!reason) {
      if (!book?.ready) reason = "CEX_BOOK_UNAVAILABLE";
      else if (bookObservationStale(book)) reason = "CEX_BOOK_STALE";
      else if (!instrument) reason = "CEX_INSTRUMENT_UNAVAILABLE";
      else if (!feeRate?.isFinite() || feeRate.lt(0)) reason = "CEX_FEE_UNAVAILABLE";
      else if (initial.instrument && (current.instrument?.instId !== initial.instrument.instId || current.instrument.lotSz !== initial.instrument.lotSz || current.instrument.minSz !== initial.instrument.minSz)) reason = "CEX_INSTRUMENT_CHANGED";
      else if (initial.feeRate && !current.feeRate?.eq(initial.feeRate)) reason = "CEX_FEE_CHANGED";
    }
    if (!reason) {
      const convertedCexShares = new Decimal(underlyingRaw.toString()).div(new Decimal(10).pow(asset.tokenDecimals)).mul(quote.assetUiMultiplier);
      if (pool.reason === "wrapper_required" && direction === "cex_buy_dex_sell") {
        if (!intendedCexShares) reason = "CEX_SIZE_UNAVAILABLE";
        else if (convertedCexShares.gt(intendedCexShares)) reason = "WRAPPER_MINT_EXCEEDS_CEX_INPUT";
        else cexShares = intendedCexShares;
      } else cexShares = floorToStep(convertedCexShares, instrument!.lotSz);
    }
    if (!reason && !cexShares) reason = "CEX_SIZE_UNAVAILABLE";
    if (!reason && cexShares) {
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
          calculation = calculateProfit({
            direction, cexNotionalUsdt: cexFill.notional, dexQuoteAmountUsdt: quoteAmount, valuationStatus: "ASSUMED",
            costs: [
              { kind: "cex_fee", amountUsdt: cexFee, source: "cex_fee_rate" },
              { kind: "network_fee", amountUsdt: gasBudget, source: "config.direct_pool_observation" },
              ...(rebalanceCost === null ? [] : [{ kind: "rebalance" as const, amountUsdt: rebalanceCost, source: "config.rebalanceCostUsdtPerTrade" }]),
            ],
          });
          gross = calculation.grossProfitUsdt;
          net = calculation.netProfitUsdt;
          invested = calculation.investedUsdt;
          if (calculation.uncomputableReason) reason = `PROFIT_CALCULATION_${calculation.uncomputableReason}`;
        }
      }
    }
    const highImpact = new Decimal(quote.priceImpactPercent).abs().gt(this.options.guardrails.maxDexPriceImpactPercent);
    const simulation = await this.simulateObservedSwap(route, direction, size, quote, net, invested, reason, highImpact);
    if (adapterOwnsPoolState && (adapterState.watchStatus !== "healthy" || adapterState.watchGeneration !== watchGeneration)) return;
    const cexSnapshot = cexFill && cexShares ? {
      side: direction === "cex_buy_dex_sell" ? "asks" : "bids",
      quantity: cexShares.toString(),
      feeRate: feeRate!.toString(),
      consumedLevels: consumedBookLevels(direction === "cex_buy_dex_sell" ? book!.asks : book!.bids, cexShares),
    } : null;
    await saveDirectPoolDecision({
      scanId, instrumentId: pool.instrument_id, chainIndex: asset.chainIndex, poolId: pool.id, direction, sizeUsdt: String(size),
      selectedQuoteId: quoteId, cexBookAt: book ? new Date(book.exchangeTime) : null, cexReceivedAt: book ? new Date(book.receivedAt) : null,
      cexSeqId: book?.seqId ?? null, cexBid: book?.bids[0]?.price ?? null, cexAsk: book?.asks[0]?.price ?? null,
      cexVwap: cexFill?.vwap.toString() ?? null, cexFeeUsdt: cexFee?.toString() ?? null,
      dexNetworkFeeUsdt: null, gasBudgetUsdt: gasBudget.toString(),
      valuationInputs: { quoteMint: pool.token_in_out.quote_address, quoteToUsdt: "ASSUMED_1_TO_1", wrapper: conversion, cex: cexSnapshot, cexBookLiveness: book ? { receivedAt: book.receivedAt, exchangeTime: book.exchangeTime, streamAliveAt: book.streamAliveAt ?? null } : null, assetUiMultiplier: quote.assetUiMultiplier, backedMultiplierApplied: pool.chain === "xlayer" ? null : "1", gasBudgetUsdt: gasBudget.toString(), gasSource: "config.direct_pool_observation", rebalanceCostUsdt: rebalanceCost?.toString() ?? null, costBreakdown: calculation?.costBreakdown ?? [], calculationReasonCode: calculation?.uncomputableReason ?? null, priceImpactPercent: quote.priceImpactPercent },
      grossProfitUsdt: gross?.toString() ?? null, netProfitUsdt: net?.toString() ?? null,
      roi: calculation?.roi?.toString() ?? null,
      valuationStatus: "ASSUMED_1_TO_1",
      decisionStatus: reason ? "BLOCKED" : highImpact ? "HIGH_PRICE_IMPACT" : "OBSERVED",
      blockReason: reason ?? (highImpact ? "PRICE_IMPACT_OVER_LIMIT_OBSERVATION_ONLY" : null),
      simulationStatus: simulation.status, simulationReason: simulation.reason,
      simulationAt: simulation.at, simulationInputDebitedRaw: simulation.inputDebitedRaw ?? null,
      simulationOutputCreditedRaw: simulation.outputCreditedRaw ?? null,
      simulationNetworkFeeNativeRaw: simulation.networkFeeNativeRaw ?? null,
      simulationComputeUnits: simulation.computeUnits ?? null,
    }).catch((error) => { this.options.onDatabaseError(error); });
  }


  private async simulateObservedSwap(
    route: ObserveRoute, direction: Direction, size: number, quote: ExactInQuote, net: Decimal | null, invested: Decimal | null,
    blockReason: string | null, highImpact: boolean,
  ): Promise<SimulationOutcome> {
    const { pool, asset } = route;
    const adapterState = this.adapters.get(pool.id)!;
    if (adapterState.adapter.stateSource === "adapter_watch" && adapterState.watchStatus !== "healthy") return { status: "SKIPPED", reason: "POOL_WATCH_UNAVAILABLE", at: null };
    if (pool.chain !== "solana" || pool.mode !== "observe_only" || !pool.verified
      || this.options.registry.dexes[pool.dex]?.chain !== "solana" || !this.adapters.has(pool.id)) {
      return { status: "NOT_APPLICABLE", reason: null, at: null };
    }
    if (!this.options.observationGas.simulationEnabled) return { status: "DISABLED", reason: null, at: null };
    if (blockReason) return { status: "NOT_QUALIFIED", reason: blockReason, at: null };
    if (highImpact) return { status: "NOT_QUALIFIED", reason: "PRICE_IMPACT_OVER_LIMIT", at: null };
    if (!net || !invested || !netMarginOk(net, invested)) {
      return { status: "NOT_QUALIFIED", reason: "NET_MARGIN_BELOW_1_PERCENT", at: null };
    }
    if (Date.now() - quote.quotedAt > asset.dexQuoteIntervalMs) {
      return { status: "SKIPPED", reason: "QUOTE_STALE", at: null };
    }
    const cooldownKey = `${pool.id}:${direction}:${new Decimal(size).toString()}`;
    const now = Date.now();
    if (now - (this.lastSimulationAt.get(cooldownKey) ?? Number.NEGATIVE_INFINITY) < 30_000) {
      return { status: "COOLDOWN", reason: "SIMULATION_COOLDOWN_30_SECONDS", at: null };
    }
    this.lastSimulationAt.set(cooldownKey, now);
    let signer: Keypair;
    try { signer = parseSolanaSimulationSigner(this.options.solanaSimulationPrivateKey); }
    catch { return { status: "SKIPPED", reason: "SOLANA_SIGNER_UNAVAILABLE", at: null };
    }
    const adapter = this.adapters.get(pool.id)?.adapter;
    if (!adapter) return { status: "SKIPPED", reason: "POOL_ADAPTER_UNAVAILABLE", at: null };
    const at = new Date();
    try {
      const swap = await adapter.buildSwap(pool, { quote, wallet: signer.publicKey.toBase58(), simulationOnly: true });
      if (adapterState.adapter.stateSource === "adapter_watch" && adapterState.watchStatus !== "healthy") return { status: "SKIPPED", reason: "POOL_WATCH_UNAVAILABLE", at: null };
      const result = await adapter.simulateSwap(pool, swap, signer);
      return {
        status: result.ok ? "PASSED" : result.skipped ? "SKIPPED" : "FAILED",
        reason: result.ok ? null : result.error ?? "SIMULATION_FAILED", at,
        inputDebitedRaw: result.amountInDebitedRaw,
        outputCreditedRaw: result.amountOutCreditedRaw,
        networkFeeNativeRaw: result.networkFeeNativeRaw,
        computeUnits: result.computeUnits,
      };
    } catch (error) {
      return { status: "FAILED", reason: messageOf(error), at };
    }
  }

}

export function logSolanaQuote(pool: RegisteredPool, scanId: string, quoteId: number, direction: Direction, quote: ExactInQuote, requestMs: number): void {
  if (pool.chain !== "solana") return;
  const key = `${pool.id}/${direction}`;
  const signature = `${quote.amountInRaw}/${quote.amountOutRaw}`;
  const now = Date.now();
  const previous = lastSolanaQuoteLogs.get(key);
  if (previous && now - previous.loggedAt < solanaQuoteLogHeartbeatMs) {
    if (signature !== previous.signature) previous.changed = true;
    previous.suppressed++;
    return;
  }
  const changed = previous?.changed || previous?.signature !== signature;
  const reason = !previous ? "initial" : changed ? "quote_changed" : "heartbeat";
  const suppressed = previous?.suppressed ?? 0;
  lastSolanaQuoteLogs.set(key, { signature, loggedAt: now, suppressed: 0, changed: false });
  logger.info(`[solana-quote] scan_id=${scanId} quote_id=${quoteId} pool_id=${pool.id} dex=${pool.dex} direction=${direction} log_reason=${reason} suppressed=${suppressed} amount_in_raw=${quote.amountInRaw} amount_out_raw=${quote.amountOutRaw} quote_slot=${quote.version.slot?.toString() ?? "unknown"} state_fingerprint=${quote.version.stateFingerprint ?? "unknown"} quoted_at=${new Date(quote.quotedAt).toISOString()} request_ms=${requestMs}`);
}

function parseSolanaSimulationSigner(secret: string): Keypair {
  const value = secret.trim();
  if (!value) throw new Error("Solana simulation signer is not configured");
  const bytes = value.startsWith("[") ? Uint8Array.from(JSON.parse(value) as number[]) : bs58.decode(value);
  return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
}

function consumedBookLevels(levels: Book["asks"], quantity: Decimal): Array<{ price: string; size: string }> {
  let remaining = quantity;
  const consumed: Array<{ price: string; size: string }> = [];
  for (const level of levels) {
    if (remaining.lte(0)) break;
    const size = Decimal.min(remaining, new Decimal(level.size));
    if (size.lte(0)) continue;
    consumed.push({ price: level.price, size: size.toString() });
    remaining = remaining.minus(size);
  }
  return consumed;
}
