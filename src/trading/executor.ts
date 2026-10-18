import { randomBytes } from "node:crypto";
import Decimal from "decimal.js";
import bs58 from "bs58";
import { JsonRpcProvider, Wallet, keccak256 } from "ethers";
import {
  AddressLookupTableAccount, Connection, Keypair, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import type { AssetConfig, Config } from "../config.js";
import type { QuoteObservation } from "../observations.js";
import { execute, query, withNamedLock } from "../db.js";
import { solanaRpcFetch } from "../solana-rpc-logging.js";
import { bookStale, floorToStep, vwap, type Instrument } from "../market/market.js";
import {
  dexApproveTransaction, dexSolanaSwapInstructions, dexSwap, okxPrivateGet, okxPrivatePost,
  type Book, type Credentials,
} from "../market/okx.js";
import { decideValuation, SOLANA_CHAIN, XLAYER_CHAIN } from "../market/valuation.js";
import { netMarginOk, swapTxError, type SwapTx } from "./gates.js";
import { recoverCycle, type CexOrderIntent, type RecoveryCycle, type RecoveryDecision, type RecoveryOrder } from "./recovery.js";
import { persistBeforeSubmit } from "./persist-before-submit.js";
import { logger } from "../logger.js";
import { evmProvider, okxAvailable, readChainBalances, readEvmAllowance, readSwapDeltas, signer } from "./balance-reader.js";
import { readSolanaSwapTokenSnapshots, validateSolanaInstruction, validateSolanaSwapQuote, validateSolanaSwapSimulation, SOLANA_ASSOCIATED_TOKEN, SOLANA_COMPUTE_BUDGET, SOLANA_OKX_ROUTER } from "./solana-swap-validation.js";

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
type CexOrder = {
  ordId?: string; clOrdId?: string; instId?: string; side?: string; sz?: string; px?: string; cTime?: string;
  sCode?: string; sMsg?: string; state?: string; accFillSz?: string; avgPx?: string;
};
type RecoveryCycleRow = {
  id: number; status: string; inst_id: string; chain_index: string;
  direction: "cex_buy_dex_sell" | "dex_buy_cex_sell"; client_order_id: string | null;
  cex_order_intent: unknown; chain_tx_hash: string | null;
};
type ApprovalTransaction = { dexContractAddress?: string; data?: string };
type ExecutionInput = {
  enabled: boolean; armed: () => boolean; tradeSizeUsdt: number; maxTradeSizeUsdt: number;
  assets: AssetConfig[]; recoveryAssets: AssetConfig[]; okx: Credentials; dex: Credentials;
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
const SOLANA_MAX_TX_FEE_LAMPORTS = 1_000_000n;
const fail = (message: string): never => { throw new Error(message); };

function recoveryCycle(row: RecoveryCycleRow): RecoveryCycle {
  return {
    id: row.id, status: row.status, instId: row.inst_id, chainIndex: row.chain_index,
    direction: row.direction, chainTxHash: row.chain_tx_hash, clientOrderId: row.client_order_id,
    cexOrderIntent: parseCexOrderIntent(row.cex_order_intent),
  };
}

function parseCexOrderIntent(value: unknown): CexOrderIntent | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.instId !== "string" || typeof parsed.clOrdId !== "string"
      || (parsed.side !== "buy" && parsed.side !== "sell") || typeof parsed.sz !== "string" || typeof parsed.px !== "string"
      || typeof parsed.dexAssetDeltaRaw !== "string" || !/^-?\d+$/.test(parsed.dexAssetDeltaRaw)
      || typeof parsed.dexQuoteDeltaRaw !== "string" || !/^-?\d+$/.test(parsed.dexQuoteDeltaRaw)) return null;
    return {
      instId: parsed.instId, clOrdId: parsed.clOrdId, side: parsed.side, sz: parsed.sz, px: parsed.px,
      dexAssetDeltaRaw: parsed.dexAssetDeltaRaw, dexQuoteDeltaRaw: parsed.dexQuoteDeltaRaw,
      preparedAt: typeof parsed.preparedAt === "string" ? parsed.preparedAt : undefined,
    };
  } catch { return null; }
}

