import Decimal from "decimal.js";
import type { Book, Level } from "./okx.js";

export type Instrument = { instId: string; state: string; lotSz: string; minSz: string; tickSz: string };
export type Fill = { quantity: Decimal; notional: Decimal; vwap: Decimal };
export const MAX_BOOK_AGE_MS = 2_000;

export function vwap(levels: Level[], quantity: Decimal): Fill | null {
  let remaining = quantity;
  let notional = new Decimal(0);
  let filled = new Decimal(0);
  for (const level of levels) {
    const available = new Decimal(level.size);
    const take = Decimal.min(remaining, available);
    if (take.gt(0)) { filled = filled.plus(take); notional = notional.plus(take.mul(level.price)); remaining = remaining.minus(take); }
    if (remaining.lte(0)) return { quantity: filled, notional, vwap: notional.div(filled) };
  }
  return null;
}

export function floorToStep(value: Decimal, step: string): Decimal {
  const increment = new Decimal(step);
  return value.div(increment).floor().mul(increment);
}

export function bookMidpoint(book: Book): Decimal {
  if (!book.asks.length || !book.bids.length) throw new Error("Order book is empty");
  return new Decimal(book.asks[0]!.price).plus(book.bids[0]!.price).div(2);
}

export function bookStale(book: Book): boolean {
  const now = Date.now();
  return !Number.isFinite(book.receivedAt) || !Number.isFinite(book.exchangeTime)
    || now - book.receivedAt > MAX_BOOK_AGE_MS || now - book.exchangeTime > MAX_BOOK_AGE_MS;
}
