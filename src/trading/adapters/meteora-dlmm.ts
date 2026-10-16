import BN from "bn.js";
import Decimal from "decimal.js";
import { createRequire } from "node:module";
import { Percentage, ReadOnlyWallet } from "@orca-so/common-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { BinArrayAccount, SwapQuote as MeteoraSwapQuote } from "@meteora-ag/dlmm";
import { solanaRpcFetch } from "../../solana-rpc-logging.js";
import { METEORA_DLMM_PROGRAM_ADDRESS, METEORA_XSPCX_USDC_POOL, type MarketRegistry, type RegisteredPool } from "../market-registry.js";
import { simulateSolanaSwap } from "../raydium-simulator.js";
import { PoolIdentityMismatchError, UnsupportedTokenError, assertExecutionInput, assertMeteoraFullFill, assertMeteoraSwapTransaction, createSolanaSimulationTransaction, errorMessage, expectedDecimals, extensionName, fingerprintMeteoraState, impactFromMarginalPrice, isScopedToken2022Pool, meteoraActiveBinPrice, meteoraQuotePerAsset, meteoraSwapForY, minimumOut, readSolanaTokenState, solanaPairMatches, startSolanaAccountWatch, validateSolanaTokenSupport } from "../pool-adapters.js";
import type { ExactInQuote, PoolAdapter, PoolWatchCallbacks, QuoteInput, SolanaMintState, SwapBuildInput, SwapSimulationResult, UnsignedSwap } from "../pool-adapters.js";

// The SDK's ESM entrypoint imports an invalid Anchor directory in Node; its CJS entrypoint resolves correctly.
const DLMM = createRequire(import.meta.url)("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm").default;

export class MeteoraDlmmAdapter implements PoolAdapter {
  readonly stateSource = "adapter_watch" as const;
  private readonly connection: Connection;
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;
  private readonly wsUrl: string | null;

  constructor(registry: MarketRegistry, dexId: string) {
    const dex = registry.dexes[dexId];
    const rpc = registry.chains.solana.rpc_http;
    if (!dex || !rpc || dex.program_id !== METEORA_DLMM_PROGRAM_ADDRESS) throw new Error("Solana RPC or pinned Meteora DLMM Program ID is not configured");
    this.dex = dex;
    this.wsUrl = registry.chains.solana.rpc_ws;
    this.connection = new Connection(rpc, { commitment: "confirmed", wsEndpoint: this.wsUrl ?? undefined, fetch: solanaRpcFetch, disableRetryOnRateLimit: true });
  }

  private createDlmm(pool: RegisteredPool): Promise<InstanceType<typeof DLMM>> {
    return DLMM.create(this.connection, new PublicKey(pool.address), { cluster: "mainnet-beta" });
  }

  private validatePoolData(pool: RegisteredPool, dlmm: InstanceType<typeof DLMM>): void {
    const pair = dlmm.lbPair;
    const tokenX = pair.tokenXMint.toBase58();
    const tokenY = pair.tokenYMint.toBase58();
    if (pool.id !== METEORA_XSPCX_USDC_POOL.id || pool.instrument_id !== METEORA_XSPCX_USDC_POOL.instrumentId
      || pool.address !== METEORA_XSPCX_USDC_POOL.address || pool.mode !== "observe_only" || pool.reason !== "quote_asset_not_pinned"
      || this.dex.program_id !== METEORA_DLMM_PROGRAM_ADDRESS || dlmm.program.programId.toBase58() !== METEORA_DLMM_PROGRAM_ADDRESS
      || !solanaPairMatches(tokenX, tokenY, pool.token_in_out.asset_address, pool.token_in_out.quote_address)
      || pair.binStep !== METEORA_XSPCX_USDC_POOL.binStep || pool.expected_bin_step !== pair.binStep) {
      throw new PoolIdentityMismatchError("Meteora DLMM identity, mint pair or bin step does not match the pinned pool");
    }
  }

  private validateToken(pool: RegisteredPool, state: SolanaMintState, blockTimestamp: bigint): SolanaMintState & { uiMultiplier: string; multiplierEffectiveTimestamp: string | null } {
    try { return validateSolanaTokenSupport(pool, state, blockTimestamp, "meteora_dlmm", this.dex.program_id); }
    catch (error) {
      if (error instanceof UnsupportedTokenError) throw new PoolIdentityMismatchError(`Meteora mint extension policy mismatch: ${error.message}`);
      throw error;
    }
  }

