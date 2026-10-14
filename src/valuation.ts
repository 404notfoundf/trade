import Decimal from "decimal.js";

export const ETH_CHAIN = "1";
export const XLAYER_CHAIN = "196";
export const SOLANA_CHAIN = "501";
export const ETH_USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const XLAYER_USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
export const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export type IndexTarget = { chainIndex: string; tokenContractAddress: string; symbol: string };
export const INDEX_TARGETS: IndexTarget[] = [
  { chainIndex: ETH_CHAIN, tokenContractAddress: ETH_USDT, symbol: "USDT" },
  { chainIndex: SOLANA_CHAIN, tokenContractAddress: SOLANA_USDT, symbol: "USDT" },
  { chainIndex: XLAYER_CHAIN, tokenContractAddress: XLAYER_USDT0, symbol: "USDT0" },
];

export function pinnedQuote(chainIndex: string): { address: string; symbol: string } | null {
  if (chainIndex === XLAYER_CHAIN) return { address: XLAYER_USDT0, symbol: "USDT0" };
  if (chainIndex === SOLANA_CHAIN) return { address: SOLANA_USDT, symbol: "USDT" };
  return null;
}

export function addressesMatch(chainIndex: string, actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return chainIndex === SOLANA_CHAIN ? actual === expected : actual.toLowerCase() === expected.toLowerCase();
}

export type IndexTick = { chainIndex?: string; tokenContractAddress?: string; price?: string | number; time?: string | number };
type AcceptedPrice = { chainIndex: string; tokenAddress: string; symbol: string; price: Decimal; sourceTime: number; fetchedAt: number; diagnostic: string };
type Rejection = { status: "unavailable" | "stale"; reason: string; diagnostic: string; fetchedAt: number };

const cache = new Map<string, AcceptedPrice>();
const rejected = new Map<string, Rejection>();
let refreshError: string | null = null;
const keyOf = (chainIndex: string, address: string) => `${chainIndex}:${chainIndex === SOLANA_CHAIN ? address : address.toLowerCase()}`;

export function resetValuation(): void {
  cache.clear();
  rejected.clear();
  refreshError = null;
}

export function acceptIndexTick(target: IndexTarget, tick: IndexTick | undefined, now: number, maxAgeMs: number): { ok: true; price: Decimal; sourceTime: number } | { ok: false; status: "unavailable" | "stale"; reason: string } {
  if (!tick || String(tick.chainIndex) !== target.chainIndex || !addressesMatch(target.chainIndex, tick.tokenContractAddress, target.tokenContractAddress)) {
    return { ok: false, status: "unavailable", reason: `${target.symbol} index response is missing or does not match the pinned address` };
  }
  let price: Decimal;
  try { price = new Decimal(tick.price ?? ""); } catch { return { ok: false, status: "unavailable", reason: `${target.symbol} index price is invalid` }; }
  if (!price.isFinite() || !price.gt(0)) return { ok: false, status: "unavailable", reason: `${target.symbol} index price is not positive` };
  const sourceTime = Number(tick.time);
  if (!Number.isFinite(sourceTime)) return { ok: false, status: "unavailable", reason: `${target.symbol} index time is invalid` };
  if (now - sourceTime > maxAgeMs) return { ok: false, status: "stale", reason: `${target.symbol} index price is stale` };
  return { ok: true, price, sourceTime };
}

function fresh(row: AcceptedPrice | undefined, now: number, maxAgeMs: number): row is AcceptedPrice {
  return !!row && now - row.sourceTime <= maxAgeMs;
}

export function applyIndexTicks(ticks: IndexTick[], now: number, maxAgeMs: number): void {
  refreshError = null;
  for (const target of INDEX_TARGETS) {
    const key = keyOf(target.chainIndex, target.tokenContractAddress);
    const tick = ticks.find((item) => String(item.chainIndex) === target.chainIndex && addressesMatch(target.chainIndex, item.tokenContractAddress, target.tokenContractAddress));
    const accepted = acceptIndexTick(target, tick, now, maxAgeMs);
    if (accepted.ok) {
      rejected.delete(key);
      cache.set(key, { chainIndex: target.chainIndex, tokenAddress: target.tokenContractAddress, symbol: target.symbol, price: accepted.price, sourceTime: accepted.sourceTime, fetchedAt: now, diagnostic: JSON.stringify(tick).slice(0, 500) });
    } else if (!fresh(cache.get(key), now, maxAgeMs)) {
      cache.delete(key);
      rejected.set(key, { status: accepted.status, reason: accepted.reason, diagnostic: JSON.stringify(tick ?? { error: accepted.reason }).slice(0, 500), fetchedAt: now });
    }
  }
}

