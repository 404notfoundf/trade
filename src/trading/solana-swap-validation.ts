import Decimal from "decimal.js";
import { Connection, PublicKey } from "@solana/web3.js";
import type { SimulatedTransactionAccountInfo } from "@solana/web3.js";
import type { AssetConfig } from "../config.js";
import { SOLANA_CHAIN } from "../market/valuation.js";
import type { SwapTx } from "./gates.js";

export const SOLANA_OKX_ROUTER = "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u";
export const SOLANA_COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export const SOLANA_ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const SOLANA_WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const fail = (message: string): never => { throw new Error(message); };

type SolanaSwapQuoteBundle = {
  routerResult?: { chainIndex?: string; fromTokenAmount?: string; toTokenAmount?: string; fromToken?: { tokenContractAddress?: string }; toToken?: { tokenContractAddress?: string }; dexRouterList?: unknown[] };
  tx?: SwapTx;
};
type SolanaInstructionAccount = { pubkey?: string; isSigner?: boolean; isWritable?: boolean };
export function validateSolanaSwapQuote(
  bundle: SolanaSwapQuoteBundle, owner: string,
  expected: { fromToken: string; toToken: string; amount: bigint; maxSlippagePercent: number },
): { fromMint: PublicKey; toMint: PublicKey; minOutput: bigint } {
  const router = bundle.routerResult;
  const tx = bundle.tx;
  const input = new Decimal(router?.fromTokenAmount ?? "NaN");
  const output = new Decimal(router?.toTokenAmount ?? "NaN");
  const slippage = new Decimal(tx?.slippagePercent ?? "NaN");
  if (!router || router.chainIndex !== SOLANA_CHAIN || !router.dexRouterList?.length
    || router.fromToken?.tokenContractAddress !== expected.fromToken || router.toToken?.tokenContractAddress !== expected.toToken
    || !input.isInteger() || !input.eq(expected.amount.toString()) || !output.isInteger() || !output.gt(0)) {
    fail("Solana router quote does not match the expected chain, tokens, or input amount");
  }
  if (!tx || tx.from !== owner || tx.to !== SOLANA_OKX_ROUTER
    || (tx.swapReceiverAddress !== undefined && tx.swapReceiverAddress !== owner)
    || !/^\d+$/.test(tx.minReceiveAmount ?? "") || !slippage.isFinite() || slippage.lt(0)
    || !Number.isFinite(expected.maxSlippagePercent) || expected.maxSlippagePercent < 0
    || expected.maxSlippagePercent >= 100 || slippage.gt(expected.maxSlippagePercent)) {
    fail("Solana swap transaction is not bound to the configured wallet, router, or slippage limit");
  }
  const minOutput = BigInt(tx!.minReceiveAmount!);
  const safeMinimum = output.mul(new Decimal(100).minus(slippage)).div(100).floor();
  if (minOutput <= 0n || new Decimal(minOutput.toString()).lt(safeMinimum) || new Decimal(minOutput.toString()).gt(output)) {
    fail("Solana minimum output does not enforce the configured slippage limit");
  }
  return { fromMint: new PublicKey(expected.fromToken), toMint: new PublicKey(expected.toToken), minOutput };
}

type SolanaSwapTokenSnapshot = {
  address: PublicKey; mint: PublicKey; tokenProgram: string; side: "input" | "output"; amount: bigint;
};

export async function readSolanaSwapTokenSnapshots(
  connection: Connection, owner: PublicKey, fromMint: PublicKey, toMint: PublicKey,
  fromDecimals: number, toDecimals: number,
): Promise<SolanaSwapTokenSnapshot[]> {
  const readMint = async (mint: PublicKey, decimals: number, side: "input" | "output"): Promise<SolanaSwapTokenSnapshot[]> => {
    const [mintInfo, parsed] = await Promise.all([
      connection.getAccountInfo(mint, "confirmed"),
      connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed"),
    ]);
    const tokenProgram = mintInfo?.owner.toBase58();
    if (!tokenProgram || !SOLANA_TOKEN_PROGRAMS.includes(tokenProgram)) throw new Error("Solana swap mint is not owned by a supported token program");
    const existing = new Map<string, bigint>();
    for (const account of parsed.value) {
      const info = (account.account.data as { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number } } } }).parsed?.info;
      const tokenAmount = info?.tokenAmount;
      if (info?.mint !== mint.toBase58() || info.owner !== owner.toBase58() || !tokenAmount
        || tokenAmount.decimals !== decimals || !/^\d+$/.test(tokenAmount.amount ?? "")) {
        throw new Error("Solana swap token account metadata does not match the expected owner or decimals");
      }
      existing.set(account.pubkey.toBase58(), BigInt(tokenAmount.amount!));
    }
    const associated = PublicKey.findProgramAddressSync([
      owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), mint.toBuffer(),
    ], new PublicKey(SOLANA_ASSOCIATED_TOKEN))[0];
    const addresses = [...new Set([...existing.keys(), associated.toBase58()])].map((address) => new PublicKey(address));
    const accountInfos = await connection.getMultipleAccountsInfo(addresses, "confirmed");
    return addresses.map((address, index) => {
      const accountInfo = accountInfos[index];
      const wasExisting = existing.has(address.toBase58());
      if (!accountInfo && wasExisting) throw new Error("Solana swap token account disappeared before simulation");
      const amount = accountInfo ? readSolanaTokenAccountAmount(accountInfo.data, accountInfo.owner.toBase58(), mint, owner, tokenProgram) : 0n;
      return { address, mint, tokenProgram, side, amount };
    });
  };
  return [
    ...(await readMint(fromMint, fromDecimals, "input")),
    ...(await readMint(toMint, toDecimals, "output")),
  ];
}