async function findOrderForRecovery(credentials: Credentials, cycle: RecoveryCycle): Promise<CexOrder | null> {
  const intent = cycle.cexOrderIntent;
  const instId = intent?.instId ?? cycle.instId;
  const clOrdId = intent?.clOrdId ?? cycle.clientOrderId;
  if (!clOrdId) return null;
  const base = new URLSearchParams({ instId, clOrdId });
  const history = new URLSearchParams({ instType: "SPOT", instId, ordType: "ioc", clOrdId });
  let succeeded = false;
  let lastError: unknown;
  for (const path of [
    `/api/v5/trade/order?${base}`,
    `/api/v5/trade/orders-history?${history}`,
    `/api/v5/trade/orders-history-archive?${history}`,
  ]) {
    try {
      const rows = await okxPrivateGet<CexOrder[]>(path, credentials);
      succeeded = true;
      const notBefore = intent?.preparedAt ? Date.parse(intent.preparedAt) - 5 * 60_000 : undefined;
      const order = rows.find((row) => row.clOrdId === clOrdId && row.instId === instId
        && (notBefore === undefined || (Number.isFinite(Number(row.cTime)) && Number(row.cTime) >= notBefore)));
      if (order) return order;
    } catch (error) { lastError = error; }
  }
  if (!succeeded && lastError) throw lastError;
  return null;
}

async function inspectChainTransaction(chainIndex: string, txHash: string, solanaRpcUrl: string): Promise<"confirmed" | "failed" | "pending" | "unknown"> {
  if (chainIndex === XLAYER_CHAIN) {
    const provider = evmProvider();
    const [receipt, transaction] = await Promise.all([
      provider.getTransactionReceipt(txHash), provider.getTransaction(txHash),
    ]);
    if (receipt) return receipt.status === 1 ? "confirmed" : "failed";
    return transaction ? "pending" : "unknown";
  }
  if (chainIndex === SOLANA_CHAIN) {
    const connection = new Connection(solanaRpcUrl, { commitment: "confirmed", fetch: solanaRpcFetch });
    const result = await connection.getSignatureStatuses([txHash], { searchTransactionHistory: true });
    const status = result.value[0];
    if (!status) return "unknown";
    if (status.err) return "failed";
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? "confirmed" : "pending";
  }
  return "unknown";
}

async function persistRecoveryDecision(cycleId: number, txHash: string | null, decision: RecoveryDecision): Promise<void> {
  if (txHash && decision.chainStatus) {
    const txStatus = decision.chainStatus === "confirmed" ? "CONFIRMED" : decision.chainStatus === "failed" ? "FAILED" : "UNCERTAIN";
    await execute("UPDATE trade_cycle_tx SET status=? WHERE tx_hash=? AND purpose='swap'", [txStatus, txHash]);
  }
  await execute(
    `UPDATE trade_cycle SET status=?,reason=?,cex_order_id=COALESCE(?,cex_order_id),
       cex_order_state=COALESCE(?,cex_order_state),cex_filled_size=COALESCE(?,cex_filled_size),
       cex_average_price=COALESCE(?,cex_average_price),
       dex_actual_asset_delta_raw=COALESCE(?,dex_actual_asset_delta_raw),
       dex_actual_quote_delta_raw=COALESCE(?,dex_actual_quote_delta_raw),recovery_checked_at=UTC_TIMESTAMP(3)
     WHERE id=? AND status NOT IN ('COMPLETE','FAILED','RECONCILED')`,
    [decision.status, decision.reason.slice(0, 500), decision.order?.ordId ?? null, decision.order?.state ?? null,
      decision.order?.accFillSz ?? null, decision.order?.avgPx ?? null, decision.assetDeltaRaw ?? null,
      decision.quoteDeltaRaw ?? null, cycleId],
  );
}

