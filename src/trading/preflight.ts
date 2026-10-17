import { createHash } from "node:crypto";
import Decimal from "decimal.js";

export type PreflightStatus = "PASS" | "BLOCKED" | "UNKNOWN" | "STALE" | "NOT_APPLICABLE";
export type PreflightDetail = string | number | boolean | null;
export type PreflightCheck = {
  key: string;
  status: PreflightStatus;
  reason: string;
  source?: string;
  observedAt?: string;
  required?: boolean;
  details?: Record<string, PreflightDetail>;
};
export type PreflightRoute = {
  instId: string;
  chainIndex: string;
  enabled: boolean;
  checks: PreflightCheck[];
};
export type PreflightReport = {
  schemaVersion: 1;
  generatedAt: string;
  configVersion: string;
  overall: "PASS" | "BLOCKED";
  checks: PreflightCheck[];
  routes: PreflightRoute[];
  blockers: string[];
};
export type PreflightConfigFingerprint = {
  quoteProvider: string;
  tradingEnabled: boolean;
  healthProbeIntervalSeconds: number;
  tradeSizeUsdt: number;
  maxTradeSizeUsdt: number;
  credentialsConfigured: { cex: boolean; dex: boolean };
  signersConfigured: { xlayer: boolean; solana: boolean };
  guardrails: Record<string, number>;
  routes: Array<{ enabled: boolean; instId: string; chainIndex: string; tokenAddress: string; tokenDecimals: number;
    quoteTokenAddress: string; quoteTokenDecimals: number; gasSafetyBufferPercent: number; dexQuoteIntervalMs: number;
    okxCurrency: string; okxChain: string; approvedMultiplier?: string; rebalanceCostUsdtPerTrade?: number }>;
  pools: Array<{ id: string; enabled: boolean; chain: string; dex: string; address: string; assetAddress: string; quoteAddress: string }>;
};
export type PreflightQuoteBalanceInput = {
  direction: "cex_buy_dex_sell" | "dex_buy_cex_sell";
  shares: string | null;
  tokenAmount: string | null;
  cexVwap: string | null;
  cexFeeUsdt: string | null;
  gasNativeRaw: string | null;
  nativeQuoteAmount: string | null;
};
export type PreflightBalanceInput = {
  cexUsdt: string;
  cexAsset: string;
  chainAssetRaw: string;
  chainQuoteRaw: string;
  chainNativeRaw: string;
};