export function noteIndexFailure(error: string, now: number, maxAgeMs: number): void {
  refreshError = error.slice(0, 500);
  for (const target of INDEX_TARGETS) {
    const key = keyOf(target.chainIndex, target.tokenContractAddress);
    if (fresh(cache.get(key), now, maxAgeMs)) continue;
    cache.delete(key);
    rejected.set(key, { status: "unavailable", reason: `${target.symbol} index refresh failed`, diagnostic: refreshError, fetchedAt: now });
  }
}

export function usdtUsdDeviationPercent(price: Decimal): Decimal {
  return price.minus(1).abs().mul(100);
}

export function usdt0ParityDeviationPercent(usdt0Usd: Decimal, usdtUsd: Decimal): Decimal {
  return usdt0Usd.div(usdtUsd).minus(1).abs().mul(100);
}

export type PriceGate = { status: "healthy" | "blocked" | "unavailable" | "stale" | "unknown"; code: string; reason: string; price: string | null; sourceTime: number | null; deviationPercent: string | null };

function usdGate(chainIndex: string, address: string, label: string, now: number, maxAgeMs: number, limit: number): PriceGate {
  const row = cache.get(keyOf(chainIndex, address));
  const live = fresh(row, now, maxAgeMs) ? row : undefined;
  if (!live) {
    const miss = rejected.get(keyOf(chainIndex, address));
    const status = miss?.status === "stale" ? "stale" : "unavailable";
    return { status, code: status === "stale" ? "USDT_PRICE_STALE" : "USDT_PRICE_SOURCE_UNAVAILABLE", reason: miss?.reason ?? `${label} index price is unavailable`, price: null, sourceTime: null, deviationPercent: null };
  }
  const deviation = usdtUsdDeviationPercent(live.price);
  if (deviation.gt(limit)) return { status: "blocked", code: "USDT_DEVIATION_LIMIT", reason: `${label}/USD deviation ${deviation.toFixed(4)}% exceeds ${limit}%`, price: live.price.toString(), sourceTime: live.sourceTime, deviationPercent: deviation.toString() };
  return { status: "healthy", code: "", reason: "", price: live.price.toString(), sourceTime: live.sourceTime, deviationPercent: deviation.toString() };
}

export type ValuationView = {
  usdtUsd: PriceGate;
  solUsdt: PriceGate;
  usdt0: PriceGate;
  parity: PriceGate;
  refreshError: string | null;
};

export function valuationView(now: number, limits: { maxUsdtUsdDeviationPercent: number; maxUsdt0UsdtDeviationPercent: number; indexPriceMaxAgeMs: number }): ValuationView {
  const maxAge = limits.indexPriceMaxAgeMs;
  const usdtUsd = usdGate(ETH_CHAIN, ETH_USDT, "USDT", now, maxAge, limits.maxUsdtUsdDeviationPercent);
  const solUsdt = usdGate(SOLANA_CHAIN, SOLANA_USDT, "Solana USDT", now, maxAge, limits.maxUsdtUsdDeviationPercent);
  const usdt0Row = cache.get(keyOf(XLAYER_CHAIN, XLAYER_USDT0));
  const usdt0Live = fresh(usdt0Row, now, maxAge) ? usdt0Row : undefined;
  const usdt0Miss = rejected.get(keyOf(XLAYER_CHAIN, XLAYER_USDT0));
  const usdt0: PriceGate = usdt0Live
    ? { status: "healthy", code: "", reason: "", price: usdt0Live.price.toString(), sourceTime: usdt0Live.sourceTime, deviationPercent: null }
    : { status: usdt0Miss?.status === "stale" ? "stale" : "unavailable", code: usdt0Miss?.status === "stale" ? "USDT_PRICE_STALE" : "USDT_PRICE_SOURCE_UNAVAILABLE", reason: usdt0Miss?.reason ?? "USDT0 index price is unavailable", price: null, sourceTime: null, deviationPercent: null };
  let parity: PriceGate;
  if (usdtUsd.status !== "healthy" || !usdtUsd.price) parity = { ...usdtUsd, price: usdtUsd.price, deviationPercent: null };
  else if (!usdt0Live) parity = { ...usdt0, deviationPercent: null };
  else {
    const deviation = usdt0ParityDeviationPercent(usdt0Live.price, new Decimal(usdtUsd.price));
    parity = deviation.gt(limits.maxUsdt0UsdtDeviationPercent)
      ? { status: "blocked", code: "USDT0_PARITY_LIMIT", reason: `USDT0/USDT deviation ${deviation.toFixed(4)}% exceeds ${limits.maxUsdt0UsdtDeviationPercent}%`, price: usdt0Live.price.toString(), sourceTime: usdt0Live.sourceTime, deviationPercent: deviation.toString() }
      : { status: "healthy", code: "", reason: "", price: usdt0Live.price.toString(), sourceTime: usdt0Live.sourceTime, deviationPercent: deviation.toString() };
  }
  return {
    usdtUsd, solUsdt, usdt0, parity, refreshError,
  };
}

