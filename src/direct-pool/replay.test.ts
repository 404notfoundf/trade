import assert from "node:assert/strict";
import Decimal from "decimal.js";
import test from "node:test";
import { vwap } from "../market/market.js";
import { calculateProfit } from "../market/profit-calculation.js";

const fixtures = [
  {
    name: "CEX buy and DEX sell",
    direction: "cex_buy_dex_sell" as const,
    cexLevels: [{ price: "49", size: "1" }, { price: "50", size: "1" }],
    cexShares: "2",
    cexFeeRate: "0.001",
    quoteAmountInRaw: "200000000",
    quoteAmountOutRaw: "101000000",
    quoteDecimals: 6,
    networkFeeUsdt: "0.05",
    rebalanceCostUsdt: "0.02",
    expected: { gross: "2", costs: "0.169", net: "1.831", invested: "99", roi: "0.01849495" },
  },
  {
    name: "DEX buy and CEX sell",
    direction: "dex_buy_cex_sell" as const,
    cexLevels: [{ price: "51", size: "1" }, { price: "50", size: "1" }],
    cexShares: "2",
    cexFeeRate: "0.001",
    quoteAmountInRaw: "99000000",
    quoteAmountOutRaw: "200000000",
    quoteDecimals: 6,
    networkFeeUsdt: "0.05",
    rebalanceCostUsdt: "0.02",
    expected: { gross: "2", costs: "0.171", net: "1.829", invested: "99", roi: "0.01847475" },
  },
];

test("recalculates saved direct-pool decisions from CEX depth, raw quote, and costs", () => {
  for (const fixture of fixtures) {
    const fill = vwap(fixture.cexLevels, new Decimal(fixture.cexShares));
    assert.ok(fill, `${fixture.name}: expected the captured CEX depth to fill`);

    const quoteAmountRaw = fixture.direction === "cex_buy_dex_sell"
      ? fixture.quoteAmountOutRaw
      : fixture.quoteAmountInRaw;
    const quoteAmountUsdt = new Decimal(quoteAmountRaw).div(new Decimal(10).pow(fixture.quoteDecimals));
    const result = calculateProfit({
      direction: fixture.direction,
      cexNotionalUsdt: fill.notional,
      dexQuoteAmountUsdt: quoteAmountUsdt,
      valuationStatus: "ASSUMED",
      costs: [
        { kind: "cex_fee", amountUsdt: fill.notional.mul(fixture.cexFeeRate), source: "cex_fee_rate" },
        { kind: "network_fee", amountUsdt: new Decimal(fixture.networkFeeUsdt), source: "config.direct_pool_observation" },
        { kind: "rebalance", amountUsdt: new Decimal(fixture.rebalanceCostUsdt), source: "config.rebalanceCostUsdtPerTrade" },
      ],
    });

    assert.equal(result.grossProfitUsdt?.toString(), fixture.expected.gross, fixture.name);
    assert.equal(result.totalCostsUsdt?.toString(), fixture.expected.costs, fixture.name);
    assert.equal(result.netProfitUsdt?.toString(), fixture.expected.net, fixture.name);
    assert.equal(result.investedUsdt?.toString(), fixture.expected.invested, fixture.name);
    assert.equal(result.roi?.toFixed(8), fixture.expected.roi, fixture.name);
    assert.equal(result.uncomputableReason, null, fixture.name);
  }
});

test("replay does not assign a profit when the captured CEX depth is insufficient", () => {
  assert.equal(vwap([{ price: "50", size: "1" }], new Decimal("2")), null);
});
