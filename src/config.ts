import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { addressesMatch, pinnedQuote } from "./valuation.js";
import { parseTrading, type TradingConfig } from "./trading/config.js";

export type AssetConfig = {
  enabled: boolean;
  instId: string;
  tokenSymbol: string;
  network: "X Layer" | "Solana";
  chainIndex: string;
  okxCurrency: string;
  okxChain: string;
  tokenAddress: string;
  tokenDecimals: number;
  quoteTokenAddress: string;
  quoteTokenDecimals: number;
  quoteTokenSymbol: string;
  approvedMultiplier?: string;
  rebalanceCostUsdtPerTrade?: number;
  observationSizesUsdt: number[];
  gasSafetyBufferPercent: number;
  dexQuoteIntervalMs: number;
};

type AssetDefinition = Omit<AssetConfig, "enabled" | "network" | "chainIndex" | "okxChain" | "tokenAddress" | "tokenDecimals" | "quoteTokenAddress" | "quoteTokenDecimals" | "quoteTokenSymbol" | "approvedMultiplier" | "rebalanceCostUsdtPerTrade"> & {
  enabled?: boolean;
  routes: Array<Pick<AssetConfig, "enabled" | "network" | "chainIndex" | "okxChain" | "tokenAddress" | "tokenDecimals" | "quoteTokenAddress" | "quoteTokenDecimals" | "quoteTokenSymbol" | "approvedMultiplier" | "rebalanceCostUsdtPerTrade">>;
};

export type Config = {
  port: number;
  runtime: { healthProbeIntervalSeconds: number; dashboardRefreshSeconds: number; guardrails: { maxUsdtUsdDeviationPercent: number; maxUsdt0UsdtDeviationPercent: number; indexPriceRefreshSeconds: number; indexPriceMaxAgeSeconds: number; maxDexPriceImpactPercent: number; maxMultiplierChangePercent: number } };
  mysql: { host: string; port: number; user: string; password: string; database: string };
  okx: { key: string; secret: string; passphrase: string };
  dex: { key: string; secret: string; passphrase: string };
  signers: { xlayerPrivateKey: string; solanaPrivateKey: string; solanaRpcUrl: string };
  assets: AssetConfig[];
  trading: TradingConfig;
};

