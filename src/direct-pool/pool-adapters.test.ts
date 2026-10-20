import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import Decimal from "decimal.js";
import { Interface } from "ethers";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { WebSocketServer } from "ws";
import { assertMeteoraFullFill, byrealQuotePerAsset, createSolanaSimulationTransaction, encodeUniswapV3Swap, impactFromMarginalPrice, impactFromOrcaSqrtPrice, impactFromSqrtPrice, isScopedToken2022Pool, meteoraSwapForY, minimumOut, orcaInputMint, startSolanaAccountWatch, usableXLayerQuoteSnapshot } from "./pool-adapters.js";
import { BYREAL_CLMM_PROGRAM_ADDRESS, BYREAL_XSPCX_USDC_POOL, METEORA_DLMM_PROGRAM_ADDRESS, METEORA_XSPCX_USDC_POOL, ORCA_XSPCX_USDC_POOL, type RegisteredPool } from "./market-registry.js";

const pool = {
  id: "pool", token_in_out: {
    asset_address: "0x1111111111111111111111111111111111111111",
    asset_decimals: 6, quote_address: "0x2222222222222222222222222222222222222222", quote_decimals: 6,
  },
} as RegisteredPool;

test("Uniswap spot comparison reports exact-in impact in both directions", () => {
  const q96 = 2n ** 96n;
  assert.equal(impactFromSqrtPrice(q96, "asset_to_quote", 100n, 100n, 6, 6, pool), "0");
  assert.ok(new Decimal(impactFromSqrtPrice(q96, "asset_to_quote", 100n, 99n, 6, 6, pool)).minus(1).abs().lt("1e-12"));
  assert.ok(new Decimal(impactFromSqrtPrice(q96, "quote_to_asset", 100n, 99n, 6, 6, pool)).minus(1).abs().lt("1e-12"));
});

test("minimum output applies integer basis-point slippage without rounding up", () => {
  assert.equal(minimumOut(10_001n, 50), 9_950n);
  assert.equal(minimumOut(999n, 0), 999n);
});

test("Byreal spot conversion handles either mint order and rejects invalid prices", () => {
  assert.equal(byrealQuotePerAsset(new Decimal("2"), true).toString(), "2");
  assert.equal(byrealQuotePerAsset(new Decimal("2"), false).toString(), "0.5");
  assert.throws(() => byrealQuotePerAsset(new Decimal(0), true), /positive/);
});

test("Orca directions use the pinned raw mint pair and spot-price decimal normalization", () => {
  const orca = { ...pool, id: ORCA_XSPCX_USDC_POOL.id, instrument_id: "XSPCX", chain: "solana", mode: "observe_only", verified: true,
    address: ORCA_XSPCX_USDC_POOL.address, token_in_out: { asset_address: ORCA_XSPCX_USDC_POOL.assetMint, asset_decimals: 8,
      quote_address: ORCA_XSPCX_USDC_POOL.quoteMint, quote_decimals: 6 } } as RegisteredPool;
  assert.equal(orcaInputMint(orca, "asset_to_quote"), ORCA_XSPCX_USDC_POOL.assetMint);
  assert.equal(orcaInputMint(orca, "quote_to_asset"), ORCA_XSPCX_USDC_POOL.quoteMint);
  assert.equal(impactFromOrcaSqrtPrice(2n ** 64n, "asset_to_quote", 100_000_000n, 100_000_000n, 8, 6, true), "0");
  assert.equal(impactFromOrcaSqrtPrice(2n ** 64n, "quote_to_asset", 100_000_000n, 100_000_000n, 8, 6, true), "0");
  assert.throws(() => impactFromOrcaSqrtPrice(0n, "asset_to_quote", 1n, 1n, 8, 6, true), /must be positive/);
});