const sensitiveDetail = /key|secret|passphrase|private|credential|rpc.?url|raw.?response/i;
const safeString = (value: string) => value.replace(/https?:\/\/[^\s"'<>]+/gi, "[endpoint redacted]")
  .replace(/(api[_ -]?key|secret|passphrase|private[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
  .replace(/[\r\n\t]+/g, " ").slice(0, 500);

export function safePreflightCheck(check: PreflightCheck): PreflightCheck {
  const details = check.details && Object.fromEntries(Object.entries(check.details)
    .filter(([key]) => !sensitiveDetail.test(key))
    .map(([key, value]) => [safeString(key), typeof value === "string" ? safeString(value) : value]));
  return {
    ...check,
    key: safeString(check.key),
    reason: safeString(check.reason),
    source: check.source ? safeString(check.source) : undefined,
    observedAt: check.observedAt ? safeString(check.observedAt) : undefined,
    details,
  };
}

export function configVersion(config: PreflightConfigFingerprint): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function buildPreflightReport(input: {
  generatedAt: string;
  configVersion: string;
  checks: PreflightCheck[];
  routes: PreflightRoute[];
}): PreflightReport {
  const checks = input.checks.map(safePreflightCheck);
  const routes = input.routes.map((route) => ({ ...route, checks: route.checks.map(safePreflightCheck) }));
  const blockers = [
    ...checks.filter((check) => check.required !== false && !checkPassed(check)).map((check) => `${check.key}: ${check.reason}`),
    ...routes.filter((route) => route.enabled)
      .flatMap((route) => route.checks.filter((check) => check.required !== false && !checkPassed(check))
        .map((check) => `${route.instId}/${route.chainIndex} ${check.key}: ${check.reason}`)),
  ];
  if (!routes.some((route) => route.enabled)) blockers.push("routes: no enabled trading routes are configured");
  return {
    schemaVersion: 1,
    generatedAt: safeString(input.generatedAt),
    configVersion: input.configVersion,
    overall: blockers.length ? "BLOCKED" : "PASS",
    checks,
    routes,
    blockers,
  };
}

export function withPreflightCheck(report: PreflightReport, check: PreflightCheck): PreflightReport {
  return buildPreflightReport({
    generatedAt: report.generatedAt,
    configVersion: report.configVersion,
    checks: [...report.checks, check],
    routes: report.routes,
  });
}

export function preflightInventoryChecks(input: {
  quotes: PreflightQuoteBalanceInput[];
  balances: PreflightBalanceInput;
  assetDecimals: number;
  quoteDecimals: number;
  gasSafetyBufferPercent: number;
}): PreflightCheck[] {
  const checks: PreflightCheck[] = input.quotes.map((quote): PreflightCheck => {
    const label = quote.direction;
    try {
      const shares = positive(quote.shares);
      const gasRaw = positive(quote.gasNativeRaw);
      const nativeRequired = new Decimal(gasRaw).mul(new Decimal(1).plus(new Decimal(input.gasSafetyBufferPercent).div(100))).ceil();
      const nativeAvailable = integer(input.balances.chainNativeRaw);
      if (quote.direction === "cex_buy_dex_sell") {
        const tokenAmount = positive(quote.tokenAmount);
        const cexRequired = shares.mul(positive(quote.cexVwap)).plus(nonNegative(quote.cexFeeUsdt));
        const chainAssetRequired = tokenAmount.mul(new Decimal(10).pow(input.assetDecimals)).ceil();
        const enough = nonNegative(input.balances.cexUsdt).gte(cexRequired)
          && integer(input.balances.chainAssetRaw).gte(chainAssetRequired) && nativeAvailable.gte(nativeRequired);
        return {
          key: `balance_${label}`, status: enough ? "PASS" as const : "BLOCKED" as const,
          required: false,
          reason: enough ? "CEX USDT, chain asset and buffered native gas cover this direction" : "CEX USDT, chain asset or buffered native gas is insufficient for this direction",
          source: "OKX account balance + chain RPC",
          details: { cexUsdtRequired: cexRequired.toSignificantDigits(8).toString(), chainAssetRequiredRaw: chainAssetRequired.toFixed(0), nativeRequiredRaw: nativeRequired.toFixed(0) },
        };
      }
      const quoteAmount = positive(quote.nativeQuoteAmount);
      const chainQuoteRequired = quoteAmount.mul(new Decimal(10).pow(input.quoteDecimals)).ceil();
      const cexAssetRequired = shares.plus(nonNegative(quote.cexFeeUsdt).div(positive(quote.cexVwap)));
      const enough = nonNegative(input.balances.cexAsset).gte(cexAssetRequired)
        && integer(input.balances.chainQuoteRaw).gte(chainQuoteRequired) && nativeAvailable.gte(nativeRequired);
      return {
        key: `balance_${label}`, status: enough ? "PASS" as const : "BLOCKED" as const,
        required: false,
        reason: enough ? "CEX asset, chain quote asset and buffered native gas cover this direction" : "CEX asset, chain quote asset or buffered native gas is insufficient for this direction",
        source: "OKX account balance + chain RPC",
        details: { cexAssetRequired: cexAssetRequired.toSignificantDigits(8).toString(), chainQuoteRequiredRaw: chainQuoteRequired.toFixed(0), nativeRequiredRaw: nativeRequired.toFixed(0) },
      };
    } catch {
      return { key: `balance_${label}`, status: "UNKNOWN" as const, required: true, reason: "Quote or balance values are missing or invalid" };
    }
  });
  const hasFundedDirection = checks.some((check) => check.status === "PASS");
  checks.push({
    key: "funded_direction",
    status: hasFundedDirection ? "PASS" : checks.some((check) => check.status === "UNKNOWN") ? "UNKNOWN" : "BLOCKED",
    reason: hasFundedDirection ? "At least one execution direction is funded" : "No execution direction has sufficient CEX, chain and gas balance",
    source: "Configured trade size",
  });
  return checks;
}

function checkPassed(check: PreflightCheck): boolean {
  return check.status === "PASS" || check.status === "NOT_APPLICABLE";
}

function positive(value: string | null): Decimal {
  const parsed = new Decimal(value ?? "NaN");
  if (!parsed.isFinite() || !parsed.gt(0)) throw new Error("not positive");
  return parsed;
}

function nonNegative(value: string | null): Decimal {
  const parsed = new Decimal(value ?? "NaN");
  if (!parsed.isFinite() || parsed.lt(0)) throw new Error("not non-negative");
  return parsed;
}

function integer(value: string | null): Decimal {
  const parsed = new Decimal(value ?? "NaN");
  if (!parsed.isInteger() || !parsed.gte(0)) throw new Error("not a non-negative integer");
  return parsed;
}
