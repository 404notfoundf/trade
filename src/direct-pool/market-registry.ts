import { readFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { parse } from "yaml";
import { pinnedQuote } from "../market/valuation.js";

export type RegistryChainName = "xlayer" | "solana";
export const ORCA_WHIRLPOOL_PROGRAM_ADDRESS = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const METEORA_DLMM_PROGRAM_ADDRESS = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const BYREAL_CLMM_PROGRAM_ADDRESS = "REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2";
export const BYREAL_XSPCX_USDC_POOL = {
  id: "xspcx-solana-byreal-clmm-usdc",
  instrumentId: "XSPCX",
  address: "LVcDubF4BFsEw8qmxupmw74bbZfiya99kor5c3Hh24r",
  assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  assetDecimals: 8,
  quoteDecimals: 6,
  feeRate: 1_000,
  tickSpacing: 10,
} as const;
export const ORCA_XSPCX_USDC_POOL = {
  id: "xspcx-solana-orca-whirlpool-usdc",
  instrumentId: "XSPCX",
  address: "ASAxmEaTT1HFe3mVC3zbKDE4tuB28W7732XQrEMBM5W2",
  assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  assetDecimals: 8,
  quoteDecimals: 6,
} as const;
export const METEORA_XSPCX_USDC_POOL = {
  id: "xspcx-solana-meteora-dlmm-usdc",
  instrumentId: "XSPCX",
  address: "5whNk71ua6aRtNKazDqEeAimmfzuX9epJcjh4isQKprn",
  assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  assetDecimals: 8,
  quoteDecimals: 6,
  binStep: 8,
} as const;
export type RegisteredChain = { chain_id: 196 | 501; kind: "evm" | "svm"; rpc_http: string | null; rpc_ws: string | null; native_symbol: "OKB" | "SOL" };
export type RegisteredDex = {
  chain: RegistryChainName;
  adapter: "uniswap_v3" | "raydium_clmm" | "orca_whirlpool" | "meteora_dlmm" | "byreal_clmm";
  quote_source: "onchain_quoter" | "local_math";
  quoter_v2?: string;
  swap_router?: string;
  factory?: string;
  program_id?: string;
  enabled?: boolean;
};
export type RegisteredInstrument = {
  instrument_id: string;
  cex_listings: Array<{ venue: "okx"; symbol: string; currency: string }>;
  chain_assets: Array<{
    chain: RegistryChainName;
    address: string;
    decimals: number;
    quote_asset: { symbol: string; address: string; decimals: number };
  }>;
};
export type RegisteredPool = {
  id: string;
  enabled: boolean;
  instrument_id: string;
  chain: RegistryChainName;
  rpc_http: string | null;
  rpc_ws: string | null;
  dex: string;
  mode: "trade_candidate" | "observe_only";
  reason?: "wrapper_required" | "quote_asset_not_pinned" | "unverified";
  verified: boolean;
  priority?: number;
  max_notional_usdt?: string;
  address: string;
  token_in_out: { asset_address: string; asset_decimals: number; quote_address: string; quote_decimals: number };
  expected_fee_tier?: number;
  expected_fee_rate?: number;
  expected_tick_spacing?: number;
  expected_bin_step?: number;
};
export type MarketRegistry = {
  schema_version: 1;
  chains: Record<RegistryChainName, RegisteredChain>;
  cexes: { okx: { kind: "cex"; enabled: boolean; book_source: "websocket" } };
  dexes: Record<string, RegisteredDex>;
  instruments: RegisteredInstrument[];
  pools: RegisteredPool[];
};

const evmAddress = /^0x[\da-f]{40}$/i;
const solAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const positiveDecimal = /^(?:\d+\.?\d*|\.\d+)$/;
const emptyRegistry: MarketRegistry = {
  schema_version: 1,
  chains: {
    xlayer: { chain_id: 196, kind: "evm", rpc_http: null, rpc_ws: null, native_symbol: "OKB" },
    solana: { chain_id: 501, kind: "svm", rpc_http: null, rpc_ws: null, native_symbol: "SOL" },
  },
  cexes: { okx: { kind: "cex", enabled: true, book_source: "websocket" } },
  dexes: {}, instruments: [], pools: [],
};

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`market-registry.yaml ${name} must be a non-empty string`);
  return value.trim();
}
function requireDecimals(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 255) throw new Error(`market-registry.yaml ${name} must be an integer from 0 to 255`);
  return Number(value);
}
function resolveEnv(value: unknown, name: string): string | null {
  const ref = requireText(value, name);
  const match = /^env:([A-Z][A-Z0-9_]*)$/.exec(ref);
  if (!match) throw new Error(`market-registry.yaml ${name} must use an env:NAME reference`);
  return process.env[match[1]!] || null;
}
function poolRpcEndpoint(value: unknown, name: string, chainDefault: string | null): string | null {
  return value === undefined ? chainDefault : resolveEnv(value, name);
}
function address(value: unknown, chain: RegistryChainName, name: string): string {
  const text = requireText(value, name);
  const valid = chain === "xlayer" ? evmAddress.test(text) : solAddress.test(text);
  if (!valid) throw new Error(`market-registry.yaml ${name} is not a valid ${chain} address`);
  if (chain === "solana") new PublicKey(text);
  return text;
}
function chainAsset(instrument: RegisteredInstrument, chain: RegistryChainName): RegisteredInstrument["chain_assets"][number] | undefined {
  return instrument.chain_assets.find((asset) => asset.chain === chain);
}

