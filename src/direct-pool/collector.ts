import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { AssetConfig } from "../config.js";
import { bookStale, floorToStep, vwap } from "../market/market.js";
import { calculateProfit } from "../market/profit-calculation.js";
import { saveDirectPoolDecision, saveDirectPoolQuote } from "./storage.js";
import { createPoolAdapter } from "./pool-adapter-factory.js";
import { PoolIdentityMismatchError, UnsupportedTokenError, type ExactInQuote } from "./pool-adapters.js";
import { solveDirectPoolCandidates, type RegisteredPool } from "./market-registry.js";
import { poolStateView } from "./pool-state.js";
import { ObserveOnlyCollector, directDirection, logSolanaQuote, messageOf, rawAmount, type AdapterState, type MarketSnapshot, type ScanOptions } from "./observe-only-collector.js";

type Route = { asset: AssetConfig; pools: RegisteredPool[]; sizeIndex: number; dueAt: number; lastScanAt: number; running: boolean };

export class DirectPoolCollector {
  private readonly routes = new Map<string, Route>();
  private readonly adapters = new Map<string, AdapterState>();
  private readonly watchRoutes = new Map<string, { asset: AssetConfig; pool: RegisteredPool }>();
  private readonly observeOnly: ObserveOnlyCollector;

  constructor(private readonly options: ScanOptions) {
    this.observeOnly = new ObserveOnlyCollector(options, this.adapters);
    for (const pool of solveDirectPoolCandidates(options.registry, options.assets)) {
      const instrument = options.registry.instruments.find((item) => item.instrument_id === pool.instrument_id)!;
      const listing = instrument.cex_listings.find((item) => item.venue === "okx")!;
      const asset = options.assets.find((item) => item.instId === listing.symbol && item.okxCurrency === listing.currency && item.chainIndex === options.registry.chains[pool.chain].chain_id.toString());
      if (!asset) continue;
      const key = routeKey(asset);
      let route = this.routes.get(key);
      if (!route) { route = { asset, pools: [], sizeIndex: 0, dueAt: Date.now() + options.coalesceWindowMs, lastScanAt: Number.NEGATIVE_INFINITY, running: false }; this.routes.set(key, route); }
      route.pools.push(pool);
      const adapter = createPoolAdapter(pool, options.registry);
      this.adapters.set(pool.id, { adapter, verified: false, identityMismatch: false, retryAt: 0, retryDelayMs: 1_000, watchStatus: adapter.stateSource === "adapter_watch" ? "unavailable" : "not_required", watchGeneration: 0 });
      if (adapter.stateSource === "adapter_watch") this.watchRoutes.set(pool.id, { asset, pool });
    }
    for (const route of this.routes.values()) route.pools.sort((a, b) => a.priority! - b.priority!);
    for (const route of this.observeOnly.registerRoutes()) {
      if (this.adapters.get(route.pool.id)!.adapter.stateSource === "adapter_watch") this.watchRoutes.set(route.pool.id, { asset: route.asset, pool: route.pool });
    }
  }

  markDirty(instId?: string, chainIndex?: string): void {
    const now = Date.now();
    for (const route of this.routes.values()) {
      if (instId && route.asset.instId !== instId) continue;
      if (chainIndex && route.asset.chainIndex !== chainIndex) continue;
      route.dueAt = Math.min(route.dueAt, Math.max(now + this.options.coalesceWindowMs, route.lastScanAt + route.asset.dexQuoteIntervalMs));
    }
    this.observeOnly.markDirty(instId, chainIndex, now);
  }

  async startAdapterWatches(): Promise<() => Promise<void>> {
    const stops: Array<() => Promise<void>> = [];
    for (const route of this.watchRoutes.values()) {
      const state = this.adapters.get(route.pool.id)!;
      if (state.adapter.stateSource !== "adapter_watch" || !state.adapter.watch) throw new Error(`Pool ${route.pool.id} requires an adapter-owned watch`);
      try {
        stops.push(await state.adapter.watch(route.pool, {
          onState: (snapshot) => {
            state.watchGeneration++;
            state.watchStatus = "healthy";
            state.verified = true;
            state.identityMismatch = false;
            state.retryAt = 0;
            state.retryDelayMs = 1_000;
            state.marginalPrice = snapshot.marginalPrice;
            state.watchError = undefined;
            this.options.onPoolState(route.pool.id, { kind: "snapshot", snapshot });
            this.options.onHealth(route.pool.id, "healthy");
            this.markDirty(route.asset.instId, route.asset.chainIndex);
          },
          onUnavailable: (reason, identityMismatch = false) => {
            state.watchGeneration++;
            state.watchStatus = "unavailable";
            state.marginalPrice = undefined;
            state.watchError = reason;
            if (identityMismatch) state.identityMismatch = true;
            this.options.onPoolState(route.pool.id, { kind: "unavailable", reason, identityMismatch });
            this.options.onHealth(route.pool.id, identityMismatch ? "invalid" : "unavailable", reason);
          },
        }));
      } catch (error) {
        const identityMismatch = error instanceof PoolIdentityMismatchError;
        state.watchStatus = "unavailable";
        state.marginalPrice = undefined;
        state.watchError = messageOf(error);
        state.identityMismatch = identityMismatch;
        this.options.onPoolState(route.pool.id, { kind: "unavailable", reason: state.watchError, identityMismatch });
        this.options.onHealth(route.pool.id, identityMismatch ? "invalid" : "unavailable", messageOf(error));
      }
    }
    return async () => { await Promise.all(stops.map((stop) => stop())); };
  }

