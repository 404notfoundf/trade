import { createHash } from "node:crypto";
import BN from "bn.js";
import Decimal from "decimal.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { Chain, BYREAL_CLMM_PROGRAM_ID, AmmConfigLayout, Instruction, PoolLayout, SqrtPriceMath, TickArrayUtils, getPdaExBitmapAccount } from "@byreal-io/byreal-clmm-sdk";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { solanaRpcFetch } from "../../solana-rpc-logging.js";
import { BYREAL_CLMM_PROGRAM_ADDRESS, BYREAL_XSPCX_USDC_POOL, type MarketRegistry, type RegisteredPool } from "../market-registry.js";
import { simulateSolanaSwap } from "../raydium-simulator.js";
import { PoolIdentityMismatchError, UnsupportedTokenError, assertExecutionInput, byrealQuotePerAsset, errorMessage, expectedDecimals, extensionName, impactFromMarginalPrice, isScopedToken2022Pool, minimumOut, readSolanaTokenState, solanaPairMatches, startSolanaAccountWatch, validateSolanaTokenSupport } from "../pool-adapters.js";
import type { ExactInQuote, PoolAdapter, PoolWatchCallbacks, QuoteInput, SolanaMintState, SwapBuildInput, SwapSimulationResult, UnsignedSwap } from "../pool-adapters.js";

export class ByrealClmmAdapter implements PoolAdapter {
  readonly stateSource = "adapter_watch" as const;
  private readonly connection: Connection;
  private readonly chain: Chain;
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;

  constructor(registry: MarketRegistry, pool: RegisteredPool) {
    const dex = registry.dexes[pool.dex];
    if (!dex || !pool.rpc_http || dex.program_id !== BYREAL_CLMM_PROGRAM_ADDRESS) throw new Error("Solana RPC or pinned Byreal CLMM Program ID is not configured");
    this.dex = dex;
    this.connection = new Connection(pool.rpc_http, { commitment: "confirmed", wsEndpoint: pool.rpc_ws ?? undefined, fetch: solanaRpcFetch, disableRetryOnRateLimit: true });
    this.chain = new Chain({ connection: this.connection as never, programId: BYREAL_CLMM_PROGRAM_ID });
  }

  private validatePoolData(pool: RegisteredPool, data: Awaited<ReturnType<Chain["getRawPoolInfoByPoolId"]>>): void {
    if (pool.id !== BYREAL_XSPCX_USDC_POOL.id || pool.instrument_id !== BYREAL_XSPCX_USDC_POOL.instrumentId || pool.chain !== "solana"
      || pool.address !== BYREAL_XSPCX_USDC_POOL.address || pool.mode !== "observe_only" || pool.reason !== "quote_asset_not_pinned"
      || this.dex.program_id !== BYREAL_CLMM_PROGRAM_ADDRESS || data.programId.toBase58() !== BYREAL_CLMM_PROGRAM_ADDRESS
      || !solanaPairMatches(data.mintA.toBase58(), data.mintB.toBase58(), pool.token_in_out.asset_address, pool.token_in_out.quote_address)
      || data.tickSpacing !== BYREAL_XSPCX_USDC_POOL.tickSpacing || pool.expected_tick_spacing !== data.tickSpacing
      || data.decayFeeFlag !== 0 || data.decayFeeInitFeeRate !== 0 || data.decayFeeDecreaseRate !== 0 || data.decayFeeDecreaseInterval !== 0
      || data.status !== 0) {
      throw new PoolIdentityMismatchError("Byreal CLMM identity, mint pair, tick spacing or supported fee mode does not match the pinned pool");
    }
  }

  private validateToken(pool: RegisteredPool, state: SolanaMintState, blockTimestamp: bigint): SolanaMintState & { uiMultiplier: string; multiplierEffectiveTimestamp: string | null } {
    try { return validateSolanaTokenSupport(pool, state, blockTimestamp, "byreal_clmm", this.dex.program_id); }
    catch (error) {
      if (error instanceof UnsupportedTokenError) throw new PoolIdentityMismatchError(`Byreal mint extension policy mismatch: ${error.message}`);
      throw error;
    }
  }

