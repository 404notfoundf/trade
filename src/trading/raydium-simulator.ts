import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction, type Connection, type Keypair, type SimulatedTransactionAccountInfo } from "@solana/web3.js";
import type { RegisteredPool } from "./market-registry.js";
import type { SwapSimulationResult, UnsignedSwap } from "./pool-adapters.js";

type SolanaSimulationInput = {
  pool: RegisteredPool; swap: UnsignedSwap; signer?: Keypair; connection: Connection;
  verifyPool: () => Promise<void>; currentStateFingerprint: () => Promise<string>;
};
type WalletTokenSnapshot = { address: PublicKey; mint: PublicKey; tokenProgram: PublicKey; account: Buffer | null; amount: bigint };

export async function simulateSolanaSwap({ pool, swap, signer, connection, verifyPool, currentStateFingerprint }: SolanaSimulationInput): Promise<SwapSimulationResult> {
  if (swap.chain !== "solana" || swap.poolId !== pool.id) throw new Error("Unsigned Solana swap does not match the registered pool");
  try {
    if (!pool.verified || (pool.mode !== "trade_candidate" && !(pool.mode === "observe_only" && swap.simulationOnly === true))) {
      throw new Error("This Solana pool is not eligible for swap simulation");
    }
    if (!signer || signer.publicKey.toBase58() !== swap.wallet) throw new Error("Simulation signer does not match the swap wallet");
    await verifyPool();
    if (await currentStateFingerprint() !== swap.stateFingerprint) throw new Error("Solana pool state changed since the quote; requote before simulation");
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const transaction = createSolanaSimulationTransaction(swap.transactionBase64, swap.wallet, latestBlockhash.blockhash);
    transaction.sign([signer]);
    const inputMint = new PublicKey(swap.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address);
    const outputMint = new PublicKey(swap.direction === "asset_to_quote" ? pool.token_in_out.quote_address : pool.token_in_out.asset_address);
    const tokenPrograms: [PublicKey, PublicKey] = swap.direction === "asset_to_quote"
      ? [new PublicKey(swap.mintTokenPrograms.asset), new PublicKey(swap.mintTokenPrograms.quote)]
      : [new PublicKey(swap.mintTokenPrograms.quote), new PublicKey(swap.mintTokenPrograms.asset)];
    const { tokens: [input, output], nativeBalance } = await readWalletTokenAccounts(connection, signer.publicKey, [inputMint, outputMint], tokenPrograms);
    if (!input.account) return { chain: "solana", ok: false, skipped: true, error: "Input associated token account is missing" };
    if (input.amount < swap.amountInRaw) return { chain: "solana", ok: false, skipped: true, error: "Insufficient input token balance" };
    const fee = await connection.getFeeForMessage(transaction.message, "confirmed");
    if (fee.value === null) throw new Error("Solana RPC could not estimate the simulation fee");
    if (BigInt(fee.value) > 1_000_000n) throw new Error("Solana simulation fee exceeds the 0.001 SOL limit");
    if (nativeBalance < BigInt(fee.value) * 2n) {
      return { chain: "solana", ok: false, skipped: true, networkFeeNativeRaw: String(fee.value), error: "Insufficient SOL balance for the buffered transaction fee" };
    }
    const simulation = await connection.simulateTransaction(transaction, {
      sigVerify: true, commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [input.address.toBase58(), output.address.toBase58()] },
    });
    if (simulation.value.err) {
      const logs = simulation.value.logs ?? [];
      const error = JSON.stringify(simulation.value.err);
      const skipped = /insufficient funds|insufficient lamports/i.test(`${error} ${logs.join(" ")}`);
      return { chain: "solana", ok: false, skipped, networkFeeNativeRaw: String(fee.value),
        computeUnits: simulation.value.unitsConsumed ?? undefined, error: skipped ? "Insufficient SOL for transaction fees or account rent" : error, logs };
    }
    const accounts = simulation.value.accounts;
    if (!accounts || accounts.length !== 2) throw new Error("Solana RPC did not return the post-simulation token accounts");
    const inputAfter = accounts[0];
    const outputAfter = accounts[1];
    if (inputAfter === undefined || outputAfter === undefined) throw new Error("Solana RPC omitted a simulated token account");
    const inputDebited = input.amount - simulatedTokenAmount(inputAfter, input, signer.publicKey);
    const outputCredited = simulatedTokenAmount(outputAfter, output, signer.publicKey) - output.amount;
    if (inputDebited !== swap.amountInRaw) throw new Error("Simulation input debit differs from the exact-in quote");
    if (outputCredited < swap.minimumAmountOutRaw) throw new Error("Simulation output is below the quoted minimum receive amount");
    return { chain: "solana", ok: true, computeUnits: simulation.value.unitsConsumed ?? undefined,
      networkFeeNativeRaw: String(fee.value), amountInDebitedRaw: inputDebited.toString(),
      amountOutCreditedRaw: outputCredited.toString(), amountOutRaw: outputCredited.toString(), logs: simulation.value.logs ?? [] };
  } catch (error) {
    return { chain: "solana", ok: false, error: errorMessage(error) };
  }
}

