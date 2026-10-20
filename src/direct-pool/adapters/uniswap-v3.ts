import Decimal from "decimal.js";
import { Interface, JsonRpcProvider } from "ethers";
import { PoolIdentityMismatchError, assertExecutionInput, assertUniswapSwapMatchesRegistry, encodeUniswapV3Swap, errorMessage, evmPoolInterface, factoryGetterInterface, impactFromSqrtPrice, minimumOut, pairMatches, quoterInterface, readAddress, readBigInt, sameAddress, swapRouterInterface, erc20Interface, usableXLayerQuoteSnapshot } from "../pool-adapters.js";
import type { ExactInQuote, PoolAdapter, QuoteInput, SwapBuildInput, SwapSimulationResult, UnsignedSwap } from "../pool-adapters.js";
import type { MarketRegistry, RegisteredPool } from "../market-registry.js";

export class UniswapV3Adapter implements PoolAdapter {
  private static readonly feeDataTtlMs = 10_000;
  readonly stateSource = "fixed_monitor" as const;
  private readonly provider: JsonRpcProvider;
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;
  private assetAddress = "";
  private quoteAddress = "";
  private assetDecimals = 0;
  private quoteDecimals = 0;
  private rpcChainValidated = false;
  private feeDataCache?: { expiresAt: number; gasPrice: bigint | null; maxFeePerGas: bigint | null };
  private feeDataPending?: Promise<NonNullable<UniswapV3Adapter["feeDataCache"]>>;

  constructor(private readonly registry: MarketRegistry, pool: RegisteredPool) {
    const dex = registry.dexes[pool.dex];
    const rpc = pool.rpc_http;
    if (!dex || !rpc) throw new Error("X Layer direct-pool RPC or DEX registration is not configured");
    this.dex = dex;
    this.provider = new JsonRpcProvider(rpc, 196, { staticNetwork: true });
  }

  async verify(pool: RegisteredPool): Promise<void> {
    const dex = this.dex;
    if (!dex.factory || !dex.quoter_v2 || (pool.mode === "trade_candidate" && !dex.swap_router) || pool.expected_fee_tier === undefined) throw new Error("X Layer factory, QuoterV2 and pool fee tier must be configured");
    const asset = this.registry.instruments.find((item) => item.instrument_id === pool.instrument_id)?.chain_assets.find((item) => item.chain === "xlayer");
    if (!asset) throw new Error(`Missing registered X Layer asset for ${pool.instrument_id}`);
    this.assetAddress = pool.token_in_out.asset_address;
    this.quoteAddress = pool.token_in_out.quote_address;
    if (pool.mode === "trade_candidate" && (!sameAddress(this.assetAddress, asset.address) || !sameAddress(this.quoteAddress, asset.quote_asset.address))) throw new Error("X Layer trade candidate does not match the registered direct token pair");
    if (!this.rpcChainValidated) {
      if (BigInt(await this.provider.send("eth_chainId", [])) !== 196n) throw new PoolIdentityMismatchError("X Layer RPC chain ID mismatch");
      this.rpcChainValidated = true;
    }
    const block = await this.provider.getBlockNumber();
    const [factory, token0, token1, fee] = await Promise.all([
      readAddress(this.provider, pool.address, evmPoolInterface, "factory", block),
      readAddress(this.provider, pool.address, evmPoolInterface, "token0", block),
      readAddress(this.provider, pool.address, evmPoolInterface, "token1", block),
      readBigInt(this.provider, pool.address, evmPoolInterface, "fee", block),
    ]);
    const [decimals0, decimals1] = await Promise.all([
      readBigInt(this.provider, token0, erc20Interface, "decimals", block),
      readBigInt(this.provider, token1, erc20Interface, "decimals", block),
    ]);
    this.assetDecimals = sameAddress(token0, this.assetAddress) ? Number(decimals0) : Number(decimals1);
    this.quoteDecimals = sameAddress(token0, this.quoteAddress) ? Number(decimals0) : Number(decimals1);
    if (!sameAddress(factory, dex.factory) || Number(fee) !== pool.expected_fee_tier
      || !pairMatches(token0, token1, this.assetAddress, this.quoteAddress)
      || this.assetDecimals !== pool.token_in_out.asset_decimals || this.quoteDecimals !== pool.token_in_out.quote_decimals
      || (pool.mode === "trade_candidate" && (this.assetDecimals !== asset.decimals || this.quoteDecimals !== asset.quote_asset.decimals))) {
      throw new PoolIdentityMismatchError("X Layer pool factory, tokens, decimals or fee tier do not match registry");
    }
    for (const target of [dex.factory, dex.quoter_v2, ...(dex.swap_router ? [dex.swap_router] : [])]) {
      if (await this.provider.getCode(target) === "0x") throw new PoolIdentityMismatchError(`X Layer registered endpoint has no contract code: ${pool.id}`);
    }
    const quoterFactory = await readAddress(this.provider, dex.quoter_v2, factoryGetterInterface, "factory", block);
    if (!sameAddress(quoterFactory, dex.factory)) throw new PoolIdentityMismatchError("X Layer QuoterV2 factory does not match registry");
    if (dex.swap_router) {
      const routerFactory = await readAddress(this.provider, dex.swap_router, factoryGetterInterface, "factory", block);
      if (!sameAddress(routerFactory, dex.factory)) throw new PoolIdentityMismatchError("X Layer Router factory does not match registry");
    }
  }

