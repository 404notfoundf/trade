import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { Interface, JsonRpcProvider } from "ethers";
import BN from "bn.js";
import { createRequire } from "node:module";
import { AccountState, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getDefaultAccountState, getExtensionTypes, getPausableConfig, getScaledUiAmountConfig, getTransferFeeConfig, getTransferHook, unpackAccount, unpackMint } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction } from "@solana/web3.js";
import { ORCA_WHIRLPOOL_PROGRAM_ID, WhirlpoolContext, type SwapQuote, type WhirlpoolData } from "@orca-so/whirlpools-sdk";
import WebSocket from "ws";
import { BYREAL_CLMM_PROGRAM_ADDRESS, BYREAL_XSPCX_USDC_POOL, METEORA_DLMM_PROGRAM_ADDRESS, METEORA_XSPCX_USDC_POOL, ORCA_WHIRLPOOL_PROGRAM_ADDRESS, ORCA_XSPCX_USDC_POOL, type MarketRegistry, type RegisteredPool } from "./market-registry.js";
export { createSolanaSimulationTransaction } from "./raydium-simulator.js";

// The SDK's ESM entrypoint imports an invalid Anchor directory in Node; its CJS entrypoint resolves correctly.
const DLMM = createRequire(import.meta.url)("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm").default;
const meteoraGetPriceOfBinByBinId = createRequire(import.meta.url)("@meteora-ag/dlmm").getPriceOfBinByBinId as typeof import("@meteora-ag/dlmm").getPriceOfBinByBinId;

