import { createHmac } from "node:crypto";
import Decimal from "decimal.js";
import WebSocket from "ws";

export type Level = { price: string; size: string };
export type Book = { asks: Level[]; bids: Level[]; exchangeTime: number; receivedAt: number; streamAliveAt?: number; seqId: number; ready: boolean };
export type Credentials = { key: string; secret: string; passphrase: string };
export type DexQuoteTiming = { requestStartedAt: Date; responseAt: Date; requestMs: number; queueWaitMs: number };
const OKX = "https://www.okx.com";
const DEX = "https://web3.okx.com";
// Stay below the DEX Trial tier's default limit of 1 request per second.
const DEX_MIN_REQUEST_INTERVAL_MS = 1100;
let nextDexRequestAt = 0;
let dexRequestQueue = Promise.resolve();

// Claim the start time before sleeping, so a later caller cannot take a slot between two already reserved legs.
export function reserveDexRequestSlot(): Promise<void> {
  const claimed = dexRequestQueue.then(() => {
    const startAt = Math.max(Date.now(), nextDexRequestAt);
    nextDexRequestAt = startAt + DEX_MIN_REQUEST_INTERVAL_MS;
    return startAt;
  });
  dexRequestQueue = claimed.then(() => {}, () => {});
  return claimed.then(async (startAt) => {
    const delay = startAt - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  });
}

function sign(secret: string, timestamp: string, method: string, path: string, body = ""): string {
  return createHmac("sha256", secret).update(`${timestamp}${method}${path}${body}`).digest("base64");
}