test("Token-2022 review exception is scoped to the exact protocol, pool and mint pair", () => {
  const orca = { ...pool, id: ORCA_XSPCX_USDC_POOL.id, instrument_id: "XSPCX", chain: "solana", mode: "observe_only", verified: true,
    address: ORCA_XSPCX_USDC_POOL.address, token_in_out: { asset_address: ORCA_XSPCX_USDC_POOL.assetMint, asset_decimals: 8,
      quote_address: ORCA_XSPCX_USDC_POOL.quoteMint, quote_decimals: 6 } } as RegisteredPool;
  assert.equal(isScopedToken2022Pool(orca, "orca_whirlpool", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), true);
  assert.equal(isScopedToken2022Pool(orca, "raydium_clmm", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), false);
  assert.equal(isScopedToken2022Pool({ ...orca, verified: false }, "orca_whirlpool", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), false);
  const meteora = { ...orca, id: METEORA_XSPCX_USDC_POOL.id, address: METEORA_XSPCX_USDC_POOL.address };
  assert.equal(isScopedToken2022Pool(meteora, "meteora_dlmm", METEORA_DLMM_PROGRAM_ADDRESS), true);
  assert.equal(isScopedToken2022Pool({ ...meteora, token_in_out: { ...meteora.token_in_out, quote_address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } }, "meteora_dlmm", METEORA_DLMM_PROGRAM_ADDRESS), false);
  const byreal = { ...orca, id: BYREAL_XSPCX_USDC_POOL.id, address: BYREAL_XSPCX_USDC_POOL.address };
  assert.equal(isScopedToken2022Pool(byreal, "byreal_clmm", BYREAL_CLMM_PROGRAM_ADDRESS), true);
  assert.equal(isScopedToken2022Pool({ ...byreal, mode: "trade_candidate" }, "byreal_clmm", BYREAL_CLMM_PROGRAM_ADDRESS), false);
});

test("Meteora direction follows the pool's token X mint and rejects partial exact-in consumption", () => {
  const meteora = { ...pool, id: METEORA_XSPCX_USDC_POOL.id, instrument_id: "XSPCX", chain: "solana", mode: "observe_only", verified: true,
    address: METEORA_XSPCX_USDC_POOL.address, token_in_out: { asset_address: METEORA_XSPCX_USDC_POOL.assetMint, asset_decimals: 8,
      quote_address: METEORA_XSPCX_USDC_POOL.quoteMint, quote_decimals: 6 } } as RegisteredPool;
  assert.equal(meteoraSwapForY(meteora, "asset_to_quote", METEORA_XSPCX_USDC_POOL.assetMint), true);
  assert.equal(meteoraSwapForY(meteora, "quote_to_asset", METEORA_XSPCX_USDC_POOL.assetMint), false);
  assert.equal(meteoraSwapForY(meteora, "asset_to_quote", METEORA_XSPCX_USDC_POOL.quoteMint), false);
  assert.equal(meteoraSwapForY(meteora, "quote_to_asset", METEORA_XSPCX_USDC_POOL.quoteMint), true);
  assert.throws(() => assertMeteoraFullFill(99n, 100n), /exact-in quote is partial/);
  assert.doesNotThrow(() => assertMeteoraFullFill(100n, 100n));
  assert.equal(impactFromMarginalPrice(new Decimal(2), "asset_to_quote", 100_000_000n, 2_000_000n, 8, 6), "0");
  assert.equal(impactFromMarginalPrice(new Decimal(2), "quote_to_asset", 2_000_000n, 100_000_000n, 8, 6), "0");
});

