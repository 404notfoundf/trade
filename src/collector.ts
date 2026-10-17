import Decimal from "decimal.js";
import type { AssetConfig, Config } from "./config.js";
import { bookMidpoint, bookObservationStale, bookStale, floorToStep, MAX_BOOK_AGE_MS, MAX_BOOK_STREAM_SILENCE_MS, vwap, type Instrument } from "./market.js";
import { dexQuote, reserveDexRequestSlot, type Book, type Credentials, type DexQuoteTiming } from "./okx.js";
import { decideValuation, XLAYER_CHAIN } from "./valuation.js";
import { calculateProfit } from "./profit-calculation.js";
import { closeOpportunityWindow, saveQuoteObservations, type QuoteObservation } from "./observations.js";
import { recordBlockedObservation, type BlockedObservation } from "./risk.js";

type MultiplierResponse = { currentMultiplier?: number | string; multiplier?: number | string; data?: { currentMultiplier?: number | string; multiplier?: number | string } };
type DexQuote = {
  chainIndex: string;
  fromTokenAmount: string;
  toTokenAmount: string;
  fromToken: { tokenContractAddress: string; decimal?: string; tokenUnitPrice?: string | null; taxRate?: string | number | null; isHoneyPot?: boolean };
  toToken: { tokenContractAddress: string; decimal?: string; tokenUnitPrice?: string | null; taxRate?: string | number | null; isHoneyPot?: boolean };
  priceImpactPercentage?: string | number | null;
  priceImpactPercent?: string | null;
  tradeFee?: string;
  estimateGasFee?: string;
  dexRouterList: unknown[];
};
type CollectorState = { instrument?: Instrument; feeRate?: Decimal; multiplier?: Decimal; multiplierRaw?: MultiplierResponse; book?: Book; dbOnline: boolean; routeStatus: "ENABLED" | "MONITOR_ONLY" | "BLOCKED"; routeReason?: string | null };
type CollectorOptions = {
  asset: AssetConfig;
  initialDelayMs?: number;
  guardrails: Config["runtime"]["guardrails"];
  dexCredentials: Credentials;
  getState: () => CollectorState;
  tradingStatus: () => "DISABLED" | "UNARMED" | "ARMED";
  checkInventory?: (row: QuoteObservation) => Promise<string | null>;
  setHealth: (dependency: string, status: string, error?: string | null) => void;
  onRouteBlocked: (reason: string) => void;
  onDatabaseError: (error: unknown) => void;
};

const decimals = (amount: Decimal, places: number) => amount.mul(new Decimal(10).pow(places)).floor().toFixed(0);
const messageOf = (error: unknown) => error instanceof Error ? error.message : "unknown error";

export class OpportunityCollector {
  private lastQuoteAt: number;
  private sizeScanIndex = 0;
  private collecting = false;
  private guardEventAt = new Map<string, number>();
  private routeWasBlocked = false;
  private lastUnavailable: string | null = null;

  constructor(private readonly options: CollectorOptions) {
    this.lastQuoteAt = Date.now() + (options.initialDelayMs ?? 0) - options.asset.dexQuoteIntervalMs;
  }

