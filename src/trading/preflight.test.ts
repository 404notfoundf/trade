import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPreflightReport, configVersion, preflightInventoryChecks, type PreflightCheck } from "./preflight.js";

const pass: PreflightCheck = { key: "database", status: "PASS", reason: "Connected", source: "mysql" };
const readyRoute = { instId: "XAAPL-USDT", chainIndex: "196", enabled: true, checks: [pass] };

test("preflight only passes when global and enabled-route checks pass", () => {
  assert.equal(buildPreflightReport({ generatedAt: "2026-01-01T00:00:00.000Z", configVersion: "v1", checks: [pass], routes: [readyRoute] }).overall, "PASS");
  assert.equal(buildPreflightReport({ generatedAt: "2026-01-01T00:00:00.000Z", configVersion: "v1", checks: [pass], routes: [] }).overall, "BLOCKED");
  assert.equal(buildPreflightReport({ generatedAt: "2026-01-01T00:00:00.000Z", configVersion: "v1", checks: [pass], routes: [{ ...readyRoute, checks: [{ key: "book", status: "STALE", reason: "book expired" }] }] }).overall, "BLOCKED");
});

test("unknown and stale required checks block, while explicit non-required direction failures do not", () => {
  for (const status of ["UNKNOWN", "STALE"] as const) {
    assert.equal(buildPreflightReport({ generatedAt: "now", configVersion: "v1", checks: [pass], routes: [{ ...readyRoute, checks: [{ key: "pool", status, reason: "not verified" }] }] }).overall, "BLOCKED");
  }
  assert.equal(buildPreflightReport({ generatedAt: "now", configVersion: "v1", checks: [pass], routes: [{ ...readyRoute, checks: [pass, { key: "reverse_balance", status: "BLOCKED", required: false, reason: "insufficient for that direction" }] }] }).overall, "PASS");
});

test("report sanitizes endpoints and credential-like detail fields", () => {
  const report = buildPreflightReport({ generatedAt: "now", configVersion: "v1", checks: [
    { key: "rpc", status: "BLOCKED", reason: "failed https://rpc.example/token?key=secret", details: { rpcUrl: "https://rpc.example/key", available: true } },
  ], routes: [readyRoute] });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("rpc.example"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("rpcUrl"), false);
  assert.match(serialized, /endpoint redacted/);
});

test("configuration fingerprint is stable and only reflects the safe projection", () => {
  const config = { quoteProvider: "aggregator", tradingEnabled: true, healthProbeIntervalSeconds: 300, tradeSizeUsdt: 100, maxTradeSizeUsdt: 100,
    credentialsConfigured: { cex: true, dex: true }, signersConfigured: { xlayer: true, solana: false },
    guardrails: { maxBookAgeMs: 2000 }, routes: [{ enabled: true, instId: "XAAPL-USDT", chainIndex: "196", tokenAddress: "token", tokenDecimals: 18,
      quoteTokenAddress: "quote", quoteTokenDecimals: 6, gasSafetyBufferPercent: 20, dexQuoteIntervalMs: 5000, okxCurrency: "XAAPL", okxChain: "XLayer" }],
    pools: [{ id: "pool", enabled: true, chain: "xlayer", dex: "uniswap-v3", address: "pool", assetAddress: "token", quoteAddress: "quote" }] };
  assert.equal(configVersion(config), configVersion(structuredClone(config)));
  assert.notEqual(configVersion(config), configVersion({ ...config, tradeSizeUsdt: 250 }));
});

test("preflight balance checks apply token decimals and gas safety buffer without exposing balances", () => {
  const checks = preflightInventoryChecks({
    quotes: [
      { direction: "cex_buy_dex_sell", shares: "10", tokenAmount: "5", cexVwap: "2", cexFeeUsdt: "0.2", gasNativeRaw: "100", nativeQuoteAmount: null },
      { direction: "dex_buy_cex_sell", shares: "10", tokenAmount: "5", cexVwap: "2", cexFeeUsdt: "0.2", gasNativeRaw: "100", nativeQuoteAmount: "12.5" },
    ],
    balances: { cexUsdt: "20.2", cexAsset: "10", chainAssetRaw: "500", chainQuoteRaw: "12500000", chainNativeRaw: "125" },
    assetDecimals: 2, quoteDecimals: 6, gasSafetyBufferPercent: 25,
  });
  assert.equal(checks.find((check) => check.key === "funded_direction")?.status, "PASS");
  const serialized = JSON.stringify(checks);
  assert.equal(serialized.includes("\"cexUsdt\""), false);
  assert.equal(serialized.includes("\"cexAsset\""), false);
});

test("preflight blocks when no execution direction has enough balance or fee data is unknown", () => {
  const insufficient = preflightInventoryChecks({
    quotes: [
      { direction: "cex_buy_dex_sell", shares: "10", tokenAmount: "5", cexVwap: "2", cexFeeUsdt: "0.2", gasNativeRaw: "100", nativeQuoteAmount: null },
      { direction: "dex_buy_cex_sell", shares: "10", tokenAmount: "5", cexVwap: "2", cexFeeUsdt: "0.2", gasNativeRaw: "100", nativeQuoteAmount: "12.5" },
    ],
    balances: { cexUsdt: "1", cexAsset: "1", chainAssetRaw: "1", chainQuoteRaw: "1", chainNativeRaw: "1" },
    assetDecimals: 2, quoteDecimals: 6, gasSafetyBufferPercent: 25,
  });
  assert.equal(insufficient.find((check) => check.key === "funded_direction")?.status, "BLOCKED");
  const unknown = preflightInventoryChecks({
    quotes: [{ direction: "cex_buy_dex_sell", shares: "10", tokenAmount: "5", cexVwap: "2", cexFeeUsdt: "0.2", gasNativeRaw: null, nativeQuoteAmount: null }],
    balances: { cexUsdt: "20.2", cexAsset: "0", chainAssetRaw: "500", chainQuoteRaw: "0", chainNativeRaw: "125" },
    assetDecimals: 2, quoteDecimals: 6, gasSafetyBufferPercent: 25,
  });
  assert.equal(unknown[0]?.status, "UNKNOWN");
  assert.equal(unknown.find((check) => check.key === "funded_direction")?.status, "UNKNOWN");
});