export type PriceSnapshot = { chainIndex: string; tokenAddress: string; symbol: string; usdPrice: string | null; source: string; sourceTime: Date | null; status: string; diagnostic: string | null };

export function snapshotRows(now: number, maxAgeMs: number): PriceSnapshot[] {
  return INDEX_TARGETS.map((target) => {
    const key = keyOf(target.chainIndex, target.tokenContractAddress);
    const live = fresh(cache.get(key), now, maxAgeMs) ? cache.get(key) : undefined;
    const miss = rejected.get(key);
    return { chainIndex: target.chainIndex, tokenAddress: target.tokenContractAddress, symbol: target.symbol, usdPrice: live?.price.toString() ?? null, source: "okx_index", sourceTime: live ? new Date(live.sourceTime) : null, status: live ? "healthy" : miss?.status ?? "unavailable", diagnostic: (live?.diagnostic ?? miss?.diagnostic ?? refreshError)?.slice(0, 500) ?? null };
  });
}

export type ValuationRisk = { instId: string; chainIndex: string; direction: string; sizeUsdt: number; reasonCode: string; reason: string };

export function valuationRiskEvents(view: ValuationView, assets: Array<{ instId: string; chainIndex: string }>): ValuationRisk[] {
  const events: ValuationRisk[] = [];
  for (const asset of assets) {
    const push = (code: string, reason: string) => events.push({ instId: asset.instId, chainIndex: asset.chainIndex, direction: "valuation", sizeUsdt: 0, reasonCode: code, reason });
    if (view.usdtUsd.status !== "healthy") { push(view.usdtUsd.code, view.usdtUsd.reason); continue; }
    if (asset.chainIndex === SOLANA_CHAIN && view.solUsdt.status !== "healthy") push(view.solUsdt.code, view.solUsdt.reason);
    if (asset.chainIndex === XLAYER_CHAIN) {
      if (view.parity.status !== "healthy") push(view.parity.code, view.parity.reason);
    }
  }
  return events;
}

export type ValuationDecision = {
  nativeAmount: string; nativeSymbol: string; usdtRate: string | null; conversionCostUsdt: string | null; usdtEstimate: string | null;
  grossProfitUsdt: string | null; netProfitUsdt: string | null; valuationStatus: "VERIFIED" | "UNKNOWN"; priceSourceTime: Date | null;
  quoteSummary: string | null; reasonCode: string | null; reason: string | null; usdtLeg: string | null;
};

