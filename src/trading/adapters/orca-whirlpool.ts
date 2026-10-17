import BN from "bn.js";
import Decimal from "decimal.js";
import type { Address } from "@coral-xyz/anchor";
import { AddressUtil, Percentage, ReadOnlyWallet, type ParsableEntity, type SimpleAccountFetchOptions, type SimpleAccountFetcher } from "@orca-so/common-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction, type AccountInfo } from "@solana/web3.js";
import { buildDefaultAccountFetcher, buildWhirlpoolClient, IGNORE_CACHE, ORCA_WHIRLPOOL_PROGRAM_ID, swapQuoteByInputToken, UseFallbackTickArray, WhirlpoolContext, type SwapQuote, type WhirlpoolData, type WhirlpoolSupportedTypes } from "@orca-so/whirlpools-sdk";
import { solanaRpcFetch } from "../../solana-rpc-logging.js";
import { ORCA_WHIRLPOOL_PROGRAM_ADDRESS, ORCA_XSPCX_USDC_POOL, type MarketRegistry, type RegisteredPool } from "../market-registry.js";
import { simulateSolanaSwap } from "../raydium-simulator.js";
import { PoolIdentityMismatchError, UnsupportedTokenError, assertExecutionInput, assertOrcaSwapTransaction, createSolanaSimulationTransaction, errorMessage, expectedDecimals, extensionName, fingerprintOrcaState, impactFromOrcaSqrtPrice, isScopedToken2022Pool, minimumOut, orcaInputMint, orcaQuotePerAsset, orcaTickArrayAddresses, readSolanaTokenState, startSolanaAccountWatch, validateSolanaTokenSupport } from "../pool-adapters.js";
import type { ExactInQuote, PoolAdapter, PoolWatchCallbacks, QuoteInput, SolanaMintState, SwapBuildInput, SwapSimulationResult, UnsignedSwap } from "../pool-adapters.js";

export function createOrcaContext(connection: Connection, wallet: ReadOnlyWallet) {
  const orcaFetcher = buildDefaultAccountFetcher(connection);
  const batchFetcher = orcaFetcher.fetcher as SimpleAccountFetcher<WhirlpoolSupportedTypes, SimpleAccountFetchOptions>;
  // Orca common-sdk 0.7.1 detaches rejected batch RPC calls in an async Promise executor.
  // shortcut: array batch reads bypass the SDK cache; revisit if this adapter needs cached array reads.
  const fetchParsedAccounts = async <T extends WhirlpoolSupportedTypes>(
    addresses: Address[], parser: ParsableEntity<T>, timeoutInSeconds = 10,
  ) => {
    const keys = AddressUtil.toPubKeys(addresses);
    const accounts: Array<AccountInfo<Buffer> | null> = [];
    for (let index = 0; index < keys.length; index += 100) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("connection.getMultipleAccountsInfo timeout")), timeoutInSeconds * 1000);
        });
        accounts.push(...await Promise.race([
          connection.getMultipleAccountsInfo(keys.slice(index, index + 100), "confirmed"), timeoutPromise,
        ]));
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    if (accounts.length !== keys.length) throw new Error("Orca batch account read returned an incomplete result");
    return { keys, parsed: keys.map((key, index) => parser.parse(key, accounts[index])) };
  };
  batchFetcher.getAccounts = async <T extends WhirlpoolSupportedTypes>(
    addresses: Address[], parser: ParsableEntity<T>, opts?: { maxAge?: number; timeoutInSeconds?: number }, now = Date.now(),
  ) => {
    const addressStrs = AddressUtil.toStrings(addresses);
    const maxAge = opts?.maxAge ?? batchFetcher.retentionPolicy.get(parser as ParsableEntity<WhirlpoolSupportedTypes>) ?? Number.POSITIVE_INFINITY;
    const missing = addressStrs.filter((address) => {
      const cached = batchFetcher.cache.get(address);
      return !cached || now - cached.fetchedAt > maxAge;
    });
    if (missing.length) {
      const { keys, parsed } = await fetchParsedAccounts(missing, parser, opts?.timeoutInSeconds);
      const fetched = new Map<string, T | null>();
      parsed.forEach((value, index) => fetched.set(keys[index]!.toBase58(), value));
      batchFetcher.populateAccounts(fetched, parser, now);
    }
    const result = new Map<string, T | null>();
    addressStrs.forEach((address) => result.set(address, batchFetcher.cache.get(address)?.value as T | null | undefined ?? null));
    return result;
  };
  batchFetcher.getAccountsAsArray = async <T extends WhirlpoolSupportedTypes>(
    addresses: Address[], parser: ParsableEntity<T>, opts?: { maxAge?: number; timeoutInSeconds?: number }, now = Date.now(),
  ) => {
    const { keys, parsed } = await fetchParsedAccounts(addresses, parser, opts?.timeoutInSeconds);
    const parsedMap = new Map<string, T | null>();
    parsed.forEach((value, index) => parsedMap.set(keys[index]!.toBase58(), value));
    batchFetcher.populateAccounts(parsedMap, parser, now);
    return parsed;
  };
  return WhirlpoolContext.from(connection, wallet, orcaFetcher, undefined, {}, ORCA_WHIRLPOOL_PROGRAM_ID);
}

