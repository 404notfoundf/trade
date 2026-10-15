import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { Interface, JsonRpcProvider } from "ethers";
import { AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getDefaultAccountState, getExtensionTypes, getPausableConfig, getScaledUiAmountConfig, getTransferFeeConfig, getTransferHook, unpackMint } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { PoolUtils, Raydium, Token, TokenAmount, toBN, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { solanaRpcFetch } from "../solana-rpc-logging.js";
import type { MarketRegistry, RegisteredPool } from "./market-registry.js";
import { simulateRaydiumSwap } from "./raydium-simulator.js";
export { createSolanaSimulationTransaction } from "./raydium-simulator.js";

const evmPoolInterface = new Interface([
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)", "function factory() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
]);
const erc20Interface = new Interface(["function decimals() view returns (uint8)"]);
const erc4626Interface = new Interface([
  "function asset() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewMint(uint256 shares) view returns (uint256 assets)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
]);
const factoryGetterInterface = new Interface(["function factory() view returns (address)"]);
const swapRouterInterface = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const quoterInterface = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const token2022ObservationPools = [
  { id: "xnvda-solana-raydium-clmm", instrumentId: "XNVDA", address: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", assetMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { id: "xspcx-solana-raydium-usdc-clmm", instrumentId: "XSPCX", address: "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
];
// shortcut: only these reviewed observe-only pools are supported; add a pool after checking its mint extensions.
const allowedToken2022Extensions = new Set<ExtensionType>([
  ExtensionType.ConfidentialTransferMint, ExtensionType.DefaultAccountState, ExtensionType.PermanentDelegate,
  ExtensionType.TransferHook, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata,
  ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig,
]);

export type PoolVersion = { chain: "xlayer" | "solana"; blockNumber?: bigint; blockHash?: string; slot?: bigint; observedAt: number; stateFingerprint: string };
export type ExactInQuote = {
  poolId: string; direction: "asset_to_quote" | "quote_to_asset"; amountInRaw: bigint; amountOutRaw: bigint;
  minimumAmountOutRaw: bigint; priceImpactPercent: string; networkFeeNativeRaw: bigint | null; networkFeeUsdt: string | null;
  assetUiMultiplier: string; version: PoolVersion; quotedAt: number; raw: unknown;
  mintTokenPrograms?: { asset: string; quote: string };
};
export type QuoteInput = { direction: ExactInQuote["direction"]; amountInRaw: bigint; slippageBps: number; expectedAssetUiMultiplier?: string };
export type SwapBuildInput = { quote: ExactInQuote; wallet: string; deadlineSeconds?: number; simulationOnly?: boolean };
export type UnsignedSwap = {
  chain: "xlayer" | "solana"; poolId: string; direction: ExactInQuote["direction"]; wallet: string;
  amountInRaw: bigint; minimumAmountOutRaw: bigint; stateFingerprint: string; version: PoolVersion; simulationOnly?: boolean;
} & ({ chain: "xlayer"; to: string; data: string; value: "0x0" }
  | { chain: "solana"; transactionBase64: string; mintTokenPrograms: { asset: string; quote: string } });
export type SwapSimulationResult = {
  chain: "xlayer" | "solana"; ok: boolean; amountOutRaw?: string; computeUnits?: number;
  networkFeeNativeRaw?: string; amountInDebitedRaw?: string; amountOutCreditedRaw?: string;
  skipped?: boolean; error?: string; logs?: string[];
};
type SolanaMintState = { mint: ReturnType<typeof unpackMint>; owner: PublicKey; extensions: ExtensionType[]; uiMultiplier?: string; multiplierEffectiveTimestamp?: string | null };
export class PoolIdentityMismatchError extends Error {}
export class UnsupportedTokenError extends Error {
  constructor(readonly failureCode: "TOKEN_PROGRAM_UNSUPPORTED" | "TOKEN_EXTENSION_UNSUPPORTED", message: string) { super(message); }
}

export interface PoolAdapter {
  verify(pool: RegisteredPool): Promise<void>;
  getAssetUiMultiplier(pool: RegisteredPool): Promise<string>;
  quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote>;
  buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap>;
  simulateSwap(pool: RegisteredPool, swap: UnsignedSwap, signer?: Keypair): Promise<SwapSimulationResult>;
}

export function createPoolAdapter(pool: RegisteredPool, registry: MarketRegistry): PoolAdapter {
  const dex = registry.dexes[pool.dex];
  if (!dex || dex.enabled === false || dex.chain !== pool.chain) throw new Error(`Pool ${pool.id} has no enabled matching DEX adapter`);
  if (dex.adapter === "uniswap_v3" && pool.chain === "xlayer") return new UniswapV3Adapter(registry, pool.dex);
  if (dex.adapter === "raydium_clmm" && pool.chain === "solana") return new RaydiumClmmAdapter(registry, pool.dex);
  throw new Error(`Unsupported adapter for pool ${pool.id}`);
}

export class XLayerWrapperAdapter {
  private readonly provider: JsonRpcProvider;
  private readonly wrapperAddress: string;
  private readonly underlyingAddress: string;
  private readonly wrapperDecimals: number;
  private readonly underlyingDecimals: number;
  private verified = false;

  constructor(registry: MarketRegistry, pool: RegisteredPool) {
    if (pool.chain !== "xlayer" || pool.reason !== "wrapper_required") throw new Error(`Pool ${pool.id} is not a configured X Layer wrapper pool`);
    const rpc = registry.chains.xlayer.rpc_http;
    const underlying = registry.instruments.find((item) => item.instrument_id === pool.instrument_id)?.chain_assets.find((item) => item.chain === "xlayer");
    if (!rpc || !underlying) throw new Error("X Layer wrapper RPC or underlying asset registration is missing");
    this.provider = new JsonRpcProvider(rpc);
    this.wrapperAddress = pool.token_in_out.asset_address;
    this.underlyingAddress = underlying.address;
    this.wrapperDecimals = pool.token_in_out.asset_decimals;
    this.underlyingDecimals = underlying.decimals;
    this.poolId = pool.id;
  }

  private readonly poolId: string;

  async verify(): Promise<void> {
    if (this.verified) return;
    if (BigInt((await this.provider.getNetwork()).chainId) !== 196n) throw new PoolIdentityMismatchError("X Layer wrapper RPC chain ID mismatch");
    if (await this.provider.getCode(this.wrapperAddress) === "0x") throw new PoolIdentityMismatchError(`X Layer wrapper has no contract code: ${this.poolId}`);
    const block = await this.provider.getBlockNumber();
    const [underlying, wrapperDecimals, underlyingDecimals] = await Promise.all([
      readAddress(this.provider, this.wrapperAddress, erc4626Interface, "asset", block),
      readBigInt(this.provider, this.wrapperAddress, erc20Interface, "decimals", block),
      readBigInt(this.provider, this.underlyingAddress, erc20Interface, "decimals", block),
    ]);
    if (!sameAddress(underlying, this.underlyingAddress) || Number(wrapperDecimals) !== this.wrapperDecimals || Number(underlyingDecimals) !== this.underlyingDecimals) {
      throw new PoolIdentityMismatchError(`X Layer wrapper asset or decimals do not match registry: ${this.poolId}`);
    }
    this.verified = true;
  }

  async previewDeposit(underlyingAmountRaw: bigint, blockNumber?: bigint): Promise<bigint> {
    return this.preview("previewDeposit", underlyingAmountRaw, blockNumber);
  }

  async previewMint(wrapperAmountRaw: bigint, blockNumber?: bigint): Promise<bigint> {
    return this.preview("previewMint", wrapperAmountRaw, blockNumber);
  }

  async previewRedeem(wrapperAmountRaw: bigint, blockNumber?: bigint): Promise<bigint> {
    return this.preview("previewRedeem", wrapperAmountRaw, blockNumber);
  }

  private async preview(method: "previewDeposit" | "previewMint" | "previewRedeem", amountRaw: bigint, blockNumber?: bigint): Promise<bigint> {
    if (amountRaw <= 0n) throw new Error("Wrapper preview amount must be positive");
    await this.verify();
    const data = await this.provider.call(
      { to: this.wrapperAddress, data: erc4626Interface.encodeFunctionData(method, [amountRaw]),
        blockTag: blockNumber === undefined ? undefined : `0x${blockNumber.toString(16)}` },
    );
    const amount = BigInt(erc4626Interface.decodeFunctionResult(method, data)[0]);
    if (amount <= 0n) throw new Error(`X Layer wrapper ${method} returned a non-positive amount`);
    return amount;
  }
}

export function createXLayerWrapperAdapter(pool: RegisteredPool, registry: MarketRegistry): XLayerWrapperAdapter {
  return new XLayerWrapperAdapter(registry, pool);
}

class UniswapV3Adapter implements PoolAdapter {
  private readonly provider: JsonRpcProvider;
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;
  private assetAddress = "";
  private quoteAddress = "";
  private assetDecimals = 0;
  private quoteDecimals = 0;

  constructor(private readonly registry: MarketRegistry, dexId: string) {
    const dex = registry.dexes[dexId];
    const rpc = registry.chains.xlayer.rpc_http;
    if (!dex || !rpc) throw new Error("X Layer direct-pool RPC or DEX registration is not configured");
    this.dex = dex;
    this.provider = new JsonRpcProvider(rpc);
  }

  async verify(pool: RegisteredPool): Promise<void> {
    const dex = this.dex;
    if (!dex.factory || !dex.quoter_v2 || (pool.mode === "trade_candidate" && !dex.swap_router) || pool.expected_fee_tier === undefined) throw new Error("X Layer factory, QuoterV2 and pool fee tier must be configured");
    const asset = this.registry.instruments.find((item) => item.instrument_id === pool.instrument_id)?.chain_assets.find((item) => item.chain === "xlayer");
    if (!asset) throw new Error(`Missing registered X Layer asset for ${pool.instrument_id}`);
    this.assetAddress = pool.token_in_out.asset_address;
    this.quoteAddress = pool.token_in_out.quote_address;
    if (pool.mode === "trade_candidate" && (!sameAddress(this.assetAddress, asset.address) || !sameAddress(this.quoteAddress, asset.quote_asset.address))) throw new Error("X Layer trade candidate does not match the registered direct token pair");
    if (BigInt((await this.provider.getNetwork()).chainId) !== 196n) throw new PoolIdentityMismatchError("X Layer RPC chain ID mismatch");
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
    const block = await this.provider.getBlock("latest");
    if (!block?.hash) throw new Error("X Layer quote block is unavailable");
    const blockNumber = block.number;
    const blockTag = `0x${blockNumber.toString(16)}`;
    const callData = quoterInterface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn: input.amountInRaw, fee: pool.expected_fee_tier, sqrtPriceLimitX96: 0n }]);
    const [slot0Data, raw, feeData] = await Promise.all([
      this.provider.send("eth_call", [{ to: pool.address, data: evmPoolInterface.encodeFunctionData("slot0") }, blockTag]) as Promise<string>,
      this.provider.send("eth_call", [{ to: dex.quoter_v2, data: callData }, blockTag]) as Promise<string>,
      this.provider.getFeeData(),
    ]);
    const sqrtPriceX96 = BigInt(evmPoolInterface.decodeFunctionResult("slot0", slot0Data)[0]);
    const [amountOutRaw, , , gasEstimate] = quoterInterface.decodeFunctionResult("quoteExactInputSingle", raw) as unknown as [bigint, bigint, number, bigint];
    if (amountOutRaw <= 0n) throw new Error("QuoterV2 returned a non-positive amountOut");
    const networkFeeNativeRaw = feeData.gasPrice === null ? null : BigInt(gasEstimate) * feeData.gasPrice;
    return {
      poolId: pool.id, direction: input.direction, amountInRaw: input.amountInRaw, amountOutRaw,
      minimumAmountOutRaw: minimumOut(amountOutRaw, input.slippageBps),
      priceImpactPercent: impactFromSqrtPrice(sqrtPriceX96, input.direction, input.amountInRaw, amountOutRaw, this.assetDecimals, this.quoteDecimals, pool),
      networkFeeNativeRaw, networkFeeUsdt: null, assetUiMultiplier: "1",
      version: { chain: "xlayer", blockNumber: BigInt(blockNumber), blockHash: block.hash, observedAt: Date.now(), stateFingerprint: `block:${blockNumber}:${block.hash}` },
      quotedAt: Date.now(), raw: { blockNumber, blockHash: block.hash, amountOutRaw: amountOutRaw.toString(), gasEstimate: String(gasEstimate) },
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
      const [gasEstimate, feeData] = await Promise.all([this.provider.estimateGas(request), this.provider.getFeeData()]);
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
      return { chain: "xlayer", ok: true, amountOutRaw: amountOut.toString(),
        networkFeeNativeRaw: gasPrice === null ? undefined : (gasEstimate * gasPrice).toString() };
    } catch (error) {
      return { chain: "xlayer", ok: false, error: errorMessage(error) };
    }
  }
}