export const evmPoolInterface = new Interface([
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function fee() view returns (uint24)", "function factory() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
]);
export const erc20Interface = new Interface(["function decimals() view returns (uint8)"]);
const erc4626Interface = new Interface([
  "function asset() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewMint(uint256 shares) view returns (uint256 assets)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
]);
export const factoryGetterInterface = new Interface(["function factory() view returns (address)"]);
export const swapRouterInterface = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
export const quoterInterface = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const token2022ObservationPools = [
  { protocol: "raydium_clmm", id: "xnvda-solana-raydium-clmm", instrumentId: "XNVDA", address: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", assetMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { protocol: "raydium_clmm", id: "xspcx-solana-raydium-usdc-clmm", instrumentId: "XSPCX", address: "AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", assetMint: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { protocol: "orca_whirlpool", id: ORCA_XSPCX_USDC_POOL.id, instrumentId: ORCA_XSPCX_USDC_POOL.instrumentId, address: ORCA_XSPCX_USDC_POOL.address, programId: ORCA_WHIRLPOOL_PROGRAM_ADDRESS, assetMint: ORCA_XSPCX_USDC_POOL.assetMint, quoteMint: ORCA_XSPCX_USDC_POOL.quoteMint },
  { protocol: "meteora_dlmm", id: METEORA_XSPCX_USDC_POOL.id, instrumentId: METEORA_XSPCX_USDC_POOL.instrumentId, address: METEORA_XSPCX_USDC_POOL.address, programId: METEORA_DLMM_PROGRAM_ADDRESS, assetMint: METEORA_XSPCX_USDC_POOL.assetMint, quoteMint: METEORA_XSPCX_USDC_POOL.quoteMint },
  { protocol: "byreal_clmm", id: BYREAL_XSPCX_USDC_POOL.id, instrumentId: BYREAL_XSPCX_USDC_POOL.instrumentId, address: BYREAL_XSPCX_USDC_POOL.address, programId: BYREAL_CLMM_PROGRAM_ADDRESS, assetMint: BYREAL_XSPCX_USDC_POOL.assetMint, quoteMint: BYREAL_XSPCX_USDC_POOL.quoteMint },
];
// shortcut: only these reviewed observe-only protocol/pool/mint pairs are supported; re-review extensions before adding another.
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
export type AdapterPoolState = { slot: bigint; observedAt: number; stateFingerprint: string; marginalPrice?: string };
export type PoolWatchCallbacks = {
  onState: (state: AdapterPoolState) => void;
  onUnavailable: (reason: string, identityMismatch?: boolean) => void;
};
export type SolanaMintState = { mint: ReturnType<typeof unpackMint>; owner: PublicKey; extensions: ExtensionType[]; uiMultiplier?: string; multiplierEffectiveTimestamp?: string | null };
export class PoolIdentityMismatchError extends Error {}
export class UnsupportedTokenError extends Error {
  constructor(readonly failureCode: "TOKEN_PROGRAM_UNSUPPORTED" | "TOKEN_EXTENSION_UNSUPPORTED", message: string) { super(message); }
}

export interface PoolAdapter {
  stateSource: "fixed_monitor" | "adapter_watch";
  verify(pool: RegisteredPool): Promise<void>;
  getAssetUiMultiplier(pool: RegisteredPool): Promise<string>;
  quoteExactIn(pool: RegisteredPool, input: QuoteInput): Promise<ExactInQuote>;
  buildSwap(pool: RegisteredPool, input: SwapBuildInput): Promise<UnsignedSwap>;
  simulateSwap(pool: RegisteredPool, swap: UnsignedSwap, signer?: Keypair): Promise<SwapSimulationResult>;
  watch?(pool: RegisteredPool, callbacks: PoolWatchCallbacks): Promise<() => Promise<void>>;
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
    const rpc = pool.rpc_http;
    const underlying = registry.instruments.find((item) => item.instrument_id === pool.instrument_id)?.chain_assets.find((item) => item.chain === "xlayer");
    if (!rpc || !underlying) throw new Error("X Layer wrapper RPC or underlying asset registration is missing");
    this.provider = new JsonRpcProvider(rpc, 196, { staticNetwork: true });
    this.wrapperAddress = pool.token_in_out.asset_address;
    this.underlyingAddress = underlying.address;
    this.wrapperDecimals = pool.token_in_out.asset_decimals;
    this.underlyingDecimals = underlying.decimals;
    this.poolId = pool.id;
  }

  private readonly poolId: string;

  async verify(): Promise<void> {
    if (this.verified) return;
    if (BigInt(await this.provider.send("eth_chainId", [])) !== 196n) throw new PoolIdentityMismatchError("X Layer wrapper RPC chain ID mismatch");
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

export function encodeUniswapV3Swap(params: { tokenIn: string; tokenOut: string; fee: number; recipient: string; deadline: number; amountIn: bigint; amountOutMinimum: bigint }): string {
  if (params.amountIn <= 0n || params.amountOutMinimum <= 0n || params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) throw new Error("Invalid Uniswap V3 exact-in swap amounts or token pair");
  return swapRouterInterface.encodeFunctionData("exactInputSingle", [{ ...params, sqrtPriceLimitX96: 0n }]);
}

export function assertExecutionInput(pool: RegisteredPool, input: SwapBuildInput, chain: "xlayer" | "solana"): void {
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

export function assertUniswapSwapMatchesRegistry(pool: RegisteredPool, dex: NonNullable<MarketRegistry["dexes"][string]>, swap: UnsignedSwap): void {
  if (swap.chain !== "xlayer" || !dex.swap_router || !sameAddress(swap.to, dex.swap_router) || swap.value !== "0x0") throw new Error("Unsigned X Layer swap target or value does not match the registry");
  const [params] = swapRouterInterface.decodeFunctionData("exactInputSingle", swap.data);
  const tokenIn = swap.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
  const tokenOut = swap.direction === "asset_to_quote" ? pool.token_in_out.quote_address : pool.token_in_out.asset_address;
  if (pool.expected_fee_tier === undefined || !sameAddress(params.tokenIn, tokenIn) || !sameAddress(params.tokenOut, tokenOut)
    || !sameAddress(params.recipient, swap.wallet) || Number(params.fee) !== pool.expected_fee_tier
    || BigInt(params.amountIn) !== swap.amountInRaw || BigInt(params.amountOutMinimum) !== swap.minimumAmountOutRaw
    || BigInt(params.sqrtPriceLimitX96) !== 0n) throw new Error("Unsigned X Layer swap calldata does not match the pinned pool and quote");
}

export async function readSolanaTokenState(connection: Connection, pool: RegisteredPool): Promise<{ mints: Map<string, SolanaMintState>; blockTimestamp: bigint }> {
  const assetKey = new PublicKey(pool.token_in_out.asset_address);
  const quoteKey = new PublicKey(pool.token_in_out.quote_address);
  const { value } = await connection.getMultipleAccountsInfoAndContext([assetKey, quoteKey, SYSVAR_CLOCK_PUBKEY], "confirmed");
  const clock = value[2];
  if (!clock || clock.data.length < 40) throw new Error("Solana Clock sysvar is unavailable or malformed");
  const blockTimestamp = clock.data.readBigInt64LE(32);
  const mints = new Map<string, SolanaMintState>();
  for (const [key, account] of [[assetKey, value[0]], [quoteKey, value[1]]] as const) {
    if (!account) throw new PoolIdentityMismatchError(`Registered Solana mint account is missing: ${key.toBase58()}`);
    let mint: ReturnType<typeof unpackMint>;
    try { mint = unpackMint(key, account, account.owner); }
    catch (error) { throw new PoolIdentityMismatchError(`Registered Solana mint account is invalid: ${key.toBase58()} (${errorMessage(error)})`); }
    mints.set(key.toBase58(), { mint, owner: account.owner, extensions: getExtensionTypes(mint.tlvData) });
  }
  return { mints, blockTimestamp };
}

export function validateSolanaTokenSupport(
  pool: RegisteredPool, state: SolanaMintState, blockTimestamp: bigint,
  protocol: "raydium_clmm" | "orca_whirlpool" | "meteora_dlmm" | "byreal_clmm", programId: string | undefined,
): SolanaMintState & { uiMultiplier: string; multiplierEffectiveTimestamp: string | null } {
  if (state.owner.equals(TOKEN_PROGRAM_ID)) return { ...state, uiMultiplier: "1", multiplierEffectiveTimestamp: null };
  if (!state.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new UnsupportedTokenError("TOKEN_PROGRAM_UNSUPPORTED", `Unsupported Solana token program: ${state.owner.toBase58()}`);
  if (!isScopedToken2022Pool(pool, protocol, programId) || state.mint.address.toBase58() !== pool.token_in_out.asset_address) {
    throw new UnsupportedTokenError("TOKEN_PROGRAM_UNSUPPORTED", "Token-2022 is enabled only for reviewed observe-only pool/program/mint pairs");
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

export function isScopedToken2022Pool(pool: RegisteredPool, protocol: "raydium_clmm" | "orca_whirlpool" | "meteora_dlmm" | "byreal_clmm", programId: string | undefined): boolean {
  return token2022ObservationPools.some((entry) => entry.protocol === protocol && pool.id === entry.id && pool.instrument_id === entry.instrumentId
    && pool.chain === "solana" && pool.mode === "observe_only" && pool.verified && pool.address === entry.address
    && programId === entry.programId && pool.token_in_out.asset_address === entry.assetMint && pool.token_in_out.quote_address === entry.quoteMint);
}

export function orcaInputMint(pool: RegisteredPool, direction: ExactInQuote["direction"]): string {
  return direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
}

export function orcaTickArrayAddresses(quote: SwapQuote): PublicKey[] {
  return [...new Map([quote.tickArray0, quote.tickArray1, quote.tickArray2, ...(quote.supplementalTickArrays ?? [])]
    .map((address) => [address.toBase58(), address] as const)).values()];
}

export async function fingerprintOrcaState(
  connection: Connection, pool: RegisteredPool, data: WhirlpoolData, tickArrayAddresses: PublicKey[],
): Promise<{ fingerprint: string; slot: number; tickArrays: string[]; tickArrayDataHashes: string[] }> {
  const programId = new PublicKey(ORCA_WHIRLPOOL_PROGRAM_ADDRESS);
  const addresses = tickArrayAddresses.map((address) => address.toBase58());
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([new PublicKey(pool.address), ...tickArrayAddresses], "confirmed");
  const poolAccount = value[0];
  if (!poolAccount || !poolAccount.owner.equals(programId)) throw new PoolIdentityMismatchError("Orca pool account is missing or owned by the wrong program");
  const tickArrayDataHashes = value.slice(1).map((account, index) => {
    if (!account) throw new Error(`Orca required tick array is unavailable: ${addresses[index]}`);
    if (!account.owner.equals(programId)) throw new PoolIdentityMismatchError(`Orca tick array owner mismatch: ${addresses[index]}`);
    return createHash("sha256").update(account.data).digest("hex");
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    pool: pool.address, poolDataHash: createHash("sha256").update(poolAccount.data).digest("hex"),
    sqrtPrice: data.sqrtPrice.toString(), liquidity: data.liquidity.toString(), tickCurrentIndex: data.tickCurrentIndex,
    tickArrays: addresses.map((address, index) => [address, tickArrayDataHashes[index]]),
  })).digest("hex");
  return { fingerprint, slot: context.slot, tickArrays: addresses, tickArrayDataHashes };
}

export async function fingerprintMeteoraState(
  connection: Connection, pool: RegisteredPool, binArrayAddresses: PublicKey[],
): Promise<{ fingerprint: string; slot: number; binArrays: string[]; binArrayDataHashes: string[] }> {
  const programId = new PublicKey(METEORA_DLMM_PROGRAM_ADDRESS);
  const binArrays = [...new Map(binArrayAddresses.map((address) => [address.toBase58(), address] as const)).values()];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([new PublicKey(pool.address), ...binArrays], "confirmed");
  const pair = value[0];
  if (!pair || !pair.owner.equals(programId) || pair.data.length < 8) throw new PoolIdentityMismatchError("Meteora LbPair is missing, malformed or owned by the wrong program");
  const binArrayDataHashes = value.slice(1).map((account, index) => {
    if (!account) throw new Error(`Meteora required bin array is unavailable: ${binArrays[index]!.toBase58()}`);
    if (!account.owner.equals(programId) || account.data.length < 8) throw new PoolIdentityMismatchError(`Meteora bin array owner or layout mismatch: ${binArrays[index]!.toBase58()}`);
    return createHash("sha256").update(account.data).digest("hex");
  });
  const pairDataHash = createHash("sha256").update(pair.data).digest("hex");
  const addresses = binArrays.map((address) => address.toBase58());
  return {
    fingerprint: createHash("sha256").update(JSON.stringify({ slot: context.slot, pool: pool.address, pairDataHash,
      binArrays: addresses.map((address, index) => [address, binArrayDataHashes[index]]) })).digest("hex"),
    slot: context.slot, binArrays: addresses, binArrayDataHashes,
  };
}

export function meteoraSwapForY(pool: RegisteredPool, direction: ExactInQuote["direction"], tokenXMint: string): boolean {
  if (tokenXMint !== pool.token_in_out.asset_address && tokenXMint !== pool.token_in_out.quote_address) {
    throw new PoolIdentityMismatchError("Meteora token X does not match the pinned mint pair");
  }
  const inputMint = direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address;
  return inputMint === tokenXMint;
}

export function assertMeteoraFullFill(consumedInAmount: bigint, amountInRaw: bigint): void {
  if (consumedInAmount !== amountInRaw) throw new Error("Meteora DLMM exact-in quote is partial");
}

export function meteoraQuotePerAsset(priceYPerX: Decimal, assetIsX: boolean): Decimal {
  if (!priceYPerX.isFinite() || !priceYPerX.gt(0)) throw new Error("Meteora active-bin price must be positive");
  return assetIsX ? priceYPerX : new Decimal(1).div(priceYPerX);
}

export function meteoraActiveBinPrice(dlmm: InstanceType<typeof DLMM>): { binId: number; pricePerToken: string } {
  const binId = dlmm.lbPair.activeId;
  const pricePerToken = new Decimal(meteoraGetPriceOfBinByBinId(binId, dlmm.lbPair.binStep).toString())
    .mul(new Decimal(10).pow(dlmm.tokenX.mint.decimals - dlmm.tokenY.mint.decimals));
  if (!pricePerToken.isFinite() || !pricePerToken.gt(0)) throw new Error("Meteora active-bin price must be positive");
  return { binId, pricePerToken: pricePerToken.toString() };
}

export function impactFromMarginalPrice(
  quotePerAsset: Decimal, direction: ExactInQuote["direction"], amountIn: bigint, amountOut: bigint,
  assetDecimals: number, quoteDecimals: number,
): string {
  if (!quotePerAsset.isFinite() || !quotePerAsset.gt(0) || amountIn <= 0n || amountOut <= 0n) throw new Error("Pool price and amounts must be positive");
  const inDecimals = direction === "asset_to_quote" ? assetDecimals : quoteDecimals;
  const outDecimals = direction === "asset_to_quote" ? quoteDecimals : assetDecimals;
  const fairOut = new Decimal(amountIn.toString()).div(new Decimal(10).pow(inDecimals))
    .mul(direction === "asset_to_quote" ? quotePerAsset : new Decimal(1).div(quotePerAsset)).mul(new Decimal(10).pow(outDecimals));
  return new Decimal(1).minus(new Decimal(amountOut.toString()).div(fairOut)).mul(100).toString();
}

export function orcaQuotePerAsset(data: WhirlpoolData, pool: RegisteredPool): string {
  const sqrtPriceX64 = new Decimal(data.sqrtPrice.toString()).div(new Decimal(2).pow(64));
  const assetIsA = data.tokenMintA.toBase58() === pool.token_in_out.asset_address;
  const priceBPerA = sqrtPriceX64.pow(2).mul(new Decimal(10).pow(assetIsA
    ? pool.token_in_out.asset_decimals - pool.token_in_out.quote_decimals
    : pool.token_in_out.quote_decimals - pool.token_in_out.asset_decimals));
  return (assetIsA ? priceBPerA : new Decimal(1).div(priceBPerA)).toString();
}

export function byrealQuotePerAsset(priceBPerA: Decimal, assetIsA: boolean): Decimal {
  if (!priceBPerA.isFinite() || !priceBPerA.gt(0)) throw new Error("Byreal pool price must be positive");
  return assetIsA ? priceBPerA : new Decimal(1).div(priceBPerA);
}

export async function startSolanaAccountWatch(
  connection: Connection, wsUrl: string | null, address: string, expectedProgramId: string,
  refresh: (reverify: boolean) => Promise<string>, callbacks: PoolWatchCallbacks,
): Promise<() => Promise<void>> {
  if (!wsUrl) {
    callbacks.onUnavailable("Solana WebSocket endpoint is not configured");
    return async () => undefined;
  }
  const poolKey = new PublicKey(address);
  let socket: WebSocket | undefined;
  let subscriptionId: number | undefined;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let retryDelay = 1_000;
  let lastPongAt = 0;
  let lastSlot = 0;
  let lastHash = "";
  let serial = Promise.resolve();

  const fail = (error: unknown, current: WebSocket) => {
    if (socket !== current || stopped) return;
    const identityMismatch = error instanceof PoolIdentityMismatchError;
    callbacks.onUnavailable(errorMessage(error), identityMismatch);
    if (identityMismatch) stopped = true;
    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) current.close();
  };
  const enqueue = (work: () => Promise<void>, current: WebSocket) => {
    serial = serial.then(work).catch((error) => fail(error, current));
  };
  const processAccount = async (
    account: { owner: string; data: [string, string] }, slot: number, reverify: boolean, force: boolean, current: WebSocket,
  ) => {
    if (stopped || socket !== current || current.readyState !== WebSocket.OPEN) return;
    if (slot < lastSlot) throw new Error("Solana account snapshot is older than the latest observed slot");
    if (account.owner !== expectedProgramId) throw new PoolIdentityMismatchError("Adapter pool account owner does not match the pinned program");
    if (account.data[1] !== "base64") throw new Error("Solana RPC returned an unsupported account encoding");
    const data = Buffer.from(account.data[0], "base64");
    if (data.length < 8) throw new PoolIdentityMismatchError("Adapter pool account is shorter than its discriminator");
    const hash = createHash("sha256").update(data).digest("hex");
    if (!force && slot === lastSlot && hash === lastHash) return;
    const marginalPrice = await refresh(reverify);
    if (stopped || socket !== current || current.readyState !== WebSocket.OPEN) return;
    if (!new Decimal(marginalPrice).isFinite() || !new Decimal(marginalPrice).gt(0)) throw new Error("Adapter returned an invalid marginal price");
    lastSlot = slot;
    lastHash = hash;
    callbacks.onState({ slot: BigInt(slot), observedAt: Date.now(), stateFingerprint: createHash("sha256").update(`${slot}:${hash}`).digest("hex"), marginalPrice });
  };
  const connect = () => {
    if (stopped) return;
    callbacks.onUnavailable("Solana WebSocket is connecting; waiting for a fresh account snapshot");
    const current = new WebSocket(wsUrl);
    socket = current;
    current.on("open", () => {
      lastPongAt = Date.now();
      current.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [address, { commitment: "confirmed", encoding: "base64" }] }));
      heartbeat = setInterval(() => {
        if (current.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongAt > 45_000) { current.terminate(); return; }
        try { current.ping(); } catch { current.terminate(); }
      }, 20_000);
    });
    current.on("pong", () => { lastPongAt = Date.now(); });
    current.on("message", (raw) => {
      let message: { id?: number; result?: number; error?: { message?: string }; method?: string; params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { owner?: string; data?: [string, string] } | null } } };
      try { message = JSON.parse(raw.toString()); }
      catch { fail(new Error("Solana WebSocket returned malformed JSON"), current); return; }
      if (message.id === 1) {
        if (message.error || !Number.isSafeInteger(message.result)) { fail(new Error(message.error?.message ?? "Solana account subscription failed"), current); return; }
        subscriptionId = message.result;
        enqueue(async () => {
          const snapshot = await connection.getAccountInfoAndContext(poolKey, "confirmed");
          if (!snapshot.value) throw new PoolIdentityMismatchError("Adapter pool account is missing from the RPC snapshot");
          await processAccount({ owner: snapshot.value.owner.toBase58(), data: [snapshot.value.data.toString("base64"), "base64"] }, snapshot.context.slot, true, true, current);
          retryDelay = 1_000;
        }, current);
      } else if (message.method === "accountNotification" && message.params?.subscription === subscriptionId) {
        const notification = message.params?.result;
        const value = notification?.value;
        const slot = notification?.context?.slot;
        if (!value || !Number.isSafeInteger(slot) || !value.owner || !value.data) { fail(new Error("Solana account notification is incomplete"), current); return; }
        enqueue(() => processAccount(value as { owner: string; data: [string, string] }, slot!, false, false, current), current);
      }
    });
    current.on("error", (error) => fail(error, current));
    current.on("close", () => {
      if (socket !== current) return;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      subscriptionId = undefined;
      if (!stopped && !reconnectTimer) {
        callbacks.onUnavailable("Solana WebSocket disconnected; waiting to reconnect");
        reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    });
  };
  connect();
  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (socket?.readyState === WebSocket.OPEN && subscriptionId !== undefined) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "accountUnsubscribe", params: [subscriptionId] }));
    }
    socket?.close();
    await serial;
  };
}