export class OrcaWhirlpoolAdapter implements PoolAdapter {
  readonly stateSource = "adapter_watch" as const;
  private readonly connection: Connection;
  private readonly context: ReturnType<typeof WhirlpoolContext.from>;
  private readonly client: ReturnType<typeof buildWhirlpoolClient>;
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;
  private readonly wsUrl: string | null;

  constructor(registry: MarketRegistry, pool: RegisteredPool) {
    const dex = registry.dexes[pool.dex];
    const rpc = pool.rpc_http;
    if (!dex || !rpc || dex.program_id !== ORCA_WHIRLPOOL_PROGRAM_ADDRESS) throw new Error("Solana RPC or pinned Orca Whirlpool Program ID is not configured");
    this.dex = dex;
    this.wsUrl = pool.rpc_ws;
    this.connection = new Connection(rpc, { commitment: "confirmed", wsEndpoint: pool.rpc_ws ?? undefined, fetch: solanaRpcFetch, disableRetryOnRateLimit: true });
    this.context = createOrcaContext(this.connection, new ReadOnlyWallet(PublicKey.default));
    this.client = buildWhirlpoolClient(this.context);
  }

  private validatePoolData(pool: RegisteredPool, data: WhirlpoolData): void {
    const pairMatches = (data.tokenMintA.toBase58() === pool.token_in_out.asset_address && data.tokenMintB.toBase58() === pool.token_in_out.quote_address)
      || (data.tokenMintA.toBase58() === pool.token_in_out.quote_address && data.tokenMintB.toBase58() === pool.token_in_out.asset_address);
    if (pool.id !== ORCA_XSPCX_USDC_POOL.id || pool.address !== ORCA_XSPCX_USDC_POOL.address || pool.mode !== "observe_only"
      || pool.reason !== "quote_asset_not_pinned" || this.dex.program_id !== ORCA_WHIRLPOOL_PROGRAM_ADDRESS || !pairMatches
      || pool.expected_fee_rate === undefined || data.feeRate !== pool.expected_fee_rate
      || pool.expected_tick_spacing === undefined || data.tickSpacing !== pool.expected_tick_spacing) {
      throw new PoolIdentityMismatchError("Orca Whirlpool identity, mint pair, fee rate or tick spacing does not match the pinned pool");
    }
  }

  private validateToken(pool: RegisteredPool, state: SolanaMintState, blockTimestamp: bigint): SolanaMintState & { uiMultiplier: string; multiplierEffectiveTimestamp: string | null } {
    try { return validateSolanaTokenSupport(pool, state, blockTimestamp, "orca_whirlpool", this.dex.program_id); }
    catch (error) {
      if (error instanceof UnsupportedTokenError) throw new PoolIdentityMismatchError(`Orca mint extension policy mismatch: ${error.message}`);
      throw error;
    }
  }

