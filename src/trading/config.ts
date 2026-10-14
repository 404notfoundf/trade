export type TradingConfig = {
  enabled: boolean;
  tradeSizeUsdt: number;
  maxTradeSizeUsdt: number;
};

export function parseTrading(raw: unknown, routes: Array<{ enabled: boolean; instId: string; chainIndex: string }>): TradingConfig {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabled = source.enabled === true;
  const tradeSizeUsdt = source.tradeSizeUsdt === undefined ? 100 : Number(source.tradeSizeUsdt);
  const maxTradeSizeUsdt = source.maxTradeSizeUsdt === undefined ? 100 : Number(source.maxTradeSizeUsdt);
  if (!Number.isFinite(tradeSizeUsdt) || tradeSizeUsdt <= 0 || !Number.isFinite(maxTradeSizeUsdt) || maxTradeSizeUsdt <= 0) {
    throw new Error("trading.tradeSizeUsdt and trading.maxTradeSizeUsdt must be positive");
  }
  if (tradeSizeUsdt > maxTradeSizeUsdt) throw new Error("trading.tradeSizeUsdt exceeds trading.maxTradeSizeUsdt");
  if (enabled) {
    if (!routes.some((route) => route.enabled)) throw new Error("trading.enabled requires at least one enabled asset route");
  }
  return { enabled, tradeSizeUsdt, maxTradeSizeUsdt };
}
