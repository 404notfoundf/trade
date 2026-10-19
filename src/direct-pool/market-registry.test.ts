import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { BYREAL_CLMM_PROGRAM_ADDRESS, BYREAL_XSPCX_USDC_POOL, loadMarketRegistry, METEORA_XSPCX_USDC_POOL, ORCA_XSPCX_USDC_POOL, parseMarketRegistry, solveDirectPoolCandidates } from "./market-registry.js";
import { createPoolAdapter } from "./pool-adapter-factory.js";

const envKeys = ["XLAYER_RPC_HTTP", "XLAYER_RPC_WS"] as const;
const solanaPoolEnvKeys = ["SOLANA_RPC_URL", "SOLANA_RPC_WS", "SOLANA_XSPCX_ORCA_RPC_HTTP", "SOLANA_XSPCX_ORCA_RPC_WS", "SOLANA_XSPCX_METEORA_RPC_HTTP", "SOLANA_XSPCX_METEORA_RPC_WS"] as const;
const withRpcEnv = (run: () => void) => {
  const old = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.XLAYER_RPC_HTTP = "https://rpc.example";
  process.env.XLAYER_RPC_WS = "wss://rpc.example";
  try { run(); }
  finally { for (const [key, value] of old) value === undefined ? delete process.env[key] : process.env[key] = value; }
};
const withSolanaPoolRpcEnv = (run: () => void) => {
  const old = new Map(solanaPoolEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of solanaPoolEnvKeys) process.env[key] = key.endsWith("_WS") ? "wss://rpc.example" : "https://rpc.example";
  try { run(); }
  finally { for (const [key, value] of old) value === undefined ? delete process.env[key] : process.env[key] = value; }
};

async function readRawRegistry(): Promise<any> {
  return parse(await readFile(new URL("../../market-registry.yaml", import.meta.url), "utf8"));
}