export async function okxPrivateGet<T>(path: string, credentials: Credentials): Promise<T> {
  const timestamp = new Date().toISOString();
  const response = await fetch(`${OKX}${path}`, { headers: {
    "OK-ACCESS-KEY": credentials.key,
    "OK-ACCESS-SIGN": sign(credentials.secret, timestamp, "GET", path),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OKX private API HTTP ${response.status}`);
  const json = await response.json() as { code: string; msg: string; data: T };
  if (json.code !== "0") throw new Error(`OKX private API ${json.code}: ${json.msg}`);
  return json.data;
}

export async function okxPrivatePost<T>(path: string, body: unknown, credentials: Credentials): Promise<T> {
  const payload = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const response = await fetch(`${OKX}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": credentials.key,
    "OK-ACCESS-SIGN": sign(credentials.secret, timestamp, "POST", path, payload),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  }, body: payload, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OKX private API HTTP ${response.status}`);
  const json = await response.json() as { code: string; msg: string; data: T };
  if (json.code !== "0") throw new Error(`OKX private API ${json.code}: ${json.msg}`);
  return json.data;
}

export async function okxPublicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${OKX}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OKX public API HTTP ${response.status}`);
  const json = await response.json() as { code: string; msg: string; data: T };
  if (json.code !== "0") throw new Error(`OKX public API ${json.code}: ${json.msg}`);
  return json.data;
}

export type OkxPublicTicker = { bidPx: Decimal; askPx: Decimal; midPx: Decimal; sourceAt: number; receivedAt: number };
type RawOkxPublicTicker = { instId: string; bidPx: string; askPx: string; ts: string };
type CachedSolUsdtTicker = { value: OkxPublicTicker; expiresAt: number } | { error: string; expiresAt: number };
export const SOLANA_BASE_FEE_LAMPORTS = 5_000n;
const solUsdtTickerTtlMs = 30_000;
const solUsdtTickerMaxAgeMs = 60_000;
let solUsdtTickerCache: CachedSolUsdtTicker | undefined;
let solUsdtTickerRequest: Promise<OkxPublicTicker> | undefined;

export async function okxSolUsdtTicker(): Promise<OkxPublicTicker> {
  const now = Date.now();
  if (solUsdtTickerCache && now < solUsdtTickerCache.expiresAt) {
    if ("error" in solUsdtTickerCache) throw new Error(solUsdtTickerCache.error);
    const cached = solUsdtTickerCache.value;
    if (now - cached.sourceAt <= solUsdtTickerMaxAgeMs && cached.sourceAt <= now + 5_000) return cached;
    solUsdtTickerCache = undefined;
  }
  if (solUsdtTickerRequest) return solUsdtTickerRequest;
  const request = (async () => {
    try {
      const rows = await okxPublicGet<RawOkxPublicTicker[]>("/api/v5/market/ticker?instId=SOL-USDT");
      const row = rows[0];
      if (!row || row.instId !== "SOL-USDT") throw new Error("OKX SOL-USDT ticker is unavailable");
      const bidPx = new Decimal(row.bidPx);
      const askPx = new Decimal(row.askPx);
      const sourceAt = Number(row.ts);
      const receivedAt = Date.now();
      if (!bidPx.isFinite() || !askPx.isFinite() || !bidPx.gt(0) || !askPx.gte(bidPx)
        || !Number.isSafeInteger(sourceAt) || sourceAt > receivedAt + 5_000 || receivedAt - sourceAt > solUsdtTickerMaxAgeMs) {
        throw new Error("OKX SOL-USDT ticker is invalid or stale");
      }
      const value = { bidPx, askPx, midPx: bidPx.plus(askPx).div(2), sourceAt, receivedAt };
      solUsdtTickerCache = { value, expiresAt: receivedAt + solUsdtTickerTtlMs };
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OKX SOL-USDT ticker error";
      solUsdtTickerCache = { error: message, expiresAt: Date.now() + 5_000 };
      throw error;
    }
  })();
  solUsdtTickerRequest = request;
  try { return await request; }
  finally { if (solUsdtTickerRequest === request) solUsdtTickerRequest = undefined; }
}

export function estimateSolanaBaseFeeUsdt(solUsdtMidPx: Decimal): Decimal {
  return new Decimal(SOLANA_BASE_FEE_LAMPORTS.toString()).div(1_000_000_000).mul(solUsdtMidPx);
}

async function dexSignedGet<T>(path: string, credentials: Credentials, label: string, onResponse?: (timing: DexQuoteTiming) => void, reserved?: Promise<void>): Promise<T> {
  const queuedAt = performance.now();
  await (reserved ?? reserveDexRequestSlot());
  const queueWaitMs = performance.now() - queuedAt;
  const requestStartedAt = new Date();
  const timestamp = new Date().toISOString();
  const startedAt = performance.now();
  const response = await fetch(`${DEX}${path}`, { headers: {
    "OK-ACCESS-KEY": credentials.key,
    "OK-ACCESS-SIGN": sign(credentials.secret, timestamp, "GET", path),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  }, signal: AbortSignal.timeout(15_000) });
  const body = await response.text();
  onResponse?.({ requestStartedAt, responseAt: new Date(), requestMs: performance.now() - startedAt, queueWaitMs });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${body.slice(0, 500)}`);
  const json = JSON.parse(body) as { code: string; msg: string; data: T };
  if (json.code !== "0") throw new Error(`${label} ${json.code}: ${json.msg}`);
  return json.data;
}

export async function dexQuote<T>(query: URLSearchParams, credentials: Credentials, reserved?: Promise<void>): Promise<{ data: T } & DexQuoteTiming> {
  let timing!: DexQuoteTiming;
  const data = await dexSignedGet<T>(`/api/v6/dex/aggregator/quote?${query.toString()}`, credentials, "DEX Quote", (result) => { timing = result; }, reserved);
  return { data, ...timing };
}

export async function dexSwap<T>(query: URLSearchParams, credentials: Credentials): Promise<T> {
  return dexSignedGet(`/api/v6/dex/aggregator/swap?${query.toString()}`, credentials, "DEX Swap");
}

export async function dexApproveTransaction<T>(query: URLSearchParams, credentials: Credentials): Promise<T> {
  return dexSignedGet(`/api/v6/dex/aggregator/approve-transaction?${query.toString()}`, credentials, "DEX Approve Transaction");
}

export async function dexSolanaSwapInstructions<T>(query: URLSearchParams, credentials: Credentials): Promise<T> {
  return dexSignedGet(`/api/v6/dex/aggregator/swap-instruction?${query.toString()}`, credentials, "DEX Solana Swap Instructions");
}

export async function dexPost<T>(path: string, body: unknown, credentials: Credentials): Promise<T> {
  await reserveDexRequestSlot();
  const payload = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const response = await fetch(`${DEX}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": credentials.key,
    "OK-ACCESS-SIGN": sign(credentials.secret, timestamp, "POST", path, payload),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
  }, body: payload, signal: AbortSignal.timeout(15_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`DEX API HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const json = JSON.parse(raw) as { code: string | number; msg: string; data: T };
  if (String(json.code) !== "0") throw new Error(`DEX API ${json.code}: ${json.msg}`);
  return json.data;
}

export function dexIndexPrices(items: Array<{ chainIndex: string; tokenContractAddress: string }>, credentials: Credentials) {
  return dexPost<Array<{ chainIndex: string; tokenContractAddress: string; price: string; time: string }>>("/api/v6/dex/index/current-price", items, credentials);
}

export class OkxOrderBook {
  private socket?: WebSocket;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private asks = new Map<string, string>();
  private bids = new Map<string, string>();
  private seqId = -1;
  private current?: Book;
  private closed = false;
  constructor(private readonly instId: string, private readonly onUpdate: (book: Book) => void, private readonly onError: (error: string) => void) {}
  start(): void { this.connect(); }
  stop(): void { this.closed = true; clearTimeout(this.retry); clearInterval(this.heartbeat); this.socket?.close(); }
  private connect(): void {
    if (this.closed) return;
    this.socket = new WebSocket("wss://ws.okx.com/ws/v5/public");
    this.socket.on("open", () => {
      this.socket?.send(JSON.stringify({ op: "subscribe", args: [{ channel: "books", instId: this.instId }] }));
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send("ping"); }, 25_000);
    });
    this.socket.on("message", (raw) => this.handle(raw.toString()));
    this.socket.on("error", () => this.onError("OKX WebSocket connection error"));
    this.socket.on("close", () => { clearInterval(this.heartbeat); this.onError("OKX WebSocket disconnected; reconnecting"); this.reset(); if (!this.closed) this.retry = setTimeout(() => this.connect(), 2000); });
  }
  private reset(): void { this.asks.clear(); this.bids.clear(); this.seqId = -1; this.current = undefined; }
  private apply(side: Map<string, string>, levels: string[][]): void {
    for (const level of levels) {
      const price = level[0]; const size = level[1];
      if (price === undefined || size === undefined) continue;
      if (size === "0") side.delete(price); else side.set(price, size);
    }
  }
  private handle(text: string): void {
    if (text === "pong") return;
    let message: any;
    try { message = JSON.parse(text); } catch { return; }
    if (message.event === "error") { this.onError(`OKX WebSocket subscription error ${message.code}`); this.socket?.close(); return; }
    const data = message.data?.[0];
    if (!data) return;
    if (!Array.isArray(data.asks) || !Array.isArray(data.bids)) return;
    const receivedAt = Date.now();
    if (message.action === "snapshot") {
      this.asks.clear(); this.bids.clear(); this.apply(this.asks, data.asks); this.apply(this.bids, data.bids);
    } else {
      if (this.seqId < 0 || (data.prevSeqId !== this.seqId && !(data.seqId < data.prevSeqId && data.prevSeqId === this.seqId))) {
        this.onError("OKX book sequence gap; reconnecting for a fresh snapshot"); this.socket?.close(); return;
      }
      // An empty incremental update is OKX's channel heartbeat; preserve the last book-data timestamp.
      if (data.asks.length === 0 && data.bids.length === 0) {
        this.seqId = Number(data.seqId);
        if (this.current) this.current.streamAliveAt = receivedAt;
        return;
      }
      this.apply(this.asks, data.asks); this.apply(this.bids, data.bids);
    }
    this.seqId = Number(data.seqId);
    const sorted = (levels: Map<string, string>, descending: boolean) => [...levels.entries()]
      .map(([price, size]) => ({ price, size })).sort((a, b) => (Number(a.price) - Number(b.price)) * (descending ? -1 : 1));
    this.current = { asks: sorted(this.asks, false), bids: sorted(this.bids, true), exchangeTime: Number(data.ts), receivedAt, streamAliveAt: receivedAt, seqId: this.seqId, ready: true };
    this.onUpdate(this.current);
  }
}