function readSolanaTokenAccountAmount(data: Buffer, program: string, mint: PublicKey, owner: PublicKey, tokenProgram: string): bigint {
  if (program !== tokenProgram || data.length < 165 || !data.subarray(0, 32).equals(mint.toBuffer())
    || !data.subarray(32, 64).equals(owner.toBuffer())) throw new Error("Solana swap token account does not match the expected mint, program, or owner");
  return data.readBigUInt64LE(64);
}

export function validateSolanaSwapSimulation(
  accounts: (SimulatedTransactionAccountInfo | null)[] | null | undefined, snapshots: SolanaSwapTokenSnapshot[],
  owner: PublicKey, expectedInput: bigint, minOutput: bigint,
): void {
  if (!accounts || accounts.length !== snapshots.length) fail("Solana RPC did not return the post-simulation token accounts");
  let inputBefore = 0n;
  let inputAfter = 0n;
  let outputBefore = 0n;
  let outputAfter = 0n;
  snapshots.forEach((snapshot, index) => {
    const account = accounts![index];
    let amount = 0n;
    if (account) {
      if (!Array.isArray(account.data) || account.data[1] !== "base64") throw new Error("Solana RPC returned an unsupported simulated token account encoding");
      amount = readSolanaTokenAccountAmount(Buffer.from(account.data[0]!, "base64"), account.owner, snapshot.mint, owner, snapshot.tokenProgram);
    }
    if (snapshot.side === "input") {
      inputBefore += snapshot.amount;
      inputAfter += amount;
    } else {
      outputBefore += snapshot.amount;
      outputAfter += amount;
    }
  });
  if (inputBefore - inputAfter !== expectedInput) fail("Solana simulation input debit differs from the exact-in quote");
  if (outputAfter - outputBefore < minOutput) fail("Solana simulation output is below the quoted minimum receive amount");
}

export function validateSolanaInstruction(programId: string, accounts: SolanaInstructionAccount[], data: Buffer, owner: string, asset: AssetConfig, rentLimit: bigint): void {
  if (programId === SOLANA_OKX_ROUTER) return;
  if (programId === SOLANA_COMPUTE_BUDGET) {
    const tag = data[0];
    if (accounts.length !== 0) throw new Error("Solana Compute Budget instruction must not reference accounts");
    if (tag === 2 && data.length === 5 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= 1_400_000) return;
    if (tag === 3 && data.length === 9) return;
    if (tag === 1 && data.length === 5 && data.readUInt32LE(1) >= 32_768 && data.readUInt32LE(1) <= 262_144) return;
    if (tag === 4 && data.length === 5 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= 67_108_864) return;
    throw new Error("Solana transaction contains an invalid or unsupported Compute Budget instruction");
  }
  const allowedMints = new Set([asset.tokenAddress, asset.quoteTokenAddress, SOLANA_WRAPPED_SOL]);
  const associatedAddresses = new Set<string>();
  for (const mint of allowedMints) {
    for (const tokenProgram of SOLANA_TOKEN_PROGRAMS) {
      associatedAddresses.add(PublicKey.findProgramAddressSync([
        new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer(),
      ], new PublicKey(SOLANA_ASSOCIATED_TOKEN))[0].toBase58());
    }
  }
  if (programId === SOLANA_ASSOCIATED_TOKEN) {
    const payer = accounts[0]?.pubkey;
    const associated = accounts[1]?.pubkey;
    const authority = accounts[2]?.pubkey;
    const mint = accounts[3]?.pubkey;
    const tokenProgram = accounts[5]?.pubkey;
    if ((data.length > 1 || (data.length === 1 && data[0] !== 1)) || payer !== owner || authority !== owner
      || !mint || !allowedMints.has(mint) || !tokenProgram || !SOLANA_TOKEN_PROGRAMS.includes(tokenProgram)
      || !associated || !associatedAddresses.has(associated)) throw new Error("Solana transaction contains an unexpected associated-token instruction");
    return;
  }
  if (programId === "11111111111111111111111111111111") {
    const tag = data.length >= 4 ? data.readUInt32LE(0) : -1;
    const source = accounts[0]?.pubkey;
    const destination = accounts[1]?.pubkey;
    if (tag !== 2 || data.length !== 12 || source !== owner || !destination || !associatedAddresses.has(destination)
      || BigInt(data.readBigUInt64LE(4)) > rentLimit) throw new Error("Solana transaction contains an unexpected System Program instruction");
    return;
  }
  throw new Error(`Solana transaction program is not allowlisted: ${programId}`);
}