  async getAssetUiMultiplier(_pool: RegisteredPool): Promise<string> { return "1"; }

  async quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote> {
    if (!this.assetAddress || !this.quoteAddress) await this.verify(pool);
    if (input.amountInRaw <= 0n || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) throw new Error("Invalid exact-in amount or slippage");
    const dex = this.dex;
    if (!dex.quoter_v2 || pool.expected_fee_tier === undefined) throw new Error("X Layer QuoterV2 or pool fee tier is not configured");
    const tokenIn = input.direction === "asset_to_quote" ? this.assetAddress : this.quoteAddress;
    const tokenOut = input.direction === "asset_to_quote" ? this.quoteAddress : this.assetAddress;
    const snapshot = usableXLayerQuoteSnapshot(input.xlayerSnapshot);
    let blockNumber: number;
    let blockHash: string;
    let sqrtPriceX96: bigint;
    if (snapshot) {
      blockNumber = Number(snapshot.blockNumber);
      blockHash = snapshot.blockHash;
      sqrtPriceX96 = snapshot.sqrtPriceX96;
    } else {
      const block = await this.provider.getBlock("latest");
      if (!block?.hash) throw new Error("X Layer quote block is unavailable");
      blockNumber = block.number;
      blockHash = block.hash;
      const slot0Data = await this.provider.send("eth_call", [{ to: pool.address, data: evmPoolInterface.encodeFunctionData("slot0") }, `0x${blockNumber.toString(16)}`]) as string;
      sqrtPriceX96 = BigInt(evmPoolInterface.decodeFunctionResult("slot0", slot0Data)[0]);
    }
    const blockTag = `0x${blockNumber.toString(16)}`;
    const callData = quoterInterface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn: input.amountInRaw, fee: pool.expected_fee_tier, sqrtPriceLimitX96: 0n }]);
    const [raw, feeData] = await Promise.all([
      this.provider.send("eth_call", [{ to: dex.quoter_v2, data: callData }, blockTag]) as Promise<string>,
      this.cachedFeeData(),
    ]);
    const [amountOutRaw, , , gasEstimate] = quoterInterface.decodeFunctionResult("quoteExactInputSingle", raw) as unknown as [bigint, bigint, number, bigint];
    if (amountOutRaw <= 0n) throw new Error("QuoterV2 returned a non-positive amountOut");
    const networkFeeNativeRaw = feeData.gasPrice === null ? null : BigInt(gasEstimate) * feeData.gasPrice;
    return {
      poolId: pool.id, direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw,
      minimumAmountOutRaw: minimumOut(amountOutRaw, input.slippageBps),
      priceImpactPercent: impactFromSqrtPrice(sqrtPriceX96, input.direction, input.amountInRaw, amountOutRaw, this.assetDecimals, this.quoteDecimals, pool),
      networkFeeNativeRaw, networkFeeUsdt: null, assetUiMultiplier: "1",
      version: { chain: "xlayer", blockNumber: BigInt(blockNumber), blockHash, observedAt: Date.now(), stateFingerprint: `block:${blockNumber}:${blockHash}` },
      quotedAt: Date.now(), raw: { blockNumber, blockHash, amountOutRaw: amountOutRaw.toString(), gasEstimate: String(gasEstimate) },
    };
  }

  async buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap> {
    assertExecutionInput(pool, input, "xlayer");
    await this.verify(pool);
    const { blockNumber, blockHash } = input.quote.version;
    if (blockNumber === undefined || !blockHash) throw new Error("X Layer quote is missing its block version");
    const block = await this.provider.getBlock(Number(blockNumber));
    if (!block || block.hash?.toLowerCase() !== blockHash.toLowerCase()) throw new Error("X Layer quote block is no longer canonical");
    const dex = this.dex;
    if (!dex.swap_router || pool.expected_fee_tier === undefined) throw new Error("X Layer Router or pool fee tier is not configured");
    const tokenIn = input.quote.direction === "asset_to_quote" ? this.assetAddress : this.quoteAddress;
    const tokenOut = input.quote.direction === "asset_to_quote" ? this.quoteAddress : this.assetAddress;
    const deadlineSeconds = input.deadlineSeconds ?? 120;
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 3600) throw new Error("Invalid unsigned swap deadline");
    const data = encodeUniswapV3Swap({ tokenIn, tokenOut, fee: pool.expected_fee_tier, recipient: input.wallet,
      deadline: Math.floor(Date.now() / 1000) + deadlineSeconds, amountIn: input.quote.amountInRaw,
      amountOutMinimum: input.quote.minimumAmountOutRaw });
    return { chain: "xlayer", poolId: pool.id, direction: input.quote.direction, wallet: input.wallet,
      amountInRaw: input.quote.amountInRaw, minimumAmountOutRaw: input.quote.minimumAmountOutRaw,
      stateFingerprint: input.quote.version.stateFingerprint, version: input.quote.version, to: dex.swap_router, data, value: "0x0" };
  }

  async simulateSwap(pool: RegisteredPool, swap: UnsignedSwap): Promise<SwapSimulationResult> {
    if (swap.chain !== "xlayer" || swap.poolId !== pool.id) throw new Error("Unsigned X Layer swap does not match the registered pool");
    try {
      if (pool.mode !== "trade_candidate" || !pool.verified) throw new Error("Observe-only pools cannot be simulated for execution");
      await this.verify(pool);
      assertUniswapSwapMatchesRegistry(pool, this.dex, swap);
      if (swap.version.blockNumber === undefined || !swap.version.blockHash
        || swap.stateFingerprint !== `block:${swap.version.blockNumber}:${swap.version.blockHash}`) throw new Error("Unsigned X Layer swap has an invalid quote version");
      const quoteBlock = await this.provider.getBlock(Number(swap.version.blockNumber));
      if (!quoteBlock || quoteBlock.hash?.toLowerCase() !== swap.version.blockHash.toLowerCase()) throw new Error("Unsigned X Layer swap quote block is no longer canonical");
      const blockNumber = await this.provider.getBlockNumber();
      const request = { to: swap.to, data: swap.data, from: swap.wallet, value: "0x0" };
      const result = await this.provider.send("eth_call", [request, `0x${blockNumber.toString(16)}`]) as string;
      const amountOut = BigInt(swapRouterInterface.decodeFunctionResult("exactInputSingle", result)[0]);
      if (amountOut < swap.minimumAmountOutRaw) throw new Error("Simulated output is below amountOutMinimum");
      const [gasEstimate, feeData] = await Promise.all([this.provider.estimateGas(request), this.cachedFeeData()]);
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
      return { chain: "xlayer", ok: true, amountOutRaw: amountOut.toString(),
        networkFeeNativeRaw: gasPrice === null ? undefined : (gasEstimate * gasPrice).toString() };
    } catch (error) {
      return { chain: "xlayer", ok: false, error: errorMessage(error) };
    }
  }

  private async cachedFeeData(): Promise<{ gasPrice: bigint | null; maxFeePerGas: bigint | null }> {
    const now = Date.now();
    if (this.feeDataCache && this.feeDataCache.expiresAt > now) return this.feeDataCache;
    if (!this.feeDataPending) {
      this.feeDataPending = this.provider.getFeeData().then((feeData) => {
        this.feeDataCache = { expiresAt: Date.now() + UniswapV3Adapter.feeDataTtlMs, gasPrice: feeData.gasPrice, maxFeePerGas: feeData.maxFeePerGas };
        return this.feeDataCache;
      }).finally(() => { this.feeDataPending = undefined; });
    }
    return this.feeDataPending;
  }
}

