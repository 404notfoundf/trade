import { MeteoraDlmmAdapter } from "./adapters/meteora-dlmm.js";
import { OrcaWhirlpoolAdapter } from "./adapters/orca-whirlpool.js";
import { RaydiumClmmAdapter } from "./adapters/raydium-clmm.js";
import { UniswapV3Adapter } from "./adapters/uniswap-v3.js";
import type { MarketRegistry, RegisteredPool } from "./market-registry.js";
import type { PoolAdapter } from "./pool-adapters.js";

export function createPoolAdapter(pool: RegisteredPool, registry: MarketRegistry): PoolAdapter {
  const dex = registry.dexes[pool.dex];
  if (!dex || dex.enabled === false || dex.chain !== pool.chain) throw new Error(`Pool ${pool.id} has no enabled matching DEX adapter`);
  if (dex.adapter === "uniswap_v3" && pool.chain === "xlayer") return new UniswapV3Adapter(registry, pool);
  if (dex.adapter === "raydium_clmm" && pool.chain === "solana") return new RaydiumClmmAdapter(registry, pool);
  if (dex.adapter === "orca_whirlpool" && pool.chain === "solana") return new OrcaWhirlpoolAdapter(registry, pool);
  if (dex.adapter === "meteora_dlmm" && pool.chain === "solana") return new MeteoraDlmmAdapter(registry, pool);
  throw new Error(`Unsupported adapter for pool ${pool.id}`);
}