export async function loadConfig(): Promise<Config> {
  const settings = parse(await readFile(new URL("../config.yaml", import.meta.url), "utf8")) as {
    port?: number;
    runtime?: Partial<Config["runtime"]>;
    mysql?: Config["mysql"];
    assets?: AssetDefinition[];
    trading?: unknown;
  };
  if (!Array.isArray(settings.assets)) throw new Error("config.yaml must contain an assets list");
  if (settings.assets.some((asset) => asset.enabled !== undefined && typeof asset.enabled !== "boolean")) throw new Error("Each asset enabled flag must be a boolean");
  if (settings.assets.some((asset) => !Array.isArray(asset.routes) || asset.routes.length === 0)) throw new Error("Each asset must contain at least one route");
  if (settings.assets.some((asset) => asset.routes.some((route) => typeof route.enabled !== "boolean"))) throw new Error("Each asset route enabled flag must be a boolean");
  if (!settings.mysql) throw new Error("config.yaml must contain MySQL settings");
  const healthProbeIntervalSeconds = settings.runtime?.healthProbeIntervalSeconds ?? 300;
  const dashboardRefreshSeconds = settings.runtime?.dashboardRefreshSeconds ?? 15;
  const guardrails = {
    maxUsdtUsdDeviationPercent: settings.runtime?.guardrails?.maxUsdtUsdDeviationPercent ?? 0.5,
    maxUsdt0UsdtDeviationPercent: settings.runtime?.guardrails?.maxUsdt0UsdtDeviationPercent ?? 0.5,
    indexPriceRefreshSeconds: settings.runtime?.guardrails?.indexPriceRefreshSeconds ?? 15,
    indexPriceMaxAgeSeconds: settings.runtime?.guardrails?.indexPriceMaxAgeSeconds ?? 60,
    maxDexPriceImpactPercent: settings.runtime?.guardrails?.maxDexPriceImpactPercent ?? 2,
    maxMultiplierChangePercent: settings.runtime?.guardrails?.maxMultiplierChangePercent ?? 1,
  };
  if (!Number.isSafeInteger(healthProbeIntervalSeconds) || healthProbeIntervalSeconds < 1 || healthProbeIntervalSeconds > 2_147_483) {
    throw new Error("runtime.healthProbeIntervalSeconds must be an integer from 1 to 2147483");
  }
  if (!Number.isSafeInteger(dashboardRefreshSeconds) || dashboardRefreshSeconds < 1 || dashboardRefreshSeconds > 86_400) {
    throw new Error("runtime.dashboardRefreshSeconds must be an integer from 1 to 86400");
  }
  if (!Number.isFinite(guardrails.maxUsdtUsdDeviationPercent) || guardrails.maxUsdtUsdDeviationPercent <= 0 || guardrails.maxUsdtUsdDeviationPercent > 100
    || !Number.isFinite(guardrails.maxUsdt0UsdtDeviationPercent) || guardrails.maxUsdt0UsdtDeviationPercent <= 0 || guardrails.maxUsdt0UsdtDeviationPercent > 100
    || !Number.isSafeInteger(guardrails.indexPriceRefreshSeconds) || guardrails.indexPriceRefreshSeconds < 1 || guardrails.indexPriceRefreshSeconds > 3600
    || !Number.isSafeInteger(guardrails.indexPriceMaxAgeSeconds) || guardrails.indexPriceMaxAgeSeconds < guardrails.indexPriceRefreshSeconds || guardrails.indexPriceMaxAgeSeconds > 86_400
    || !Number.isFinite(guardrails.maxDexPriceImpactPercent) || guardrails.maxDexPriceImpactPercent <= 0 || guardrails.maxDexPriceImpactPercent > 100
    || !Number.isFinite(guardrails.maxMultiplierChangePercent) || guardrails.maxMultiplierChangePercent <= 0 || guardrails.maxMultiplierChangePercent > 100) {
    throw new Error("runtime.guardrails values must be positive; percentage limits cannot exceed 100");
  }
  const assets = settings.assets.flatMap((definition) => definition.routes.map((route) => ({
    instId: definition.instId,
    tokenSymbol: definition.tokenSymbol,
    okxCurrency: definition.okxCurrency,
    observationSizesUsdt: definition.observationSizesUsdt,
    gasSafetyBufferPercent: definition.gasSafetyBufferPercent,
    dexQuoteIntervalMs: definition.dexQuoteIntervalMs,
    ...route,
    enabled: definition.enabled !== false && route.enabled,
  })));
  const routeKeys = new Set<string>();
  for (const asset of assets) {
    const addressPattern = asset.chainIndex === "196" ? /^0x[\da-f]{40}$/i : asset.chainIndex === "501" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : null;
    const quote = pinnedQuote(asset.chainIndex);
    if (!addressPattern || !addressPattern.test(asset.tokenAddress) || !addressPattern.test(asset.quoteTokenAddress)
      || (asset.chainIndex === "196" && asset.network !== "X Layer") || (asset.chainIndex === "501" && asset.network !== "Solana")
      || !quote || asset.quoteTokenSymbol !== quote.symbol || !addressesMatch(asset.chainIndex, asset.quoteTokenAddress, quote.address) || asset.quoteTokenDecimals !== 6) {
      throw new Error(`Invalid chain or pinned quote token for ${asset.instId} (${asset.network}/${asset.chainIndex})`);
    }
    const routeKey = `${asset.instId}:${asset.chainIndex}`;
    if (routeKeys.has(routeKey)) throw new Error(`Duplicate asset route ${routeKey}`);
    routeKeys.add(routeKey);
    if (!asset.okxCurrency || !asset.okxChain || !Number.isSafeInteger(asset.tokenDecimals) || asset.tokenDecimals < 0 || asset.tokenDecimals > 255
      || !Number.isSafeInteger(asset.quoteTokenDecimals) || asset.quoteTokenDecimals < 0 || asset.quoteTokenDecimals > 255) {
      throw new Error(`Invalid token metadata for ${asset.instId} (${asset.network})`);
    }
    if (!Array.isArray(asset.observationSizesUsdt) || !asset.observationSizesUsdt.length || asset.observationSizesUsdt.some((size) => !Number.isFinite(size) || size <= 0)) {
      throw new Error(`Invalid observation sizes for ${asset.instId}`);
    }
    if (asset.rebalanceCostUsdtPerTrade !== undefined && (!Number.isFinite(asset.rebalanceCostUsdtPerTrade) || asset.rebalanceCostUsdtPerTrade < 0)) throw new Error(`Invalid rebalancing cost for ${asset.instId} (${asset.network})`);
    if (asset.approvedMultiplier !== undefined && (!Number.isFinite(Number(asset.approvedMultiplier)) || Number(asset.approvedMultiplier) <= 0)) throw new Error(`Invalid approved multiplier for ${asset.instId} (${asset.network})`);
    if (!Number.isSafeInteger(asset.dexQuoteIntervalMs) || asset.dexQuoteIntervalMs < 2000
      || !Number.isFinite(asset.gasSafetyBufferPercent) || asset.gasSafetyBufferPercent < 0) throw new Error(`Invalid quote interval or gas buffer for ${asset.instId}`);
  }
  return {
    port: settings.port ?? 3000,
    runtime: { healthProbeIntervalSeconds, dashboardRefreshSeconds, guardrails },
    mysql: settings.mysql,
    okx: { key: process.env.OKX_API_KEY || "", secret: process.env.OKX_API_SECRET || "", passphrase: process.env.OKX_API_PASSPHRASE || "" },
    dex: { key: process.env.OKX_DEX_API_KEY || "", secret: process.env.OKX_DEX_API_SECRET || "", passphrase: process.env.OKX_DEX_API_PASSPHRASE || "" },
    signers: {
      xlayerPrivateKey: process.env.XLAYER_PRIVATE_KEY || "",
      solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || "",
      solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    },
    assets,
    trading: parseTrading(settings.trading, assets),
  };
}