  async collect(): Promise<void> {
    const { asset, guardrails, dexCredentials, getState, setHealth, onDatabaseError, onRouteBlocked } = this.options;
    const state = getState();
    const { instrument, feeRate, multiplier, multiplierRaw, book } = state;
    const credentialsReady = [dexCredentials.key, dexCredentials.secret, dexCredentials.passphrase].every(Boolean);
    if (state.routeStatus === "BLOCKED") {
      if (!this.routeWasBlocked && state.dbOnline) await closeOpportunityWindow(asset.instId, asset.chainIndex, "ROUTE_BLOCKED");
      this.routeWasBlocked = true;
      return;
    }
    this.routeWasBlocked = false;
    if (this.collecting || !state.dbOnline) return;
    const unavailable = !credentialsReady ? "DEX_CREDENTIALS_MISSING" : !instrument ? "CEX_INSTRUMENT_UNAVAILABLE" : !feeRate ? "CEX_FEE_UNAVAILABLE" : !multiplier ? "MULTIPLIER_UNAVAILABLE" : !book?.ready ? "CEX_BOOK_UNAVAILABLE" : null;
    if (unavailable) {
      if (this.lastUnavailable !== unavailable) await closeOpportunityWindow(asset.instId, asset.chainIndex, unavailable);
      this.lastUnavailable = unavailable;
      return;
    }
    this.lastUnavailable = null;
    if (!instrument || !feeRate || !multiplier || !book?.ready) return;
    if (Date.now() - this.lastQuoteAt < asset.dexQuoteIntervalMs) return;
    this.lastQuoteAt = Date.now();
    this.collecting = true;
    try {
      const stale = bookObservationStale(book);
      if (stale) {
        const reason = `OKX order book stream is stale; ${bookFreshnessDetails(book)}`;
        setHealth("cex_book", "stale", reason);
        for (const size of asset.observationSizesUsdt) await this.recordBlock({ instId: asset.instId, chainIndex: asset.chainIndex, sizeUsdt: size, reasonCode: "CEX_BOOK_STALE", reason, cexTs: new Date(book.exchangeTime), quoteResponse: bookDiagnostic(book) });
        return;
      }
      setHealth("cex_book", "healthy");
      const scanSize = asset.observationSizesUsdt[this.sizeScanIndex]!;
      this.sizeScanIndex = (this.sizeScanIndex + 1) % asset.observationSizesUsdt.length;
      let guardrailBlocked = false;
      let multiplierChanged = false;
      for (const size of [scanSize]) {
        if (getState().routeStatus === "BLOCKED" || multiplierChanged) break;
        const sizingBook = getState().book;
        if (!sizingBook?.ready || bookObservationStale(sizingBook)) {
          const reason = `OKX order book ${sizingBook ? "not ready or stale" : "missing"}; ${bookFreshnessDetails(sizingBook)}`;
          setHealth("cex_book", "stale", reason);
          await this.recordBlock({ instId: asset.instId, chainIndex: asset.chainIndex, sizeUsdt: size, reasonCode: "CEX_BOOK_STALE", reason, cexTs: sizingBook ? new Date(sizingBook.exchangeTime) : null, quoteResponse: sizingBook ? bookDiagnostic(sizingBook) : null });
          continue;
        }
        const sizeMidpoint = bookMidpoint(sizingBook);
        const desiredShares = floorToStep(new Decimal(size).div(sizeMidpoint), instrument.lotSz);
        if (desiredShares.lt(instrument.minSz)) continue;
        if (!vwap(sizingBook.asks, desiredShares) || !vwap(sizingBook.bids, desiredShares)) {
          const reason = `Insufficient OKX order book depth for ${size} USDT`;
          setHealth("cex_depth", "insufficient_depth", reason);
          await this.recordBlock({ instId: asset.instId, chainIndex: asset.chainIndex, sizeUsdt: size, reasonCode: "CEX_DEPTH_INSUFFICIENT", reason, cexTs: new Date(sizingBook.exchangeTime), quoteResponse: bookDiagnostic(sizingBook) });
          continue;
        }
        setHealth("cex_depth", "healthy");
        const tokenAmount = desiredShares.div(multiplier);
        const common = { chainIndex: asset.chainIndex, swapMode: "exactIn" };
        const rawQuotes: unknown[] = [];
        const observations: QuoteObservation[] = [];
        const capture = async (direction: string, from: string, to: string, amount: string, reserved: Promise<void>, build: (quote: DexQuote, currentBook: Book, timing: DexQuoteTiming) => Promise<QuoteObservation>) => {
          try {
            if (multiplierChanged) { observations.length = 0; return; }
            const currentState = () => {
              const current = getState();
              if (current.routeStatus === "BLOCKED") { observations.length = 0; return null; }
              if (!current.multiplier || !current.multiplier.eq(multiplier)) throw new BlockedScanError("MULTIPLIER_CHANGED", "Multiplier changed during quote scan; stale observation discarded");
              return current;
            };
            if (!currentState()) return;
            const { data: response, ...timing } = await dexQuote<DexQuote[]>(new URLSearchParams({ ...common, fromTokenAddress: from, toTokenAddress: to, amount }), dexCredentials, reserved);
            const { requestMs } = timing;
            const quote = response[0]; rawQuotes.push({ quote: quote ?? response, ...timing });
            if (requestMs > 2000) throw new BlockedScanError("DEX_QUOTE_SLOW", `DEX ${direction} quote took ${requestMs.toFixed(0)} ms`);
            if (!currentState()) return;
            const identityError = quoteIdentityMismatch(quote, asset, from, to);
            if (identityError) { observations.length = 0; onRouteBlocked(identityError); throw new BlockedScanError("TOKEN_IDENTITY_MISMATCH", identityError); }
            if (!validQuote(quote, asset, from, to, amount)) throw new BlockedScanError("DEX_QUOTE_INVALID", `DEX ${direction} quote missing, amount or token address mismatch`);
            if (quote.fromToken.isHoneyPot || quote.toToken.isHoneyPot || [quote.fromToken.taxRate, quote.toToken.taxRate].some((tax) => {
              if (tax === undefined || tax === null) return false;
              const parsed = parseDecimal(tax);
              return !parsed || parsed.isNegative() || parsed.gt(0);
            })) throw new BlockedScanError("TOKEN_TAX_UNSUPPORTED", `DEX ${direction} quote reports a token tax or invalid tax rate`);
            const impact = parseDecimal(quote.priceImpactPercentage ?? quote.priceImpactPercent);
            if (!impact) throw new BlockedScanError("PRICE_IMPACT_UNKNOWN", `DEX ${direction} quote has no usable price impact; positive estimate suppressed`);
            if (impact.abs().gt(guardrails.maxDexPriceImpactPercent)) throw new BlockedScanError("PRICE_IMPACT_LIMIT", `DEX ${direction} price impact ${impact.toString()}% exceeds ${guardrails.maxDexPriceImpactPercent}%`);
            const currentBook = getState().book;
            if (!currentBook?.ready || bookObservationStale(currentBook)) {
              const state = !currentBook ? "missing" : !currentBook.ready ? "not_ready" : "stale";
              throw new BlockedScanError("CEX_BOOK_STALE", `OKX order book ${state} after DEX ${direction} quote; ${bookFreshnessDetails(currentBook)}; dexRequestMs=${timing.requestMs.toFixed(0)}; dexQueueWaitMs=${timing.queueWaitMs.toFixed(0)}`);
            }
            const observation = await build(quote, currentBook, timing);
            const latestState = currentState();
            if (!latestState) return;
            if (bookObservationStale(currentBook)) throw new BlockedScanError("CEX_BOOK_STALE", `OKX order book stream expired during ${direction} valuation; ${bookFreshnessDetails(currentBook)}; dexRequestMs=${timing.requestMs.toFixed(0)}; dexQueueWaitMs=${timing.queueWaitMs.toFixed(0)}`);
            observation.routeStatus = latestState.routeStatus;
            const profit = observation.netProfitAfterRebalanceUsdt ?? observation.netProfitUsdt;
            const buffer = Decimal.max(new Decimal("0.5"), new Decimal(size).mul("0.003"));
            observation.executionBufferUsdt = buffer.toString();
            const tradingStatus = this.options.tradingStatus();
            if (tradingStatus !== "ARMED") {
              observation.executableStatus = "NOT_EVALUATED";
              observation.executionReason = tradingStatus === "DISABLED" ? "Trading module is disabled" : "Automatic trading is not armed";
            } else if (latestState.routeStatus !== "ENABLED") {
              observation.executableStatus = "NOT_EXECUTABLE";
              observation.executionReason = latestState.routeReason ?? "Route is not enabled for transfers";
            } else if (bookStale(currentBook)) {
              observation.executableStatus = "NOT_EXECUTABLE";
              observation.executionReason = `CEX order book data is older than ${MAX_BOOK_AGE_MS} ms`;
            } else if (observation.valuationStatus !== "VERIFIED" || observation.status !== "OK" || !profit || !new Decimal(profit).gt(buffer)) {
              observation.executableStatus = "NOT_EXECUTABLE";
              observation.executionReason = "Net profit does not exceed the execution safety buffer";
            } else {
              observation.executableProfitUsdt = new Decimal(profit).minus(buffer).toString();
              try { observation.executionReason = this.options.checkInventory ? await this.options.checkInventory(observation) ?? "" : "Inventory check is unavailable"; }
              catch (error) { observation.executionReason = `Inventory check failed: ${messageOf(error)}`; }
              if (bookStale(currentBook)) {
                observation.executableStatus = "NOT_EXECUTABLE";
                observation.executionReason = `CEX order book data is older than ${MAX_BOOK_AGE_MS} ms`;
              } else observation.executableStatus = observation.executionReason === "" ? "EXECUTABLE" : "NOT_EXECUTABLE";
            }
            observations.push(observation);
          } catch (error) {
            const blocked = error instanceof BlockedScanError ? error : new BlockedScanError("DEX_QUOTE_UNAVAILABLE", messageOf(error));
            const currentBook = getState().book;
            const event = { instId: asset.instId, chainIndex: asset.chainIndex, direction, sizeUsdt: size, reasonCode: blocked.code, reason: blocked.message, cexTs: currentBook ? new Date(currentBook.exchangeTime) : null, quoteResponse: rawQuotes };
            if (blocked.code === "PRICE_IMPACT_LIMIT" || blocked.code === "PRICE_IMPACT_UNKNOWN") {
              guardrailBlocked = true;
              setHealth(`guardrail_${asset.chainIndex}_${asset.instId}`, "blocked", blocked.message);
              await this.recordGuard(event);
            } else {
              await this.recordBlock(event);
              if (blocked.code === "MULTIPLIER_CHANGED") {
                multiplierChanged = true;
                setHealth(`multiplier_guard_${asset.chainIndex}_${asset.instId}`, "blocked", blocked.message);
              }
            }
            if (blocked.code === "CEX_BOOK_STALE") setHealth("cex_book", "stale", blocked.message);
            else if (blocked.code === "DEX_QUOTE_SLOW") setHealth("dex_quote", "degraded", blocked.message);
            else if (blocked.code !== "MULTIPLIER_CHANGED") setHealth("dex_quote", "unavailable", blocked.message);
          }
        };
        const sellAmount = decimals(tokenAmount, asset.tokenDecimals);
        const buyAmount = decimals(new Decimal(size), asset.quoteTokenDecimals);
        // Both legs claim slots before either request, so index price or the other route cannot cut in.
        const sellSlot = reserveDexRequestSlot();
        const buySlot = reserveDexRequestSlot();
        await capture("cex_buy_dex_sell", asset.tokenAddress, asset.quoteTokenAddress, sellAmount, sellSlot, (quote, currentBook, timing) => {
          const fill = vwap(currentBook.asks, desiredShares);
          if (!fill) throw new BlockedScanError("CEX_DEPTH_INSUFFICIENT", `Insufficient CEX depth to buy ${size} USDT`);
          return makeObservation(asset, "cex_buy_dex_sell", size, desiredShares, fill.vwap, fill.notional, fill.notional.mul(feeRate), feeRate, quote, timing, false, multiplier, multiplierRaw, currentBook, state.routeStatus, guardrails);
        });
        await capture("dex_buy_cex_sell", asset.quoteTokenAddress, asset.tokenAddress, buyAmount, buySlot, (quote, currentBook, timing) => {
          const boughtToken = new Decimal(quote.toTokenAmount).div(new Decimal(10).pow(asset.tokenDecimals));
          const cexShares = floorToStep(boughtToken.mul(multiplier), instrument.lotSz);
          const fill = vwap(currentBook.bids, cexShares);
          if (!fill || cexShares.lt(instrument.minSz)) throw new BlockedScanError("CEX_DEPTH_INSUFFICIENT", "CEX depth is insufficient for DEX buy output");
          return makeObservation(asset, "dex_buy_cex_sell", size, cexShares, fill.vwap, fill.notional, fill.notional.mul(feeRate), feeRate, quote, timing, false, multiplier, multiplierRaw, currentBook, state.routeStatus, guardrails);
        });
        const latestState = getState();
        if (latestState.routeStatus === "BLOCKED" || !latestState.multiplier || !latestState.multiplier.eq(multiplier)) observations.length = 0;
        else for (const observation of observations) observation.routeStatus = latestState.routeStatus;
        if (observations.length) {
          try { await saveQuoteObservations(observations); setHealth("dex_quote", "healthy"); }
          catch (error) { onDatabaseError(error); throw error; }
          setHealth(`multiplier_guard_${asset.chainIndex}_${asset.instId}`, "healthy");
          for (const row of observations) {
            if (!row.valuationReasonCode) continue;
            await this.recordGuard({ instId: asset.instId, chainIndex: asset.chainIndex, direction: row.direction, sizeUsdt: size, reasonCode: row.valuationReasonCode, reason: row.quoteSummary ?? row.valuationReasonCode, cexTs: row.cexTs, quoteResponse: { summary: row.quoteSummary, priceSourceTime: row.priceSourceTime, quote: row.rawResponse } });
          }
        }
      }
      if (!guardrailBlocked) setHealth(`guardrail_${asset.chainIndex}_${asset.instId}`, "healthy");
    } finally {
      this.collecting = false;
    }
  }