export function createTradeExecutor(input: ExecutionInput): { tick: () => Promise<void>; checkApprovals: () => Promise<void>; recover: () => Promise<boolean> } {
  const lastScanAt = new Map<string, number>();
  let localRunning = false;
  let recoveryReady = false;
  let recoveryRunning = false;
  return {
    recover: async () => {
      if (recoveryReady) return true;
      if (!input.dbReady() || recoveryRunning) return false;
      recoveryRunning = true;
      try {
        const result = await withNamedLock("xaapl_trade_execution", async () => {
          const cycles = await query<Array<RecoveryCycleRow>>(
            `SELECT c.id,c.status,c.inst_id,c.chain_index,c.direction,c.client_order_id,c.cex_order_intent,
                    COALESCE(c.chain_tx_hash,tx.tx_hash) chain_tx_hash
             FROM trade_cycle c LEFT JOIN trade_cycle_tx tx ON tx.trade_cycle_id=c.id AND tx.purpose='swap'
             WHERE c.status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY c.id`,
          );
          if (!cycles.length) {
            recoveryReady = true;
            input.setHealth("trade_execution", "healthy", "No incomplete trade cycles need recovery");
            return true;
          }

          recoveryReady = false;
          input.pause();
          for (const row of cycles) {
            const cycle = recoveryCycle(row);
            let decision;
            try {
              const asset = input.recoveryAssets.find((item) => item.instId === row.inst_id && item.chainIndex === row.chain_index);
              decision = await recoverCycle(cycle, {
                chainStatus: (chainIndex, txHash) => inspectChainTransaction(chainIndex, txHash, input.signers.solanaRpcUrl),
                swapDeltas: async (pending) => {
                  if (!asset) throw new Error("Asset configuration for the incomplete trade cycle is unavailable");
                  const wallet = signer(asset.chainIndex, input.signers.xlayerPrivateKey, input.signers.solanaPrivateKey);
                  if (!wallet) throw new Error("Wallet signer is unavailable to verify the recorded chain transaction");
                  return readSwapDeltas(asset, pending.chainTxHash!, wallet.address, input.signers.solanaRpcUrl);
                },
                cexOrder: (pending) => findOrderForRecovery(input.okx, pending),
              });
            } catch (error) {
              decision = { status: "RECOVERY_REQUIRED" as const, reason: messageOf(error).slice(0, 500) };
            }
            await persistRecoveryDecision(row.id, cycle.chainTxHash, decision);
          }

          const remaining = await query<Array<{ id: number; status: string }>>(
            "SELECT id,status FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id LIMIT 1",
          );
          if (remaining[0]) {
            input.setHealth("trade_execution", remaining[0].status === "HEDGE_REQUIRED" ? "blocked" : "reconciling", `Trade cycle ${remaining[0].id} requires ${remaining[0].status}; automatic trading remains paused`);
            return false;
          }
          recoveryReady = true;
          input.setHealth("trade_execution", "healthy", "Trade-cycle recovery completed");
          return true;
        });
        if (result === null) {
          input.setHealth("trade_execution", "busy", "Another process holds the trade execution lock; recovery is pending");
          return false;
        }
        return result;
      } catch (error) {
        recoveryReady = false;
        input.pause();
        input.setHealth("trade_execution", "blocked", `Trade-cycle recovery failed: ${messageOf(error)}`);
        logger.error("Trade-cycle recovery failed", error);
        return false;
      } finally { recoveryRunning = false; }
    },
    tick: async () => {
      if (!input.enabled || !input.armed() || !input.dbReady() || !recoveryReady || localRunning) return;
      localRunning = true;
      try {
        const acquired = await withNamedLock("xaapl_trade_execution", async () => {
          const active = await query<Array<{ id: number; status: string }>>(
            "SELECT id,status FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id DESC LIMIT 1",
          );
          if (active[0]) {
            recoveryReady = false;
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
  const cycleId = await createCycle(asset, "cex_buy_dex_sell", gate.decision.netProfitUsdt!, gate.quoteInput, gate.quoteOutput, gate.shares,
    createExecutionIntent(asset, "cex_buy_dex_sell", bundle, quoteState, gate.quoteInput, gate.quoteOutput, gate.shares, gate.decision.netProfitUsdt!));
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
    await persistSwapDeltas(cycleId, deltas);
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
      cexFeeSource: "cex_fee_rate", networkFeeSource: "pretrade_gas_quote_estimate",
      now, maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    if (decision.valuationStatus !== "VERIFIED" || !decision.netProfitUsdt || !decision.capitalAtRiskUsdt
      || !netMarginOk(new Decimal(decision.netProfitUsdt), new Decimal(decision.capitalAtRiskUsdt))) {
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
    const order = await persistBeforeSubmit(
      () => persistCexOrderIntent(cycleId, txHash, {
        version: 1, instId: asset.instId, tdMode: "cash", clOrdId, side: "buy", ordType: "ioc",
        px: limitPrice.toString(), sz: actualShares.toString(), bookExchangeTime: latestBook.exchangeTime,
        bookReceivedAt: latestBook.receivedAt, bookSeqId: latestBook.seqId,
        dexAssetDeltaRaw: deltas.assetDelta.toString(), dexQuoteDeltaRaw: deltas.quoteDelta.toString(), preparedAt: new Date().toISOString(),
      }),
      () => placeIocOrder(input.okx, cycleId, clOrdId, asset.instId, "buy", actualShares, limitPrice),
    );
    await persistCexOrderResult(cycleId, order);
    const filled = new Decimal(order.accFillSz ?? "0");
    const avgPrice = order.avgPx ? new Decimal(order.avgPx) : null;
    if (!filled.eq(actualShares) || order.state !== "filled" || !avgPrice?.isFinite()) {
      await setCycle(cycleId, "HEDGE_REQUIRED", `CEX IOC ended ${order.state ?? "unknown"} with ${filled.toString()} of ${actualShares.toString()} shares filled`, txHash);
      input.setHealth("trade_execution", "blocked", `Trade cycle ${cycleId} has an unmatched position; manual reconciliation required`);
      return true;
    }
    const actualCost = filled.mul(avgPrice);
    const finalDecision = decideValuation({
      chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "cex_buy_dex_sell",
      quoteAmount: outputHuman, cexCost: actualCost, cexFee: actualCost.mul(latest.feeRate), gasUsdt,
      cexFeeSource: "cex_fee_rate", networkFeeSource: "pretrade_gas_quote_estimate",
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
    const currentCycle = await query<Array<{ status: string }>>("SELECT status FROM trade_cycle WHERE id=?", [cycleId]).catch(() => null);
    const chainRows = await query<Array<{ purpose: string; status: string }>>(
      "SELECT purpose,status FROM trade_cycle_tx WHERE trade_cycle_id=?", [cycleId],
    ).catch(() => null);
    const status = currentCycle?.[0]?.status === "CEX_SUBMITTED" ? "RECOVERY_REQUIRED" : chainRows === null
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
  const cycleId = await createCycle(asset, "dex_buy_cex_sell", gate.decision.netProfitUsdt!, gate.quoteInput, gate.quoteOutput, gate.shares,
    createExecutionIntent(asset, "dex_buy_cex_sell", bundle, quoteState, gate.quoteInput, gate.quoteOutput, gate.shares, gate.decision.netProfitUsdt!));
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
    await persistSwapDeltas(cycleId, deltas);
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
      cexFeeSource: "cex_fee_rate", networkFeeSource: "pretrade_gas_quote_estimate",
      now, maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    if (decision.valuationStatus !== "VERIFIED" || !decision.usdtLeg || !decision.netProfitUsdt || !decision.capitalAtRiskUsdt
      || !netMarginOk(new Decimal(decision.netProfitUsdt), new Decimal(decision.capitalAtRiskUsdt))) {
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
    const order = await persistBeforeSubmit(
      () => persistCexOrderIntent(cycleId, txHash, {
        version: 1, instId: asset.instId, tdMode: "cash", clOrdId, side: "sell", ordType: "ioc",
        px: limitPrice.toString(), sz: actualShares.toString(), bookExchangeTime: latestBook.exchangeTime,
        bookReceivedAt: latestBook.receivedAt, bookSeqId: latestBook.seqId,
        dexAssetDeltaRaw: deltas.assetDelta.toString(), dexQuoteDeltaRaw: deltas.quoteDelta.toString(), preparedAt: new Date().toISOString(),
      }),
      () => placeIocOrder(input.okx, cycleId, clOrdId, asset.instId, "sell", actualShares, limitPrice),
    );
    await persistCexOrderResult(cycleId, order);
    const filled = new Decimal(order.accFillSz ?? "0");
    const avgPrice = order.avgPx ? new Decimal(order.avgPx) : null;
    if (!filled.eq(actualShares) || order.state !== "filled" || !avgPrice?.isFinite()) {
      await setCycle(cycleId, "HEDGE_REQUIRED", "CEX IOC ended " + (order.state ?? "unknown") + " with " + filled.toString() + " of " + actualShares.toString() + " shares filled", txHash);
      input.setHealth("trade_execution", "blocked", "Trade cycle " + cycleId + " has an unmatched position; manual reconciliation required");
      return true;
    }
    const finalDecision = decideValuation({
      chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "dex_buy_cex_sell",
      quoteAmount: quoteSpentHuman, cexCost: filled.mul(avgPrice), cexFee: filled.mul(avgPrice).mul(latest.feeRate), gasUsdt,
      cexFeeSource: "cex_fee_rate", networkFeeSource: "pretrade_gas_quote_estimate",
      now: Date.now(), maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
      maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
    });
    if (finalDecision.valuationStatus !== "VERIFIED" || !finalDecision.netProfitUsdt || !finalDecision.capitalAtRiskUsdt
      || !netMarginOk(new Decimal(finalDecision.netProfitUsdt), new Decimal(finalDecision.capitalAtRiskUsdt))) {
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
    const currentCycle = await query<Array<{ status: string }>>("SELECT status FROM trade_cycle WHERE id=?", [cycleId]).catch(() => null);
    const chainRows = await query<Array<{ purpose: string; status: string }>>(
      "SELECT purpose,status FROM trade_cycle_tx WHERE trade_cycle_id=?", [cycleId],
    ).catch(() => null);
    const status = currentCycle?.[0]?.status === "CEX_SUBMITTED" ? "RECOVERY_REQUIRED" : chainRows === null
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
    cexFeeSource: "cex_fee_rate", networkFeeSource: "aggregator_trade_fee_estimate+safety_buffer",
    now, maxAgeMs, maxUsdtUsdDeviationPercent: input.guardrails.maxUsdtUsdDeviationPercent,
    maxUsdt0UsdtDeviationPercent: input.guardrails.maxUsdt0UsdtDeviationPercent,
  });
  if (decision.valuationStatus !== "VERIFIED" || !decision.netProfitUsdt || !decision.capitalAtRiskUsdt
    || !netMarginOk(new Decimal(decision.netProfitUsdt), new Decimal(decision.capitalAtRiskUsdt))) return null;
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

function createExecutionIntent(
  asset: AssetConfig, direction: string, bundle: SwapBundle, state: ExecutionState,
  dexInput: string, dexOutput: string, cexSize: Decimal, netProfit: string,
): string {
  return JSON.stringify({
    version: 1, recordedAt: new Date().toISOString(), instId: asset.instId, chainIndex: asset.chainIndex, direction,
    expected: { dexInput, dexOutput, cexSize: cexSize.toString(), netProfitUsdt: netProfit },
    dexQuote: {
      fromToken: bundle.routerResult?.fromToken?.tokenContractAddress,
      toToken: bundle.routerResult?.toToken?.tokenContractAddress,
      fromTokenAmount: bundle.routerResult?.fromTokenAmount,
      toTokenAmount: bundle.routerResult?.toTokenAmount,
      priceImpactPercent: bundle.routerResult?.priceImpactPercent ?? bundle.routerResult?.priceImpactPercentage,
    },
    market: {
      multiplier: state.multiplier?.toString(), feeRate: state.feeRate?.toString(),
      book: state.book && { exchangeTime: state.book.exchangeTime, receivedAt: state.book.receivedAt, seqId: state.book.seqId },
    },
  });
}

async function createCycle(asset: AssetConfig, direction: string, netProfit: string, dexInput: string, dexOutput: string, cexSize: Decimal, executionIntent: string): Promise<number> {
  const clOrdId = `xa${Date.now().toString(36)}${randomBytes(6).toString("hex")}`.slice(0, 32);
  const result = await execute(
    "INSERT INTO trade_cycle (inst_id,chain_index,direction,status,client_order_id,dex_from_amount,dex_to_amount,cex_requested_size,expected_net_profit_usdt,execution_intent,reason) VALUES (?,?,?,'PREPARING',?,?,?,?,?,?,NULL)",
    [asset.instId, asset.chainIndex, direction, clOrdId, dexInput, dexOutput, cexSize.toString(), netProfit, executionIntent],
  );
  return result.insertId;
}

async function persistSwapDeltas(cycleId: number, deltas: { assetDelta: bigint; quoteDelta: bigint }): Promise<void> {
  await execute("UPDATE trade_cycle SET dex_actual_asset_delta_raw=?,dex_actual_quote_delta_raw=? WHERE id=?", [
    deltas.assetDelta.toString(), deltas.quoteDelta.toString(), cycleId,
  ]);
}

async function persistCexOrderIntent(cycleId: number, txHash: string, intent: CexOrderIntent & {
  version: 1; tdMode: "cash"; ordType: "ioc"; bookExchangeTime: number; bookReceivedAt: number; bookSeqId: number; preparedAt: string;
}): Promise<void> {
  const result = await execute(
    `UPDATE trade_cycle SET cex_order_intent=?,cex_order_side=?,cex_order_limit_price=?,cex_requested_size=?,
       cex_order_state='SUBMITTING',status='CEX_SUBMITTED',reason=NULL,chain_tx_hash=COALESCE(?,chain_tx_hash)
     WHERE id=? AND status='DEX_CONFIRMED' AND cex_order_intent IS NULL`,
    [JSON.stringify(intent), intent.side, intent.px, intent.sz, txHash, cycleId],
  );
  if (result.affectedRows !== 1) throw new Error(`CEX order intent was not persisted for trade cycle ${cycleId}`);
}

async function persistCexOrderResult(cycleId: number, order: CexOrder): Promise<void> {
  await execute(
    `UPDATE trade_cycle SET cex_order_id=?,cex_order_state=?,cex_filled_size=?,cex_average_price=? WHERE id=?`,
    [order.ordId ?? null, order.state ?? null, order.accFillSz ?? "0", order.avgPx ?? null, cycleId],
  );
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