export function impactFromOrcaSqrtPrice(
  sqrtPriceX64: bigint, direction: ExactInQuote["direction"], amountIn: bigint, amountOut: bigint,
  assetDecimals: number, quoteDecimals: number, assetIsA: boolean,
): string {
  if (sqrtPriceX64 <= 0n || amountIn <= 0n || amountOut <= 0n) throw new Error("Orca pool price and amounts must be positive");
  const priceBPerA = new Decimal(sqrtPriceX64.toString()).div(new Decimal(2).pow(64)).pow(2).mul(new Decimal(10).pow(assetIsA ? assetDecimals - quoteDecimals : quoteDecimals - assetDecimals));
  const quotePerAsset = assetIsA ? priceBPerA : new Decimal(1).div(priceBPerA);
  const inDecimals = direction === "asset_to_quote" ? assetDecimals : quoteDecimals;
  const outDecimals = direction === "asset_to_quote" ? quoteDecimals : assetDecimals;
  const fairOut = new Decimal(amountIn.toString()).div(new Decimal(10).pow(inDecimals))
    .mul(direction === "asset_to_quote" ? quotePerAsset : new Decimal(1).div(quotePerAsset)).mul(new Decimal(10).pow(outDecimals));
  if (!fairOut.gt(0)) throw new Error("Orca pool has an invalid marginal price");
  return new Decimal(1).minus(new Decimal(amountOut.toString()).div(fairOut)).mul(100).toString();
}