  private async recordBlock(event: BlockedObservation): Promise<void> {
    try {
      await recordBlockedObservation(event);
      const routeWide = event.reasonCode === "MULTIPLIER_CHANGED";
      await closeOpportunityWindow(event.instId, event.chainIndex, event.reasonCode, routeWide ? undefined : event.direction, event.direction && !routeWide ? event.sizeUsdt : undefined);
    } catch (error) {
      this.options.onDatabaseError(error);
      throw error;
    }
  }

  private async recordGuard(event: BlockedObservation): Promise<void> {
    const key = `${event.reasonCode}:${event.direction}:${event.sizeUsdt}`;
    const now = Date.now();
    if (now - (this.guardEventAt.get(key) ?? 0) < 60_000) return;
    await this.recordBlock(event);
    this.guardEventAt.set(key, now);
  }
}

function bookDiagnostic(book: Book): unknown {
  return { exchangeTime: book.exchangeTime, receivedAt: book.receivedAt, streamAliveAt: book.streamAliveAt ?? null, seqId: book.seqId, asks: book.asks.slice(0, 5), bids: book.bids.slice(0, 5) };
}

function bookFreshnessDetails(book: Book | undefined): string {
  if (!book) return `maxBookAgeMs=${MAX_BOOK_AGE_MS}; maxStreamSilenceMs=${MAX_BOOK_STREAM_SILENCE_MS}; book=missing`;
  const now = Date.now();
  const age = (timestamp: number) => Number.isFinite(timestamp) ? String(Math.round(now - timestamp)) : "invalid";
  const iso = (timestamp: number) => Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).toISOString() : "invalid";
  return `maxBookAgeMs=${MAX_BOOK_AGE_MS}; maxStreamSilenceMs=${MAX_BOOK_STREAM_SILENCE_MS}; bookAgeMs=${age(book.receivedAt)}; exchangeAgeMs=${age(book.exchangeTime)}; streamSilenceMs=${age(book.streamAliveAt ?? Number.NaN)}; receivedAt=${iso(book.receivedAt)}; exchangeTime=${iso(book.exchangeTime)}; streamAliveAt=${iso(book.streamAliveAt ?? Number.NaN)}; seqId=${book.seqId}; bestBid=${book.bids[0]?.price ?? "none"}; bestAsk=${book.asks[0]?.price ?? "none"}`;
}