  async runDue(now = Date.now()): Promise<void> {
    await Promise.all([
      ...[...this.routes.values()].map(async (route) => {
      if (route.running || route.dueAt > now) return;
      route.running = true;
      route.lastScanAt = now;
      route.dueAt = Number.POSITIVE_INFINITY;
      try { await this.scan(route); }
      finally { route.running = false; }
      }),
      this.observeOnly.runDue(now),
    ]);
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
      let bestQuote: { quoteId: number; poolId: string; quote: ExactInQuote; calculation: ReturnType<typeof calculateProfit>; cexVwap: Decimal; cexFee: Decimal } | undefined;
      let blockReason = "NO_VALID_POOL_QUOTE";
      const attempts: string[] = [];
      for (const pool of route.pools) {
        const adapterState = this.adapters.get(pool.id)!;
        const state = this.options.getState(asset, pool);
        const poolStatus = poolStateView(adapterState, state.pool);
        const adapterOwnsPoolState = adapterState.adapter.stateSource === "adapter_watch";
        const watchGeneration = adapterState.watchGeneration;
        const poolHealthy = poolStatus.healthy;
        if (adapterState.identityMismatch) { blockReason = "POOL_IDENTITY_MISMATCH_REARM_REQUIRED"; attempts.push(`${pool.id}:identity_mismatch`); continue; }
        if (!poolHealthy) { blockReason = poolStatus.error ? "POOL_STATE_UNHEALTHY" : "POOL_NOT_READY"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
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
          const quote = await adapterState.adapter.quoteExactIn(pool, {
            direction: directDirection(direction), amountInRaw, slippageBps: this.options.slippageBps ?? 50,
            xlayerSnapshot: pool.chain === "xlayer" && state.pool ? state.pool : undefined,
          });
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
          logSolanaQuote(pool, scanId, quoteId, direction, quote, requestMs);
          if (adapterOwnsPoolState && (adapterState.watchStatus !== "healthy" || adapterState.watchGeneration !== watchGeneration)) {
            blockReason = "POOL_STATE_CHANGED";
            attempts.push(`${pool.id}:pool_state_changed`);
            continue;
          }
          const latest = this.options.getState(asset, pool);
          if (!latest.book?.ready || bookStale(latest.book) || latest.book.seqId !== book.seqId) { blockReason = "CEX_BOOK_CHANGED_OR_STALE"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          if (latest.quoteValuationStatus !== "VERIFIED") { blockReason = "QUOTE_VALUATION_UNKNOWN"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          if (new Decimal(quote.priceImpactPercent).abs().gt(this.options.guardrails.maxDexPriceImpactPercent)) { blockReason = "PRICE_IMPACT_LIMIT"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          if (quote.networkFeeUsdt === null) { blockReason = "NETWORK_FEE_UNKNOWN"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          const dexQuoteAmount = new Decimal((direction === "cex_buy_dex_sell" ? quote.amountOutRaw : quote.amountInRaw).toString()).div(new Decimal(10).pow(asset.quoteTokenDecimals));
          const dexAssetAmount = new Decimal((direction === "cex_buy_dex_sell" ? quote.amountInRaw : quote.amountOutRaw).toString()).div(new Decimal(10).pow(asset.tokenDecimals));
          const cexShares = direction === "cex_buy_dex_sell" ? targetShares : floorToStep(dexAssetAmount.mul(multiplier), instrument.lotSz);
          const fill = direction === "cex_buy_dex_sell" ? askFill : vwap(book.bids, cexShares);
          if (!fill || cexShares.lt(instrument.minSz)) { blockReason = "CEX_DEPTH_INSUFFICIENT"; attempts.push(`${pool.id}:${blockReason.toLowerCase()}`); continue; }
          const cexFee = fill.notional.mul(feeRate);
          const rebalanceCost = asset.rebalanceCostUsdtPerTrade === undefined ? null : new Decimal(asset.rebalanceCostUsdtPerTrade);
          const calculation = calculateProfit({
            direction, cexNotionalUsdt: fill.notional, dexQuoteAmountUsdt: dexQuoteAmount, valuationStatus: "VERIFIED",
            costs: [
              { kind: "cex_fee", amountUsdt: cexFee, source: "cex_fee_rate" },
              { kind: "network_fee", amountUsdt: new Decimal(quote.networkFeeUsdt), source: "adapter_network_fee_quote" },
              ...(rebalanceCost === null ? [] : [{ kind: "rebalance" as const, amountUsdt: rebalanceCost, source: "config.rebalanceCostUsdtPerTrade" }]),
            ],
          });
          const gross = calculation.grossProfitUsdt;
          const net = calculation.netProfitUsdt;
          if (calculation.uncomputableReason || !gross || !net) {
            blockReason = `PROFIT_CALCULATION_${calculation.uncomputableReason ?? "UNAVAILABLE"}`;
            attempts.push(`${pool.id}:${blockReason.toLowerCase()}`);
            continue;
          }
          if (net.gt(0)) { bestQuote = { quoteId, poolId: pool.id, quote, calculation, cexVwap: fill.vwap, cexFee }; blockReason = "SELECTED"; break; }
          if (!bestQuote || net.gt(bestQuote.calculation.netProfitUsdt!)) bestQuote = { quoteId, poolId: pool.id, quote, calculation, cexVwap: fill.vwap, cexFee };
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
            route.dueAt = Math.min(route.dueAt, adapterState.retryAt);
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
      const selectedId = bestQuote?.quoteId ?? null;
      const shares = bestQuote ? (direction === "cex_buy_dex_sell" ? targetShares : new Decimal(bestQuote.quote.amountOutRaw.toString()).div(new Decimal(10).pow(asset.tokenDecimals)).mul(multiplier)) : direction === "cex_buy_dex_sell" ? targetShares : null;
      const cexFill = shares === null ? null : vwap(direction === "cex_buy_dex_sell" ? book.asks : book.bids, shares);
      const cexFee = cexFill && feeRate ? cexFill.notional.mul(feeRate) : null;
      const profitable = bestQuote?.calculation.netProfitUsdt?.gt(0) ?? false;
      const noOpportunity = bestQuote !== undefined || blockReason === "NO_NET_OPPORTUNITY";
      const decisionStatus = profitable ? "SELECTED" : noOpportunity ? "NO_OPPORTUNITY" : "BLOCKED";
      const decisionReason = profitable ? null : noOpportunity
        ? attempts.length ? `NO_NET_OPPORTUNITY: ${attempts.join(", ")}` : "NO_NET_OPPORTUNITY"
        : attempts.length ? `${blockReason}: ${attempts.join(", ")}` : blockReason;
      try {
        await saveDirectPoolDecision({
          scanId, instrumentId: route.pools[0]!.instrument_id, chainIndex: asset.chainIndex, poolId: bestQuote?.poolId ?? (route.pools.length === 1 ? route.pools[0]!.id : null), direction, sizeUsdt: String(size),
          selectedQuoteId: selectedId, cexBookAt: new Date(book.exchangeTime), cexReceivedAt: new Date(book.receivedAt), cexSeqId: book.seqId,
          cexBid: book.bids[0]?.price ?? null, cexAsk: book.asks[0]?.price ?? null, cexVwap: bestQuote?.cexVwap.toString() ?? cexFill?.vwap.toString() ?? null,
          cexFeeUsdt: bestQuote?.cexFee.toString() ?? cexFee?.toString() ?? null, dexNetworkFeeUsdt: bestQuote?.quote.networkFeeUsdt ?? null, gasBudgetUsdt: null,
          valuationInputs: { quoteValuationStatus: current.quoteValuationStatus, attempts, costBreakdown: bestQuote?.calculation.costBreakdown ?? [] },
          grossProfitUsdt: bestQuote?.calculation.grossProfitUsdt?.toString() ?? null,
          netProfitUsdt: bestQuote?.calculation.netProfitUsdt?.toString() ?? null, roi: bestQuote?.calculation.roi?.toString() ?? null,
          valuationStatus: current.quoteValuationStatus, decisionStatus, blockReason: decisionReason,
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