test("existing wrapped and non-pinned pools stay observe-only and produce no candidate route", async () => {
  const registry = await loadMarketRegistry();
  assert.equal(registry.dexes.uniswap_v3_xlayer?.quoter_v2, "0xd1b797d92d87b688193a2b976efc8d577d204343");
  assert.equal(registry.dexes.uniswap_v3_xlayer?.swap_router, "0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca");
  assert.equal(registry.dexes.uniswap_v3_xlayer?.factory, "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804");
  assert.equal(registry.dexes.raydium_clmm_solana?.program_id, "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  assert.equal(registry.dexes.orca_whirlpool_solana?.adapter, "orca_whirlpool");
  assert.equal(registry.dexes.meteora_dlmm_solana?.adapter, "meteora_dlmm");
  assert.deepEqual([registry.dexes.byreal_clmm_solana?.adapter, registry.dexes.byreal_clmm_solana?.program_id], ["byreal_clmm", BYREAL_CLMM_PROGRAM_ADDRESS]);
  assert.deepEqual(registry.pools.map((pool) => [pool.mode, pool.reason]), [
    ["observe_only", "wrapper_required"], ["observe_only", "wrapper_required"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"],
  ]);
  const wspcxx = registry.pools.find((pool) => pool.id === "xspcx-xlayer-wspcxx-usdg-v3")!;
  assert.deepEqual([wspcxx.enabled, wspcxx.address, wspcxx.token_in_out.asset_address, wspcxx.token_in_out.quote_address, wspcxx.expected_fee_tier], [
    true, "0x535aabfaf9a6fbc1a04317b98885706dc6bf1650", "0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072", "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", 500,
  ]);
  const orca = registry.pools.find((pool) => pool.id === ORCA_XSPCX_USDC_POOL.id)!;
  assert.deepEqual([orca.address, orca.expected_fee_rate, orca.expected_tick_spacing], [ORCA_XSPCX_USDC_POOL.address, 500, 8]);
  const meteora = registry.pools.find((pool) => pool.id === METEORA_XSPCX_USDC_POOL.id)!;
  assert.deepEqual([meteora.address, meteora.expected_bin_step], [METEORA_XSPCX_USDC_POOL.address, METEORA_XSPCX_USDC_POOL.binStep]);
  const byreal = registry.pools.find((pool) => pool.id === BYREAL_XSPCX_USDC_POOL.id)!;
  assert.deepEqual([byreal.address, byreal.expected_fee_rate, byreal.expected_tick_spacing], [BYREAL_XSPCX_USDC_POOL.address, BYREAL_XSPCX_USDC_POOL.feeRate, BYREAL_XSPCX_USDC_POOL.tickSpacing]);
  assert.deepEqual(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XNVDA-USDT", okxCurrency: "XNVDA", chainIndex: "196", tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", quoteTokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736" }]), []);
});

test("registry rejects Orca identity or fee/tick metadata drift", async () => {
  const mutations: Array<(pool: any, dex: any) => void> = [
    (pool) => { pool.address = "ASAxmEaTT1HFe3mVC3zbKDE4tuB28W7732XQrEMBM5W3"; },
    (pool) => { pool.expected_fee_rate = 0; },
    (pool) => { delete pool.expected_tick_spacing; },
    (_pool, dex) => { dex.program_id = "11111111111111111111111111111111"; },
    (pool) => { pool.token_in_out.asset_decimals = 9; },
  ];
  for (const mutate of mutations) {
    const raw = await readRawRegistry();
    const pool = raw.pools.find((candidate: any) => candidate.id === ORCA_XSPCX_USDC_POOL.id);
    mutate(pool, raw.dexes.orca_whirlpool_solana);
    assert.throws(() => parseMarketRegistry(raw));
  }
});

test("registry creates the fixed Orca adapter without changing observe-only eligibility", async () => {
  const raw = await readRawRegistry();
  withSolanaPoolRpcEnv(() => {
    const registry = parseMarketRegistry(raw);
    const pool = registry.pools.find((candidate) => candidate.id === ORCA_XSPCX_USDC_POOL.id)!;
    const adapter = createPoolAdapter(pool, registry);
    assert.equal(adapter.constructor.name, "OrcaWhirlpoolAdapter");
    assert.equal(adapter.stateSource, "adapter_watch");
    assert.equal(typeof adapter.watch, "function");
    assert.equal(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XSPCX-USDT", okxCurrency: "XSPCX", chainIndex: "501", tokenAddress: ORCA_XSPCX_USDC_POOL.assetMint, quoteTokenAddress: ORCA_XSPCX_USDC_POOL.quoteMint }]).length, 0);
  });
});

test("registry pins the one Meteora DLMM pool and creates only an observe-only adapter", async () => {
  const raw = await readRawRegistry();
  withSolanaPoolRpcEnv(() => {
    const registry = parseMarketRegistry(raw);
    const pool = registry.pools.find((candidate) => candidate.id === METEORA_XSPCX_USDC_POOL.id)!;
    const adapter = createPoolAdapter(pool, registry);
    assert.equal(adapter.constructor.name, "MeteoraDlmmAdapter");
    assert.equal(adapter.stateSource, "adapter_watch");
    assert.equal(typeof adapter.watch, "function");
    assert.deepEqual(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XSPCX-USDT", okxCurrency: "XSPCX", chainIndex: "501",
      tokenAddress: METEORA_XSPCX_USDC_POOL.assetMint, quoteTokenAddress: METEORA_XSPCX_USDC_POOL.quoteMint }]), []);
  });
});

test("registry rejects Meteora program, pool, mint, mode or bin-step drift", async () => {
  const mutations: Array<(pool: any, dex: any) => void> = [
    (pool) => { pool.address = "5whNk71ua6aRtNKazDqEeAimmfzuX9epJcjh4isQKprq"; },
    (pool) => { pool.expected_bin_step = 9; },
    (pool) => { pool.token_in_out.quote_address = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; },
    (pool) => { pool.mode = "trade_candidate"; },
    (_pool, dex) => { dex.program_id = "11111111111111111111111111111111"; },
  ];
  for (const mutate of mutations) {
    const raw = await readRawRegistry();
    const pool = raw.pools.find((candidate: any) => candidate.id === METEORA_XSPCX_USDC_POOL.id);
    mutate(pool, raw.dexes.meteora_dlmm_solana);
    assert.throws(() => parseMarketRegistry(raw));
  }
});

test("registry pins the Byreal CLMM pool and keeps it observe-only", async () => {
  const raw = await readRawRegistry();
  withSolanaPoolRpcEnv(() => {
    const registry = parseMarketRegistry(raw);
    const pool = registry.pools.find((candidate) => candidate.id === BYREAL_XSPCX_USDC_POOL.id)!;
    const adapter = createPoolAdapter(pool, registry);
    assert.equal(adapter.constructor.name, "ByrealClmmAdapter");
    assert.equal(adapter.stateSource, "adapter_watch");
    assert.equal(typeof adapter.watch, "function");
    assert.deepEqual(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XSPCX-USDT", okxCurrency: "XSPCX", chainIndex: "501",
      tokenAddress: BYREAL_XSPCX_USDC_POOL.assetMint, quoteTokenAddress: BYREAL_XSPCX_USDC_POOL.quoteMint }]), []);
  });
});