export function assertOrcaSwapTransaction(
  transaction: Transaction, context: ReturnType<typeof WhirlpoolContext.from>, pool: RegisteredPool,
  exactIn: ExactInQuote, quote: SwapQuote, data: WhirlpoolData, wallet: PublicKey,
): void {
  const programId = ORCA_WHIRLPOOL_PROGRAM_ID;
  const allowedPrograms = [programId, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SystemProgram.programId];
  if (transaction.instructions.some((instruction) => !allowedPrograms.some((allowed) => allowed.equals(instruction.programId)))) {
    throw new Error("Orca unsigned swap contains an unexpected instruction program");
  }
  const swapInstructions = transaction.instructions.filter((instruction) => instruction.programId.equals(programId));
  if (swapInstructions.length !== 1) throw new Error("Orca unsigned transaction must contain exactly one Whirlpool swap instruction");
  const instruction = swapInstructions[0]!;
  const decoded = (context.program.coder.instruction as typeof context.program.coder.instruction & { decode(data: Buffer): { name: string; data: unknown } | null }).decode(instruction.data);
  if (!decoded || (decoded.name !== "swap" && decoded.name !== "swapV2")) throw new Error("Orca unsigned transaction does not contain a supported swap instruction");
  const args = decoded.data as { amount: BN; otherAmountThreshold: BN; amountSpecifiedIsInput: boolean; aToB: boolean };
  if (BigInt(args.amount.toString()) !== exactIn.amountInRaw || BigInt(args.otherAmountThreshold.toString()) !== exactIn.minimumAmountOutRaw
    || !args.amountSpecifiedIsInput || args.aToB !== quote.aToB) throw new Error("Orca swap instruction direction or raw limits do not match the exact-in quote");
  if (!transaction.feePayer?.equals(wallet)) throw new Error("Orca transaction fee payer does not match the simulation wallet");
  const inputMint = new PublicKey(orcaInputMint(pool, exactIn.direction));
  const outputMint = new PublicKey(exactIn.direction === "asset_to_quote" ? pool.token_in_out.quote_address : pool.token_in_out.asset_address);
  const inputProgram = new PublicKey(exactIn.direction === "asset_to_quote" ? exactIn.mintTokenPrograms!.asset : exactIn.mintTokenPrograms!.quote);
  const outputProgram = new PublicKey(exactIn.direction === "asset_to_quote" ? exactIn.mintTokenPrograms!.quote : exactIn.mintTokenPrograms!.asset);
  const requiredAccounts = [new PublicKey(pool.address), data.tokenMintA, data.tokenMintB, data.tokenVaultA, data.tokenVaultB,
    getAssociatedTokenAddressSync(inputMint, wallet, false, inputProgram),
    getAssociatedTokenAddressSync(outputMint, wallet, false, outputProgram), ...orcaTickArrayAddresses(quote)];
  if (requiredAccounts.some((address) => !instruction.keys.some((key) => key.pubkey.equals(address)))) {
    throw new Error("Orca swap instruction is missing a pinned pool, vault, mint, wallet token account or tick array");
  }
}

