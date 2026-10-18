import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  ETH_USDT, SOLANA_USDT, XLAYER_USDT0, acceptIndexTick, applyIndexTicks, decideValuation, noteIndexFailure, resetValuation, valuationView,
} from "./valuation.js";

const now = 1_700_000_000_000;
const maxAgeMs = 60_000;
const limits = { maxUsdtUsdDeviationPercent: 0.5, maxUsdt0UsdtDeviationPercent: 0.5, maxAgeMs };
const eth = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const usdt0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

function load(prices: { eth?: string; sol?: string; usdt0?: string }, time = now): void {
  resetValuation();
  applyIndexTicks([
    { chainIndex: "1", tokenContractAddress: eth, price: prices.eth ?? "1", time: String(time) },
    { chainIndex: "501", tokenContractAddress: SOLANA_USDT, price: prices.sol ?? "1", time: String(time) },
    { chainIndex: "196", tokenContractAddress: usdt0, price: prices.usdt0 ?? "1", time: String(time) },
  ], now, maxAgeMs);
}

const base = { quoteAmount: new Decimal(100), cexCost: new Decimal(99), cexFee: new Decimal("0.1"), gasUsdt: new Decimal("0.05"), now, ...limits };

load({ eth: "1.005" });
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).usdtUsd.status, "healthy");
load({ eth: "1.0050000001" });
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).usdtUsd.code, "USDT_DEVIATION_LIMIT");
load({ usdt0: "1.005" });
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).parity.status, "healthy");
load({ usdt0: "1.0050000001" });
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).parity.code, "USDT0_PARITY_LIMIT");
load({}, now - 60_000);
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).usdtUsd.status, "healthy");
load({}, now - 60_001);
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).usdtUsd.code, "USDT_PRICE_STALE");

assert.equal(acceptIndexTick({ chainIndex: "1", tokenContractAddress: ETH_USDT, symbol: "USDT" }, { chainIndex: "1", tokenContractAddress: eth, price: "1", time: String(now) }, now, maxAgeMs).ok, true);
assert.equal(acceptIndexTick({ chainIndex: "501", tokenContractAddress: SOLANA_USDT, symbol: "USDT" }, { chainIndex: "501", tokenContractAddress: SOLANA_USDT.toLowerCase(), price: "1", time: String(now) }, now, maxAgeMs).ok, false);
assert.equal(acceptIndexTick({ chainIndex: "1", tokenContractAddress: ETH_USDT, symbol: "USDT" }, { chainIndex: "1", tokenContractAddress: eth, price: "-1", time: String(now) }, now, maxAgeMs).ok, false);

load({});
const solana = decideValuation({ ...base, chainIndex: "501", quoteTokenAddress: SOLANA_USDT, direction: "cex_buy_dex_sell" });
assert.equal(solana.valuationStatus, "VERIFIED");
assert.equal(solana.reasonCode, null);
assert.equal(solana.usdtEstimate, "0.85");
assert.equal(solana.usdtRate, "1");
assert.equal(solana.grossProfitUsdt, "1");
assert.equal(solana.totalCostsUsdt, "0.15");
assert.equal(solana.investedUsdt, "99");
assert.equal(solana.capitalAtRiskUsdt, "99.15");
assert.equal(solana.roi, new Decimal("0.85").div(99).toString());
load({ sol: "1.006" });
const solPaused = decideValuation({ ...base, chainIndex: "501", quoteTokenAddress: SOLANA_USDT, direction: "cex_buy_dex_sell" });
assert.equal(solPaused.valuationStatus, "UNKNOWN");
assert.equal(solPaused.reasonCode, "USDT_DEVIATION_LIMIT");
assert.equal(solPaused.usdtEstimate, null);
assert.equal(solPaused.netProfitUsdt, null);
assert.equal(solPaused.calculationReasonCode, "VALUATION_UNKNOWN");
load({ eth: "1.006", sol: "1" });
assert.equal(decideValuation({ ...base, chainIndex: "501", quoteTokenAddress: SOLANA_USDT, direction: "cex_buy_dex_sell" }).reasonCode, "USDT_DEVIATION_LIMIT");

load({});
const xlayer = decideValuation({ ...base, chainIndex: "196", quoteTokenAddress: XLAYER_USDT0, direction: "dex_buy_cex_sell" });
assert.equal(xlayer.valuationStatus, "VERIFIED");
assert.equal(xlayer.usdtRate, "1");
assert.equal(xlayer.usdtLeg, "100");
assert.equal(xlayer.conversionCostUsdt, "0");
assert.equal(xlayer.netProfitUsdt, "-1.15");
assert.equal(xlayer.investedUsdt, "100");
assert.equal(xlayer.capitalAtRiskUsdt, "100.15");
load({ usdt0: "1.006" });
assert.equal(decideValuation({ ...base, chainIndex: "196", quoteTokenAddress: XLAYER_USDT0, direction: "dex_buy_cex_sell" }).reasonCode, "USDT0_PARITY_LIMIT");
load({});
const verified = decideValuation({ ...base, chainIndex: "196", quoteTokenAddress: XLAYER_USDT0, direction: "dex_buy_cex_sell", cexCost: new Decimal(100), gasUsdt: new Decimal("0.2") });
assert.equal(verified.valuationStatus, "VERIFIED");
resetValuation();
load({});
assert.equal(verified.nativeSymbol, "USDT0");
assert.equal(verified.usdtEstimate, "-0.3");
assert.equal(verified.costBreakdown[1]?.source, "network_fee_estimate");
assert.equal(verified.usdtRate, "1");
assert.equal(verified.conversionCostUsdt, "0");
assert.equal(decideValuation({ ...base, chainIndex: "196", quoteTokenAddress: "0x0000000000000000000000000000000000000001", direction: "cex_buy_dex_sell" }).reasonCode, "USDT0_PROTOCOL_MISMATCH");

load({});
noteIndexFailure("timeout", now, maxAgeMs);
assert.equal(valuationView(now, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).usdtUsd.status, "healthy");
noteIndexFailure("timeout", now + 60_001, maxAgeMs);
assert.equal(valuationView(now + 60_001, { ...limits, indexPriceMaxAgeMs: maxAgeMs }).usdtUsd.code, "USDT_PRICE_SOURCE_UNAVAILABLE");
console.log("valuation.check ok");