class RaydiumClmmAdapter implements PoolAdapter {
  private readonly connection: Connection;
  private readonly raydium = new Map<string, Promise<Raydium>>();
  private readonly dex: NonNullable<MarketRegistry["dexes"][string]>;

  constructor(private readonly registry: MarketRegistry, dexId: string) {
    const dex = registry.dexes[dexId];
    const rpc = registry.chains.solana.rpc_http;
    if (!dex || !dex.program_id || !rpc) throw new Error("Solana RPC or Raydium CLMM Program ID is not configured");
    this.dex = dex;
    this.connection = new Connection(rpc, { commitment: "confirmed", wsEndpoint: registry.chains.solana.rpc_ws ?? undefined, fetch: solanaRpcFetch, disableRetryOnRateLimit: true });
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
    const tokenState = await this.readTokenState(pool);
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

  async getAssetUiMultiplier(pool: RegisteredPool): Promise<string> {
    const state = await this.readTokenState(pool);
    const asset = state.mints.get(pool.token_in_out.asset_address);
    if (!asset) throw new PoolIdentityMismatchError("Raydium registered asset mint is missing");
    return this.validateTokenSupport(pool, asset, state.blockTimestamp).uiMultiplier;
  }

  async quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote> {
    if (input.amountInRaw <= 0n || !Number.isSafeInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) throw new Error("Invalid exact-in amount or slippage");
    const { poolInfo, computePoolInfo, tickData } = await (await this.sdk()).clmm.getPoolInfoFromRpc(pool.address);
    const after = await this.connection.getSlot("confirmed");
    if (poolInfo.programId !== this.dex.program_id) throw new PoolIdentityMismatchError("Raydium quote rejected: unexpected CLMM program");
    const tokenState = await this.readTokenState(pool);
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

  private async readTokenState(pool: RegisteredPool): Promise<{ mints: Map<string, SolanaMintState>; blockTimestamp: bigint }> {
    const assetKey = new PublicKey(pool.token_in_out.asset_address);
    const quoteKey = new PublicKey(pool.token_in_out.quote_address);
    const { value } = await this.connection.getMultipleAccountsInfoAndContext([assetKey, quoteKey, SYSVAR_CLOCK_PUBKEY], "confirmed");
    const clock = value[2];
    if (!clock || clock.data.length < 40) throw new Error("Solana Clock sysvar is unavailable or malformed");
    const blockTimestamp = clock.data.readBigInt64LE(32);
    const mints = new Map<string, SolanaMintState>();
    for (const [key, account] of [[assetKey, value[0]], [quoteKey, value[1]]] as const) {
      if (!account) throw new PoolIdentityMismatchError(`Registered Solana mint account is missing: ${key.toBase58()}`);
      let mint: ReturnType<typeof unpackMint>;
      try { mint = unpackMint(key, account, account.owner); }
      catch (error) { throw new PoolIdentityMismatchError(`Registered Solana mint account is invalid: ${key.toBase58()} (${errorMessage(error)})`); }
      const extensions = getExtensionTypes(mint.tlvData);
      mints.set(key.toBase58(), { mint, owner: account.owner, extensions });
    }
    return { mints, blockTimestamp };
  }

  private validateTokenSupport(pool: RegisteredPool, state: SolanaMintState, blockTimestamp: bigint): SolanaMintState & { uiMultiplier: string; multiplierEffectiveTimestamp: string | null } {
    if (state.owner.equals(TOKEN_PROGRAM_ID)) return { ...state, uiMultiplier: "1", multiplierEffectiveTimestamp: null };
    if (!state.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new UnsupportedTokenError("TOKEN_PROGRAM_UNSUPPORTED", `Unsupported Solana token program: ${state.owner.toBase58()}`);
    const programId = this.dex.program_id;
    if (!programId || !isScopedToken2022Pool(pool, programId) || !token2022ObservationPools.some((entry) => entry.assetMint === state.mint.address.toBase58())) {
      throw new UnsupportedTokenError("TOKEN_PROGRAM_UNSUPPORTED", "Token-2022 is enabled only for reviewed Raydium observe-only pools");
    }
    const unsupported = state.extensions.filter((extension) => !allowedToken2022Extensions.has(extension));
    if (unsupported.length) throw new UnsupportedTokenError("TOKEN_EXTENSION_UNSUPPORTED", `Unsupported Token-2022 extensions: ${unsupported.map(extensionName).join(", ")}`);
    if (getTransferFeeConfig(state.mint)) throw new UnsupportedTokenError("TOKEN_EXTENSION_UNSUPPORTED", "Token-2022 transfer fees are not supported for observation quotes");
    const hook = getTransferHook(state.mint);
    if (hook && !hook.programId.equals(PublicKey.default)) throw new UnsupportedTokenError("TOKEN_EXTENSION_UNSUPPORTED", "Token-2022 transfer hook is enabled");
    const defaultState = getDefaultAccountState(state.mint);
    if (defaultState && defaultState.state !== AccountState.Initialized) throw new UnsupportedTokenError("TOKEN_EXTENSION_UNSUPPORTED", "Token-2022 default token-account state is not initialized");
    if (getPausableConfig(state.mint)?.paused) throw new UnsupportedTokenError("TOKEN_EXTENSION_UNSUPPORTED", "Token-2022 mint is paused");
    const scaled = getScaledUiAmountConfig(state.mint);
    const multiplier = scaled && blockTimestamp >= scaled.newMultiplierEffectiveTimestamp ? scaled.newMultiplier : scaled?.multiplier ?? 1;
    if (!Number.isFinite(multiplier) || multiplier <= 0) throw new UnsupportedTokenError("TOKEN_EXTENSION_UNSUPPORTED", "Token-2022 scaled UI multiplier is invalid");
    return { ...state, uiMultiplier: String(multiplier), multiplierEffectiveTimestamp: scaled?.newMultiplierEffectiveTimestamp.toString() ?? null };
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
    return simulateRaydiumSwap({ pool, swap, signer, connection: this.connection, verifyPool: () => this.verify(pool),
      currentStateFingerprint: async () => {
        const { poolInfo, computePoolInfo, tickData } = await (await this.sdk(new PublicKey(swap.wallet))).clmm.getPoolInfoFromRpc(pool.address);
        return fingerprintRaydiumState(poolInfo, computePoolInfo, tickData[pool.address] ?? {});
      } });
  }
}

export function encodeUniswapV3Swap(params: { tokenIn: string; tokenOut: string; fee: number; recipient: string; deadline: number; amountIn: bigint; amountOutMinimum: bigint }): string {
  if (params.amountIn <= 0n || params.amountOutMinimum <= 0n || params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) throw new Error("Invalid Uniswap V3 exact-in swap amounts or token pair");
  return swapRouterInterface.encodeFunctionData("exactInputSingle", [{ ...params, sqrtPriceLimitX96: 0n }]);
}

function assertExecutionInput(pool: RegisteredPool, input: SwapBuildInput, chain: "xlayer" | "solana"): void {
  const poolEligible = pool.mode === "trade_candidate" || (chain === "solana" && input.simulationOnly === true && pool.mode === "observe_only");
  if (!poolEligible || !pool.verified || pool.chain !== chain || (chain !== "solana" && input.simulationOnly === true) || input.quote.poolId !== pool.id || input.quote.version.chain !== chain
    || input.quote.amountInRaw <= 0n || input.quote.amountOutRaw <= 0n || input.quote.minimumAmountOutRaw <= 0n
    || input.quote.minimumAmountOutRaw > input.quote.amountOutRaw || (chain === "xlayer"
      ? input.quote.version.blockNumber === undefined || !input.quote.version.blockHash
      : input.quote.version.slot === undefined)) throw new Error(`Invalid ${chain} verified execution input`);
  if (chain === "xlayer" ? !/^0x[\da-f]{40}$/i.test(input.wallet) : !PublicKey.isOnCurve(new PublicKey(input.wallet).toBytes())) {
    throw new Error(`Invalid ${chain} simulation wallet`);
  }
}

function assertUniswapSwapMatchesRegistry(pool: RegisteredPool, dex: NonNullable<MarketRegistry["dexes"][string]>, swap: UnsignedSwap): void {
  if (swap.chain !== "xlayer" || !dex.swap_router || !sameAddress(swap.to, dex.swap_router) || swap.value !== "0x0") throw new Error("Unsigned X Layer swap target or value does not match the registry");
  const [params] = swapRouterInterface.decodeFunctionData("exactInputSingle", swap.data);
  const tokenIn = swap.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
  const tokenOut = swap.direction === "asset_to_quote" ? pool.token_in_out.quote_address : pool.token_in_out.asset_address;
  if (pool.expected_fee_tier === undefined || !sameAddress(params.tokenIn, tokenIn) || !sameAddress(params.tokenOut, tokenOut)
    || !sameAddress(params.recipient, swap.wallet) || Number(params.fee) !== pool.expected_fee_tier
    || BigInt(params.amountIn) !== swap.amountInRaw || BigInt(params.amountOutMinimum) !== swap.minimumAmountOutRaw
    || BigInt(params.sqrtPriceLimitX96) !== 0n) throw new Error("Unsigned X Layer swap calldata does not match the pinned pool and quote");
}

function fingerprintRaydiumState(poolInfo: { id: string }, computePoolInfo: { sqrtPriceX64: { toString(): string }; liquidity: { toString(): string }; tickCurrent: number }, tickArrays: Record<string, unknown>): string {
  const tickAddresses = Object.keys(tickArrays).sort();
  return createHash("sha256").update(JSON.stringify({ pool: poolInfo.id, sqrtPriceX64: computePoolInfo.sqrtPriceX64.toString(),
    liquidity: computePoolInfo.liquidity.toString(), tickCurrent: computePoolInfo.tickCurrent,
    tickArrays: tickAddresses.map((key) => [key, JSON.stringify(tickArrays[key], jsonSafe)]) })).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, "[rpc endpoint]").slice(0, 500) : "unknown simulation error";
}

function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

function expectedDecimals(mint: string, pool: RegisteredPool): number {
  return mint === pool.token_in_out.asset_address ? pool.token_in_out.asset_decimals : pool.token_in_out.quote_decimals;
}

function isScopedToken2022Pool(pool: RegisteredPool, programId: string): boolean {
  return token2022ObservationPools.some((entry) => pool.id === entry.id && pool.instrument_id === entry.instrumentId
    && pool.chain === "solana" && pool.mode === "observe_only" && pool.verified && pool.address === entry.address
    && programId === entry.programId && pool.token_in_out.asset_address === entry.assetMint && pool.token_in_out.quote_address === entry.quoteMint);
}

function extensionName(extension: ExtensionType): string { return ExtensionType[extension] ?? `Unknown(${extension})`; }

export function minimumOut(amountOut: bigint, slippageBps: number): bigint { return amountOut * BigInt(10_000 - slippageBps) / 10_000n; }
function sameAddress(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function pairMatches(a: string, b: string, expectedA: string, expectedB: string): boolean { return (sameAddress(a, expectedA) && sameAddress(b, expectedB)) || (sameAddress(a, expectedB) && sameAddress(b, expectedA)); }
async function readAddress(provider: JsonRpcProvider, to: string, contract: Interface, method: string, block: number): Promise<string> {
  const raw = await provider.send("eth_call", [{ to, data: contract.encodeFunctionData(method) }, `0x${block.toString(16)}`]) as string;
  return String(contract.decodeFunctionResult(method, raw)[0]);
}
async function readBigInt(provider: JsonRpcProvider, to: string, contract: Interface, method: string, block: number): Promise<bigint> {
  const raw = await provider.send("eth_call", [{ to, data: contract.encodeFunctionData(method) }, `0x${block.toString(16)}`]) as string;
  return BigInt(contract.decodeFunctionResult(method, raw)[0]);
}
export function impactFromSqrtPrice(sqrt: bigint, direction: ExactInQuote["direction"], amountIn: bigint, amountOut: bigint, assetDecimals: number, quoteDecimals: number, pool: RegisteredPool): string {
  const q96 = new Decimal(2).pow(96);
  const assetIs0 = pool.token_in_out.asset_address.toLowerCase() < pool.token_in_out.quote_address.toLowerCase();
  const decimals0 = assetIs0 ? assetDecimals : quoteDecimals;
  const decimals1 = assetIs0 ? quoteDecimals : assetDecimals;
  const priceToken1PerToken0 = new Decimal(sqrt.toString()).div(q96).pow(2).mul(new Decimal(10).pow(decimals0 - decimals1));
  const quotePerAsset = assetIs0 ? priceToken1PerToken0 : new Decimal(1).div(priceToken1PerToken0);
  const amountInDecimals = direction === "asset_to_quote" ? assetDecimals : quoteDecimals;
  const amountOutDecimals = direction === "asset_to_quote" ? quoteDecimals : assetDecimals;
  const fairOut = new Decimal(amountIn.toString()).div(new Decimal(10).pow(amountInDecimals))
    .mul(direction === "asset_to_quote" ? quotePerAsset : new Decimal(1).div(quotePerAsset)).mul(new Decimal(10).pow(amountOutDecimals));
  if (!fairOut.gt(0)) throw new Error(`Pool ${pool.id} has an invalid marginal price`);
  return new Decimal(1).minus(new Decimal(amountOut.toString()).div(fairOut)).mul(100).toString();
}
