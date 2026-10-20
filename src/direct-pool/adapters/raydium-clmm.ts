import { createHash } from "node:crypto";
import BN from "bn.js";
import Decimal from "decimal.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { PoolUtils, Raydium, Token, TokenAmount, toBN, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { solanaRpcFetch } from "../../solana-rpc-logging.js";
import type { MarketRegistry, RegisteredPool } from "../market-registry.js";
import { simulateSolanaSwap } from "../raydium-simulator.js";
import { PoolIdentityMismatchError, UnsupportedTokenError, assertExecutionInput, createSolanaSimulationTransaction, errorMessage, expectedDecimals, extensionName, fingerprintRaydiumState, impactFromMarginalPrice, isScopedToken2022Pool, jsonSafe, minimumOut, readSolanaTokenState, solanaPairMatches, validateSolanaTokenSupport } from "../pool-adapters.js";
import type { ExactInQuote, PoolAdapter, QuoteInput, SolanaMintState, SolanaTokenState, SwapBuildInput, SwapSimulationResult, UnsignedSwap } from "../pool-adapters.js";

export class RaydiumClmmAdapter implements PoolAdapter {
  readonly stateSource = "fixed_monitor" as const;
  private readonly connection: Connection;
  private readonly raydium = new Map<string, Promise<Raydium>>();
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;

  constructor(private readonly registry: MarketRegistry, pool: RegisteredPool) {
    const dex = registry.dexes[pool.dex];
    const rpc = pool.rpc_http;
    if (!dex || !dex.program_id || !rpc) throw new Error("Solana RPC or Raydium CLMM Program ID is not configured");
    this.dex = dex;
    this.connection = new Connection(rpc, { commitment: "confirmed", wsEndpoint: pool.rpc_ws ?? undefined, fetch: solanaRpcFetch, disableRetryOnRateLimit: true });
  }

  private sdk(owner = PublicKey.default): Promise<Raydium> {
    const key = owner.toBase58();
    let client = this.raydium.get(key);
    if (!client) {
      client = Raydium.load({ connection: this.connection, owner, cluster: "mainnet", disableFeatureCheck: true, disableLoadToken: true });
      this.raydium.set(key, client);
    }
    return client;
  }

  async verify(pool: RegisteredPool): Promise<void> {
    const snapshot = await (await this.sdk()).clmm.getRpcClmmPoolInfo({ poolId: pool.address });
    const tokenState = await this.readSolanaTokenState(pool);
    const mintA = tokenState.mints.get(snapshot.mintA.toBase58());
    const mintB = tokenState.mints.get(snapshot.mintB.toBase58());
    const asset = this.registry.instruments.find((item) => item.instrument_id === pool.instrument_id)?.chain_assets.find((item) => item.chain === "solana");
    if (!asset || snapshot.programId.toBase58() !== this.dex.program_id || !mintA || !mintB
      || !((snapshot.mintA.toBase58() === pool.token_in_out.asset_address && snapshot.mintB.toBase58() === pool.token_in_out.quote_address)
        || (snapshot.mintA.toBase58() === pool.token_in_out.quote_address && snapshot.mintB.toBase58() === pool.token_in_out.asset_address))
      || mintA.mint.decimals !== snapshot.mintDecimalsA || mintB.mint.decimals !== snapshot.mintDecimalsB
      || mintA.mint.decimals !== expectedDecimals(snapshot.mintA.toBase58(), pool)
      || mintB.mint.decimals !== expectedDecimals(snapshot.mintB.toBase58(), pool)
      || (pool.mode === "trade_candidate" && (pool.token_in_out.asset_address !== asset.address || pool.token_in_out.quote_address !== asset.quote_asset.address))) {
      throw new PoolIdentityMismatchError("Raydium pool identity, mint decimals or registered Program ID mismatch");
    }
    this.validateTokenSupport(pool, mintA, tokenState.blockTimestamp);
    this.validateTokenSupport(pool, mintB, tokenState.blockTimestamp);
  }

  async readSolanaTokenState(pool: RegisteredPool): Promise<SolanaTokenState> { return readSolanaTokenState(this.connection, pool); }