export function parseMarketRegistry(value: unknown, enabledObservePoolIds?: readonly string[]): MarketRegistry {
  if (!record(value) || value.schema_version !== 1) throw new Error("market-registry.yaml schema_version must be 1");
  if (!record(value.chains) || !record(value.cexes) || !record(value.cexes.okx) || !record(value.dexes)
    || !Array.isArray(value.instruments) || !Array.isArray(value.pools)) throw new Error("market-registry.yaml is missing chains, cexes, dexes, instruments or pools");

  const chains = {} as MarketRegistry["chains"];
  for (const [name, chainId, kind, nativeSymbol] of [["xlayer", 196, "evm", "OKB"], ["solana", 501, "svm", "SOL"]] as const) {
    const raw = value.chains[name];
    if (!record(raw) || raw.chain_id !== chainId || raw.kind !== kind || raw.native_symbol !== nativeSymbol) throw new Error(`Invalid ${name} chain registration`);
    chains[name] = { chain_id: chainId, kind, native_symbol: nativeSymbol, rpc_http: resolveEnv(raw.rpc_http, `chains.${name}.rpc_http`), rpc_ws: resolveEnv(raw.rpc_ws, `chains.${name}.rpc_ws`) };
  }
  const okx = value.cexes.okx;
  if (okx.kind !== "cex" || typeof okx.enabled !== "boolean" || okx.book_source !== "websocket") throw new Error("Invalid OKX CEX registration");

  const dexes: MarketRegistry["dexes"] = {};
  for (const [id, raw] of Object.entries(value.dexes)) {
    if (!record(raw) || (raw.chain !== "xlayer" && raw.chain !== "solana")) throw new Error(`Invalid DEX registration ${id}`);
    const expected = raw.chain === "xlayer"
      ? raw.adapter === "uniswap_v3" && raw.quote_source === "onchain_quoter"
      : (raw.adapter === "raydium_clmm" || raw.adapter === "orca_whirlpool" || raw.adapter === "meteora_dlmm" || raw.adapter === "byreal_clmm") && raw.quote_source === "local_math";
    if (!expected || (raw.enabled !== undefined && typeof raw.enabled !== "boolean")) throw new Error(`Unknown adapter or quote source for ${id}`);
    const dex: RegisteredDex = { chain: raw.chain, adapter: raw.adapter as RegisteredDex["adapter"], quote_source: raw.quote_source as RegisteredDex["quote_source"], enabled: raw.enabled as boolean | undefined };
    if (raw.chain === "xlayer") {
      dex.quoter_v2 = address(raw.quoter_v2, "xlayer", `dexes.${id}.quoter_v2`);
      dex.swap_router = address(raw.swap_router, "xlayer", `dexes.${id}.swap_router`);
      dex.factory = address(raw.factory, "xlayer", `dexes.${id}.factory`);
    } else {
      dex.program_id = address(raw.program_id, "solana", `dexes.${id}.program_id`);
      if (raw.adapter === "orca_whirlpool" && (id !== "orca_whirlpool_solana" || dex.program_id !== ORCA_WHIRLPOOL_PROGRAM_ADDRESS)) {
        throw new Error(`Orca Whirlpool DEX ${id} must use the pinned Solana program`);
      }
      if (raw.adapter === "meteora_dlmm" && (id !== "meteora_dlmm_solana" || dex.program_id !== METEORA_DLMM_PROGRAM_ADDRESS)) {
        throw new Error(`Meteora DLMM DEX ${id} must use the pinned Solana program`);
      }
      if (raw.adapter === "byreal_clmm" && (id !== "byreal_clmm_solana" || dex.program_id !== BYREAL_CLMM_PROGRAM_ADDRESS)) {
        throw new Error(`Byreal CLMM DEX ${id} must use the pinned Solana program`);
      }
    }
    dexes[id] = dex;
  }

  const instruments: RegisteredInstrument[] = [];
  const instrumentIds = new Set<string>();
  for (const [index, raw] of value.instruments.entries()) {
    if (!record(raw) || !Array.isArray(raw.cex_listings) || !Array.isArray(raw.chain_assets)) throw new Error(`Invalid instrument at index ${index}`);
    const instrument_id = requireText(raw.instrument_id, `instruments[${index}].instrument_id`);
    if (instrumentIds.has(instrument_id)) throw new Error(`Duplicate instrument_id ${instrument_id}`);
    instrumentIds.add(instrument_id);
    const cex_listings = raw.cex_listings.map((listing, listingIndex) => {
      if (!record(listing) || listing.venue !== "okx") throw new Error(`Invalid OKX listing for ${instrument_id}`);
      return { venue: "okx" as const, symbol: requireText(listing.symbol, `instruments[${index}].cex_listings[${listingIndex}].symbol`), currency: requireText(listing.currency, `instruments[${index}].cex_listings[${listingIndex}].currency`) };
    });
    if (!cex_listings.length || new Set(cex_listings.map((listing) => listing.symbol)).size !== cex_listings.length) throw new Error(`Duplicate or missing CEX listing for ${instrument_id}`);
    const chain_assets = raw.chain_assets.map((asset, assetIndex) => {
      if (!record(asset) || (asset.chain !== "xlayer" && asset.chain !== "solana") || !record(asset.quote_asset)) throw new Error(`Invalid chain asset for ${instrument_id}`);
      const quote = pinnedQuote(chains[asset.chain].chain_id.toString());
      const quote_asset = {
        symbol: requireText(asset.quote_asset.symbol, `instruments[${index}].chain_assets[${assetIndex}].quote_asset.symbol`),
        address: address(asset.quote_asset.address, asset.chain, `instruments[${index}].chain_assets[${assetIndex}].quote_asset.address`),
        decimals: requireDecimals(asset.quote_asset.decimals, `instruments[${index}].chain_assets[${assetIndex}].quote_asset.decimals`),
      };
      if (!quote || quote_asset.symbol !== quote.symbol || quote_asset.decimals !== 6 || !sameAddress(asset.chain, quote_asset.address, quote.address)) throw new Error(`Non-pinned quote asset for ${instrument_id}/${asset.chain}`);
      return { chain: asset.chain as RegistryChainName, address: address(asset.address, asset.chain, `instruments[${index}].chain_assets[${assetIndex}].address`), decimals: requireDecimals(asset.decimals, `instruments[${index}].chain_assets[${assetIndex}].decimals`), quote_asset };
    });
    if (new Set(chain_assets.map((asset) => asset.chain)).size !== chain_assets.length) throw new Error(`Duplicate chain asset for ${instrument_id}`);
    instruments.push({ instrument_id, cex_listings, chain_assets });
  }

  const pools: RegisteredPool[] = [];
  const poolIds = new Set<string>();
  const poolKeys = new Set<string>();
  for (const [index, raw] of value.pools.entries()) {
    if (!record(raw) || (raw.chain !== "xlayer" && raw.chain !== "solana") || !record(raw.token_in_out)
      || (raw.mode !== "trade_candidate" && raw.mode !== "observe_only") || typeof raw.verified !== "boolean"
      || (raw.enabled !== undefined && typeof raw.enabled !== "boolean")) throw new Error(`Invalid pool at index ${index}`);
    const id = requireText(raw.id, `pools[${index}].id`);
    const instrument_id = requireText(raw.instrument_id, `pools[${index}].instrument_id`);
    const chain = raw.chain;
    if ((raw.rpc_http === undefined) !== (raw.rpc_ws === undefined)) throw new Error(`Pool ${id} must override rpc_http and rpc_ws together`);
    const rpc_http = poolRpcEndpoint(raw.rpc_http, `pools[${index}].rpc_http`, chains[chain].rpc_http);
    const rpc_ws = poolRpcEndpoint(raw.rpc_ws, `pools[${index}].rpc_ws`, chains[chain].rpc_ws);
    const dexId = requireText(raw.dex, `pools[${index}].dex`);
    const dex = dexes[dexId];
    const instrument = instruments.find((candidate) => candidate.instrument_id === instrument_id);
    const asset = instrument && chainAsset(instrument, chain);
    if (poolIds.has(id) || !dex || dex.enabled === false || dex.chain !== chain || !instrument || !asset) throw new Error(`Invalid or duplicate pool registration ${id}`);
    const poolAddress = address(raw.address, chain, `pools[${index}].address`);
    const assetAddress = address(raw.token_in_out.asset_address, chain, `pools[${index}].token_in_out.asset_address`);
    const quoteAddress = address(raw.token_in_out.quote_address, chain, `pools[${index}].token_in_out.quote_address`);
    const assetDecimals = requireDecimals(raw.token_in_out.asset_decimals, `pools[${index}].token_in_out.asset_decimals`);
    const quoteDecimals = requireDecimals(raw.token_in_out.quote_decimals, `pools[${index}].token_in_out.quote_decimals`);
    if (sameAddress(chain, assetAddress, quoteAddress)) throw new Error(`Pool ${id} has identical tokens`);
    const poolKey = `${instrument_id}:${chain}:${chain === "xlayer" ? poolAddress.toLowerCase() : poolAddress}`;
    if (poolKeys.has(poolKey)) throw new Error(`Duplicate instrument/chain/pool address ${poolKey}`);
    poolIds.add(id); poolKeys.add(poolKey);
    const reason = raw.reason;
    let expected_fee_rate: number | undefined;
    let expected_tick_spacing: number | undefined;
    let expected_bin_step: number | undefined;
    if (dex.adapter === "orca_whirlpool") {
      if (id !== ORCA_XSPCX_USDC_POOL.id || instrument_id !== ORCA_XSPCX_USDC_POOL.instrumentId || chain !== "solana"
        || poolAddress !== ORCA_XSPCX_USDC_POOL.address || assetAddress !== ORCA_XSPCX_USDC_POOL.assetMint
        || quoteAddress !== ORCA_XSPCX_USDC_POOL.quoteMint || assetDecimals !== ORCA_XSPCX_USDC_POOL.assetDecimals
        || quoteDecimals !== ORCA_XSPCX_USDC_POOL.quoteDecimals || raw.mode !== "observe_only" || raw.verified !== true
        || reason !== "quote_asset_not_pinned") throw new Error(`Orca Whirlpool pool ${id} does not match the pinned XSPCX/USDC observe-only registration`);
      if (!Number.isSafeInteger(raw.expected_fee_rate) || Number(raw.expected_fee_rate) < 1 || Number(raw.expected_fee_rate) > 65_535
        || !Number.isSafeInteger(raw.expected_tick_spacing) || Number(raw.expected_tick_spacing) < 1 || Number(raw.expected_tick_spacing) > 65_535
        || raw.expected_fee_tier !== undefined || raw.expected_bin_step !== undefined) throw new Error(`Pool ${id} must declare valid expected_fee_rate and expected_tick_spacing`);
      expected_fee_rate = Number(raw.expected_fee_rate);
      expected_tick_spacing = Number(raw.expected_tick_spacing);
    } else if (dex.adapter === "meteora_dlmm") {
      if (id !== METEORA_XSPCX_USDC_POOL.id || instrument_id !== METEORA_XSPCX_USDC_POOL.instrumentId || chain !== "solana"
        || poolAddress !== METEORA_XSPCX_USDC_POOL.address || assetAddress !== METEORA_XSPCX_USDC_POOL.assetMint
        || quoteAddress !== METEORA_XSPCX_USDC_POOL.quoteMint || assetDecimals !== METEORA_XSPCX_USDC_POOL.assetDecimals
        || quoteDecimals !== METEORA_XSPCX_USDC_POOL.quoteDecimals || raw.mode !== "observe_only" || raw.verified !== true
        || reason !== "quote_asset_not_pinned") throw new Error(`Meteora DLMM pool ${id} does not match the pinned XSPCX/USDC observe-only registration`);
      if (raw.expected_bin_step !== METEORA_XSPCX_USDC_POOL.binStep || raw.expected_fee_rate !== undefined
        || raw.expected_tick_spacing !== undefined || raw.expected_fee_tier !== undefined) {
        throw new Error(`Pool ${id} must declare the pinned Meteora DLMM bin step only`);
      }
      expected_bin_step = METEORA_XSPCX_USDC_POOL.binStep;
    } else if (dex.adapter === "byreal_clmm") {
      if (id !== BYREAL_XSPCX_USDC_POOL.id || instrument_id !== BYREAL_XSPCX_USDC_POOL.instrumentId || chain !== "solana"
        || poolAddress !== BYREAL_XSPCX_USDC_POOL.address || assetAddress !== BYREAL_XSPCX_USDC_POOL.assetMint
        || quoteAddress !== BYREAL_XSPCX_USDC_POOL.quoteMint || assetDecimals !== BYREAL_XSPCX_USDC_POOL.assetDecimals
        || quoteDecimals !== BYREAL_XSPCX_USDC_POOL.quoteDecimals || raw.mode !== "observe_only" || raw.verified !== true
        || reason !== "quote_asset_not_pinned") throw new Error(`Byreal CLMM pool ${id} does not match the pinned XSPCX/USDC observe-only registration`);
      if (raw.expected_fee_rate !== BYREAL_XSPCX_USDC_POOL.feeRate || raw.expected_tick_spacing !== BYREAL_XSPCX_USDC_POOL.tickSpacing
        || raw.expected_fee_tier !== undefined || raw.expected_bin_step !== undefined) throw new Error(`Pool ${id} must declare the pinned Byreal fee rate and tick spacing`);
      expected_fee_rate = BYREAL_XSPCX_USDC_POOL.feeRate;
      expected_tick_spacing = BYREAL_XSPCX_USDC_POOL.tickSpacing;
    } else if (raw.expected_fee_rate !== undefined || raw.expected_tick_spacing !== undefined || raw.expected_bin_step !== undefined) {
      throw new Error(`Pool ${id} uses protocol-specific fee or bin-step fields`);
    }
    if (raw.mode === "trade_candidate") {
      if (!raw.verified || !Number.isSafeInteger(raw.priority) || Number(raw.priority) < 0
        || typeof raw.max_notional_usdt !== "string" || !positiveDecimal.test(raw.max_notional_usdt) || Number(raw.max_notional_usdt) <= 0
        || !sameAddress(chain, assetAddress, asset.address) || !sameAddress(chain, quoteAddress, asset.quote_asset.address)
        || assetDecimals !== asset.decimals || quoteDecimals !== asset.quote_asset.decimals
        || !rpc_http || !rpc_ws
        || (chain === "xlayer" && (!dex.factory || !dex.quoter_v2 || !dex.swap_router))
        || (chain === "solana" && !dex.program_id)
        || reason !== undefined) throw new Error(`Unsafe or incomplete trade_candidate registration ${id}`);
    } else if (reason !== "wrapper_required" && reason !== "quote_asset_not_pinned" && reason !== "unverified") {
      throw new Error(`observe_only pool ${id} must declare a blocking reason`);
    }
    let expected_fee_tier: number | undefined;
    if (chain === "xlayer") {
      if (!Number.isSafeInteger(raw.expected_fee_tier) || Number(raw.expected_fee_tier) < 0 || Number(raw.expected_fee_tier) > 1_000_000) throw new Error(`Pool ${id} has invalid expected_fee_tier`);
      expected_fee_tier = Number(raw.expected_fee_tier);
    }
    pools.push({ id, enabled: raw.enabled !== false, instrument_id, chain, rpc_http, rpc_ws, dex: dexId, mode: raw.mode, reason: reason as RegisteredPool["reason"], verified: raw.verified,
      priority: raw.priority as number | undefined, max_notional_usdt: raw.max_notional_usdt as string | undefined,
      address: poolAddress, token_in_out: { asset_address: assetAddress, asset_decimals: assetDecimals, quote_address: quoteAddress, quote_decimals: quoteDecimals },
      expected_fee_tier, expected_fee_rate, expected_tick_spacing, expected_bin_step });
  }
  const registry: MarketRegistry = { schema_version: 1, chains, cexes: { okx: { kind: "cex", enabled: okx.enabled, book_source: "websocket" } }, dexes, instruments, pools };
  if (enabledObservePoolIds === undefined) return registry;
  const selected = new Set(enabledObservePoolIds);
  if (selected.size !== enabledObservePoolIds.length) throw new Error("MARKET_REGISTRY_OBSERVE_POOL_IDS contains duplicate pool ids");
  const known = new Set(pools.map((pool) => pool.id));
  const unknown = enabledObservePoolIds.find((id) => !known.has(id));
  if (unknown) throw new Error(`MARKET_REGISTRY_OBSERVE_POOL_IDS references unknown pool id: ${unknown}`);
  const tradeCandidate = enabledObservePoolIds.find((id) => pools.find((pool) => pool.id === id)?.mode !== "observe_only");
  if (tradeCandidate) throw new Error(`MARKET_REGISTRY_OBSERVE_POOL_IDS cannot enable trade_candidate pool: ${tradeCandidate}`);
  return { ...registry, pools: pools.map((pool) => pool.mode === "observe_only" ? { ...pool, enabled: selected.has(pool.id) } : pool) };
}