class BlockedScanError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function validQuote(quote: DexQuote | undefined, asset: AssetConfig, from: string, to: string, amount: string): quote is DexQuote {
  const equalsAddress = (a: string | undefined, b: string) => asset.chainIndex === "196" ? a?.toLowerCase() === b.toLowerCase() : a === b;
  if (!quote || quote.chainIndex !== asset.chainIndex || !Array.isArray(quote.dexRouterList) || quote.dexRouterList.length === 0 || !equalsAddress(quote.fromToken?.tokenContractAddress, from) || !equalsAddress(quote.toToken?.tokenContractAddress, to)) return false;
  const decimalsFor = (address: string) => equalsAddress(address, asset.tokenAddress) ? asset.tokenDecimals : asset.quoteTokenDecimals;
  const fromDecimals = decimalsFor(from);
  const toDecimals = decimalsFor(to);
  if ((quote.fromToken.decimal !== undefined && Number(quote.fromToken.decimal) !== fromDecimals) || (quote.toToken.decimal !== undefined && Number(quote.toToken.decimal) !== toDecimals)) return false;
  const input = new Decimal(quote.fromTokenAmount);
  const output = new Decimal(quote.toTokenAmount);
  return input.isFinite() && input.eq(amount) && output.isFinite() && output.gt(0);
}