  private async loadPoolInfo(pool: RegisteredPool): Promise<Awaited<ReturnType<Chain["getRawPoolInfoByPoolId"]>>> {
    const data = await this.chain.getRawPoolInfoByPoolId(pool.address);
    this.validatePoolData(pool, data);
    const configAccount = await this.connection.getAccountInfo(new PublicKey(data.ammConfig.toBase58()), "confirmed");
    if (!configAccount || !configAccount.owner.equals(new PublicKey(BYREAL_CLMM_PROGRAM_ADDRESS))) {
      throw new PoolIdentityMismatchError("Byreal AMM config is missing or owned by the wrong program");
    }
    const config = AmmConfigLayout.decode(configAccount.data);
    if (config.tradeFeeRate !== BYREAL_XSPCX_USDC_POOL.feeRate || pool.expected_fee_rate !== config.tradeFeeRate
      || config.tickSpacing !== BYREAL_XSPCX_USDC_POOL.tickSpacing) {
      throw new PoolIdentityMismatchError("Byreal AMM config fee rate or tick spacing does not match the pinned pool");
    }
    return data;
  }

  async verify(pool: RegisteredPool): Promise<void> {
    if (await this.connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new PoolIdentityMismatchError("Byreal CLMM RPC is not Solana mainnet");
    const data = await this.loadPoolInfo(pool);
    const tokenState = await readSolanaTokenState(this.connection, pool);
    const mintA = tokenState.mints.get(data.mintA.toBase58());
    const mintB = tokenState.mints.get(data.mintB.toBase58());
    const asset = tokenState.mints.get(pool.token_in_out.asset_address);
    const quote = tokenState.mints.get(pool.token_in_out.quote_address);
    if (!mintA || !mintB || !asset || !quote
      || mintA.mint.decimals !== data.mintDecimalsA || mintB.mint.decimals !== data.mintDecimalsB
      || mintA.mint.decimals !== expectedDecimals(data.mintA.toBase58(), pool)
      || mintB.mint.decimals !== expectedDecimals(data.mintB.toBase58(), pool)) {
      throw new PoolIdentityMismatchError("Byreal CLMM mint decimals do not match the pinned pool");
    }
    const checkedAsset = this.validateToken(pool, asset, tokenState.blockTimestamp);
    const checkedQuote = this.validateToken(pool, quote, tokenState.blockTimestamp);
    if (!checkedAsset.owner.equals(TOKEN_2022_PROGRAM_ID) || !checkedQuote.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new PoolIdentityMismatchError("Byreal XSPCXx/USDC must use the reviewed Token-2022 asset and classic SPL USDC mint");
    }
    const poolKey = new PublicKey(pool.address);
    const [poolAccount, vaultAAccount, vaultBAccount] = await this.connection.getMultipleAccountsInfo([poolKey,
      new PublicKey(data.vaultA.toBase58()), new PublicKey(data.vaultB.toBase58())], "confirmed");
    if (!poolAccount || !poolAccount.owner.equals(new PublicKey(BYREAL_CLMM_PROGRAM_ADDRESS))) throw new PoolIdentityMismatchError("Byreal pool account owner does not match its program");
    for (const [key, account, mint] of [[data.vaultA, vaultAAccount, mintA], [data.vaultB, vaultBAccount, mintB]] as const) {
      if (!account || !account.owner.equals(mint.owner)) throw new PoolIdentityMismatchError("Byreal token vault is missing or owned by the wrong token program");
      let vault: ReturnType<typeof unpackAccount>;
      try { vault = unpackAccount(new PublicKey(key.toBase58()), account, account.owner); }
      catch { throw new PoolIdentityMismatchError("Byreal token vault account layout is invalid"); }
      if (!vault.mint.equals(new PublicKey(mint.mint.address.toBase58())) || !vault.owner.equals(poolKey)) {
        throw new PoolIdentityMismatchError("Byreal token vault mint or authority does not match the decoded pool");
      }
    }
  }

  async getAssetUiMultiplier(pool: RegisteredPool): Promise<string> {
    const state = await readSolanaTokenState(this.connection, pool);
    const asset = state.mints.get(pool.token_in_out.asset_address);
    if (!asset) throw new PoolIdentityMismatchError("Byreal registered asset mint is missing");
    return this.validateToken(pool, asset, state.blockTimestamp).uiMultiplier;
  }

  private async fingerprint(
    pool: RegisteredPool, data: Awaited<ReturnType<Chain["getRawPoolInfoByPoolId"]>>, tickArrayKeys: PublicKey[],
  ): Promise<{ fingerprint: string; slot: number; tickArrays: string[]; tickArrayDataHashes: string[] }> {
    const programId = new PublicKey(BYREAL_CLMM_PROGRAM_ADDRESS);
    const uniqueTickArrays = [...new Map(tickArrayKeys.map((key) => [key.toBase58(), new PublicKey(key.toBase58())] as const)).values()];
    const configKey = new PublicKey(data.ammConfig.toBase58());
    const bitmapKey = new PublicKey(getPdaExBitmapAccount(BYREAL_CLMM_PROGRAM_ID, data.poolId).publicKey.toBase58());
    const keys = [new PublicKey(pool.address), configKey, bitmapKey, ...uniqueTickArrays];
    const { context, value } = await this.connection.getMultipleAccountsInfoAndContext(keys, "confirmed");
    const [poolAccount, configAccount, bitmapAccount, ...tickArrayAccounts] = value;
    if (!poolAccount || !poolAccount.owner.equals(programId) || poolAccount.data.length < 8) throw new PoolIdentityMismatchError("Byreal pool account is missing or owned by the wrong program");
    if (!configAccount || !configAccount.owner.equals(programId) || !bitmapAccount || !bitmapAccount.owner.equals(programId)) {
      throw new PoolIdentityMismatchError("Byreal quote config or tick bitmap is missing or owned by the wrong program");
    }
    const latestPool = PoolLayout.decode(poolAccount.data);
    if (latestPool.mintA.toBase58() !== data.mintA.toBase58() || latestPool.mintB.toBase58() !== data.mintB.toBase58()
      || latestPool.tickCurrent !== data.tickCurrent || !latestPool.sqrtPriceX64.eq(data.sqrtPriceX64) || !latestPool.liquidity.eq(data.liquidity)) {
      throw new Error("Byreal pool state changed during exact-in quote; retry with a fresh snapshot");
    }
    const config = AmmConfigLayout.decode(configAccount.data);
    if (config.tradeFeeRate !== BYREAL_XSPCX_USDC_POOL.feeRate || config.tickSpacing !== BYREAL_XSPCX_USDC_POOL.tickSpacing) {
      throw new PoolIdentityMismatchError("Byreal fee config changed from its pinned values");
    }
    const tickArrayDataHashes = tickArrayAccounts.map((account, index) => {
      const key = uniqueTickArrays[index]!;
      if (!account || !account.owner.equals(programId) || account.data.length < 8) throw new PoolIdentityMismatchError(`Byreal tick array is missing or owned by the wrong program: ${key.toBase58()}`);
      try {
        const tickArray = TickArrayUtils.parseTickArrayContainer(account.data, key);
        if (tickArray.data.poolId.toBase58() !== pool.address) throw new Error("pool id mismatch");
      } catch { throw new PoolIdentityMismatchError(`Byreal tick array layout or pool identity mismatch: ${key.toBase58()}`); }
      return createHash("sha256").update(account.data).digest("hex");
    });
    const addresses = uniqueTickArrays.map((key) => key.toBase58());
    const hashes = [poolAccount, configAccount, bitmapAccount].map((account) => createHash("sha256").update(account.data).digest("hex"));
    return {
      fingerprint: createHash("sha256").update(JSON.stringify({ pool: pool.address, hashes, tickArrays: addresses.map((address, index) => [address, tickArrayDataHashes[index]]) })).digest("hex"),
      slot: context.slot, tickArrays: addresses, tickArrayDataHashes,
    };
  }

  private async exactInQuote(pool: RegisteredPool, input: QuoteInput): Promise<{
    poolInfo: Awaited<ReturnType<Chain["getRawPoolInfoByPoolId"]>>;
    quote: Awaited<ReturnType<Chain["qouteSwap"]>>;
    state: Awaited<ReturnType<ByrealClmmAdapter["fingerprint"]>>;
    assetToken: ReturnType<ByrealClmmAdapter["validateToken"]>;
    quoteToken: ReturnType<ByrealClmmAdapter["validateToken"]>;
  }> {
    const poolInfo = await this.loadPoolInfo(pool);
    const tokenState = await readSolanaTokenState(this.connection, pool);
    const assetToken = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.asset_address)!, tokenState.blockTimestamp);
    const quoteToken = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.quote_address)!, tokenState.blockTimestamp);
    if (assetToken.mint.decimals !== pool.token_in_out.asset_decimals || quoteToken.mint.decimals !== pool.token_in_out.quote_decimals) {
      throw new PoolIdentityMismatchError("Byreal registered mint decimals do not match the pinned pool");
    }
    if (input.direction === "asset_to_quote" && input.expectedAssetUiMultiplier !== undefined
      && !new Decimal(input.expectedAssetUiMultiplier).eq(assetToken.uiMultiplier)) throw new Error("Byreal scaled UI multiplier changed while sizing the exact-in amount");
    const inputAddress = input.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
    const inputMint = poolInfo.mintA.toBase58() === inputAddress ? poolInfo.mintA : poolInfo.mintB;
    const quote = await this.chain.qouteSwap({ poolInfo, inputTokenMint: inputMint, amountIn: new BN(input.amountInRaw.toString()),
      slippage: input.slippageBps / 10_000, catchLiquidityInsufficient: true });
    if (!quote.allTrade || BigInt(quote.amountIn.toString()) !== input.amountInRaw) throw new Error("Byreal exact-in quote is partial");
    const amountOutRaw = BigInt(quote.expectedAmountOut.toString());
    const minimumAmountOutRaw = BigInt(quote.minAmountOut.toString());
    if (amountOutRaw <= 0n || minimumAmountOutRaw <= 0n || minimumAmountOutRaw > amountOutRaw) throw new Error("Byreal exact-in quote returned invalid output amounts");
    const state = await this.fingerprint(pool, poolInfo, quote.remainingAccounts as PublicKey[]);
    return { poolInfo, quote, state, assetToken, quoteToken };
  }

  async quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote> {
    if (input.amountInRaw <= 0n || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) throw new Error("Invalid exact-in amount or slippage");
    const result = await this.exactInQuote(pool, input);
    const amountOutRaw = BigInt(result.quote.expectedAmountOut.toString());
    const minimumAmountOutRaw = BigInt(result.quote.minAmountOut.toString());
    const assetIsA = result.poolInfo.mintA.toBase58() === pool.token_in_out.asset_address;
    const quotePerAsset = byrealQuotePerAsset(SqrtPriceMath.sqrtPriceX64ToPrice(result.poolInfo.sqrtPriceX64,
      result.poolInfo.mintDecimalsA, result.poolInfo.mintDecimalsB), assetIsA);
    const priceImpactPercent = impactFromMarginalPrice(quotePerAsset, input.direction, input.amountInRaw, amountOutRaw,
      pool.token_in_out.asset_decimals, pool.token_in_out.quote_decimals);
    const quotedAt = Date.now();
    return {
      poolId: pool.id, direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw, minimumAmountOutRaw,
      priceImpactPercent, networkFeeNativeRaw: null, networkFeeUsdt: null, assetUiMultiplier: result.assetToken.uiMultiplier,
      version: { chain: "solana", slot: BigInt(result.state.slot), observedAt: quotedAt, stateFingerprint: result.state.fingerprint }, quotedAt,
      mintTokenPrograms: { asset: result.assetToken.owner.toBase58(), quote: result.quoteToken.owner.toBase58() },
      raw: { slot: result.state.slot, tickCurrent: result.poolInfo.tickCurrent, tickSpacing: result.poolInfo.tickSpacing,
        feeRate: BYREAL_XSPCX_USDC_POOL.feeRate, decayFeeFlag: result.poolInfo.decayFeeFlag,
        liquidity: result.poolInfo.liquidity.toString(), sqrtPriceX64: result.poolInfo.sqrtPriceX64.toString(),
        tickArrays: result.state.tickArrays, tickArrayDataHashes: result.state.tickArrayDataHashes,
        amountOutRaw: amountOutRaw.toString(), minimumAmountOutRaw: minimumAmountOutRaw.toString(), feeRaw: result.quote.feeAmount.toString(),
        slippageBps: input.slippageBps, priceImpactPercent, assetUiMultiplier: result.assetToken.uiMultiplier,
        multiplierEffectiveTimestamp: result.assetToken.multiplierEffectiveTimestamp,
        assetTokenProgram: result.assetToken.owner.toBase58(), quoteTokenProgram: result.quoteToken.owner.toBase58(),
        assetExtensions: result.assetToken.extensions.map(extensionName) },
    };
  }

  async buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap> {
    assertExecutionInput(pool, input, "solana");
    if (pool.mode !== "observe_only" || input.simulationOnly !== true) throw new Error("Byreal swaps can only be built for observe-only simulation");
    const raw = input.quote.raw as { slippageBps?: unknown };
    const slippageBps = raw && Number.isSafeInteger(raw.slippageBps) ? Number(raw.slippageBps) : undefined;
    if (slippageBps === undefined || !input.quote.mintTokenPrograms) throw new Error("Byreal quote is missing validated swap metadata");
    const fresh = await this.exactInQuote(pool, { direction: input.quote.direction, amountInRaw: input.quote.amountInRaw, slippageBps });
    if (fresh.state.fingerprint !== input.quote.version.stateFingerprint
      || BigInt(fresh.quote.expectedAmountOut.toString()) !== input.quote.amountOutRaw
      || BigInt(fresh.quote.minAmountOut.toString()) !== input.quote.minimumAmountOutRaw
      || fresh.assetToken.uiMultiplier !== input.quote.assetUiMultiplier
      || fresh.assetToken.owner.toBase58() !== input.quote.mintTokenPrograms.asset
      || fresh.quoteToken.owner.toBase58() !== input.quote.mintTokenPrograms.quote) throw new Error("Byreal pool, tick arrays or mint state changed; requote before building");

    const wallet = new PublicKey(input.wallet);
    const mintA = new PublicKey(fresh.poolInfo.mintA.toBase58());
    const mintB = new PublicKey(fresh.poolInfo.mintB.toBase58());
    const tokenProgramA = mintA.toBase58() === pool.token_in_out.asset_address ? new PublicKey(input.quote.mintTokenPrograms.asset) : new PublicKey(input.quote.mintTokenPrograms.quote);
    const tokenProgramB = mintB.toBase58() === pool.token_in_out.asset_address ? new PublicKey(input.quote.mintTokenPrograms.asset) : new PublicKey(input.quote.mintTokenPrograms.quote);
    const tokenAccountA = getAssociatedTokenAddressSync(mintA, wallet, false, tokenProgramA, ASSOCIATED_TOKEN_PROGRAM_ID);
    const tokenAccountB = getAssociatedTokenAddressSync(mintB, wallet, false, tokenProgramB, ASSOCIATED_TOKEN_PROGRAM_ID);
    const swapResult = await Instruction.swapBaseInInstruction({
      poolInfo: fresh.poolInfo, ownerInfo: { wallet: wallet as never, tokenAccountA: tokenAccountA as never, tokenAccountB: tokenAccountB as never },
      amount: new BN(input.quote.amountInRaw.toString()), otherAmountThreshold: new BN(input.quote.minimumAmountOutRaw.toString()),
      sqrtPriceLimitX64: fresh.quote.executionPrice, exTickArrayBitmap: getPdaExBitmapAccount(BYREAL_CLMM_PROGRAM_ID, fresh.poolInfo.poolId).publicKey,
      tickArray: fresh.quote.remainingAccounts, isInputMintA: fresh.quote.isInputMintA,
    });
    if (swapResult.instructions.length !== 1) throw new Error("Byreal SDK returned an unexpected swap instruction count");
    const swapInstruction = swapResult.instructions[0]!;
    if (!swapInstruction.programId.equals(new PublicKey(BYREAL_CLMM_PROGRAM_ADDRESS))) throw new Error("Byreal SDK returned an instruction for an unexpected program");
    const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: wallet, recentBlockhash: latestBlockhash.blockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(wallet, tokenAccountA, wallet, mintA, tokenProgramA),
      createAssociatedTokenAccountIdempotentInstruction(wallet, tokenAccountB, wallet, mintB, tokenProgramB), swapInstruction as never,
    );
    const state = fresh.state;
    return { chain: "solana", poolId: pool.id, direction: input.quote.direction, wallet: input.wallet,
      amountInRaw: input.quote.amountInRaw, minimumAmountOutRaw: input.quote.minimumAmountOutRaw,
      stateFingerprint: state.fingerprint, version: input.quote.version, simulationOnly: true,
      mintTokenPrograms: input.quote.mintTokenPrograms,
      transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
  }

  async simulateSwap(pool: RegisteredPool, swap: UnsignedSwap, signer?: Keypair): Promise<SwapSimulationResult> {
    return simulateSolanaSwap({ pool, swap, signer, connection: this.connection, verifyPool: () => this.verify(pool),
      currentStateFingerprint: async () => {
        const quote = await this.quoteExactIn(pool, { direction: swap.direction, amountInRaw: swap.amountInRaw, slippageBps: 50 });
        return quote.version.stateFingerprint;
      } });
  }

  async watch(pool: RegisteredPool, callbacks: PoolWatchCallbacks): Promise<() => Promise<void>> {
    return startSolanaAccountWatch(this.connection, pool.rpc_ws, pool.address, this.dex.program_id!, async (reverify) => {
      if (reverify) await this.verify(pool);
      const data = await this.loadPoolInfo(pool);
      const price = SqrtPriceMath.sqrtPriceX64ToPrice(data.sqrtPriceX64, data.mintDecimalsA, data.mintDecimalsB);
      return byrealQuotePerAsset(price, data.mintA.toBase58() === pool.token_in_out.asset_address).toString();
    }, callbacks);
  }
}