  async getAssetUiMultiplier(pool: RegisteredPool, tokenState?: SolanaTokenState): Promise<string> {
    const state = tokenState ?? await this.readSolanaTokenState(pool);
    const asset = state.mints.get(pool.token_in_out.asset_address);
    if (!asset) throw new PoolIdentityMismatchError("Raydium registered asset mint is missing");
    return this.validateTokenSupport(pool, asset, state.blockTimestamp).uiMultiplier;
  }

  async quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote> {
    if (input.amountInRaw <= 0n || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) throw new Error("Invalid exact-in amount or slippage");
    const { poolInfo, computePoolInfo, tickData } = await (await this.sdk()).clmm.getPoolInfoFromRpc(pool.address);
    const after = await this.connection.getSlot("confirmed");
    if (poolInfo.programId !== this.dex.program_id) throw new PoolIdentityMismatchError("Raydium quote rejected: unexpected CLMM program");
    const tokenState = input.solanaTokenState ?? await this.readSolanaTokenState(pool);
    const mintA = tokenState.mints.get(poolInfo.mintA.address);
    const mintB = tokenState.mints.get(poolInfo.mintB.address);
    if (!mintA || !mintB || mintA.mint.decimals !== poolInfo.mintA.decimals || mintB.mint.decimals !== poolInfo.mintB.decimals
      || !((poolInfo.mintA.address === pool.token_in_out.asset_address && poolInfo.mintB.address === pool.token_in_out.quote_address)
        || (poolInfo.mintA.address === pool.token_in_out.quote_address && poolInfo.mintB.address === pool.token_in_out.asset_address))) {
      throw new PoolIdentityMismatchError("Raydium quote mint pair or decimals do not match registry");
    }
    const assetToken = this.validateTokenSupport(pool, tokenState.mints.get(pool.token_in_out.asset_address)!, tokenState.blockTimestamp);
    const quoteToken = this.validateTokenSupport(pool, tokenState.mints.get(pool.token_in_out.quote_address)!, tokenState.blockTimestamp);
    if (input.direction === "asset_to_quote" && input.expectedAssetUiMultiplier !== undefined
      && !new Decimal(input.expectedAssetUiMultiplier).eq(assetToken.uiMultiplier)) {
      throw new Error("Raydium scaled UI multiplier changed while sizing the exact-in amount");
    }
    const isAssetA = poolInfo.mintA.address === pool.token_in_out.asset_address;
    const inputIsAsset = input.direction === "asset_to_quote";
    const inputMint = inputIsAsset ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
    const tokenIn = inputMint === poolInfo.mintA.address ? poolInfo.mintA : poolInfo.mintB;
    const tokenOut = inputMint === poolInfo.mintA.address ? poolInfo.mintB : poolInfo.mintA;
    const epochInfo = await (await this.sdk()).fetchEpochInfo();
    const blockTimestamp = Math.floor(Date.now() / 1000);
    const computed = PoolUtils.computeAmountOutFormat({
      poolInfo: computePoolInfo,
      tickarrayBitmapExtension: computePoolInfo.exBitmapInfo,
      tickArrayCache: tickData[pool.address]!,
      amountIn: new TokenAmount(new Token({ mint: inputMint, decimals: tokenIn.decimals, skipMint: true }), input.amountInRaw.toString(), true).raw,
      tokenOut, slippage: 0, epochInfo, blockTimestamp,
    });
    const amountOutRaw = BigInt(computed.amountOut.amount.raw.toString());
    const tickAddresses = Object.keys(tickData[pool.address] ?? {}).sort();
    const stateFingerprint = createHash("sha256").update(JSON.stringify({
      pool: poolInfo.id, sqrtPriceX64: computePoolInfo.sqrtPriceX64.toString(),
      liquidity: computePoolInfo.liquidity.toString(), tickCurrent: computePoolInfo.tickCurrent,
      tickArrays: tickAddresses.map((key) => [key, JSON.stringify(tickData[pool.address]![key])]),
    }, jsonSafe)).digest("hex");
    return {
      poolId: pool.id, direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw,
      minimumAmountOutRaw: minimumOut(amountOutRaw, input.slippageBps),
      priceImpactPercent: computed.priceImpact.toFixed(10), networkFeeNativeRaw: null, networkFeeUsdt: null,
      assetUiMultiplier: assetToken.uiMultiplier,
      version: { chain: "solana", slot: BigInt(after), observedAt: Date.now(), stateFingerprint }, quotedAt: Date.now(),
      mintTokenPrograms: { asset: assetToken.owner.toBase58(), quote: quoteToken.owner.toBase58() },
      raw: { slot: after, tickArrays: tickAddresses, amountOutRaw: amountOutRaw.toString(), priceImpactPercent: computed.priceImpact.toFixed(10), feeRaw: computed.fee.toString(),
        assetUiMultiplier: assetToken.uiMultiplier, multiplierEffectiveTimestamp: assetToken.multiplierEffectiveTimestamp, chainTimestamp: tokenState.blockTimestamp.toString(),
        assetTokenProgram: assetToken.owner.toBase58(), quoteTokenProgram: quoteToken.owner.toBase58(), assetExtensions: assetToken.extensions.map(extensionName) },
    };
  }