function quoteIdentityMismatch(quote: DexQuote | undefined, asset: AssetConfig, from: string, to: string): string | null {
  if (!quote) return null;
  const equalsAddress = (a: string | undefined, b: string) => asset.chainIndex === "196" ? a?.toLowerCase() === b.toLowerCase() : a === b;
  if (quote.chainIndex !== asset.chainIndex || !equalsAddress(quote.fromToken?.tokenContractAddress, from) || !equalsAddress(quote.toToken?.tokenContractAddress, to)) {
    return `DEX quote token or chain does not match pinned ${asset.network} config`;
  }
  const decimalsFor = (address: string) => equalsAddress(address, asset.tokenAddress) ? asset.tokenDecimals : asset.quoteTokenDecimals;
  const fromDecimals = decimalsFor(from);
  const toDecimals = decimalsFor(to);
  if ((quote.fromToken.decimal !== undefined && Number(quote.fromToken.decimal) !== fromDecimals) || (quote.toToken.decimal !== undefined && Number(quote.toToken.decimal) !== toDecimals)) {
    return `DEX quote token decimals do not match pinned ${asset.network} config`;
  }
  return null;
}

async function makeObservation(asset: AssetConfig, direction: "cex_buy_dex_sell" | "dex_buy_cex_sell", size: number, shares: Decimal, cexPrice: Decimal, cexCost: Decimal, cexFee: Decimal, feeRate: Decimal, quote: DexQuote, timing: DexQuoteTiming, isStale: boolean, multiplier: Decimal, multiplierRaw: MultiplierResponse | undefined, book: Book, routeStatus: CollectorState["routeStatus"], guardrails: Config["runtime"]["guardrails"]): Promise<QuoteObservation> {
  const gasBase = quote.tradeFee === undefined ? null : new Decimal(quote.tradeFee);
  const usableGas = gasBase && gasBase.isFinite() && gasBase.gte(0) ? gasBase : null;
  const gas = usableGas?.mul(new Decimal(1).plus(new Decimal(asset.gasSafetyBufferPercent).div(100))) ?? null;
  const dexReceived = new Decimal(quote.toTokenAmount).div(new Decimal(10).pow(direction === "cex_buy_dex_sell" ? asset.quoteTokenDecimals : asset.tokenDecimals));
  const quoteAmount = direction === "cex_buy_dex_sell"
    ? dexReceived
    : new Decimal(quote.fromTokenAmount).div(new Decimal(10).pow(asset.quoteTokenDecimals));
  const maxAgeMs = guardrails.indexPriceMaxAgeSeconds * 1000;
  const now = Date.now();
  const decision = decideValuation({
    chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction, quoteAmount, cexCost, cexFee, gasUsdt: gas,
    cexFeeSource: "cex_fee_rate", networkFeeSource: "dex.tradeFee_usd+safety_buffer",
    now, maxAgeMs,
    maxUsdtUsdDeviationPercent: guardrails.maxUsdtUsdDeviationPercent, maxUsdt0UsdtDeviationPercent: guardrails.maxUsdt0UsdtDeviationPercent,
  });
  const verified = decision.valuationStatus === "VERIFIED";
  const gross = decision.grossProfitUsdt;
  const net = decision.netProfitUsdt;
  const rebalanceCost = asset.rebalanceCostUsdtPerTrade === undefined ? null : new Decimal(asset.rebalanceCostUsdtPerTrade);
  const adjusted = verified && decision.usdtLeg !== null && rebalanceCost !== null ? calculateProfit({
    direction, cexNotionalUsdt: cexCost, dexQuoteAmountUsdt: new Decimal(decision.usdtLeg), valuationStatus: "VERIFIED",
    costs: [
      { kind: "cex_fee", amountUsdt: cexFee, source: "cex_fee_rate" },
      { kind: "network_fee", amountUsdt: gas, source: "dex.tradeFee_usd+safety_buffer" },
      { kind: "rebalance", amountUsdt: rebalanceCost, source: "config.rebalanceCostUsdtPerTrade" },
    ],
  }) : null;
  const afterRebalance = adjusted?.netProfitUsdt ?? null;
  const roi = rebalanceCost === null ? decision.roi : adjusted?.roi?.toString() ?? null;
  const fromPrice = validUsdPrice(quote.fromToken.tokenUnitPrice);
  const toPrice = validUsdPrice(quote.toToken.tokenUnitPrice);
  const impact = parseDecimal(quote.priceImpactPercentage ?? quote.priceImpactPercent);
  return {
    instId: asset.instId, chainIndex: asset.chainIndex, routeStatus, direction, sizeUsdt: size, shares: shares.toString(),
    tokenAmount: direction === "cex_buy_dex_sell" ? shares.div(multiplier).toString() : dexReceived.toString(),
    cexVwap: cexPrice.toString(), cexFeeRate: feeRate.toString(),
    dexUsdtAmount: verified ? decision.usdtLeg : null,
    cexFeeUsdt: cexFee.toString(), gasUsdt: gas?.toString() ?? null, gasNativeRaw: quote.estimateGasFee ?? null,
    gasSource: "dex.tradeFee_usd", grossProfitUsdt: gross,
    netProfitUsdt: net, rebalanceCostUsdt: rebalanceCost?.toString() ?? null,
    netProfitAfterRebalanceUsdt: afterRebalance?.toString() ?? null,
    roi,
    multiplier: multiplier.toString(), multiplierRaw: JSON.stringify(multiplierRaw), cexTs: new Date(book.exchangeTime), cexReceivedAt: new Date(book.receivedAt),
    dexTs: timing.responseAt, dexRequestStartedAt: timing.requestStartedAt, dexQueueWaitMs: timing.queueWaitMs,
    priceImpactPercent: impact?.isFinite() ? impact.toString() : null,
    dexRequestMs: timing.requestMs,
    fromTokenUnitPriceUsd: fromPrice?.toString() ?? null, toTokenUnitPriceUsd: toPrice?.toString() ?? null,
    paidValueUsd: null, receivedValueUsd: null,
    isStale, status: gas === null ? "GAS_UNKNOWN" : "OK", rawResponse: JSON.stringify({ ...quote, orderBookLiveness: { exchangeTime: book.exchangeTime, receivedAt: book.receivedAt, streamAliveAt: book.streamAliveAt ?? null } }),
    nativeQuoteAmount: decision.nativeAmount, nativeQuoteSymbol: decision.nativeSymbol, usdtRate: verified ? decision.usdtRate : null,
    conversionCostUsdt: verified ? decision.conversionCostUsdt : null, usdtEstimate: verified ? decision.usdtEstimate : null,
    valuationStatus: decision.valuationStatus, priceSourceTime: decision.priceSourceTime, quoteSummary: decision.quoteSummary,
    valuationReasonCode: decision.reasonCode,
    executionBufferUsdt: "0", executableProfitUsdt: null, executableStatus: "NOT_EVALUATED", executionReason: null,
  };
}

function validUsdPrice(value: string | null | undefined): Decimal | null {
  const price = parseDecimal(value);
  return price?.gt(0) ? price : null;
}

function parseDecimal(value: string | number | null | undefined): Decimal | null {
  if (value === undefined || value === null) return null;
  try {
    const price = new Decimal(value);
    return price.isFinite() ? price : null;
  } catch {
    return null;
  }
}
