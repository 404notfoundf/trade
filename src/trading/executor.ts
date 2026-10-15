import { randomBytes } from "node:crypto";
import Decimal from "decimal.js";
import bs58 from "bs58";
import { FetchRequest, JsonRpcProvider, Wallet, keccak256 } from "ethers";
import {
  AddressLookupTableAccount, Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import type { SimulatedTransactionAccountInfo } from "@solana/web3.js";
import type { AssetConfig, Config } from "../config.js";
import type { QuoteObservation } from "../observations.js";
import { execute, query, withNamedLock } from "../db.js";
import { solanaRpcFetch } from "../solana-rpc-logging.js";
import { bookStale, floorToStep, vwap, type Instrument } from "../market.js";
import {
  dexApproveTransaction, dexSolanaSwapInstructions, dexSwap, okxPrivateGet, okxPrivatePost,
  type Book, type Credentials,
} from "../okx.js";
import { decideValuation, SOLANA_CHAIN, XLAYER_CHAIN } from "../valuation.js";
import { netMarginOk, swapTxError, type SwapTx } from "./gates.js";
import { logger } from "../logger.js";

type RouterToken = { tokenContractAddress?: string; decimal?: string; taxRate?: string | number | null; isHoneyPot?: boolean };
type RouterResult = {
  chainIndex?: string; fromTokenAmount?: string; toTokenAmount?: string;
  fromToken?: RouterToken; toToken?: RouterToken; priceImpactPercentage?: string | number | null; priceImpactPercent?: string | null;
  tradeFee?: string; dexRouterList?: unknown[];
};
type SolInstruction = {
  programId?: string; data?: string;
  accounts?: Array<{ pubkey?: string; isSigner?: boolean; isWritable?: boolean }>;
};
type SwapBundle = {
  routerResult?: RouterResult; tx?: SwapTx; instructionLists?: SolInstruction[];
  addressLookupTableAccount?: string[];
};
type ExecutionState = {
  routeStatus: "ENABLED" | "MONITOR_ONLY" | "BLOCKED";
  instrument?: Instrument; feeRate?: Decimal; multiplier?: Decimal; book?: Book;
};
type CexBalance = { ccy: string; availBal: string };
type CexOrder = {
  ordId?: string; clOrdId?: string; sCode?: string; sMsg?: string;
  state?: string; accFillSz?: string; avgPx?: string;
};
type ApprovalTransaction = { dexContractAddress?: string; data?: string };
type ExecutionInput = {
  enabled: boolean; armed: () => boolean; tradeSizeUsdt: number; maxTradeSizeUsdt: number;
  assets: AssetConfig[]; okx: Credentials; dex: Credentials;
  signers: Config["signers"]; guardrails: Config["runtime"]["guardrails"];
  dbReady: () => boolean; getState: (asset: AssetConfig) => ExecutionState; pause: () => void;
  setHealth: (dependency: string, status: string, error?: string | null) => void;
};

export function createOpportunityInventoryChecker(okx: Credentials, signers: Config["signers"], assets: AssetConfig[], tradeSizeUsdt: number, maxTradeSizeUsdt: number): (asset: AssetConfig, row: QuoteObservation) => Promise<string | null> {
  const cache = new Map<string, { at: number; value: Promise<Decimal | { asset: bigint; quote: bigint; native: bigint }> }>();
  const cached = <T extends Decimal | { asset: bigint; quote: bigint; native: bigint }>(key: string, read: () => Promise<T>): Promise<T> => {
    const previous = cache.get(key);
    if (previous && Date.now() - previous.at < 1000) return previous.value as Promise<T>;
    const value = read();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  return async (asset, row) => {
    if (!new Decimal(row.sizeUsdt).eq(tradeSizeUsdt) || row.sizeUsdt > maxTradeSizeUsdt) return `Observed size does not match configured executable size ${tradeSizeUsdt} USDT`;
    if (![okx.key, okx.secret, okx.passphrase].every(Boolean)) return "OKX read credentials are unavailable";
    const active = await query<Array<{ id: number; status: string }>>(
      "SELECT id,status FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id DESC LIMIT 1",
    );
    if (active[0]) return `Trade cycle ${active[0].id} is still ${active[0].status}`;
    const wallet = signer(asset.chainIndex, signers.xlayerPrivateKey, signers.solanaPrivateKey);
    if (!wallet) return "Wallet signer is unavailable";
    const [cexBalance, chainBalances] = await Promise.all([
      cached(`cex:${row.direction === "cex_buy_dex_sell" ? "USDT" : asset.okxCurrency}`, () => okxAvailable(okx, row.direction === "cex_buy_dex_sell" ? "USDT" : asset.okxCurrency)),
      cached(`chain:${asset.instId}:${asset.chainIndex}:${wallet.address}`, () => readChainBalances(asset, wallet.address, signers)),
    ]);
    const reservations = await query<Array<{ inst_id: string; chain_index: string; direction: string; size_usdt: string; shares: string; token_amount: string; native_quote_amount: string | null; cex_vwap: string; cex_fee_usdt: string; gas_native_raw: string | null }>>(
      `SELECT o.inst_id,o.chain_index,o.direction,CAST(o.size_usdt AS CHAR) size_usdt,CAST(q.shares AS CHAR) shares,CAST(q.token_amount AS CHAR) token_amount,
       CAST(q.native_quote_amount AS CHAR) native_quote_amount,CAST(q.cex_vwap AS CHAR) cex_vwap,CAST(q.cex_fee_usdt AS CHAR) cex_fee_usdt,q.gas_native_raw
       FROM opportunity o JOIN quote_observation q ON q.id=o.quote_observation_id
       WHERE o.ended_at IS NULL AND o.legacy_sample=0 AND o.executable_status='EXECUTABLE'
         AND NOT (o.inst_id=? AND o.chain_index=? AND o.direction=? AND o.size_usdt=?)`,
      [asset.instId, asset.chainIndex, row.direction, String(row.sizeUsdt)],
    );
    let reservedCex = new Decimal(0);
    let reservedCexAsset = new Decimal(0);
    let reservedAsset = 0n;
    let reservedQuote = 0n;
    let reservedNative = 0n;
    for (const reservation of reservations) {
      const reservedAssetConfig = assets.find((item) => item.instId === reservation.inst_id && item.chainIndex === reservation.chain_index);
      if (!reservedAssetConfig) continue;
      if (reservation.direction === "cex_buy_dex_sell") {
        reservedCex = reservedCex.plus(new Decimal(reservation.shares).mul(reservation.cex_vwap).plus(reservation.cex_fee_usdt));
        if (reservation.chain_index === asset.chainIndex && reservedAssetConfig.tokenAddress === asset.tokenAddress) reservedAsset += rawAmount(new Decimal(reservation.token_amount), asset.tokenDecimals);
      } else if (reservation.inst_id === asset.instId) {
        reservedCexAsset = reservedCexAsset.plus(reservation.shares);
      }
      if (reservation.chain_index === asset.chainIndex) {
        if (reservedAssetConfig.quoteTokenAddress === asset.quoteTokenAddress && reservation.native_quote_amount) reservedQuote += rawAmount(new Decimal(reservation.native_quote_amount), asset.quoteTokenDecimals);
        if (!reservation.gas_native_raw || !/^\d+$/.test(reservation.gas_native_raw)) return "Another active opportunity has no usable native gas estimate";
        reservedNative += BigInt(new Decimal(reservation.gas_native_raw).mul(new Decimal(1).plus(new Decimal(reservedAssetConfig.gasSafetyBufferPercent).div(100))).ceil().toFixed(0));
      }
    }
    if (!row.gasNativeRaw || !/^\d+$/.test(row.gasNativeRaw) || BigInt(row.gasNativeRaw) <= 0n) return "DEX native gas estimate is unavailable";
    const gasBuffer = new Decimal(row.gasNativeRaw).mul(new Decimal(1).plus(new Decimal(asset.gasSafetyBufferPercent).div(100))).ceil();
    if (chainBalances.native < BigInt(gasBuffer.toFixed(0)) + reservedNative) return `Wallet ${asset.chainIndex === XLAYER_CHAIN ? "OKB" : "SOL"} balance is below buffered gas needs`;
    if (row.direction === "cex_buy_dex_sell") {
      const requiredCex = new Decimal(row.shares).mul(row.cexVwap).plus(row.cexFeeUsdt);
      if (cexBalance.minus(reservedCex).lt(requiredCex)) return `CEX available USDT after active opportunity reservations is below ${requiredCex.toString()}`;
      if (chainBalances.asset - reservedAsset < rawAmount(new Decimal(row.tokenAmount), asset.tokenDecimals)) return `Wallet ${asset.tokenSymbol} balance after active opportunity reservations is insufficient`;
    } else {
      if (cexBalance.minus(reservedCexAsset).lt(row.shares)) return `CEX available ${asset.okxCurrency} balance after active opportunity reservations is below ${row.shares}`;
      if (!row.nativeQuoteAmount || chainBalances.quote - reservedQuote < rawAmount(new Decimal(row.nativeQuoteAmount), asset.quoteTokenDecimals)) return `Wallet ${asset.quoteTokenSymbol} balance after active opportunity reservations is insufficient`;
    }
    return null;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const human = (raw: bigint, decimals: number) => new Decimal(raw.toString()).div(new Decimal(10).pow(decimals));
const rawAmount = (amount: Decimal, decimals: number) => BigInt(amount.mul(new Decimal(10).pow(decimals)).floor().toFixed(0));
const addressEqual = (asset: AssetConfig, left: string | undefined, right: string) => asset.chainIndex === SOLANA_CHAIN ? left === right : left?.toLowerCase() === right.toLowerCase();
const SOLANA_OKX_ROUTER = "proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u";
const SOLANA_COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SOLANA_ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SOLANA_TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const SOLANA_WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const SOLANA_MAX_TX_FEE_LAMPORTS = 1_000_000n;
const fail = (message: string): never => { throw new Error(message); };

export function createTradeExecutor(input: ExecutionInput): { tick: () => Promise<void>; checkApprovals: () => Promise<void> } {
  const lastScanAt = new Map<string, number>();
  let localRunning = false;
  return {
    tick: async () => {
      if (!input.enabled || !input.armed() || !input.dbReady() || localRunning) return;
      localRunning = true;
      try {
        const acquired = await withNamedLock("xaapl_trade_execution", async () => {
          const active = await query<Array<{ id: number; status: string }>>(
            "SELECT id,status FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id DESC LIMIT 1",
          );
          if (active[0]) {
            input.pause();
            input.setHealth("trade_execution", active[0].status === "HEDGE_REQUIRED" ? "blocked" : "reconciling", `Trade cycle ${active[0].id} is ${active[0].status}; automatic trading is paused`);
            return;
          }
          for (const asset of input.assets) {
            if (!input.armed()) return;
            if (asset.chainIndex !== XLAYER_CHAIN && asset.chainIndex !== SOLANA_CHAIN) continue;
            const key = `${asset.instId}:${asset.chainIndex}`;
            if (Date.now() - (lastScanAt.get(key) ?? 0) < asset.dexQuoteIntervalMs) continue;
            lastScanAt.set(key, Date.now());
            try {
              if (await tryCexBuyDexSell(asset, input) || await tryDexBuyCexSell(asset, input)) return;
            } catch (error) {
              input.setHealth(`trade_${asset.chainIndex}`, "unavailable", messageOf(error));
              logger.error(`Trade execution check failed for ${asset.network}`, error);
              const pending = await query<Array<{ id: number }>>(
                "SELECT id FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id DESC LIMIT 1",
              );
              if (pending[0]) { input.pause(); return; }
            }
          }
        });
        if (acquired === null) input.setHealth("trade_execution", "busy", "Another process holds the trade execution lock");
      } catch (error) {
        input.setHealth("trade_execution", "unavailable", messageOf(error));
        logger.error("Trade execution tick failed", error);
      } finally { localRunning = false; }
    },
    checkApprovals: async () => {
      const assets = input.assets.filter((entry) => entry.chainIndex === XLAYER_CHAIN);
      if (!assets.length) return;
      const wallet = signer(XLAYER_CHAIN, input.signers.xlayerPrivateKey, "");
      const dexReady = [input.dex.key, input.dex.secret, input.dex.passphrase].every(Boolean);
      const checked = new Set<string>();
      for (const asset of assets) {
        for (const token of [
          { address: asset.tokenAddress, symbol: asset.tokenSymbol, decimals: asset.tokenDecimals },
          { address: asset.quoteTokenAddress, symbol: asset.quoteTokenSymbol, decimals: asset.quoteTokenDecimals },
        ]) {
          const key = token.address.toLowerCase();
          if (checked.has(key)) continue;
          checked.add(key);
          const dependency = approvalDependency(token.symbol);
          if (!wallet) {
            input.setHealth(dependency, "not_configured", "Set a valid XLAYER_PRIVATE_KEY to check this wallet's allowance");
          } else if (!dexReady) {
            input.setHealth(dependency, "not_configured", "Set OKX DEX API credentials to resolve the current approval spender");
          } else {
            await checkEvmAllowance(asset, token.address, token.symbol, token.decimals, wallet.address, 1n, input);
          }
        }
      }
    },
  };
}

async function tryCexBuyDexSell(asset: AssetConfig, input: ExecutionInput): Promise<boolean> {
  const state = input.getState(asset);
  if (state.routeStatus !== "ENABLED" || !state.instrument || !state.feeRate || !state.multiplier || !state.book?.ready || bookStale(state.book)) return false;
  const checkedMultiplier = state.multiplier;
  if (![input.okx.key, input.okx.secret, input.okx.passphrase].every(Boolean)) {
    input.setHealth(`trade_${asset.chainIndex}`, "not_configured", "Set an OKX CEX key with Read and Trade permissions; Withdraw must remain disabled");
    return false;
  }
  if (![input.dex.key, input.dex.secret, input.dex.passphrase].every(Boolean)) {
    input.setHealth(`trade_${asset.chainIndex}`, "not_configured", "Set OKX DEX API credentials");
    return false;
  }
  if (!Number.isFinite(input.tradeSizeUsdt) || input.tradeSizeUsdt <= 0 || input.tradeSizeUsdt > input.maxTradeSizeUsdt) return false;
  const wallet = signer(asset.chainIndex, input.signers.xlayerPrivateKey, input.signers.solanaPrivateKey);
  if (!wallet) {
    input.setHealth(`trade_${asset.chainIndex}`, "not_configured", `Set the ${asset.chainIndex === XLAYER_CHAIN ? "XLAYER_PRIVATE_KEY" : "SOLANA_PRIVATE_KEY"} runtime secret`);
    return false;
  }

  const asks = state.book.asks;
  if (!asks.length) return false;
  const wantedShares = floorToStep(new Decimal(input.tradeSizeUsdt).div(asks[0]!.price), state.instrument.lotSz);
  if (wantedShares.lt(state.instrument.minSz)) return false;
  const wantedToken = wantedShares.div(state.multiplier);
  const amount = rawAmount(wantedToken, asset.tokenDecimals);
  if (amount <= 0n) return false;
  const expectedShares = floorToStep(human(amount, asset.tokenDecimals).mul(state.multiplier), state.instrument.lotSz);
  const expectedFill = vwap(asks, expectedShares);
  if (!expectedFill || expectedShares.lt(state.instrument.minSz)) return false;

  const [cexUsdt, chainBalances] = await Promise.all([
    okxAvailable(input.okx, "USDT"), readChainBalances(asset, wallet.address, input.signers),
  ]);
  const requiredCexUsdt = expectedFill.notional.mul(new Decimal(1).plus(state.feeRate));
  if (cexUsdt.lt(requiredCexUsdt)) {
    input.setHealth(`inventory_${asset.chainIndex}`, "insufficient_balance", `CEX available USDT ${cexUsdt.toString()} is below required ${requiredCexUsdt.toString()}`);
    return false;
  }
  if (chainBalances.asset < amount) {
    input.setHealth(`inventory_${asset.chainIndex}`, "insufficient_balance", `Wallet AAPLx is below the ${human(amount, asset.tokenDecimals).toString()} token trade size`);
    return false;
  }
  if (chainBalances.native <= 0n) {
    input.setHealth(`inventory_${asset.chainIndex}`, "insufficient_balance", `Wallet has no ${asset.chainIndex === XLAYER_CHAIN ? "OKB" : "SOL"} for gas`);
    return false;
  }

  let bundle = await requestSwap(asset, wallet.address, amount, asset.tokenAddress, asset.quoteTokenAddress, input);
  let quoteState = input.getState(asset);
  if (quoteState.routeStatus !== "ENABLED" || !quoteState.multiplier?.eq(checkedMultiplier)) return false;
  let gate = await evaluateSwap(asset, bundle, amount, quoteState, input);
  if (!gate) return false;
  const approvalSpender = asset.chainIndex === XLAYER_CHAIN
    ? await checkEvmAllowance(asset, asset.tokenAddress, asset.tokenSymbol, asset.tokenDecimals, wallet.address, amount, input)
    : null;
  if (asset.chainIndex === XLAYER_CHAIN && !approvalSpender) return false;
  const cycleId = await createCycle(asset, "cex_buy_dex_sell", gate.decision.netProfitUsdt!, gate.quoteInput, gate.quoteOutput, gate.shares);
  try {
    if (!input.armed()) {
      await setCycle(cycleId, "FAILED", "Trading was disarmed before the swap was signed");
      return true;
    }
    const beforeSwapState = input.getState(asset);
    if (beforeSwapState.routeStatus !== "ENABLED" || !beforeSwapState.multiplier?.eq(checkedMultiplier) || !beforeSwapState.feeRate
      || !beforeSwapState.book?.ready || bookStale(beforeSwapState.book)) {
      await setCycle(cycleId, "FAILED", "Route, multiplier, or CEX book changed before the swap was signed");
      return true;
    }
    const currentFill = vwap(beforeSwapState.book.asks, gate.shares);
    if (currentFill?.notional.gt(input.maxTradeSizeUsdt)) {
      await setCycle(cycleId, "FAILED", "CEX buy notional exceeds the configured per-trade limit before the DEX swap");
      return true;
    }
    const availableBeforeSwap = await okxAvailable(input.okx, "USDT");
    if (!currentFill || availableBeforeSwap.lt(currentFill.notional.mul(new Decimal(1).plus(beforeSwapState.feeRate!)))) {
      await setCycle(cycleId, "FAILED", "CEX USDT inventory became insufficient before the DEX swap");
      input.setHealth("inventory_" + asset.chainIndex, "insufficient_balance", "CEX available USDT is now below the required CEX buy amount");
      return true;
    }
    if (!input.armed()) {
      await setCycle(cycleId, "FAILED", "Trading was disarmed before the swap was signed");
      return true;
    }
    if (asset.chainIndex === XLAYER_CHAIN && !await checkEvmAllowance(asset, asset.tokenAddress, asset.tokenSymbol, asset.tokenDecimals, wallet.address, amount, input, approvalSpender!)) {
      await setCycle(cycleId, "FAILED", `${asset.tokenSymbol} allowance is insufficient before the X Layer swap`);
      return true;
    }
    let txHash: string;
    if (asset.chainIndex === XLAYER_CHAIN) {
      const provider = evmProvider();
      const error = swapTxError(bundle.tx, wallet.address, input.guardrails.maxDexPriceImpactPercent, {
        fromToken: asset.tokenAddress, toToken: asset.quoteTokenAddress, amount: new Decimal(amount.toString()),
        output: new Decimal(bundle.routerResult!.toTokenAmount!),
      });
      if (error) fail(error);
      await provider.call({ from: wallet.address, to: bundle.tx!.to, data: bundle.tx!.data, value: BigInt(bundle.tx!.value ?? "0") });
      txHash = await sendEvmCall(cycleId, asset, wallet.evm!, provider, bundle.tx!.to!, bundle.tx!.data!, "swap");
    } else {
      txHash = await sendSolanaSwap(cycleId, asset, wallet.solana!, bundle, input.signers.solanaRpcUrl, {
        fromToken: asset.tokenAddress, toToken: asset.quoteTokenAddress, amount,
        maxSlippagePercent: input.guardrails.maxDexPriceImpactPercent,
      });
    }
    await setCycle(cycleId, "DEX_CONFIRMED", null, txHash);
    const deltas = await readSwapDeltas(asset, txHash, wallet.address, input.signers.solanaRpcUrl);
    const tokenSold = -deltas.assetDelta;
    const stableReceived = deltas.quoteDelta;
    if (tokenSold <= 0n || stableReceived <= 0n || tokenSold > amount) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX confirmed but actual wallet balance deltas are invalid; reconcile manually");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual reconciliation`);
      return true;
    }

    const latest = input.getState(asset);
    if (!latest.book?.ready || bookStale(latest.book) || !latest.feeRate || !latest.multiplier || !latest.multiplier.eq(checkedMultiplier) || !latest.instrument) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but fresh CEX market data is unavailable");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    const actualShares = floorToStep(human(tokenSold, asset.tokenDecimals).mul(latest.multiplier), latest.instrument.lotSz);
    if (actualShares.lt(latest.instrument.minSz)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX fill is below the CEX minimum order size");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    const outputHuman = human(stableReceived, asset.quoteTokenDecimals);
    const gasUsdt = new Decimal(gate.gasUsdt);
    const now = Date.now();
    const maxAgeMs = input.guardrails.indexPriceMaxAgeSeconds * 1000;
    const availableAfter = await okxAvailable(input.okx, "USDT");
    const latestBook = input.getState(asset).book;
    if (!latestBook?.ready || bookStale(latestBook)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but the CEX order book became stale");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    const fill = vwap(latestBook.asks, actualShares);
    if (!fill) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but CEX buy depth is insufficient");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    if (fill.notional.gt(input.maxTradeSizeUsdt)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but CEX buy notional exceeds the configured per-trade limit");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    const decision = decideValuation({
      chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "cex_buy_dex_sell",
      quoteAmount: outputHuman, cexCost: fill.notional, cexFee: fill.notional.mul(latest.feeRate), gasUsdt,
      now, maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    if (decision.valuationStatus !== "VERIFIED" || !decision.netProfitUsdt || !netMarginOk(new Decimal(decision.netProfitUsdt), fill.notional.plus(fill.notional.mul(latest.feeRate)).plus(gasUsdt))) {
      await setCycle(cycleId, "HEDGE_REQUIRED", decision.reason ?? "DEX filled but the minimum net margin is no longer available");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    const limitPrice = maxCexBuyPrice(decision.usdtLeg!, gasUsdt, actualShares, latest.feeRate, latest.instrument.tickSz);
    if (!limitPrice || limitPrice.lt(latestBook.asks[0]!.price)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but the CEX IOC limit cannot preserve the minimum margin");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    if (actualShares.mul(limitPrice).gt(input.maxTradeSizeUsdt)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but the CEX buy order would exceed the configured per-trade limit");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }
    if (availableAfter.lt(actualShares.mul(limitPrice).mul(new Decimal(1).plus(latest.feeRate)))) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but CEX available USDT is insufficient for the hedge");
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs manual CEX hedge`);
      return true;
    }

    const clOrdIdResult = (await query<Array<{ client_order_id: string }>>("SELECT client_order_id FROM trade_cycle WHERE id=?", [cycleId]))[0]?.client_order_id;
    if (!clOrdIdResult) throw new Error("Trade client order ID was not persisted");
    const clOrdId = clOrdIdResult;
    await setCycle(cycleId, "CEX_SUBMITTED", null, txHash);
    const order = await placeIocOrder(input.okx, cycleId, clOrdId, asset.instId, "buy", actualShares, limitPrice);
    const filled = new Decimal(order.accFillSz ?? "0");
    const avgPrice = order.avgPx ? new Decimal(order.avgPx) : null;
    await execute(
      "UPDATE trade_cycle SET cex_requested_size=?,cex_filled_size=?,cex_average_price=? WHERE id=?",
      [actualShares.toString(), filled.toString(), avgPrice?.toString() ?? null, cycleId],
    );
    if (!filled.eq(actualShares) || order.state !== "filled" || !avgPrice?.isFinite()) {
      await setCycle(cycleId, "HEDGE_REQUIRED", `CEX IOC ended ${order.state ?? "unknown"} with ${filled.toString()} of ${actualShares.toString()} shares filled`, txHash);
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} has an unmatched position; manual reconciliation required`);
      return true;
    }
    const actualCost = filled.mul(avgPrice);
    const finalDecision = decideValuation({
      chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "cex_buy_dex_sell",
      quoteAmount: outputHuman, cexCost: actualCost, cexFee: actualCost.mul(latest.feeRate), gasUsdt,
      now: Date.now(), maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    if (finalDecision.valuationStatus !== "VERIFIED" || !finalDecision.netProfitUsdt) {
      await setCycle(cycleId, "HEDGE_REQUIRED", finalDecision.reason ?? "Final trade valuation is unavailable", txHash);
      return true;
    }
    await execute("UPDATE trade_cycle SET post_fill_net_profit_estimate_usdt=? WHERE id=?", [finalDecision.netProfitUsdt, cycleId]);
    await setCycle(cycleId, "COMPLETE", `CEX IOC filled ${filled.toString()} shares`, txHash);
    input.setHealth(`trade_${asset.chainIndex}`, "healthy", null);
    input.setHealth("trade_execution", "healthy", `Completed ${asset.network} CEX-buy/DEX-sell cycle ${cycleId}`);
    logger.info(`Completed CEX-buy/DEX-sell cycle ${cycleId} on ${asset.network}`);
    return true;
  } catch (error) {
    const chainRows = await query<Array<{ purpose: string; status: string }>>(
      "SELECT purpose,status FROM trade_cycle_tx WHERE trade_cycle_id=?", [cycleId],
    ).catch(() => null);
    const status = chainRows === null
      || chainRows.some((row) => row.status === "SUBMITTED" || row.status === "UNCERTAIN")
      || chainRows.some((row) => row.purpose === "swap" && row.status !== "FAILED")
      ? "HEDGE_REQUIRED" : "FAILED";
    await setCycle(cycleId, status, messageOf(error).slice(0, 500));
    if (status === "HEDGE_REQUIRED") input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} needs reconciliation`);
    throw error;
  }
}

async function tryDexBuyCexSell(asset: AssetConfig, input: ExecutionInput): Promise<boolean> {
  const state = input.getState(asset);
  if (state.routeStatus !== "ENABLED" || !state.instrument || !state.feeRate || !state.multiplier || !state.book?.ready || bookStale(state.book)) return false;
  const checkedMultiplier = state.multiplier;
  if (![input.okx.key, input.okx.secret, input.okx.passphrase, input.dex.key, input.dex.secret, input.dex.passphrase].every(Boolean)) return false;
  if (!Number.isFinite(input.tradeSizeUsdt) || input.tradeSizeUsdt <= 0 || input.tradeSizeUsdt > input.maxTradeSizeUsdt) return false;
  const wallet = signer(asset.chainIndex, input.signers.xlayerPrivateKey, input.signers.solanaPrivateKey);
  if (!wallet) return false;
  const amount = rawAmount(new Decimal(input.tradeSizeUsdt), asset.quoteTokenDecimals);
  if (amount <= 0n) return false;

  const [cexAsset, chainBalances] = await Promise.all([
    okxAvailable(input.okx, asset.okxCurrency), readChainBalances(asset, wallet.address, input.signers),
  ]);
  if (cexAsset.lte(0)) {
    input.setHealth("inventory_" + asset.chainIndex, "insufficient_balance", "CEX available " + asset.okxCurrency + " is zero for the DEX-buy/CEX-sell direction");
    return false;
  }
  if (chainBalances.quote < amount) {
    input.setHealth("inventory_" + asset.chainIndex, "insufficient_balance", "Wallet " + asset.quoteTokenSymbol + " is below the DEX-buy input amount");
    return false;
  }
  if (chainBalances.native <= 0n) {
    input.setHealth("inventory_" + asset.chainIndex, "insufficient_balance", "Wallet has no " + (asset.chainIndex === XLAYER_CHAIN ? "OKB" : "SOL") + " for gas");
    return false;
  }

  let bundle = await requestSwap(asset, wallet.address, amount, asset.quoteTokenAddress, asset.tokenAddress, input);
  let quoteState = input.getState(asset);
  if (quoteState.routeStatus !== "ENABLED" || !quoteState.multiplier?.eq(checkedMultiplier)) return false;
  let gate = await evaluateSwap(asset, bundle, amount, quoteState, input, "dex_buy_cex_sell");
  if (!gate) return false;
  if (cexAsset.lt(gate.shares)) {
    input.setHealth("inventory_" + asset.chainIndex, "insufficient_balance", "CEX available " + asset.okxCurrency + " " + cexAsset.toString() + " is below required " + gate.shares.toString());
    return false;
  }
  const approvalSpender = asset.chainIndex === XLAYER_CHAIN
    ? await checkEvmAllowance(asset, asset.quoteTokenAddress, asset.quoteTokenSymbol, asset.quoteTokenDecimals, wallet.address, amount, input)
    : null;
  if (asset.chainIndex === XLAYER_CHAIN && !approvalSpender) return false;
  const cycleId = await createCycle(asset, "dex_buy_cex_sell", gate.decision.netProfitUsdt!, gate.quoteInput, gate.quoteOutput, gate.shares);
  try {
    if (!input.armed()) {
      await setCycle(cycleId, "FAILED", "Trading was disarmed before the swap was signed");
      return true;
    }
    const beforeSwapState = input.getState(asset);
    if (beforeSwapState.routeStatus !== "ENABLED" || !beforeSwapState.multiplier?.eq(checkedMultiplier) || !beforeSwapState.feeRate
      || !beforeSwapState.book?.ready || bookStale(beforeSwapState.book)) {
      await setCycle(cycleId, "FAILED", "Route, multiplier, or CEX book changed before the swap was signed");
      return true;
    }
    const currentFill = vwap(beforeSwapState.book.bids, gate.shares);
    if (!currentFill) {
      await setCycle(cycleId, "FAILED", "CEX sell depth became insufficient before the DEX swap");
      return true;
    }
    if (currentFill.notional.gt(input.maxTradeSizeUsdt)) {
      await setCycle(cycleId, "FAILED", "CEX sell notional exceeds the configured per-trade limit before the DEX swap");
      return true;
    }
    const availableBeforeSwap = await okxAvailable(input.okx, asset.okxCurrency);
    if (availableBeforeSwap.lt(gate.shares)) {
      await setCycle(cycleId, "FAILED", "CEX XAAPL inventory became insufficient before the DEX swap");
      input.setHealth("inventory_" + asset.chainIndex, "insufficient_balance", "CEX available " + asset.okxCurrency + " is below the required sell amount");
      return true;
    }
    if (!input.armed()) {
      await setCycle(cycleId, "FAILED", "Trading was disarmed before the swap was signed");
      return true;
    }
    if (asset.chainIndex === XLAYER_CHAIN && !await checkEvmAllowance(asset, asset.quoteTokenAddress, asset.quoteTokenSymbol, asset.quoteTokenDecimals, wallet.address, amount, input, approvalSpender!)) {
      await setCycle(cycleId, "FAILED", `${asset.quoteTokenSymbol} allowance is insufficient before the X Layer swap`);
      return true;
    }
    let txHash: string;
    if (asset.chainIndex === XLAYER_CHAIN) {
      const error = swapTxError(bundle.tx, wallet.address, input.guardrails.maxDexPriceImpactPercent, {
        fromToken: asset.quoteTokenAddress, toToken: asset.tokenAddress, amount: new Decimal(amount.toString()),
        output: new Decimal(bundle.routerResult!.toTokenAmount!),
      });
      if (error) fail(error);
      await evmProvider().call({ from: wallet.address, to: bundle.tx!.to, data: bundle.tx!.data, value: BigInt(bundle.tx!.value ?? "0") });
      txHash = await sendEvmCall(cycleId, asset, wallet.evm!, evmProvider(), bundle.tx!.to!, bundle.tx!.data!, "swap");
    } else {
      txHash = await sendSolanaSwap(cycleId, asset, wallet.solana!, bundle, input.signers.solanaRpcUrl, {
        fromToken: asset.quoteTokenAddress, toToken: asset.tokenAddress, amount,
        maxSlippagePercent: input.guardrails.maxDexPriceImpactPercent,
      });
    }
    await setCycle(cycleId, "DEX_CONFIRMED", null, txHash);
    const deltas = await readSwapDeltas(asset, txHash, wallet.address, input.signers.solanaRpcUrl);
    const tokenBought = deltas.assetDelta;
    const quoteSpent = -deltas.quoteDelta;
    if (tokenBought <= 0n || quoteSpent <= 0n || quoteSpent > amount) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX confirmed but actual wallet balance deltas are invalid; reconcile manually");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual reconciliation");
      return true;
    }

    const latest = input.getState(asset);
    if (!latest.book?.ready || bookStale(latest.book) || !latest.feeRate || !latest.multiplier || !latest.multiplier.eq(checkedMultiplier) || !latest.instrument) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but fresh CEX market data is unavailable");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    const actualShares = floorToStep(human(tokenBought, asset.tokenDecimals).mul(latest.multiplier), latest.instrument.lotSz);
    if (actualShares.lt(latest.instrument.minSz)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX fill is below the CEX minimum order size");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    const quoteSpentHuman = human(quoteSpent, asset.quoteTokenDecimals);
    const gasUsdt = new Decimal(gate.gasUsdt);
    const now = Date.now();
    const maxAgeMs = input.guardrails.indexPriceMaxAgeSeconds * 1000;
    const availableAfter = await okxAvailable(input.okx, asset.okxCurrency);
    const latestBook = input.getState(asset).book;
    if (!latestBook?.ready || bookStale(latestBook)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but the CEX order book became stale");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    const fill = vwap(latestBook.bids, actualShares);
    if (!fill) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but CEX sell depth is insufficient");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    if (fill.notional.gt(input.maxTradeSizeUsdt)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but CEX sell notional exceeds the configured per-trade limit");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    const decision = decideValuation({
      chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "dex_buy_cex_sell",
      quoteAmount: quoteSpentHuman, cexCost: fill.notional, cexFee: fill.notional.mul(latest.feeRate), gasUsdt,
      now, maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    const invested = new Decimal(decision.usdtLeg ?? "NaN").plus(fill.notional.mul(latest.feeRate)).plus(gasUsdt);
    if (decision.valuationStatus !== "VERIFIED" || !decision.usdtLeg || !decision.netProfitUsdt
      || !netMarginOk(new Decimal(decision.netProfitUsdt), invested)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", decision.reason ?? "DEX filled but the minimum net margin is no longer available");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    const limitPrice = minCexSellPrice(decision.usdtLeg, gasUsdt, actualShares, latest.feeRate, latest.instrument.tickSz);
    if (!limitPrice || limitPrice.gt(latestBook.bids[0]!.price)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but the CEX IOC limit cannot preserve the minimum margin");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }
    if (availableAfter.lt(actualShares)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "DEX filled but CEX XAAPL inventory is insufficient for the hedge");
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs manual CEX hedge");
      return true;
    }

    const clOrdId = (await query<Array<{ client_order_id: string }>>("SELECT client_order_id FROM trade_cycle WHERE id=?", [cycleId]))[0]?.client_order_id;
    if (!clOrdId) throw new Error("Trade client order ID was not persisted");
    await setCycle(cycleId, "CEX_SUBMITTED", null, txHash);
    const order = await placeIocOrder(input.okx, cycleId, clOrdId, asset.instId, "sell", actualShares, limitPrice);
    const filled = new Decimal(order.accFillSz ?? "0");
    const avgPrice = order.avgPx ? new Decimal(order.avgPx) : null;
    await execute(
      "UPDATE trade_cycle SET cex_requested_size=?,cex_filled_size=?,cex_average_price=? WHERE id=?",
      [actualShares.toString(), filled.toString(), avgPrice?.toString() ?? null, cycleId],
    );
    if (!filled.eq(actualShares) || order.state !== "filled" || !avgPrice?.isFinite()) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "CEX IOC ended " + (order.state ?? "unknown") + " with " + filled.toString() + " of " + actualShares.toString() + " shares filled", txHash);
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " has an unmatched position; manual reconciliation required");
      return true;
    }
    const finalDecision = decideValuation({
      chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "dex_buy_cex_sell",
      quoteAmount: quoteSpentHuman, cexCost: filled.mul(avgPrice), cexFee: filled.mul(avgPrice).mul(latest.feeRate), gasUsdt,
      now: Date.now(), maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    const finalInvested = new Decimal(finalDecision.usdtLeg ?? "NaN").plus(filled.mul(avgPrice).mul(latest.feeRate)).plus(gasUsdt);
    if (finalDecision.valuationStatus !== "VERIFIED" || !finalDecision.netProfitUsdt
      || !netMarginOk(new Decimal(finalDecision.netProfitUsdt), finalInvested)) {
      await setCycle(cycleId, "HEDGE_REQUIRED", finalDecision.reason ?? "Final trade margin fell below the configured minimum", txHash);
      return true;
    }
    await execute("UPDATE trade_cycle SET post_fill_net_profit_estimate_usdt=? WHERE id=?", [finalDecision.netProfitUsdt, cycleId]);
    await setCycle(cycleId, "COMPLETE", "CEX IOC filled " + filled.toString() + " shares", txHash);
    input.setHealth("trade_" + asset.chainIndex, "healthy", null);
    input.setHealth("trade_execution", "healthy", "Completed " + asset.network + " DEX-buy/CEX-sell cycle " + cycleId);
    logger.info("Completed DEX-buy/CEX-sell cycle " + cycleId + " on " + asset.network);
    return true;
  } catch (error) {
    const chainRows = await query<Array<{ purpose: string; status: string }>>(
      "SELECT purpose,status FROM trade_cycle_tx WHERE trade_cycle_id=?", [cycleId],
    ).catch(() => null);
    const status = chainRows === null
      || chainRows.some((row) => row.status === "SUBMITTED" || row.status === "UNCERTAIN")
      || chainRows.some((row) => row.purpose === "swap" && row.status !== "FAILED")
      ? "HEDGE_REQUIRED" : "FAILED";
    await setCycle(cycleId, status, messageOf(error).slice(0, 500));
    if (status === "HEDGE_REQUIRED") input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " needs reconciliation");
    throw error;
  }
}

async function evaluateSwap(asset: AssetConfig, bundle: SwapBundle, expectedInput: bigint, state: ExecutionState, input: ExecutionInput, direction: "cex_buy_dex_sell" | "dex_buy_cex_sell" = "cex_buy_dex_sell") {
  const router = bundle.routerResult;
  if (!router || router.chainIndex !== asset.chainIndex || !Array.isArray(router.dexRouterList) || !router.dexRouterList.length
    || !addressEqual(asset, router.fromToken?.tokenContractAddress, direction === "cex_buy_dex_sell" ? asset.tokenAddress : asset.quoteTokenAddress)
    || !addressEqual(asset, router.toToken?.tokenContractAddress, direction === "cex_buy_dex_sell" ? asset.quoteTokenAddress : asset.tokenAddress)) return null;
  const fromRaw = new Decimal(router.fromTokenAmount ?? "NaN");
  const toRaw = new Decimal(router.toTokenAmount ?? "NaN");
  if (!fromRaw.isInteger() || !fromRaw.eq(expectedInput) || !toRaw.isInteger() || !toRaw.gt(0)) return null;
  const fromDecimals = direction === "cex_buy_dex_sell" ? asset.tokenDecimals : asset.quoteTokenDecimals;
  const toDecimals = direction === "cex_buy_dex_sell" ? asset.quoteTokenDecimals : asset.tokenDecimals;
  if ((router.fromToken?.decimal !== undefined && Number(router.fromToken.decimal) !== fromDecimals)
    || (router.toToken?.decimal !== undefined && Number(router.toToken.decimal) !== toDecimals)) return null;
  if (router.fromToken?.isHoneyPot || router.toToken?.isHoneyPot || [router.fromToken?.taxRate, router.toToken?.taxRate].some((tax) => {
    if (tax === undefined || tax === null) return false;
    try { const parsed = new Decimal(tax); return !parsed.isFinite() || parsed.isNegative() || parsed.gt(0); } catch { return true; }
  })) return null;
  const rawImpact = router.priceImpactPercentage ?? router.priceImpactPercent;
  let impact: Decimal | null = null;
  if (rawImpact !== undefined && rawImpact !== null) {
    try { const parsed = new Decimal(rawImpact); if (parsed.isFinite()) impact = parsed; } catch { return null; }
  }
  if (!impact?.isFinite() || impact.abs().gt(input.guardrails.maxDexPriceImpactPercent)) return null;
  if (!state.book?.ready || bookStale(state.book) || !state.instrument || !state.feeRate || !state.multiplier) return null;
  const quoteInput = human(BigInt(fromRaw.toFixed(0)), fromDecimals);
  const quoteOutput = human(BigInt(toRaw.toFixed(0)), toDecimals);
  const estimatedShares = floorToStep(human(direction === "cex_buy_dex_sell" ? expectedInput : BigInt(toRaw.toFixed(0)), asset.tokenDecimals).mul(state.multiplier), state.instrument.lotSz);
  const cexFill = vwap(direction === "cex_buy_dex_sell" ? state.book.asks : state.book.bids, estimatedShares);
  if (!cexFill || cexFill.notional.gt(input.maxTradeSizeUsdt) || estimatedShares.lt(state.instrument.minSz)) return null;
  const gasRaw = router.tradeFee === undefined ? null : new Decimal(router.tradeFee);
  if (!gasRaw?.isFinite() || gasRaw.lt(0)) return null;
  const gasUsdt = gasRaw.mul(new Decimal(1).plus(new Decimal(asset.gasSafetyBufferPercent).div(100)));
  const now = Date.now();
  const maxAgeMs = input.guardrails.indexPriceMaxAgeSeconds * 1000;
  const decision = decideValuation({
    chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction,
    quoteAmount: direction === "cex_buy_dex_sell" ? quoteOutput : quoteInput, cexCost: cexFill.notional, cexFee: cexFill.notional.mul(state.feeRate), gasUsdt,
    now, maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
    maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
  });
  const invested = direction === "cex_buy_dex_sell"
    ? cexFill.notional.plus(cexFill.notional.mul(state.feeRate)).plus(gasUsdt)
    : new Decimal(decision.usdtLeg ?? "NaN").plus(cexFill.notional.mul(state.feeRate)).plus(gasUsdt);
  if (decision.valuationStatus !== "VERIFIED" || !decision.netProfitUsdt || !netMarginOk(new Decimal(decision.netProfitUsdt), invested)) return null;
  if (new Decimal(input.tradeSizeUsdt).gt(input.maxTradeSizeUsdt)) return null;
  return { decision, gasUsdt: gasUsdt.toString(), quoteInput: quoteInput.toString(), quoteOutput: quoteOutput.toString(), shares: estimatedShares };
}

async function requestSwap(asset: AssetConfig, wallet: string, amount: bigint, fromToken: string, toToken: string, input: ExecutionInput): Promise<SwapBundle> {
  const query = new URLSearchParams({
    chainIndex: asset.chainIndex, amount: amount.toString(), fromTokenAddress: fromToken,
    toTokenAddress: toToken, userWalletAddress: wallet,
    swapMode: "exactIn", slippagePercent: String(input.guardrails.maxDexPriceImpactPercent),
    priceImpactProtectionPercent: String(input.guardrails.maxDexPriceImpactPercent),
  });
  if (asset.chainIndex === XLAYER_CHAIN) {
    const rows = await dexSwap<SwapBundle[]>(query, input.dex);
    const bundle = rows[0];
    if (!bundle || !bundle.tx) throw new Error("X Layer DEX swap response has no transaction");
    const error = swapTxError(bundle.tx, wallet, input.guardrails.maxDexPriceImpactPercent, {
      fromToken, toToken, amount: new Decimal(amount.toString()),
      output: new Decimal(bundle.routerResult?.toTokenAmount ?? "NaN"),
    });
    if (error) fail(error);
    return bundle;
  }
  const response = await dexSolanaSwapInstructions<SwapBundle | SwapBundle[]>(query, input.dex);
  const bundle = Array.isArray(response) ? response[0] : response;
  if (!bundle || !bundle.routerResult || !bundle.instructionLists?.length) throw new Error("Solana DEX response has no swap instructions");
  return bundle;
}

async function okxAvailable(credentials: Credentials, currency: string): Promise<Decimal> {
  const rows = await okxPrivateGet<Array<{ details?: CexBalance[] }>>(`/api/v5/account/balance?ccy=${encodeURIComponent(currency)}`, credentials);
  const row = rows[0]?.details?.find((item) => item.ccy === currency);
  const amount = new Decimal(row?.availBal ?? "0");
  if (!amount.isFinite() || amount.lt(0)) fail(`OKX available ${currency} balance is unavailable`);
  return amount;
}

function signer(chainIndex: string, xlayerKey: string, solanaKey: string): { address: string; evm?: Wallet; solana?: Keypair } | null {
  try {
    if (chainIndex === XLAYER_CHAIN && xlayerKey) {
      const evm = new Wallet(xlayerKey);
      return { address: evm.address, evm };
    }
    if (chainIndex === SOLANA_CHAIN && solanaKey) {
      const secret = solanaKey.trim();
      const bytes = secret.startsWith("[")
        ? Uint8Array.from(JSON.parse(secret) as number[])
        : bs58.decode(secret);
      const solana = bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
      return { address: solana.publicKey.toBase58(), solana };
    }
  } catch {
    fail(`Invalid ${chainIndex === XLAYER_CHAIN ? "X Layer" : "Solana"} runtime private key`);
  }
  return null;
}

export function validateTradeSigners(assets: AssetConfig[], signers: Config["signers"]): void {
  for (const asset of assets) {
    if (signer(asset.chainIndex, signers.xlayerPrivateKey, signers.solanaPrivateKey)) continue;
    const secretName = asset.chainIndex === XLAYER_CHAIN ? "XLAYER_PRIVATE_KEY" : "SOLANA_PRIVATE_KEY";
    fail(`Trading is enabled but ${secretName} is required for ${asset.network} route (${asset.instId})`);
  }
}

let sharedEvmProvider: JsonRpcProvider | undefined;
function evmProvider(): JsonRpcProvider {
  if (!sharedEvmProvider) {
    const request = new FetchRequest(process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech");
    request.timeout = 10_000;
    sharedEvmProvider = new JsonRpcProvider(request, 196, { staticNetwork: true });
  }
  return sharedEvmProvider;
}

async function readChainBalances(asset: AssetConfig, owner: string, signers: Config["signers"]): Promise<{ asset: bigint; quote: bigint; native: bigint }> {
  if (asset.chainIndex === XLAYER_CHAIN) {
    const provider = evmProvider();
    const [token, quote, native] = await Promise.all([
      readEvmTokenBalance(provider, asset.tokenAddress, owner),
      readEvmTokenBalance(provider, asset.quoteTokenAddress, owner),
      provider.getBalance(owner),
    ]);
    return { asset: token, quote, native };
  }
  const connection = new Connection(signers.solanaRpcUrl, { commitment: "confirmed", fetch: solanaRpcFetch });
  const ownerKey = new PublicKey(owner);
  const tokenKey = new PublicKey(asset.tokenAddress);
  const quoteKey = new PublicKey(asset.quoteTokenAddress);
  const [token, quote, native] = await Promise.all([
    readSolTokenBalance(connection, ownerKey, tokenKey, asset.tokenDecimals),
    readSolTokenBalance(connection, ownerKey, quoteKey, asset.quoteTokenDecimals),
    connection.getBalance(ownerKey, "confirmed"),
  ]);
  return { asset: token, quote, native: BigInt(native) };
}

async function readEvmTokenBalance(provider: JsonRpcProvider, token: string, owner: string): Promise<bigint> {
  const data = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  const result = await provider.call({ to: token, data });
  if (!/^0x[\da-f]{64}$/i.test(result)) fail("X Layer token balance response is invalid");
  return BigInt(result);
}

async function readSolTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey, expectedDecimals: number): Promise<bigint> {
  const result = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = 0n;
  for (const account of result.value) {
    const parsed = account.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } };
    const tokenAmount = parsed.parsed?.info?.tokenAmount;
    const raw = tokenAmount?.amount;
    if (!tokenAmount || raw === undefined || tokenAmount.decimals !== expectedDecimals || !/^\d+$/.test(raw)) throw new Error("Solana token account metadata does not match pinned decimals");
    total += BigInt(raw);
  }
  return total;
}

async function readSwapDeltas(asset: AssetConfig, txHash: string, owner: string, solanaRpcUrl: string): Promise<{ assetDelta: bigint; quoteDelta: bigint }> {
  if (asset.chainIndex === XLAYER_CHAIN) {
    const receipt = await evmProvider().getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) throw new Error("Confirmed X Layer swap receipt is unavailable");
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ownerTopic = `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
    let assetDelta = 0n;
    let quoteDelta = 0n;
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== transferTopic || !log.topics[1] || !log.topics[2]) continue;
      const from = log.topics[1].toLowerCase();
      const to = log.topics[2].toLowerCase();
      const amount = BigInt(log.data);
      if (log.address.toLowerCase() === asset.tokenAddress.toLowerCase()) {
        if (from === ownerTopic) assetDelta -= amount;
        if (to === ownerTopic) assetDelta += amount;
      }
      if (log.address.toLowerCase() === asset.quoteTokenAddress.toLowerCase()) {
        if (from === ownerTopic) quoteDelta -= amount;
        if (to === ownerTopic) quoteDelta += amount;
      }
    }
    return { assetDelta, quoteDelta };
  }
  const connection = new Connection(solanaRpcUrl, { commitment: "confirmed", fetch: solanaRpcFetch });
  const transaction = await connection.getTransaction(txHash, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const meta = transaction?.meta;
  if (!meta || meta.err) throw new Error("Confirmed Solana swap metadata is unavailable");
  const sumMint = (rows: typeof meta.preTokenBalances, mint: string) => (rows ?? [])
    .filter((row) => row.mint === mint && row.owner === owner)
    .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
  const tokenDelta = sumMint(meta.postTokenBalances, asset.tokenAddress) - sumMint(meta.preTokenBalances, asset.tokenAddress);
  const stableDelta = sumMint(meta.postTokenBalances, asset.quoteTokenAddress) - sumMint(meta.preTokenBalances, asset.quoteTokenAddress);
  return { assetDelta: tokenDelta, quoteDelta: stableDelta };
}

async function readEvmAllowance(provider: JsonRpcProvider, token: string, owner: string, spender: string): Promise<bigint> {
  const data = `0xdd62ed3e${owner.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}`;
  const result = await provider.call({ to: token, data });
  if (!/^0x[\da-f]{64}$/i.test(result)) fail("X Layer token allowance response is invalid");
  return BigInt(result);
}

function approvalDependency(symbol: string): string {
  return `approval_xlayer_${symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

async function checkEvmAllowance(
  asset: AssetConfig, token: string, symbol: string, decimals: number, owner: string,
  required: bigint, input: ExecutionInput, knownSpender?: string,
): Promise<string | null> {
  const dependency = approvalDependency(symbol);
  try {
    let spender = knownSpender;
    if (!spender) {
      const rows = await dexApproveTransaction<ApprovalTransaction[]>(new URLSearchParams({
        chainIndex: asset.chainIndex, tokenContractAddress: token, approveAmount: "1",
      }), input.dex);
      const approval = rows[0];
      if (!approval || !/^0x[\da-f]{40}$/i.test(approval.dexContractAddress ?? "")
        || !/^0x095ea7b3[\da-f]{128}$/i.test(approval.data ?? "")) {
        fail(`OKX returned an invalid ${symbol} approval spender`);
      }
      const spenderAddress = approval!.dexContractAddress!;
      if (approval!.data!.slice(34, 74).toLowerCase() !== spenderAddress.slice(2).toLowerCase()) {
        fail(`OKX returned inconsistent ${symbol} approval data`);
      }
      spender = spenderAddress;
    }
    const allowance = await readEvmAllowance(evmProvider(), token, owner, spender);
    if (allowance < required) {
      input.setHealth(dependency, "blocked", `${symbol} allowance for wallet ${owner} to OKX spender ${spender} is ${human(allowance, decimals).toString()}, below required ${human(required, decimals).toString()}. Manually grant unlimited allowance to this spender on X Layer.`);
      return null;
    }
    input.setHealth(dependency, "healthy");
    return spender;
  } catch (error) {
    input.setHealth(dependency, "unavailable", messageOf(error));
    return null;
  }
}

async function sendEvmCall(cycleId: number, asset: AssetConfig, wallet: Wallet, provider: JsonRpcProvider, to: string, data: string, purpose: string): Promise<string> {
  const network = await provider.getNetwork();
  if (network.chainId !== 196n) fail("Configured X Layer RPC is not chain ID 196");
  const feeData = await provider.getFeeData();
  const fee = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (fee === null) throw new Error("X Layer gas price is unavailable");
  const estimate = await provider.estimateGas({ from: wallet.address, to, data, value: 0n });
  const gasLimit = estimate * 120n / 100n;
  const balance = await provider.getBalance(wallet.address);
  if (balance < gasLimit * fee * 120n / 100n) fail("X Layer native balance is below the buffered transaction gas estimate");
  const txRequest = {
    to, data, value: 0n, chainId: 196n, nonce: await provider.getTransactionCount(wallet.address, "pending"), gasLimit,
    ...(feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null
      ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
      : { gasPrice: fee }),
  };
  const signed = await wallet.signTransaction(txRequest);
  const hash = keccak256(signed);
  await recordChainTx(cycleId, asset.chainIndex, purpose, hash, "SUBMITTED");
  await setCycle(cycleId, purpose === "swap" ? "DEX_SUBMITTED" : "APPROVAL_SUBMITTED", null, hash);
  try { await provider.broadcastTransaction(signed); } catch { /* The recorded hash is reconciled below; never sign and resend here. */ }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    if (receipt) {
      if (receipt.status !== 1) {
        await updateChainTx(hash, "FAILED");
        throw new Error(`X Layer ${purpose} transaction reverted (${hash})`);
      }
      await updateChainTx(hash, "CONFIRMED");
      return hash;
    }
    await sleep(1_000);
  }
  await updateChainTx(hash, "UNCERTAIN");
  throw new Error(`X Layer transaction confirmation is uncertain (${hash})`);
}

async function sendSolanaSwap(
  cycleId: number, asset: AssetConfig, owner: Keypair, bundle: SwapBundle, rpcUrl: string,
  expected: { fromToken: string; toToken: string; amount: bigint; maxSlippagePercent: number },
): Promise<string> {
  const connection = new Connection(rpcUrl, { commitment: "confirmed", fetch: solanaRpcFetch });
  const ownerAddress = owner.publicKey.toBase58();
  const quote = validateSolanaSwapQuote(bundle, ownerAddress, expected);
  const rentLimit = BigInt(await connection.getMinimumBalanceForRentExemption(165, "confirmed")) * 2n;
  let hasOkxRouter = false;
  const instructions = (bundle.instructionLists ?? []).map((item) => {
    const programId = item.programId;
    const data = item.data;
    const accountRows = item.accounts;
    if (!programId || !data || !Array.isArray(accountRows)) throw new Error("Solana DEX instruction is incomplete");
    const keys = accountRows.map((account) => {
      const pubkey = account.pubkey;
      if (!pubkey) throw new Error("Solana DEX instruction account is missing");
      if (account.isSigner && pubkey !== ownerAddress) throw new Error("Solana swap requires an unconfigured additional signer");
      return { pubkey: new PublicKey(pubkey), isSigner: account.isSigner === true, isWritable: account.isWritable === true };
    });
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Solana DEX instruction data is not base64");
    const bytes = Buffer.from(data, "base64");
    validateSolanaInstruction(programId, accountRows, bytes, ownerAddress, asset, rentLimit);
    if (programId === SOLANA_OKX_ROUTER) {
      if (!accountRows.some((account) => account.pubkey === ownerAddress && account.isSigner === true)) throw new Error("OKX Solana router instruction does not bind the configured signer");
      hasOkxRouter = true;
    }
    return new TransactionInstruction({ programId: new PublicKey(programId), keys, data: bytes });
  });
  if (!hasOkxRouter) fail("Solana swap does not call the pinned OKX router program");
  const lookupTables: AddressLookupTableAccount[] = [];
  for (const address of bundle.addressLookupTableAccount ?? []) {
    const result = await connection.getAddressLookupTable(new PublicKey(address), { commitment: "confirmed" });
    const table = result.value;
    if (!table) throw new Error("Solana address lookup table is unavailable");
    lookupTables.push(table);
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([owner]);
  const tokenSnapshots = await readSolanaSwapTokenSnapshots(
    connection, owner.publicKey, quote.fromMint, quote.toMint,
    quote.fromMint.toBase58() === asset.tokenAddress ? asset.tokenDecimals : asset.quoteTokenDecimals,
    quote.toMint.toBase58() === asset.tokenAddress ? asset.tokenDecimals : asset.quoteTokenDecimals,
  );
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed", sigVerify: true,
    accounts: { encoding: "base64", addresses: tokenSnapshots.map((account) => account.address.toBase58()) },
  });
  if (simulation.value.err) fail(`Solana swap simulation failed: ${JSON.stringify(simulation.value.err).slice(0, 300)}`);
  validateSolanaSwapSimulation(simulation.value.accounts, tokenSnapshots, owner.publicKey, expected.amount, quote.minOutput);
  const fee = await connection.getFeeForMessage(message, "confirmed");
  if (fee.value === null || BigInt(fee.value) > SOLANA_MAX_TX_FEE_LAMPORTS) fail("Solana transaction fee exceeds the 0.001 SOL safety limit");
  if (BigInt(await connection.getBalance(owner.publicKey, "confirmed")) < BigInt(fee.value!) * 2n) fail("Solana balance is below the buffered transaction fee estimate");
  const signatureBytes = transaction.signatures[0];
  if (!signatureBytes) throw new Error("Solana signed transaction has no owner signature");
  const signature = bs58.encode(signatureBytes);
  await recordChainTx(cycleId, asset.chainIndex, "swap", signature, "SUBMITTED");
  await setCycle(cycleId, "DEX_SUBMITTED", null, signature);
  try {
    await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmation.value.err) {
      await updateChainTx(signature, "FAILED");
      throw new Error(`Solana swap transaction failed (${signature})`);
    }
    await updateChainTx(signature, "CONFIRMED");
    return signature;
  } catch (error) {
    const status = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null);
    const observed = status?.value[0];
    if (observed?.confirmationStatus === "confirmed" || observed?.confirmationStatus === "finalized") {
      if (observed.err) {
        await updateChainTx(signature, "FAILED");
        throw new Error(`Solana swap transaction failed (${signature})`);
      }
      await updateChainTx(signature, "CONFIRMED");
      return signature;
    }
    await updateChainTx(signature, "UNCERTAIN");
    throw error;
  }
}

function validateSolanaSwapQuote(
  bundle: SwapBundle, owner: string,
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

async function readSolanaSwapTokenSnapshots(
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

function validateSolanaSwapSimulation(
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

function validateSolanaInstruction(programId: string, accounts: NonNullable<SolInstruction["accounts"]>, data: Buffer, owner: string, asset: AssetConfig, rentLimit: bigint): void {
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

async function placeIocOrder(credentials: Credentials, cycleId: number, clOrdId: string, instId: string, side: "buy" | "sell", size: Decimal, price: Decimal): Promise<CexOrder> {
  let ack: CexOrder | undefined;
  try {
    const rows = await okxPrivatePost<CexOrder[]>("/api/v5/trade/order", {
      instId, tdMode: "cash", clOrdId, side, ordType: "ioc", px: price.toString(), sz: size.toString(),
    }, credentials);
    ack = rows[0];
    if (ack?.sCode && ack.sCode !== "0") fail(`OKX order rejected: ${ack.sMsg ?? ack.sCode}`);
  } catch (error) {
    ack = await findOrder(credentials, instId, clOrdId).catch(() => undefined);
    if (!ack) fail(`OKX order acknowledgement is uncertain for ${clOrdId}: ${messageOf(error)}`);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const latest = await findOrder(credentials, instId, clOrdId).catch(() => undefined);
    if (latest) ack = latest;
    if (ack?.state === "filled" || ack?.state === "canceled" || ack?.state === "mmp_canceled") return ack;
    await sleep(500);
  }
  const current = await findOrder(credentials, instId, clOrdId).catch(() => undefined);
  if (current?.state === "live" || current?.state === "partially_filled") {
    for (let attempt = 0; attempt < 5; attempt++) {
      await okxPrivatePost("/api/v5/trade/cancel-order", { instId, clOrdId }, credentials).catch(() => undefined);
      const afterCancel = await findOrder(credentials, instId, clOrdId).catch(() => undefined);
      if (afterCancel?.state === "filled" || afterCancel?.state === "canceled" || afterCancel?.state === "mmp_canceled") return afterCancel;
      await sleep(500);
    }
    fail(`OKX IOC cancellation is uncertain for ${clOrdId}`);
  }
  return current ?? ack ?? fail(`OKX order state is uncertain for ${clOrdId}`);
}

async function findOrder(credentials: Credentials, instId: string, clOrdId: string): Promise<CexOrder | undefined> {
  const queryString = new URLSearchParams({ instId, clOrdId }).toString();
  const rows = await okxPrivateGet<CexOrder[]>(`/api/v5/trade/order?${queryString}`, credentials);
  return rows[0];
}

function maxCexBuyPrice(proceeds: string, gas: Decimal, shares: Decimal, feeRate: Decimal, tickSize: string): Decimal | null {
  const maximumCost = new Decimal(proceeds).minus(gas.mul("1.01")).div(new Decimal("1.01").mul(new Decimal(1).plus(feeRate)));
  if (!maximumCost.isFinite() || !maximumCost.gt(0) || !shares.gt(0)) return null;
  const tick = new Decimal(tickSize);
  const price = maximumCost.div(shares).div(tick).floor().mul(tick);
  return price.gt(0) ? price : null;
}

function minCexSellPrice(cost: string, gas: Decimal, shares: Decimal, feeRate: Decimal, tickSize: string): Decimal | null {
  const denominator = new Decimal(1).minus(new Decimal("1.01").mul(feeRate));
  if (!denominator.isFinite() || !denominator.gt(0) || !shares.isFinite() || !shares.gt(0)) return null;
  const minimumProceeds = new Decimal(cost).plus(gas).mul("1.01").div(denominator);
  if (!minimumProceeds.isFinite() || !minimumProceeds.gt(0)) return null;
  const tick = new Decimal(tickSize);
  const price = minimumProceeds.div(shares).div(tick).ceil().mul(tick);
  return price.gt(0) ? price : null;
}

async function createCycle(asset: AssetConfig, direction: string, netProfit: string, dexInput: string, dexOutput: string, cexSize: Decimal): Promise<number> {
  const clOrdId = `xa${Date.now().toString(36)}${randomBytes(6).toString("hex")}`.slice(0, 32);
  const result = await execute(
    "INSERT INTO trade_cycle (inst_id,chain_index,direction,status,client_order_id,dex_from_amount,dex_to_amount,cex_requested_size,expected_net_profit_usdt,reason) VALUES (?,?,?,'PREPARING',?,?,?,?,?,NULL)",
    [asset.instId, asset.chainIndex, direction, clOrdId, dexInput, dexOutput, cexSize.toString(), netProfit],
  );
  return result.insertId;
}

async function setCycle(id: number, status: string, reason: string | null, txHash?: string): Promise<void> {
  await execute("UPDATE trade_cycle SET status=?,reason=?,chain_tx_hash=COALESCE(?,chain_tx_hash) WHERE id=?", [status, reason?.slice(0, 500) ?? null, txHash ?? null, id]);
}

async function recordChainTx(cycleId: number, chainIndex: string, purpose: string, hash: string, status: string): Promise<void> {
  await execute("INSERT INTO trade_cycle_tx (trade_cycle_id,chain_index,purpose,tx_hash,status) VALUES (?,?,?,?,?)", [cycleId, chainIndex, purpose, hash, status]);
}

async function updateChainTx(hash: string, status: string): Promise<void> {
  await execute("UPDATE trade_cycle_tx SET status=? WHERE tx_hash=?", [status, hash]);
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
