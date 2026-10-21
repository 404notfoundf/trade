import Decimal from "decimal.js";

export const OBSERVED_MINIMUM_PROFIT_FLOOR = {
  poolIds: [
    "xspcx-solana-raydium-usdc-clmm",
    "xspcx-solana-orca-whirlpool-usdc",
    "xspcx-solana-meteora-dlmm-usdc",
    "xspcx-solana-byreal-clmm-usdc",
  ],
  direction: "dex_buy_cex_sell",
  sizeUsdt: "100",
  slippageBps: 10,
  minimumNetProfitUsdt: "0.01",
} as const;

export type MinimumProfitStatus = "PASS" | "BELOW_FLOOR" | "UNCOMPUTABLE" | "NOT_APPLICABLE";

export function isObservedMinimumProfitTarget(poolId: string, direction: string, sizeUsdt: string | number): boolean {
  return OBSERVED_MINIMUM_PROFIT_FLOOR.poolIds.some((targetPoolId) => targetPoolId === poolId)
    && direction === OBSERVED_MINIMUM_PROFIT_FLOOR.direction
    && new Decimal(String(sizeUsdt)).eq(OBSERVED_MINIMUM_PROFIT_FLOOR.sizeUsdt);
}

export function minimumProfitStatus(netProfitUsdt: Decimal | null): MinimumProfitStatus {
  if (netProfitUsdt === null || !netProfitUsdt.isFinite()) return "UNCOMPUTABLE";
  return netProfitUsdt.gte(OBSERVED_MINIMUM_PROFIT_FLOOR.minimumNetProfitUsdt) ? "PASS" : "BELOW_FLOOR";
}