  private validateTokenSupport(pool: RegisteredPool, state: SolanaMintState, blockTimestamp: bigint) {
    return validateSolanaTokenSupport(pool, state, blockTimestamp, "raydium_clmm", this.dex.program_id);
  }

  async buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap> {
    assertExecutionInput(pool, input, "solana");
    await this.verify(pool);
    const raydium = await this.sdk(new PublicKey(input.wallet));
    const { poolInfo, computePoolInfo, tickData } = await raydium.clmm.getPoolInfoFromRpc(pool.address);
    const stateFingerprint = fingerprintRaydiumState(poolInfo, computePoolInfo, tickData[pool.address] ?? {});
    if (stateFingerprint !== input.quote.version.stateFingerprint) throw new Error("Raydium pool state changed since the exact-in quote; requote before building");
    const inputMint = input.quote.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
    const { poolInfo: swapPoolInfo, rpcData, tickArrays } = await raydium.clmm.getSwapPoolInfo(pool.address, poolInfo.mintA.address === inputMint);
    const built = await raydium.clmm.swap({
      poolInfo: swapPoolInfo, inputMint, amountIn: toBN(input.quote.amountInRaw.toString()),
      amountOutMin: toBN(input.quote.minimumAmountOutRaw.toString()), observationId: rpcData.observationId,
      ownerInfo: { useSOLBalance: false, feePayer: new PublicKey(input.wallet) },
      remainingAccounts: tickArrays.map((tickArray) => tickArray.address), associatedOnly: true, txVersion: TxVersion.LEGACY,
    });
    if (built.signers.length) throw new Error("Raydium unsigned swap unexpectedly requires additional signers");
    const mintTokenPrograms = input.quote.mintTokenPrograms;
    if (!mintTokenPrograms) throw new Error("Solana quote is missing validated mint token programs");
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    built.transaction.feePayer = new PublicKey(input.wallet);
    built.transaction.recentBlockhash = latestBlockhash.blockhash;
    return { chain: "solana", poolId: pool.id, direction: input.quote.direction, wallet: input.wallet,
      amountInRaw: input.quote.amountInRaw, minimumAmountOutRaw: input.quote.minimumAmountOutRaw,
      stateFingerprint, version: input.quote.version, simulationOnly: input.simulationOnly === true,
      mintTokenPrograms,
      transactionBase64: built.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
  }

  async simulateSwap(pool: RegisteredPool, swap: UnsignedSwap, signer?: Keypair): Promise<SwapSimulationResult> {
    return simulateSolanaSwap({ pool, swap, signer, connection: this.connection, verifyPool: () => this.verify(pool),
      currentStateFingerprint: async () => {
        const { poolInfo, computePoolInfo, tickData } = await (await this.sdk(new PublicKey(swap.wallet))).clmm.getPoolInfoFromRpc(pool.address);
        return fingerprintRaydiumState(poolInfo, computePoolInfo, tickData[pool.address] ?? {});
      } });
  }
}
