import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { addressesMatch, pinnedQuote } from "./market/valuation.js";
import { parseTrading, type TradingConfig } from "./trading/config.js";
import { loadMarketRegistry, type MarketRegistry } from "./direct-pool/market-registry.js";

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

export type FixedPoolConfig = {
  enabled: boolean;
  id: string;
  instId: string;
  chainIndex: "196" | "501";
  dex: "uniswap-v3" | "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm";
  address: string;
  baseTokenSymbol: string;
  baseTokenAddress: string;
  baseTokenDecimals: number;
  quoteTokenSymbol: string;
  quoteTokenAddress: string;
  quoteTokenDecimals: number;
  baseTokenToCexAssetRatio: string;
  expectedFee?: number;
  expectedFactory?: string;
  expectedProgramId?: string;
};

type AssetDefinition = Omit<AssetConfig, "enabled" | "network" | "chainIndex" | "okxChain" | "tokenAddress" | "tokenDecimals" | "quoteTokenAddress" | "quoteTokenDecimals" | "quoteTokenSymbol" | "approvedMultiplier" | "rebalanceCostUsdtPerTrade"> & {
  enabled?: boolean;
  routes: Array<Pick<AssetConfig, "enabled" | "network" | "chainIndex" | "okxChain" | "tokenAddress" | "tokenDecimals" | "quoteTokenAddress" | "quoteTokenDecimals" | "quoteTokenSymbol" | "approvedMultiplier" | "rebalanceCostUsdtPerTrade">>;
};

export type Config = {
  port: number;
  marketdata: { quoteProvider: "aggregator" | "direct_pool"; aggregatorShadow: boolean; coalesceWindowMs: number; directQuoteRetentionDays: number; directDecisionRetentionDays: number };
  directPoolObservation: { simulationEnabled: boolean; xlayerWrapThenSwapGasUsdt: number; xlayerSwapThenUnwrapGasUsdt: number; solanaSwapGasUsdt: number };
  runtime: { healthProbeIntervalSeconds: number; guardrails: { maxUsdtUsdDeviationPercent: number; maxUsdt0UsdtDeviationPercent: number; indexPriceRefreshSeconds: number; indexPriceMaxAgeSeconds: number; maxDexPriceImpactPercent: number; maxMultiplierChangePercent: number } };
  mysql: { host: string; port: number; user: string; password: string; database: string };
  okx: { key: string; secret: string; passphrase: string };
  dex: { key: string; secret: string; passphrase: string };
  signers: { xlayerPrivateKey: string; solanaPrivateKey: string; solanaSimulationPrivateKey: string; solanaRpcUrl: string };
  assets: AssetConfig[];
  fixedPools: FixedPoolConfig[];
  marketRegistry: MarketRegistry;
  trading: TradingConfig;
};