test("adapter account watch fails closed on disconnect and resnapshots after reconnect", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const states: Array<{ slot: bigint; stateFingerprint: string }> = [];
  const unavailable: string[] = [];
  let connections = 0;
  let stop: (() => Promise<void>) | undefined;
  sockets.on("connection", (socket) => {
    const connectionNumber = ++connections;
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string };
      if (request.method !== "accountSubscribe") return;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: connectionNumber }));
      if (connectionNumber === 1) setTimeout(() => socket.close(), 100);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const account = { owner: new PublicKey(METEORA_DLMM_PROGRAM_ADDRESS), data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) };
    const connection = { getAccountInfoAndContext: async () => ({ context: { slot: 10 }, value: account }) } as any;
    stop = await startSolanaAccountWatch(connection, `ws://127.0.0.1:${port}`, METEORA_XSPCX_USDC_POOL.address, METEORA_DLMM_PROGRAM_ADDRESS,
      async (reverify) => { assert.equal(reverify, true); return "1.5"; }, {
        onState: (state) => states.push(state), onUnavailable: (reason) => unavailable.push(reason),
      });
    const deadline = Date.now() + 5_000;
    while ((connections < 2 || states.length < 2 || !unavailable.some((reason) => reason.includes("disconnected"))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(connections >= 2, "watch did not reconnect");
    assert.equal(states.length, 2, "fresh snapshot was not emitted on reconnect");
    assert.ok(unavailable.some((reason) => reason.includes("disconnected")));
  } finally {
    await stop?.();
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())));
  }
});

test("Uniswap unsigned transaction encodes the pinned single pool, recipient, deadline and minimum output", () => {
  const iface = new Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)"]);
  const data = encodeUniswapV3Swap({ tokenIn: pool.token_in_out.asset_address, tokenOut: pool.token_in_out.quote_address,
    fee: 500, recipient: "0x3333333333333333333333333333333333333333", deadline: 1000, amountIn: 123n, amountOutMinimum: 99n });
  const [params] = iface.decodeFunctionData("exactInputSingle", data);
  assert.equal(params.tokenIn, pool.token_in_out.asset_address);
  assert.equal(params.tokenOut, pool.token_in_out.quote_address);
  assert.equal(params.fee, 500n);
  assert.equal(params.amountIn, 123n);
  assert.equal(params.amountOutMinimum, 99n);
  assert.equal(params.sqrtPriceLimitX96, 0n);
});

test("Solana simulation uses an unsigned versioned message and validates its fee payer", () => {
  const wallet = Keypair.generate().publicKey;
  const transaction = new Transaction({ feePayer: wallet, recentBlockhash: PublicKey.default.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: PublicKey.default, lamports: 1 }));
  const encoded = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const simulated = createSolanaSimulationTransaction(encoded, wallet.toBase58(), PublicKey.default.toBase58());
  assert.equal(simulated.message.compiledInstructions.length, 1);
  assert.equal(simulated.signatures.length, 1);
  assert.ok(simulated.signatures[0]!.every((value) => value === 0));
  assert.throws(() => createSolanaSimulationTransaction(encoded, Keypair.generate().publicKey.toBase58(), PublicKey.default.toBase58()), /fee payer/);
});

test("X Layer quote snapshot accepts a complete fixed-monitor version", () => {
  const blockHash = `0x${"a".repeat(64)}`;
  const now = Date.now();
  assert.deepEqual(usableXLayerQuoteSnapshot({ blockNumber: 123, blockHash, sqrtPriceRaw: "79228162514264337593543950336", observedAt: now }, now), {
    blockNumber: 123n, blockHash, sqrtPriceX96: 79228162514264337593543950336n,
  });
});

test("X Layer quote snapshot rejects incomplete or invalid state", () => {
  const blockHash = `0x${"a".repeat(64)}`;
  const now = Date.now();
  assert.equal(usableXLayerQuoteSnapshot(undefined), undefined);
  assert.equal(usableXLayerQuoteSnapshot({ blockNumber: null, blockHash, sqrtPriceRaw: "1", observedAt: now }, now), undefined);
  assert.equal(usableXLayerQuoteSnapshot({ blockNumber: 123, blockHash: "0x1", sqrtPriceRaw: "1", observedAt: now }, now), undefined);
  assert.equal(usableXLayerQuoteSnapshot({ blockNumber: 123, blockHash, sqrtPriceRaw: "0", observedAt: now }, now), undefined);
  assert.equal(usableXLayerQuoteSnapshot({ blockNumber: 123, blockHash, sqrtPriceRaw: "1", observedAt: now + 1 }, now), undefined);
});
