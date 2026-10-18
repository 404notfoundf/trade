import assert from "node:assert/strict";
import Decimal from "decimal.js";
import test from "node:test";
import { calculateProfit } from "./profit-calculation.js";

const decimal = (value: string) => new Decimal(value);
const cost = (kind: "cex_fee" | "network_fee" | "rebalance", amount: string | null, source: string = kind) => ({
  kind, amountUsdt: amount === null ? null : decimal(amount), source,
});

test("calculates both directions with the same cost and investment rules", () => {
  const cexBuy = calculateProfit({
    direction: "cex_buy_dex_sell", cexNotionalUsdt: decimal("100"), dexQuoteAmountUsdt: decimal("103"), valuationStatus: "VERIFIED",
    costs: [cost("cex_fee", "0.2"), cost("network_fee", "0.3"), cost("rebalance", "0.5")],
  });
  const dexBuy = calculateProfit({
    direction: "dex_buy_cex_sell", cexNotionalUsdt: decimal("103"), dexQuoteAmountUsdt: decimal("100"), valuationStatus: "VERIFIED",
    costs: [cost("cex_fee", "0.2"), cost("network_fee", "0.3"), cost("rebalance", "0.5")],
  });

  for (const result of [cexBuy, dexBuy]) {
    assert.equal(result.grossProfitUsdt?.toString(), "3");
    assert.equal(result.totalCostsUsdt?.toString(), "1");
    assert.equal(result.netProfitUsdt?.toString(), "2");
    assert.equal(result.investedUsdt?.toString(), "100");
    assert.equal(result.capitalAtRiskUsdt?.toString(), "101");
    assert.equal(result.roi?.toString(), "0.02");
    assert.equal(result.uncomputableReason, null);
  }
  assert.deepEqual(cexBuy.costBreakdown.map(({ kind, amountUsdt, source }) => [kind, amountUsdt, source]), [
    ["cex_fee", "0.2", "cex_fee"], ["network_fee", "0.3", "network_fee"], ["rebalance", "0.5", "rebalance"],
  ]);
});

test("keeps loss-making trades negative and does not double-count DEX pool fees", () => {
  const result = calculateProfit({
    direction: "dex_buy_cex_sell", cexNotionalUsdt: decimal("99.5"), dexQuoteAmountUsdt: decimal("100"), valuationStatus: "ASSUMED",
    costs: [cost("cex_fee", "0.1"), cost("network_fee", "0.2")],
  });
  assert.equal(result.grossProfitUsdt?.toString(), "-0.5");
  assert.equal(result.netProfitUsdt?.toString(), "-0.8");
});

test("withholds USDT profit when quote valuation is unknown", () => {
  const result = calculateProfit({
    direction: "cex_buy_dex_sell", cexNotionalUsdt: decimal("99"), dexQuoteAmountUsdt: decimal("100"), valuationStatus: "UNKNOWN",
    costs: [cost("cex_fee", "0.1"), cost("network_fee", "0.2")],
  });
  assert.equal(result.grossProfitUsdt, null);
  assert.equal(result.netProfitUsdt, null);
  assert.equal(result.investedUsdt, null);
  assert.equal(result.uncomputableReason, "VALUATION_UNKNOWN");
});

test("reports gross but withholds net and ROI when a cost is unknown", () => {
  const result = calculateProfit({
    direction: "cex_buy_dex_sell", cexNotionalUsdt: decimal("99"), dexQuoteAmountUsdt: decimal("100"), valuationStatus: "VERIFIED",
    costs: [cost("cex_fee", "0.1"), cost("network_fee", null, "simulation_not_available")],
  });
  assert.equal(result.grossProfitUsdt?.toString(), "1");
  assert.equal(result.netProfitUsdt, null);
  assert.equal(result.investedUsdt?.toString(), "99");
  assert.equal(result.roi, null);
  assert.equal(result.uncomputableReason, "COST_UNKNOWN");
  assert.equal(result.costBreakdown[1]?.source, "simulation_not_available");
});

test("rejects invalid trade amounts and negative costs while preserving Decimal precision", () => {
  const zeroInvestment = calculateProfit({
    direction: "cex_buy_dex_sell", cexNotionalUsdt: decimal("0"), dexQuoteAmountUsdt: decimal("1"), valuationStatus: "VERIFIED", costs: [],
  });
  assert.equal(zeroInvestment.roi, null);
  assert.equal(zeroInvestment.uncomputableReason, "INVALID_TRADE_AMOUNT");

  const negativeCost = calculateProfit({
    direction: "cex_buy_dex_sell", cexNotionalUsdt: decimal("1"), dexQuoteAmountUsdt: decimal("1.000000000000000001"), valuationStatus: "VERIFIED",
    costs: [cost("cex_fee", "-0.01")],
  });
  assert.equal(negativeCost.grossProfitUsdt?.toString(), "1e-18");
  assert.equal(negativeCost.netProfitUsdt, null);
  assert.equal(negativeCost.uncomputableReason, "INVALID_COST");
});
