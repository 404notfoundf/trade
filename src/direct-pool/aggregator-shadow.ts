import Decimal from "decimal.js";
import type { AssetConfig } from "../config.js";
import { bookStale } from "../market/market.js";
import { dexQuote, reserveDexRequestSlot, type Book, type Credentials, type DexQuoteTiming } from "../market/okx.js";
import { saveAggregatorShadowQuote } from "./storage.js";

export type AggregatorQuote = {
  chainIndex?: string; fromTokenAmount?: string; toTokenAmount?: string;
  fromToken?: { tokenContractAddress?: string; decimal?: string; tokenUnitPrice?: string | null };
  toToken?: { tokenContractAddress?: string; decimal?: string; tokenUnitPrice?: string | null };
  priceImpactPercentage?: string | number | null; priceImpactPercent?: string | null; dexRouterList?: unknown[];
};

export type AggregatorShadowRequest = {
  scanId: string; asset: AssetConfig; sizeUsdt: number; book: Book;
  assetAmountRaw: string; quoteAmountRaw: string;
};

type Leg = { direction: "cex_buy_dex_sell" | "dex_buy_cex_sell"; from: string; to: string; amount: string; slot: Promise<void> };

const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, "[rpc endpoint]").slice(0, 500) : "unknown shadow error";

export class AggregatorShadowCollector {
  private readonly pending = new Map<string, AggregatorShadowRequest>();
  private readonly running = new Set<string>();

  constructor(private readonly credentials: Credentials, private readonly callbacks: {
    onHealth: (status: string, reason?: string | null) => void;
    onDatabaseError: (error: unknown) => void;
  }) {}

  request(request: AggregatorShadowRequest): void {
    const key = `${request.asset.instId}:${request.asset.chainIndex}`;
    this.pending.set(key, request);
    if (this.running.has(key)) return;
    this.running.add(key);
    void this.drain(key).finally(() => {
      this.running.delete(key);
      if (this.pending.has(key)) this.request(this.pending.get(key)!);
    });
  }

  private async drain(key: string): Promise<void> {
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    const { asset, book } = request;
    const legs: Omit<Leg, "slot">[] = [
      { direction: "cex_buy_dex_sell", from: asset.tokenAddress, to: asset.quoteTokenAddress, amount: request.assetAmountRaw },
      { direction: "dex_buy_cex_sell", from: asset.quoteTokenAddress, to: asset.tokenAddress, amount: request.quoteAmountRaw },
    ];
    if (![this.credentials.key, this.credentials.secret, this.credentials.passphrase].every(Boolean)) {
      await this.recordBoth(request, legs, "DEX_CREDENTIALS_MISSING", "Aggregator credentials are not configured");
      this.callbacks.onHealth("not_configured", "Aggregator credentials are not configured");
      return;
    }
    if (!book.ready || bookStale(book)) {
      await this.recordBoth(request, legs, "CEX_BOOK_STALE", "Captured CEX book expired before the shadow quote");
      this.callbacks.onHealth("unavailable", "Captured CEX book expired before the shadow quote");
      return;
    }
    const slotted: Leg[] = legs.map((leg) => ({ ...leg, slot: reserveDexRequestSlot() }));
    const results = await Promise.all(slotted.map((leg) => this.recordOne(request, leg)));
    const failed = results.filter((result) => !result.ok);
    this.callbacks.onHealth(failed.length === results.length ? "unavailable" : failed.length ? "degraded" : "healthy", failed.map((result) => result.reason).filter(Boolean).join("; ") || null);
  }

  private async recordBoth(request: AggregatorShadowRequest, legs: Omit<Leg, "slot">[], failureCode: string, failureReason: string): Promise<void> {
    await Promise.all(legs.map((leg) => this.save(request, leg, null, null, "FAILED", failureCode, failureReason, null)));
  }

  private async recordOne(request: AggregatorShadowRequest, leg: Leg): Promise<{ ok: boolean; reason: string | null }> {
    let quote: AggregatorQuote | undefined;
    let timing: DexQuoteTiming | undefined;
    let failureCode: string | null = null;
    let failureReason: string | null = null;
    let rawResponse: unknown = null;
    try {
      const result = await dexQuote<AggregatorQuote[]>(new URLSearchParams({ chainIndex: request.asset.chainIndex, swapMode: "exactIn",
        fromTokenAddress: leg.from, toTokenAddress: leg.to, amount: leg.amount }), this.credentials, leg.slot);
      timing = result;
      quote = result.data[0];
      rawResponse = quote ?? result.data;
      if (!isValidAggregatorQuote(quote, request.asset, leg)) {
        failureCode = "AGGREGATOR_QUOTE_INVALID";
        failureReason = "Aggregator shadow response did not match the pinned token pair and exact-in amount";
      }
    } catch (error) {
      failureCode = "AGGREGATOR_QUOTE_FAILED";
      failureReason = errorMessage(error);
      rawResponse = { error: failureReason };
    }
    await this.save(request, leg, quote?.toTokenAmount ?? null,
      numeric(quote?.priceImpactPercentage ?? quote?.priceImpactPercent), failureCode ? "FAILED" : "OK",
      failureCode, failureReason, rawResponse, timing);
    return { ok: !failureCode, reason: failureReason };
  }

  private async save(request: AggregatorShadowRequest, leg: Omit<Leg, "slot">, amountOutRaw: string | null,
    priceImpactPercent: string | null, status: string, failureCode: string | null, failureReason: string | null,
    rawResponse: unknown, timing?: DexQuoteTiming): Promise<void> {
    try {
      await saveAggregatorShadowQuote({ scanId: request.scanId, instrumentId: request.asset.instId, chainIndex: request.asset.chainIndex,
        direction: leg.direction, sizeUsdt: String(request.sizeUsdt), cexBookAt: new Date(request.book.exchangeTime),
        cexReceivedAt: new Date(request.book.receivedAt), cexSeqId: request.book.seqId, fromToken: leg.from, toToken: leg.to,
        amountInRaw: leg.amount, amountOutRaw, priceImpactPercent, quotedAt: timing?.responseAt ?? null,
        requestMs: timing?.requestMs ?? null, queueWaitMs: timing?.queueWaitMs ?? null, status, failureCode, failureReason, rawResponse });
    } catch (error) { this.callbacks.onDatabaseError(error); }
  }
}

export function isValidAggregatorQuote(quote: AggregatorQuote | undefined, asset: AssetConfig, leg: Pick<Leg, "from" | "to" | "amount">): quote is AggregatorQuote {
  const equals = (left: string | undefined, right: string) => asset.chainIndex === "196" ? left?.toLowerCase() === right.toLowerCase() : left === right;
  if (!quote || quote.chainIndex !== asset.chainIndex || !Array.isArray(quote.dexRouterList) || quote.dexRouterList.length === 0
    || !equals(quote.fromToken?.tokenContractAddress, leg.from) || !equals(quote.toToken?.tokenContractAddress, leg.to)) return false;
  const input = new Decimal(quote.fromTokenAmount ?? "NaN");
  const output = new Decimal(quote.toTokenAmount ?? "NaN");
  return input.isFinite() && input.eq(leg.amount) && output.isFinite() && output.gt(0);
}

function numeric(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed.toString() : null;
  } catch { return null; }
}