export function assertMeteoraSwapTransaction(
  transaction: Transaction, dlmm: InstanceType<typeof DLMM>, pool: RegisteredPool, quote: ExactInQuote,
  wallet: PublicKey, binArrays: PublicKey[],
): void {
  const programId = new PublicKey(METEORA_DLMM_PROGRAM_ADDRESS);
  const allowedPrograms = [programId, ASSOCIATED_TOKEN_PROGRAM_ID, ComputeBudgetProgram.programId];
  if (transaction.instructions.some((instruction) => !allowedPrograms.some((allowed) => allowed.equals(instruction.programId)))) {
    throw new Error("Meteora unsigned swap contains an unexpected instruction program");
  }
  const computeBudgetInstructions = transaction.instructions.filter((instruction) => instruction.programId.equals(ComputeBudgetProgram.programId));
  if (computeBudgetInstructions.length > 1 || computeBudgetInstructions.some((instruction) => instruction.data.length !== 5 || instruction.data[0] !== 2)) {
    throw new Error("Meteora unsigned swap contains an unexpected compute-budget instruction");
  }
  const swapInstructions = transaction.instructions.filter((instruction) => instruction.programId.equals(programId));
  if (swapInstructions.length !== 1) throw new Error("Meteora unsigned transaction must contain exactly one DLMM swap instruction");
  const instruction = swapInstructions[0]!;
  const decoded = (dlmm.program.coder.instruction as typeof dlmm.program.coder.instruction & { decode(data: Buffer): { name: string; data: unknown } | null }).decode(instruction.data);
  if (!decoded || decoded.name !== "swap2") throw new Error("Meteora unsigned transaction does not contain the expected swap2 instruction");
  const args = decoded.data as { amountIn?: BN; minAmountOut?: BN };
  if (args.amountIn?.toString() !== quote.amountInRaw.toString() || args.minAmountOut?.toString() !== quote.minimumAmountOutRaw.toString()) {
    throw new Error("Meteora swap instruction raw limits do not match the exact-in quote");
  }
  const inputMint = new PublicKey(quote.direction === "asset_to_quote" ? pool.token_in_out.asset_address : pool.token_in_out.quote_address);
  const outputMint = new PublicKey(quote.direction === "asset_to_quote" ? pool.token_in_out.quote_address : pool.token_in_out.asset_address);
  const inputProgram = new PublicKey(quote.direction === "asset_to_quote" ? quote.mintTokenPrograms!.asset : quote.mintTokenPrograms!.quote);
  const outputProgram = new PublicKey(quote.direction === "asset_to_quote" ? quote.mintTokenPrograms!.quote : quote.mintTokenPrograms!.asset);
  const requiredAccounts = [new PublicKey(pool.address), dlmm.lbPair.reserveX, dlmm.lbPair.reserveY, dlmm.lbPair.tokenXMint, dlmm.lbPair.tokenYMint,
    getAssociatedTokenAddressSync(inputMint, wallet, false, inputProgram), getAssociatedTokenAddressSync(outputMint, wallet, false, outputProgram), ...binArrays];
  if (requiredAccounts.some((address) => !instruction.keys.some((key) => key.pubkey.equals(address)))
    || !instruction.keys.some((key) => key.pubkey.equals(wallet) && key.isSigner)) {
    throw new Error("Meteora swap instruction is missing a pinned pool, reserve, mint, wallet token account or bin array");
  }
  const message = transaction.compileMessage();
  if (!transaction.feePayer?.equals(wallet) || message.header.numRequiredSignatures !== 1 || !message.accountKeys[0]?.equals(wallet)) {
    throw new Error("Meteora unsigned transaction has an unexpected fee payer or signer");
  }
}