  async verify(pool: RegisteredPool): Promise<void> {
    if (await this.connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new PoolIdentityMismatchError("Orca Whirlpool RPC is not Solana mainnet");
    const poolKey = new PublicKey(pool.address);
    const data = await this.context.fetcher.getPool(poolKey, IGNORE_CACHE);
    if (!data) throw new PoolIdentityMismatchError("Orca Whirlpool pool account is missing");
    this.validatePoolData(pool, data);
    const tokenState = await readSolanaTokenState(this.connection, pool);
    const mintA = tokenState.mints.get(data.tokenMintA.toBase58());
    const mintB = tokenState.mints.get(data.tokenMintB.toBase58());
    if (!mintA || !mintB || mintA.mint.decimals !== expectedDecimals(data.tokenMintA.toBase58(), pool)
      || mintB.mint.decimals !== expectedDecimals(data.tokenMintB.toBase58(), pool)) {
      throw new PoolIdentityMismatchError("Orca Whirlpool mint decimals do not match the pinned pool");
    }
    const asset = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.asset_address)!, tokenState.blockTimestamp);
    const quote = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.quote_address)!, tokenState.blockTimestamp);
    if (!asset.owner.equals(TOKEN_2022_PROGRAM_ID) || !quote.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new PoolIdentityMismatchError("Orca XSPCX/USDC must use the reviewed Token-2022 asset and classic SPL USDC mint");
    }
    const accounts = await this.connection.getMultipleAccountsInfoAndContext([poolKey, data.tokenVaultA, data.tokenVaultB], "confirmed");
    const [poolAccount, vaultAAccount, vaultBAccount] = accounts.value;
    if (!poolAccount || !poolAccount.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID)) throw new PoolIdentityMismatchError("Orca pool account owner does not match its program");
    for (const [vaultKey, vaultAccount, mint] of [[data.tokenVaultA, vaultAAccount, mintA], [data.tokenVaultB, vaultBAccount, mintB]] as const) {
      if (!vaultAccount || !vaultAccount.owner.equals(mint.owner)) throw new PoolIdentityMismatchError("Orca token vault is missing or owned by the wrong token program");
      let vault: ReturnType<typeof unpackAccount>;
      try { vault = unpackAccount(vaultKey, vaultAccount, vaultAccount.owner); }
      catch { throw new PoolIdentityMismatchError("Orca token vault account layout is invalid"); }
      if (!vault.mint.equals(mint.mint.address) || !vault.owner.equals(poolKey)) throw new PoolIdentityMismatchError("Orca token vault mint or authority does not match the decoded pool");
    }
  }

  async watch(pool: RegisteredPool, callbacks: PoolWatchCallbacks): Promise<() => Promise<void>> {
    return startSolanaAccountWatch(this.connection, this.wsUrl, pool.address, this.dex.program_id!, async (reverify) => {
      if (reverify) await this.verify(pool);
      const data = await this.context.fetcher.getPool(new PublicKey(pool.address), IGNORE_CACHE);
      if (!data) throw new PoolIdentityMismatchError("Orca Whirlpool pool account is missing");
      this.validatePoolData(pool, data);
      return orcaQuotePerAsset(data, pool);
    }, callbacks);
  }

  async getAssetUiMultiplier(pool: RegisteredPool): Promise<string> {
    const state = await readSolanaTokenState(this.connection, pool);
    const asset = state.mints.get(pool.token_in_out.asset_address);
    if (!asset) throw new PoolIdentityMismatchError("Orca registered asset mint is missing");
    return this.validateToken(pool, asset, state.blockTimestamp).uiMultiplier;
  }

  private async exactInQuote(
    client: ReturnType<typeof buildWhirlpoolClient>, context: ReturnType<typeof WhirlpoolContext.from>,
    pool: RegisteredPool, direction: ExactInQuote["direction"], amountInRaw: bigint,
  ): Promise<{ whirlpool: Awaited<ReturnType<typeof client.getPool>>; data: WhirlpoolData; quote: SwapQuote }> {
    const whirlpool = await client.getPool(pool.address, IGNORE_CACHE);
    const data = whirlpool.getData();
    this.validatePoolData(pool, data);
    const inputMint = orcaInputMint(pool, direction);
    const quote = await swapQuoteByInputToken(whirlpool, inputMint, new BN(amountInRaw.toString()), Percentage.fromFraction(0, 10_000),
      ORCA_WHIRLPOOL_PROGRAM_ID, context.fetcher, IGNORE_CACHE, UseFallbackTickArray.Never);
    const inputIsA = inputMint === data.tokenMintA.toBase58();
    if (quote.aToB !== inputIsA || !quote.amountSpecifiedIsInput || BigInt(quote.estimatedAmountIn.toString()) !== amountInRaw) {
      throw new PoolIdentityMismatchError("Orca SDK returned a quote with the wrong input direction or amount");
    }
    return { whirlpool, data, quote };
  }

  async quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote> {
    if (input.amountInRaw <= 0n || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) throw new Error("Invalid exact-in amount or slippage");
    const { data, quote } = await this.exactInQuote(this.client, this.context, pool, input.direction, input.amountInRaw);
    const tokenState = await readSolanaTokenState(this.connection, pool);
    const assetToken = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.asset_address)!, tokenState.blockTimestamp);
    const quoteToken = this.validateToken(pool, tokenState.mints.get(pool.token_in_out.quote_address)!, tokenState.blockTimestamp);
    if (input.direction === "asset_to_quote" && input.expectedAssetUiMultiplier !== undefined
      && !new Decimal(input.expectedAssetUiMultiplier).eq(assetToken.uiMultiplier)) throw new Error("Orca scaled UI multiplier changed while sizing the exact-in amount");
    const amountOutRaw = BigInt(quote.estimatedAmountOut.toString());
    const minimumAmountOutRaw = minimumOut(amountOutRaw, input.slippageBps);
    if (amountOutRaw <= 0n || minimumAmountOutRaw <= 0n) throw new Error("Orca exact-in quote returned a non-positive output");
    const tickArrayAddresses = orcaTickArrayAddresses(quote);
    const state = await fingerprintOrcaState(this.connection, pool, data, tickArrayAddresses);
    const isAssetA = data.tokenMintA.toBase58() === pool.token_in_out.asset_address;
    const priceImpactPercent = impactFromOrcaSqrtPrice(BigInt(data.sqrtPrice.toString()), input.direction, input.amountInRaw, amountOutRaw,
      pool.token_in_out.asset_decimals, pool.token_in_out.quote_decimals, isAssetA);
    const quotedAt = Date.now();
    return {
      poolId: pool.id, direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw, minimumAmountOutRaw,
      priceImpactPercent, networkFeeNativeRaw: null, networkFeeUsdt: null, assetUiMultiplier: assetToken.uiMultiplier,
      version: { chain: "solana", slot: BigInt(state.slot), observedAt: quotedAt, stateFingerprint: state.fingerprint }, quotedAt,
      mintTokenPrograms: { asset: assetToken.owner.toBase58(), quote: quoteToken.owner.toBase58() },
      raw: { slot: state.slot, feeRate: data.feeRate, tickSpacing: data.tickSpacing, tickCurrentIndex: data.tickCurrentIndex,
        liquidity: data.liquidity.toString(), sqrtPrice: data.sqrtPrice.toString(), tickArrays: state.tickArrays,
        tickArrayDataHashes: state.tickArrayDataHashes, amountOutRaw: amountOutRaw.toString(), minimumAmountOutRaw: minimumAmountOutRaw.toString(),
        feeRaw: quote.estimatedFeeAmount.toString(), estimatedEndTickIndex: quote.estimatedEndTickIndex,
        estimatedEndSqrtPrice: quote.estimatedEndSqrtPrice.toString(), priceImpactPercent, assetUiMultiplier: assetToken.uiMultiplier,
        multiplierEffectiveTimestamp: assetToken.multiplierEffectiveTimestamp, chainTimestamp: tokenState.blockTimestamp.toString(),
        assetTokenProgram: assetToken.owner.toBase58(), quoteTokenProgram: quoteToken.owner.toBase58(), assetExtensions: assetToken.extensions.map(extensionName) },
    };
  }

  async buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap> {
    assertExecutionInput(pool, input, "solana");
    if (input.simulationOnly !== true) throw new Error("Orca swaps can only be built for simulation");
    await this.verify(pool);
    const wallet = new PublicKey(input.wallet);
    const context = createOrcaContext(this.connection, new ReadOnlyWallet(wallet));
    const client = buildWhirlpoolClient(context);
    const { whirlpool, data, quote } = await this.exactInQuote(client, context, pool, input.quote.direction, input.quote.amountInRaw);
    const state = await fingerprintOrcaState(this.connection, pool, data, orcaTickArrayAddresses(quote));
    if (state.fingerprint !== input.quote.version.stateFingerprint) throw new Error("Orca pool state changed; requote before building");
    if (BigInt(quote.estimatedAmountOut.toString()) !== input.quote.amountOutRaw) throw new Error("Orca exact-in quote changed; requote before building");
    quote.otherAmountThreshold = new BN(input.quote.minimumAmountOutRaw.toString());
    const builder = await whirlpool.swap(quote, wallet);
    const payload = await builder.build({ maxSupportedTransactionVersion: "legacy" });
    if (payload.signers.length || !(payload.transaction instanceof Transaction) || !payload.transaction.feePayer?.equals(wallet)) {
      throw new Error("Orca unsigned swap has extra signers or an unexpected fee payer");
    }
    if (!input.quote.mintTokenPrograms) throw new Error("Orca quote is missing validated mint token programs");
    assertOrcaSwapTransaction(payload.transaction, context, pool, input.quote, quote, data, wallet);
    return { chain: "solana", poolId: pool.id, direction: input.quote.direction, wallet: input.wallet,
      amountInRaw: input.quote.amountInRaw, minimumAmountOutRaw: input.quote.minimumAmountOutRaw,
      stateFingerprint: state.fingerprint, version: input.quote.version, simulationOnly: true,
      mintTokenPrograms: input.quote.mintTokenPrograms!,
      transactionBase64: payload.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
  }

  async simulateSwap(pool: RegisteredPool, swap: UnsignedSwap, signer?: Keypair): Promise<SwapSimulationResult> {
    return simulateSolanaSwap({ pool, swap, signer, connection: this.connection, verifyPool: () => this.verify(pool),
      currentStateFingerprint: async () => {
        const { data, quote } = await this.exactInQuote(this.client, this.context, pool, swap.direction, swap.amountInRaw);
        return (await fingerprintOrcaState(this.connection, pool, data, orcaTickArrayAddresses(quote))).fingerprint;
      } });
  }
}