test("registry rejects Byreal program, pool, mint, mode or fee metadata drift", async () => {
  const mutations: Array<(pool: any, dex: any) => void> = [
    (pool) => { pool.address = "LVcDubF4BFsEw8qmxupmw74bbZfiya99kor5c3Hh24s"; },
    (pool) => { pool.expected_fee_rate = 999; },
    (pool) => { pool.expected_tick_spacing = 8; },
    (pool) => { pool.token_in_out.quote_address = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"; },
    (pool) => { pool.mode = "trade_candidate"; },
    (_pool, dex) => { dex.program_id = "11111111111111111111111111111111"; },
  ];
  for (const mutate of mutations) {
    const raw = await readRawRegistry();
    const pool = raw.pools.find((candidate: any) => candidate.id === BYREAL_XSPCX_USDC_POOL.id);
    mutate(pool, raw.dexes.byreal_clmm_solana);
    assert.throws(() => parseMarketRegistry(raw));
  }
});

test("registry accepts a complete direct pinned-quote candidate and solves it by CEX listing", async () => {
  const raw = await readRawRegistry();
  raw.pools.push({
    id: "xnvda-xlayer-usdt0-direct", instrument_id: "XNVDA", chain: "xlayer", dex: "uniswap_v3_xlayer",
    mode: "trade_candidate", verified: true, priority: 10, max_notional_usdt: "100", expected_fee_tier: 500,
    address: "0x4444444444444444444444444444444444444444",
    token_in_out: { asset_address: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", asset_decimals: 18, quote_address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", quote_decimals: 6 },
  });
  withRpcEnv(() => {
    const registry = parseMarketRegistry(raw);
    const routes = solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XNVDA-USDT", okxCurrency: "XNVDA", chainIndex: "196", tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", quoteTokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736" }]);
    assert.deepEqual(routes.map((pool) => pool.id), ["xnvda-xlayer-usdt0-direct"]);
    assert.equal(createPoolAdapter(routes[0]!, registry).stateSource, "fixed_monitor");
    assert.deepEqual(solveDirectPoolCandidates(registry, [{ enabled: false, instId: "XNVDA-USDT", okxCurrency: "XNVDA", chainIndex: "196", tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", quoteTokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736" }]), []);
  });
});

test("registry rejects a wrapper or non-pinned quote promoted to trade_candidate", async () => {
  const raw = await readRawRegistry();
  Object.assign(raw.pools[0], { mode: "trade_candidate", priority: 1, max_notional_usdt: "100" });
  delete raw.pools[0].reason;
  withRpcEnv(() => assert.throws(() => parseMarketRegistry(raw), /Unsafe or incomplete trade_candidate/));
});

test("registry rejects malformed protocol deployment addresses", async () => {
  const raw = await readRawRegistry();
  raw.dexes.raydium_clmm_solana.program_id = "not-a-solana-address";
  assert.throws(() => parseMarketRegistry(raw), /not a valid solana address/);
});