export function createSolanaSimulationTransaction(transactionBase64: string, wallet: string, recentBlockhash: string): VersionedTransaction {
  const transaction = Transaction.from(Buffer.from(transactionBase64, "base64"));
  if (!transaction.feePayer?.equals(new PublicKey(wallet))) throw new Error("Solana unsigned transaction fee payer does not match its wallet");
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(wallet), recentBlockhash,
    instructions: transaction.instructions }).compileToV0Message());
}

async function readWalletTokenAccounts(
  connection: Connection, owner: PublicKey, mints: [PublicKey, PublicKey], tokenPrograms: [PublicKey, PublicKey],
): Promise<{ tokens: [WalletTokenSnapshot, WalletTokenSnapshot]; nativeBalance: bigint }> {
  const snapshots = mints.map((mint, index) => {
    const tokenProgram = tokenPrograms[index]!;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error("Swap mint uses an unsupported token program");
    }
    return { address: getAssociatedTokenAddressSync(mint, owner, false, tokenProgram), mint, tokenProgram };
  });
  const accounts = await connection.getMultipleAccountsInfo([
    ...mints, ...snapshots.map((snapshot) => snapshot.address), owner,
  ], "confirmed");
  const tokens = snapshots.map((snapshot, index) => {
    const mintInfo = accounts[index];
    if (!mintInfo || !mintInfo.owner.equals(snapshot.tokenProgram)) {
      throw new Error("Swap mint is unavailable or owned by an unsupported token program");
    }
    const account = accounts[index + 2];
    return { ...snapshot, account: account?.data ?? null,
      amount: account ? tokenAmount(account.data, account.owner, snapshot.mint, owner, snapshot.tokenProgram) : 0n };
  }) as [WalletTokenSnapshot, WalletTokenSnapshot];
  return { tokens, nativeBalance: BigInt(accounts[4]?.lamports ?? 0) };
}

function simulatedTokenAmount(account: SimulatedTransactionAccountInfo | null, snapshot: WalletTokenSnapshot, owner: PublicKey): bigint {
  if (!account) return 0n;
  if (!Array.isArray(account.data) || account.data[1] !== "base64") throw new Error("Solana RPC returned an unsupported simulated token account encoding");
  return tokenAmount(Buffer.from(account.data[0]!, "base64"), new PublicKey(account.owner), snapshot.mint, owner, snapshot.tokenProgram);
}

function tokenAmount(data: Buffer, program: PublicKey, mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): bigint {
  if (!program.equals(tokenProgram) || data.length < 165 || !data.subarray(0, 32).equals(mint.toBuffer())
    || !data.subarray(32, 64).equals(owner.toBuffer())) throw new Error("Solana swap token account does not match the expected wallet, mint, or token program");
  return data.readBigUInt64LE(64);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, "[rpc endpoint]").slice(0, 500) : "unknown simulation error";
}