export function fingerprintRaydiumState(poolInfo: { id: string }, computePoolInfo: { sqrtPriceX64: { toString(): string }; liquidity: { toString(): string }; tickCurrent: number }, tickArrays: Record<string, unknown>): string {
  const tickAddresses = Object.keys(tickArrays).sort();
  return createHash("sha256").update(JSON.stringify({ pool: poolInfo.id, sqrtPriceX64: computePoolInfo.sqrtPriceX64.toString(),
    liquidity: computePoolInfo.liquidity.toString(), tickCurrent: computePoolInfo.tickCurrent,
    tickArrays: tickAddresses.map((key) => [key, JSON.stringify(tickArrays[key], jsonSafe)]) })).digest("hex");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/https?:\/\/[^\s"'<>]+/g, "[rpc endpoint]").slice(0, 500) : "unknown simulation error";
}

export function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

export function expectedDecimals(mint: string, pool: RegisteredPool): number {
  return mint === pool.token_in_out.asset_address ? pool.token_in_out.asset_decimals : pool.token_in_out.quote_decimals;
}

export function extensionName(extension: ExtensionType): string { return ExtensionType[extension] ?? `Unknown(${extension})`; }

export function minimumOut(amountOut: bigint, slippageBps: number): bigint { return amountOut * BigInt(10_000 - slippageBps) / 10_000n; }
export function sameAddress(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
export function pairMatches(a: string, b: string, expectedA: string, expectedB: string): boolean { return (sameAddress(a, expectedA) && sameAddress(b, expectedB)) || (sameAddress(a, expectedB) && sameAddress(b, expectedA)); }
export function solanaPairMatches(a: string, b: string, expectedA: string, expectedB: string): boolean { return (a === expectedA && b === expectedB) || (a === expectedB && b === expectedA); }
export async function readAddress(provider: JsonRpcProvider, to: string, contract: Interface, method: string, block: number): Promise<string> {
  const raw = await provider.send("eth_call", [{ to, data: contract.encodeFunctionData(method) }, `0x${block.toString(16)}`]) as string;
  return String(contract.decodeFunctionResult(method, raw)[0]);
}
export async function readBigInt(provider: JsonRpcProvider, to: string, contract: Interface, method: string, block: number): Promise<bigint> {
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
