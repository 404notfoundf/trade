import Decimal from "decimal.js";

export type ProfitDirection = "cex_buy_dex_sell" | "dex_buy_cex_sell";
export type ProfitValuationStatus = "VERIFIED" | "ASSUMED" | "UNKNOWN";
export type ProfitCostKind = "cex_fee" | "network_fee" | "rebalance" | "other";
export type ProfitCostInput = { kind: ProfitCostKind; amountUsdt: Decimal | null; source: string };
export type ProfitCostBreakdown = { kind: ProfitCostKind; amountUsdt: string | null; source: string };
export type ProfitUncomputableReason = "VALUATION_UNKNOWN" | "INVALID_TRADE_AMOUNT" | "INVALID_COST" | "COST_UNKNOWN";
export type ProfitCalculation = {
  grossProfitUsdt: Decimal | null;
  costBreakdown: ProfitCostBreakdown[];
  totalCostsUsdt: Decimal | null;
  netProfitUsdt: Decimal | null;
  investedUsdt: Decimal | null;
  capitalAtRiskUsdt: Decimal | null;
  roi: Decimal | null;
  uncomputableReason: ProfitUncomputableReason | null;
};

export function calculateProfit(input: {
  direction: ProfitDirection;
  cexNotionalUsdt: Decimal;
  dexQuoteAmountUsdt: Decimal;
  valuationStatus: ProfitValuationStatus;
  costs: ProfitCostInput[];
}): ProfitCalculation {
  const costBreakdown = input.costs.map(({ kind, amountUsdt, source }) => ({
    kind, source,
    amountUsdt: amountUsdt?.isFinite() && amountUsdt.gte(0) ? amountUsdt.toString() : null,
  }));
  const unavailable = (reason: ProfitUncomputableReason, grossProfitUsdt: Decimal | null = null, investedUsdt: Decimal | null = null): ProfitCalculation => ({
    grossProfitUsdt, costBreakdown, totalCostsUsdt: null, netProfitUsdt: null,
    investedUsdt, capitalAtRiskUsdt: null, roi: null, uncomputableReason: reason,
  });

  if (input.valuationStatus === "UNKNOWN") return unavailable("VALUATION_UNKNOWN");
  if (![input.cexNotionalUsdt, input.dexQuoteAmountUsdt].every((amount) => amount.isFinite() && amount.gt(0))) {
    return unavailable("INVALID_TRADE_AMOUNT");
  }

  const grossProfitUsdt = input.direction === "cex_buy_dex_sell"
    ? input.dexQuoteAmountUsdt.minus(input.cexNotionalUsdt)
    : input.cexNotionalUsdt.minus(input.dexQuoteAmountUsdt);
  const investedUsdt = input.direction === "cex_buy_dex_sell" ? input.cexNotionalUsdt : input.dexQuoteAmountUsdt;
  if (input.costs.some(({ amountUsdt }) => amountUsdt !== null && (!amountUsdt.isFinite() || amountUsdt.lt(0)))) {
    return unavailable("INVALID_COST", grossProfitUsdt, investedUsdt);
  }
  if (input.costs.some(({ amountUsdt }) => amountUsdt === null)) return unavailable("COST_UNKNOWN", grossProfitUsdt, investedUsdt);

  const totalCostsUsdt = input.costs.reduce((total, cost) => total.plus(cost.amountUsdt!), new Decimal(0));
  const netProfitUsdt = grossProfitUsdt.minus(totalCostsUsdt);
  return {
    grossProfitUsdt, costBreakdown, totalCostsUsdt, netProfitUsdt, investedUsdt,
    capitalAtRiskUsdt: investedUsdt.plus(totalCostsUsdt), roi: netProfitUsdt.div(investedUsdt),
    uncomputableReason: null,
  };
}
