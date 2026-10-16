import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { loadMarketRegistry, METEORA_XSPCX_USDC_POOL, ORCA_XSPCX_USDC_POOL, parseMarketRegistry, solveDirectPoolCandidates } from "./market-registry.js";
import { createPoolAdapter } from "./pool-adapter-factory.js";

const envKeys = ["XLAYER_RPC_HTTP", "XLAYER_RPC_WS"] as const;
const withRpcEnv = (run: () => void) => {
  const old = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.XLAYER_RPC_HTTP = "https://rpc.example";
  process.env.XLAYER_RPC_WS = "wss://rpc.example";
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
  assert.deepEqual(registry.pools.map((pool) => [pool.mode, pool.reason]), [
    ["observe_only", "wrapper_required"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"], ["observe_only", "quote_asset_not_pinned"],
  ]);
  const orca = registry.pools.find((pool) => pool.id === ORCA_XSPCX_USDC_POOL.id)!;
  assert.deepEqual([orca.address, orca.expected_fee_rate, orca.expected_tick_spacing], [ORCA_XSPCX_USDC_POOL.address, 500, 8]);
  const meteora = registry.pools.find((pool) => pool.id === METEORA_XSPCX_USDC_POOL.id)!;
  assert.deepEqual([meteora.address, meteora.expected_bin_step], [METEORA_XSPCX_USDC_POOL.address, METEORA_XSPCX_USDC_POOL.binStep]);
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
  const old = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
  try {
    const registry = parseMarketRegistry(raw);
    const pool = registry.pools.find((candidate) => candidate.id === ORCA_XSPCX_USDC_POOL.id)!;
    const adapter = createPoolAdapter(pool, registry);
    assert.equal(adapter.constructor.name, "OrcaWhirlpoolAdapter");
    assert.equal(adapter.stateSource, "adapter_watch");
    assert.equal(typeof adapter.watch, "function");
    assert.equal(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XSPCX-USDT", okxCurrency: "XSPCX", chainIndex: "501", tokenAddress: ORCA_XSPCX_USDC_POOL.assetMint, quoteTokenAddress: ORCA_XSPCX_USDC_POOL.quoteMint }]).length, 0);
  } finally { old === undefined ? delete process.env.SOLANA_RPC_URL : process.env.SOLANA_RPC_URL = old; }
});

test("registry pins the one Meteora DLMM pool and creates only an observe-only adapter", async () => {
  const raw = await readRawRegistry();
  const old = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
  try {
    const registry = parseMarketRegistry(raw);
    const pool = registry.pools.find((candidate) => candidate.id === METEORA_XSPCX_USDC_POOL.id)!;
    const adapter = createPoolAdapter(pool, registry);
    assert.equal(adapter.constructor.name, "MeteoraDlmmAdapter");
    assert.equal(adapter.stateSource, "adapter_watch");
    assert.equal(typeof adapter.watch, "function");
    assert.deepEqual(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XSPCX-USDT", okxCurrency: "XSPCX", chainIndex: "501",
      tokenAddress: METEORA_XSPCX_USDC_POOL.assetMint, quoteTokenAddress: METEORA_XSPCX_USDC_POOL.quoteMint }]), []);
  } finally { old === undefined ? delete process.env.SOLANA_RPC_URL : process.env.SOLANA_RPC_URL = old; }
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
