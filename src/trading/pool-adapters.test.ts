import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { Interface } from "ethers";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createSolanaSimulationTransaction, encodeUniswapV3Swap, impactFromSqrtPrice, minimumOut } from "./pool-adapters.js";
import type { RegisteredPool } from "./market-registry.js";

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