  async verify(pool: RegisteredPool): Promise<void> {
    if (await this.connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new PoolIdentityMismatchError("Meteora DLMM RPC is not Solana mainnet");
    const account = await this.connection.getAccountInfoAndContext(new PublicKey(pool.address), "confirmed");
    if (!account.value || !account.value.owner.equals(new PublicKey(METEORA_DLMM_PROGRAM_ADDRESS)) || account.value.data.length < 8) {
      throw new PoolIdentityMismatchError("Meteora LbPair account is missing, malformed or owned by the wrong program");
    }
    const [dlmm, tokenState] = await Promise.all([this.createDlmm(pool), readSolanaTokenState(this.connection, pool)]);
    this.validatePoolData(pool, dlmm);
    const mintX = tokenState.mints.get(dlmm.lbPair.tokenXMint.toBase58());
    const mintY = tokenState.mints.get(dlmm.lbPair.tokenYMint.toBase58());
    const asset = tokenState.mints.get(pool.token_in_out.asset_address);
    const quote = tokenState.mints.get(pool.token_in_out.quote_address);
    if (!mintX || !mintY || !asset || !quote
      || mintX.mint.decimals !== expectedDecimals(dlmm.lbPair.tokenXMint.toBase58(), pool)
      || mintY.mint.decimals !== expectedDecimals(dlmm.lbPair.tokenYMint.toBase58(), pool)) {
      throw new PoolIdentityMismatchError("Meteora DLMM mint decimals do not match the pinned pool");
    }
    const checkedAsset = this.validateToken(pool, asset, tokenState.blockTimestamp);
    const checkedQuote = this.validateToken(pool, quote, tokenState.blockTimestamp);
    if (!checkedAsset.owner.equals(TOKEN_2022_PROGRAM_ID) || !checkedQuote.owner.equals(TOKEN_PROGRAM_ID)
      || !dlmm.tokenX.owner.equals(mintX.owner) || !dlmm.tokenY.owner.equals(mintY.owner)) {
      throw new PoolIdentityMismatchError("Meteora XSPCX/USDC must use the reviewed Token-2022 asset and classic SPL USDC mint");
    }
  }

  async getAssetUiMultiplier(pool: RegisteredPool): Promise<string> {
    const state = await readSolanaTokenState(this.connection, pool);
    const asset = state.mints.get(pool.token_in_out.asset_address);
    if (!asset) throw new PoolIdentityMismatchError("Meteora registered asset mint is missing");
    return this.validateToken(pool, asset, state.blockTimestamp).uiMultiplier;
  }

  private async exactInQuote(pool: RegisteredPool, input: QuoteInput): Promise<{
    dlmm: InstanceType<typeof DLMM>; bins: BinArrayAccount[]; quote: MeteoraSwapQuote;
    state: Awaited<ReturnType<typeof fingerprintMeteoraState>>; activeBin: { binId: number; pricePerToken: string };
    assetToken: ReturnType<MeteoraDlmmAdapter["validateToken"]>; quoteToken: ReturnType<MeteoraDlmmAdapter["validateToken"]>;
  }> {
    const dlmm = await this.createDlmm(pool);
    this.validatePoolData(pool, dlmm);
    const tokenState = await readSolanaTokenState(this.connection, pool);
    const assetToken = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.asset_address)!, tokenState.blockTimestamp);
    const quoteToken = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.quote_address)!, tokenState.blockTimestamp);
    if (assetToken.mint.decimals !== pool.token_in_out.asset_decimals || quoteToken.mint.decimals !== pool.token_in_out.quote_decimals) {
      throw new PoolIdentityMismatchError("Meteora registered mint decimals do not match the pinned pool");
    }
    if (input.direction === "asset_to_quote" && input.expectedAssetUiMultiplier !== undefined
      && !new Decimal(input.expectedAssetUiMultiplier).eq(assetToken.uiMultiplier)) throw new Error("Meteora scaled UI multiplier changed while sizing the exact-in amount");
    const swapForY = meteoraSwapForY(pool, input.direction, dlmm.lbPair.tokenXMint.toBase58());
    const bins = await dlmm.getBinArrayForSwap(swapForY);
    const quote = dlmm.swapQuote(new BN(input.amountInRaw.toString()), swapForY, new BN(input.slippageBps), bins, false);
    assertMeteoraFullFill(BigInt(quote.consumedInAmount.toString()), input.amountInRaw);
    if (BigInt(quote.outAmount.toString()) <= 0n || BigInt(quote.minOutAmount.toString()) <= 0n) throw new Error("Meteora DLMM exact-in quote returned a non-positive output");
    const activeBin = meteoraActiveBinPrice(dlmm);
    const state = await fingerprintMeteoraState(this.connection, pool, quote.binArraysPubkey as PublicKey[]);
    return { dlmm, bins, quote, state, activeBin, assetToken, quoteToken };
  }

  async quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote> {
    if (input.amountInRaw <= 0n || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) throw new Error("Invalid exact-in amount or slippage");
    const result = await this.exactInQuote(pool, input);
    const amountOutRaw = BigInt(result.quote.outAmount.toString());
    const minimumAmountOutRaw = BigInt(result.quote.minOutAmount.toString());
    const assetIsX = result.dlmm.lbPair.tokenXMint.toBase58() === pool.token_in_out.asset_address;
    const quotePerAsset = meteoraQuotePerAsset(new Decimal(result.activeBin.pricePerToken), assetIsX);
    const priceImpactPercent = impactFromMarginalPrice(quotePerAsset, input.direction, input.amountInRaw, amountOutRaw,
      pool.token_in_out.asset_decimals, pool.token_in_out.quote_decimals);
    const quotedAt = Date.now();
    const binArrays = result.state.binArrays;
    const binArrayDataHashes = result.state.binArrayDataHashes;
    return {
      poolId: pool.id, direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw, minimumAmountOutRaw,
      priceImpactPercent, networkFeeNativeRaw: null, networkFeeUsdt: null, assetUiMultiplier: result.assetToken.uiMultiplier,
      version: { chain: "solana", slot: BigInt(result.state.slot), observedAt: quotedAt, stateFingerprint: result.state.fingerprint }, quotedAt,
      mintTokenPrograms: { asset: result.assetToken.owner.toBase58(), quote: result.quoteToken.owner.toBase58() },
      raw: { slot: result.state.slot, activeBinId: result.activeBin.binId, activeBinPrice: result.activeBin.pricePerToken,
        binStep: result.dlmm.lbPair.binStep, binArrays, binArrayDataHashes, consumedInAmount: result.quote.consumedInAmount.toString(),
        amountOutRaw: amountOutRaw.toString(), minimumAmountOutRaw: minimumAmountOutRaw.toString(), feeRaw: result.quote.fee.toString(),
        protocolFeeRaw: result.quote.protocolFee.toString(), priceImpactPercent, slippageBps: input.slippageBps,
        assetTokenProgram: result.assetToken.owner.toBase58(), quoteTokenProgram: result.quoteToken.owner.toBase58(),
        assetExtensions: result.assetToken.extensions.map(extensionName) },
    };
  }

  async buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap> {
    assertExecutionInput(pool, input, "solana");
    if (input.simulationOnly !== true) throw new Error("Meteora swaps can only be built for simulation");
    const raw = input.quote.raw as { slippageBps?: unknown };
    const slippageBps = raw && Number.isSafeInteger(raw.slippageBps) ? Number(raw.slippageBps) : undefined;
    if (slippageBps === undefined || !input.quote.mintTokenPrograms) throw new Error("Meteora quote is missing validated swap metadata");
    const fresh = await this.exactInQuote(pool, { direction: input.quote.direction, amountInRaw: input.quote.amountInRaw, slippageBps });
    if (fresh.state.fingerprint !== input.quote.version.stateFingerprint || BigInt(fresh.quote.outAmount.toString()) !== input.quote.amountOutRaw
      || BigInt(fresh.quote.minOutAmount.toString()) !== input.quote.minimumAmountOutRaw
      || fresh.assetToken.uiMultiplier !== input.quote.assetUiMultiplier
      || fresh.assetToken.owner.toBase58() !== input.quote.mintTokenPrograms.asset || fresh.quoteToken.owner.toBase58() !== input.quote.mintTokenPrograms.quote) {
      throw new Error("Meteora pool, bin or mint state changed; requote before building");
    }
    const wallet = new PublicKey(input.wallet);
    const inToken = new PublicKey(input.quote.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address);
    const outToken = new PublicKey(input.quote.direction === "asset_to_quote" ? pool.token_in_out.quote_address : pool.token_in_out.asset_address);
    const transaction = await fresh.dlmm.swap({ inToken, outToken, inAmount: new BN(input.quote.amountInRaw.toString()),
      minOutAmount: new BN(input.quote.minimumAmountOutRaw.toString()), lbPair: new PublicKey(pool.address), user: wallet,
      binArraysPubkey: fresh.quote.binArraysPubkey as PublicKey[] });
    assertMeteoraSwapTransaction(transaction, fresh.dlmm, pool, input.quote, wallet, fresh.quote.binArraysPubkey as PublicKey[]);
    return { chain: "solana", poolId: pool.id, direction: input.quote.direction, wallet: input.wallet,
      amountInRaw: input.quote.amountInRaw, minimumAmountOutRaw: input.quote.minimumAmountOutRaw,
      stateFingerprint: fresh.state.fingerprint, version: input.quote.version, simulationOnly: true,
      mintTokenPrograms: input.quote.mintTokenPrograms, transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
  }

  async simulateSwap(pool: RegisteredPool, swap: UnsignedSwap, signer?: Keypair): Promise<SwapSimulationResult> {
    return simulateSolanaSwap({ pool, swap, signer, connection: this.connection, verifyPool: () => this.verify(pool), currentStateFingerprint: async () => {
      const quote = await this.quoteExactIn(pool, { direction: swap.direction, amountInRaw: swap.amountInRaw, slippageBps: 50 });
      return quote.version.stateFingerprint;
    } });
  }

  async watch(pool: RegisteredPool, callbacks: PoolWatchCallbacks): Promise<() => Promise<void>> {
    return startSolanaAccountWatch(this.connection, this.wsUrl, pool.address, this.dex.program_id!, async (reverify) => {
      if (reverify) await this.verify(pool);
      const dlmm = await this.createDlmm(pool);
      this.validatePoolData(pool, dlmm);
      const assetIsX = dlmm.lbPair.tokenXMint.toBase58() === pool.token_in_out.asset_address;
      return meteoraQuotePerAsset(new Decimal(meteoraActiveBinPrice(dlmm).pricePerToken), assetIsX).toString();
    }, callbacks);
  }
}