export async function loadConfig(): Promise<Config> {
  const settings = parse(await readFile(new URL("../config.yaml", import.meta.url), "utf8")) as {
    port?: number;
    runtime?: Partial<Config["runtime"]>;
    marketdata?: {
      quote_provider?: "aggregator" | "direct_pool";
      aggregator_shadow?: boolean;
      coalesce_window_ms?: number;
      direct_quote_retention_days?: number;
      direct_decision_retention_days?: number;
    };
    direct_pool_observation?: {
      simulation_enabled?: boolean;
      xlayer_wrap_then_swap_gas_usdt?: number;
      xlayer_swap_then_unwrap_gas_usdt?: number;
      solana_swap_gas_usdt?: number;
    };
    mysql?: Config["mysql"];
    assets?: AssetDefinition[];
    trading?: unknown;
    fixedPools?: FixedPoolConfig[];
  };
  if (!Array.isArray(settings.assets)) throw new Error("config.yaml must contain an assets list");
  if (settings.assets.some((asset) => asset.enabled !== undefined && typeof asset.enabled !== "boolean")) throw new Error("Each asset enabled flag must be a boolean");
  if (settings.assets.some((asset) => !Array.isArray(asset.routes) || asset.routes.length === 0)) throw new Error("Each asset must contain at least one route");
  if (settings.assets.some((asset) => asset.routes.some((route) => typeof route.enabled !== "boolean"))) throw new Error("Each asset route enabled flag must be a boolean");
  if (!settings.mysql) throw new Error("config.yaml must contain MySQL settings");
  const marketdata = {
    quoteProvider: settings.marketdata?.quote_provider ?? "aggregator",
    aggregatorShadow: settings.marketdata?.aggregator_shadow ?? false,
    coalesceWindowMs: settings.marketdata?.coalesce_window_ms ?? 250,
    directQuoteRetentionDays: settings.marketdata?.direct_quote_retention_days ?? 7,
    directDecisionRetentionDays: settings.marketdata?.direct_decision_retention_days ?? 180,
  };
  if ((marketdata.quoteProvider !== "aggregator" && marketdata.quoteProvider !== "direct_pool")
    || typeof marketdata.aggregatorShadow !== "boolean"
    || !Number.isSafeInteger(marketdata.coalesceWindowMs) || Number(marketdata.coalesceWindowMs) < 200 || Number(marketdata.coalesceWindowMs) > 250
    || !Number.isSafeInteger(marketdata.directQuoteRetentionDays) || Number(marketdata.directQuoteRetentionDays) < 1 || Number(marketdata.directQuoteRetentionDays) > 3650
    || !Number.isSafeInteger(marketdata.directDecisionRetentionDays) || Number(marketdata.directDecisionRetentionDays) < 1 || Number(marketdata.directDecisionRetentionDays) > 36500) {
    throw new Error("Invalid marketdata settings");
  }
  if (marketdata.aggregatorShadow && marketdata.quoteProvider !== "direct_pool") {
    throw new Error("marketdata.aggregator_shadow requires quote_provider: direct_pool");
  }
  const observation = {
    simulationEnabled: settings.direct_pool_observation?.simulation_enabled ?? false,
    xlayerWrapThenSwapGasUsdt: settings.direct_pool_observation?.xlayer_wrap_then_swap_gas_usdt ?? 0.05,
    xlayerSwapThenUnwrapGasUsdt: settings.direct_pool_observation?.xlayer_swap_then_unwrap_gas_usdt ?? 0.05,
    solanaSwapGasUsdt: settings.direct_pool_observation?.solana_swap_gas_usdt ?? 0.01,
  };
  if (typeof observation.simulationEnabled !== "boolean"
    || [observation.xlayerWrapThenSwapGasUsdt, observation.xlayerSwapThenUnwrapGasUsdt, observation.solanaSwapGasUsdt]
      .some((value) => !Number.isFinite(value) || value < 0 || value > 1_000)) {
    throw new Error("direct_pool_observation requires a boolean simulation_enabled and gas budgets between 0 and 1000 USDT");
  }
  const healthProbeIntervalSeconds = settings.runtime?.healthProbeIntervalSeconds ?? 300;
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
  const fixedPools = settings.fixedPools ?? [];
  if (!Array.isArray(fixedPools)) throw new Error("fixedPools must be a list");
  const poolIds = new Set<string>();
  const poolAddresses = new Set<string>();
  for (const pool of fixedPools) {
    const addressPattern = pool.chainIndex === "196" ? /^0x[\da-f]{40}$/i : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const familyMetadataValid = pool.chainIndex === "196"
      ? Number.isSafeInteger(pool.expectedFee) && !!pool.expectedFactory && /^0x[\da-f]{40}$/i.test(pool.expectedFactory)
      : !!pool.expectedProgramId && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool.expectedProgramId);
    const addressKey = `${pool.chainIndex}:${pool.chainIndex === "196" ? pool.address?.toLowerCase() : pool.address}`;
    if (typeof pool.enabled !== "boolean" || !pool.id || pool.id.length > 27 || poolIds.has(pool.id) || poolAddresses.has(addressKey) || !pool.instId
      || !settings.assets.some((asset) => asset.instId === pool.instId) || !pool.baseTokenSymbol || !pool.quoteTokenSymbol
      || (pool.chainIndex !== "196" && pool.chainIndex !== "501")
      || pool.baseTokenAddress === pool.quoteTokenAddress
      || !addressPattern.test(pool.address) || !addressPattern.test(pool.baseTokenAddress) || !addressPattern.test(pool.quoteTokenAddress)
      || (pool.chainIndex === "196" && pool.dex !== "uniswap-v3") || (pool.chainIndex === "501" && pool.dex !== "raydium-clmm")
      || !familyMetadataValid || !Number.isSafeInteger(pool.baseTokenDecimals) || !Number.isSafeInteger(pool.quoteTokenDecimals) || pool.baseTokenDecimals < 0 || pool.baseTokenDecimals > 255 || pool.quoteTokenDecimals < 0 || pool.quoteTokenDecimals > 255
      || !/^(?:\d+\.?\d*|\.\d+)$/.test(pool.baseTokenToCexAssetRatio) || !Number.isFinite(Number(pool.baseTokenToCexAssetRatio)) || Number(pool.baseTokenToCexAssetRatio) <= 0) throw new Error(`Invalid fixed pool ${pool.id || "(missing id)"}`);
    poolIds.add(pool.id);
    poolAddresses.add(addressKey);
  }
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
    marketdata: {
      quoteProvider: marketdata.quoteProvider as Config["marketdata"]["quoteProvider"],
      aggregatorShadow: marketdata.aggregatorShadow as boolean,
      coalesceWindowMs: marketdata.coalesceWindowMs as number,
      directQuoteRetentionDays: marketdata.directQuoteRetentionDays as number,
      directDecisionRetentionDays: marketdata.directDecisionRetentionDays as number,
    },
    directPoolObservation: observation,
    runtime: { healthProbeIntervalSeconds, guardrails },
    mysql: settings.mysql,
    okx: { key: process.env.OKX_API_KEY || "", secret: process.env.OKX_API_SECRET || "", passphrase: process.env.OKX_API_PASSPHRASE || "" },
    dex: { key: process.env.OKX_DEX_API_KEY || "", secret: process.env.OKX_DEX_API_SECRET || "", passphrase: process.env.OKX_DEX_API_PASSPHRASE || "" },
    signers: {
      xlayerPrivateKey: process.env.XLAYER_PRIVATE_KEY || "",
      solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY || "",
      solanaSimulationPrivateKey: process.env.SOLANA_SIMULATION_PRIVATE_KEY || "",
      solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    },
    assets,
    fixedPools,
    marketRegistry: await loadMarketRegistry(),
    trading: parseTrading(settings.trading, assets),
  };
}
