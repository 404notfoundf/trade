import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { loadMarketRegistry, parseMarketRegistry, solveDirectPoolCandidates } from "./market-registry.js";

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
  assert.deepEqual(registry.pools.map((pool) => [pool.mode, pool.reason]), [
    ["observe_only", "wrapper_required"], ["observe_only", "quote_asset_not_pinned"],
  ]);
  assert.deepEqual(solveDirectPoolCandidates(registry, [{ enabled: true, instId: "XNVDA-USDT", okxCurrency: "XNVDA", chainIndex: "196", tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", quoteTokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736" }]), []);
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