export function decideValuation(input: {
  chainIndex: string; quoteTokenAddress: string; direction: "cex_buy_dex_sell" | "dex_buy_cex_sell"; quoteAmount: Decimal;
  cexCost: Decimal; cexFee: Decimal; gasUsdt: Decimal | null; now: number; maxAgeMs: number;
  maxUsdtUsdDeviationPercent: number; maxUsdt0UsdtDeviationPercent: number;
}): ValuationDecision {
  const pinned = pinnedQuote(input.chainIndex);
  const nativeSymbol = pinned?.symbol ?? "UNKNOWN";
  const unknown = (code: string, reason: string, sourceTime: number | null, sameUnit = false): ValuationDecision => {
    const gross = sameUnit ? (input.direction === "cex_buy_dex_sell" ? input.quoteAmount.minus(input.cexCost) : input.cexCost.minus(input.quoteAmount)) : null;
    const net = gross === null || input.gasUsdt === null ? null : gross.minus(input.cexFee).minus(input.gasUsdt);
    return {
      nativeAmount: input.quoteAmount.toString(), nativeSymbol, usdtRate: null, conversionCostUsdt: null, usdtEstimate: null,
      grossProfitUsdt: gross?.toString() ?? null, netProfitUsdt: net?.toString() ?? null, valuationStatus: "UNKNOWN",
      priceSourceTime: sourceTime === null ? null : new Date(sourceTime), quoteSummary: reason.slice(0, 500), reasonCode: code, reason, usdtLeg: null,
    };
  };
  if (!pinned || !addressesMatch(input.chainIndex, input.quoteTokenAddress, pinned.address)) {
    return unknown(input.chainIndex === XLAYER_CHAIN ? "USDT0_PROTOCOL_MISMATCH" : "USDT_CONVERSION_UNAVAILABLE", input.chainIndex === XLAYER_CHAIN ? "X Layer quote token does not match pinned official USDT0" : "Quote token is not pinned official USDT", null);
  }
  const view = valuationView(input.now, { maxUsdtUsdDeviationPercent: input.maxUsdtUsdDeviationPercent, maxUsdt0UsdtDeviationPercent: input.maxUsdt0UsdtDeviationPercent, indexPriceMaxAgeMs: input.maxAgeMs });
  if (view.usdtUsd.status !== "healthy") return unknown(view.usdtUsd.code, view.usdtUsd.reason, view.usdtUsd.sourceTime, input.chainIndex === SOLANA_CHAIN);
  if (input.chainIndex === SOLANA_CHAIN) {
    if (view.solUsdt.status !== "healthy") return unknown(view.solUsdt.code, view.solUsdt.reason, view.solUsdt.sourceTime, true);
    if (!input.quoteAmount.gt(0)) return unknown("USDT_CONVERSION_UNAVAILABLE", "Solana USDT amount is not positive", view.solUsdt.sourceTime, true);
    return settle(input, nativeSymbol, input.quoteAmount, new Decimal(0), new Decimal(1), Math.min(view.usdtUsd.sourceTime ?? input.now, view.solUsdt.sourceTime ?? input.now), "Solana native USDT identity; no USDT0 reserve check");
  }
  if (view.parity.status !== "healthy") return unknown(view.parity.code, view.parity.reason, view.parity.sourceTime ?? view.usdtUsd.sourceTime);
  if (!input.quoteAmount.isFinite() || !input.quoteAmount.gt(0)) return unknown("USDT_CONVERSION_UNAVAILABLE", "USDT0 quote amount is not positive", view.usdt0.sourceTime);
  return settle(input, nativeSymbol, input.quoteAmount, new Decimal(0), new Decimal(1), Math.min(view.usdtUsd.sourceTime ?? input.now, view.usdt0.sourceTime ?? input.now), "USDT0 is valued 1:1 with USDT; cross-chain fees are excluded");
}

function settle(input: { direction: "cex_buy_dex_sell" | "dex_buy_cex_sell"; quoteAmount: Decimal; cexCost: Decimal; cexFee: Decimal; gasUsdt: Decimal | null }, nativeSymbol: string, usdtAmount: Decimal, conversionCost: Decimal, rate: Decimal, sourceTime: number, summary: string): ValuationDecision {
  const gross = input.direction === "cex_buy_dex_sell" ? usdtAmount.minus(input.cexCost) : input.cexCost.minus(usdtAmount);
  const net = input.gasUsdt === null ? null : gross.minus(input.cexFee).minus(input.gasUsdt);
  return {
    nativeAmount: input.quoteAmount.toString(), nativeSymbol, usdtRate: rate.toString(), conversionCostUsdt: conversionCost.toString(),
    usdtEstimate: net?.toString() ?? null, grossProfitUsdt: gross.toString(), netProfitUsdt: net?.toString() ?? null, valuationStatus: "VERIFIED",
    priceSourceTime: new Date(sourceTime), quoteSummary: summary.slice(0, 500), reasonCode: null, reason: null, usdtLeg: usdtAmount.toString(),
  };
}