function sameAddress(chain: RegistryChainName, left: string, right: string): boolean {
  return chain === "xlayer" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function loadMarketRegistry(): Promise<MarketRegistry> {
  try {
    const configuredPoolIds = process.env.MARKET_REGISTRY_OBSERVE_POOL_IDS;
    const enabledObservePoolIds = configuredPoolIds === undefined ? undefined : configuredPoolIds === "" ? [] : configuredPoolIds.split(",").map((id) => id.trim());
    if (enabledObservePoolIds?.some((id) => !id)) throw new Error("MARKET_REGISTRY_OBSERVE_POOL_IDS must be a comma-separated list of observe_only pool ids");
    return parseMarketRegistry(parse(await readFile(new URL("../../market-registry.yaml", import.meta.url), "utf8")), enabledObservePoolIds);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyRegistry;
    throw error;
  }
}

export function solveDirectPoolCandidates(registry: MarketRegistry, assets: Array<{ enabled?: boolean; instId: string; okxCurrency: string; chainIndex: string; tokenAddress: string; quoteTokenAddress: string }>): RegisteredPool[] {
  if (!registry.cexes.okx.enabled) return [];
  return registry.pools.filter((pool) => {
    if (pool.enabled === false || pool.mode !== "trade_candidate" || !pool.verified) return false;
    const instrument = registry.instruments.find((candidate) => candidate.instrument_id === pool.instrument_id);
    const listing = instrument?.cex_listings.find((item) => item.venue === "okx");
    const chainAsset = instrument && chainAssetFor(instrument, pool.chain);
    const chainIndex = registry.chains[pool.chain].chain_id.toString();
    return !!listing && !!chainAsset && assets.some((asset) => asset.enabled !== false && asset.instId === listing.symbol && asset.okxCurrency === listing.currency
      && asset.chainIndex === chainIndex && sameAddress(pool.chain, asset.tokenAddress, chainAsset.address)
      && sameAddress(pool.chain, asset.quoteTokenAddress, chainAsset.quote_asset.address)
      && sameAddress(pool.chain, pool.token_in_out.asset_address, chainAsset.address)
      && sameAddress(pool.chain, pool.token_in_out.quote_address, chainAsset.quote_asset.address));
  }).sort((a, b) => a.instrument_id.localeCompare(b.instrument_id) || a.chain.localeCompare(b.chain) || a.priority! - b.priority!);
}

function chainAssetFor(instrument: RegisteredInstrument, chain: RegistryChainName) {
  return instrument.chain_assets.find((asset) => asset.chain === chain);
}

export function emptyMarketRegistry(): MarketRegistry { return structuredClone(emptyRegistry); }
