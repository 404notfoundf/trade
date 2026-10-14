import Decimal from "decimal.js";
import type { AssetConfig, Config } from "../config.js";
import { bookStale, floorToStep, vwap, type Instrument } from "../market.js";
import { dexSwap, type Book, type Credentials } from "../okx.js";
import { decideValuation, XLAYER_CHAIN } from "../valuation.js";
import { netMarginOk, selectCall, swapTxError, type SwapTx, type UnsignedCall } from "./gates.js";

type RouterToken = { tokenContractAddress?: string; decimal?: string; taxRate?: string | number | null; isHoneyPot?: boolean };
type RouterResult = {
  chainIndex?: string;
  fromTokenAmount?: string;
  toTokenAmount?: string;
  fromToken?: RouterToken;
  toToken?: RouterToken;
  priceImpactPercentage?: string | number | null;
  priceImpactPercent?: string | null;
  tradeFee?: string;
  dexRouterList?: unknown[];
};
type SwapItem = { routerResult?: RouterResult; tx?: SwapTx };

export type TradeState = {
  routeStatus: "ENABLED" | "MONITOR_ONLY" | "BLOCKED";
  instrument?: Instrument;
  feeRate?: Decimal;
  multiplier?: Decimal;
  book?: Book;
};

export type PrepareInput = {
  wallet: string;
  tradeSizeUsdt: number;
  asset: AssetConfig;
  guardrails: Config["runtime"]["guardrails"];
  dex: Credentials;
  getState: () => TradeState;
};

export type PrepareResult = { ok: true; call: UnsignedCall; summary: string } | { ok: false; reason: string };

export type PrepareServices = {
  dexSwap: typeof dexSwap;
  decideValuation: typeof decideValuation;
  readAllowance: typeof readAllowance;
};

let busy = false;
const fail = (reason: string): PrepareResult => ({ ok: false, reason });
const same = (left: string | undefined, right: string) => left?.toLowerCase() === right.toLowerCase();
const defaultServices: PrepareServices = { dexSwap, decideValuation, readAllowance };

export async function prepareBuy(input: PrepareInput, services: PrepareServices = defaultServices): Promise<PrepareResult> {
  if (busy) return fail("已有一笔正在生成，请等它结束再点");
  busy = true;
  try {
    return await run(input, services);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "生成失败");
  } finally {
    busy = false;
  }
}

async function run(input: PrepareInput, services: PrepareServices): Promise<PrepareResult> {
  const { asset, guardrails } = input;
  if (asset.instId !== "XAAPL-USDT" || asset.chainIndex !== XLAYER_CHAIN) return fail("只准备 XAAPL 的 X Layer 买入");
  const state = input.getState();
  if (state.routeStatus !== "ENABLED") return fail("路线不是 ENABLED，充值网络未核验，拒绝生成");
  if (!state.instrument || !state.feeRate || !state.multiplier) return fail("OKX 合约、费率或 multiplier 未就绪");
  if (!state.book?.ready || bookStale(state.book)) return fail("OKX 盘口超过 2000 ms 或未就绪");
  if (![input.dex.key, input.dex.secret, input.dex.passphrase].every(Boolean)) return fail("DEX 凭证未配置");

  const amount = new Decimal(input.tradeSizeUsdt).mul(new Decimal(10).pow(asset.quoteTokenDecimals)).floor();
  if (!amount.gt(0)) return fail("买入数量无效");
  const slippage = String(guardrails.maxDexPriceImpactPercent);
  const rows = await services.dexSwap<SwapItem[]>(new URLSearchParams({
    chainIndex: asset.chainIndex,
    amount: amount.toFixed(0),
    fromTokenAddress: asset.quoteTokenAddress,
    toTokenAddress: asset.tokenAddress,
    slippagePercent: slippage,
    userWalletAddress: input.wallet,
    swapMode: "exactIn",
    swapReceiverAddress: input.wallet,
    priceImpactProtectionPercent: slippage,
  }), input.dex);
  const item = rows[0];
  const routerErrorText = routerError(item?.routerResult, asset, amount);
  if (routerErrorText) return fail(routerErrorText);
  const router = item!.routerResult!;
  if (router.fromToken?.isHoneyPot || router.toToken?.isHoneyPot || [router.fromToken?.taxRate, router.toToken?.taxRate].some((tax) => {
    if (tax === undefined || tax === null) return false;
    const parsed = parseDecimal(tax);
    return !parsed || parsed.isNegative() || parsed.gt(0);
  })) return fail("DEX 返回了代币税费或无效税费，拒绝生成可执行交易");
  const impact = parseDecimal(router.priceImpactPercentage ?? router.priceImpactPercent);
  if (!impact) return fail("DEX 价格影响缺失，拒绝生成");
  if (impact.abs().gt(guardrails.maxDexPriceImpactPercent)) return fail(`DEX 价格影响 ${impact.toString()}% 超过上限`);

  const afterSwap = input.getState();
  if (afterSwap.routeStatus !== "ENABLED" || !afterSwap.instrument || !afterSwap.feeRate || !afterSwap.multiplier) return fail("报价返回后路线或 OKX 状态已不可用");
  if (!afterSwap.book?.ready || bookStale(afterSwap.book)) return fail("报价返回后盘口已过期");
  const gasBase = router.tradeFee === undefined ? null : new Decimal(router.tradeFee);
  const gas = gasBase && gasBase.isFinite() && gasBase.gte(0) ? gasBase.mul(new Decimal(1).plus(new Decimal(asset.gasSafetyBufferPercent).div(100))) : null;
  if (!gas) return fail("Gas 未知，拒绝生成");
  const txError = swapTxError(item?.tx, input.wallet, guardrails.maxDexPriceImpactPercent, {
    fromToken: asset.quoteTokenAddress, toToken: asset.tokenAddress, amount, output: new Decimal(router.toTokenAmount!),
  });
  if (txError || !item?.tx?.to || !item.tx.data) return fail(txError ?? "swap tx 无效");
  const quoteAmount = new Decimal(router.fromTokenAmount!).div(new Decimal(10).pow(asset.quoteTokenDecimals));
  const maxAgeMs = guardrails.indexPriceMaxAgeSeconds * 1000;
  const allowance = await services.readAllowance(asset.quoteTokenAddress, input.wallet, item.tx.to);
  if (!allowance) return fail("USDT0 allowance 查询失败，拒绝生成");

  const latest = input.getState();
  if (latest.routeStatus !== "ENABLED" || !latest.instrument || !latest.feeRate || !latest.multiplier) return fail("估值返回后路线或 OKX 状态已不可用");
  if (!latest.book?.ready || bookStale(latest.book)) return fail("估值返回后盘口已过期");
  const bought = new Decimal(router.toTokenAmount!).div(new Decimal(10).pow(asset.tokenDecimals));
  const shares = floorToStep(bought.mul(latest.multiplier), latest.instrument.lotSz);
  const fill = vwap(latest.book.bids, shares);
  if (!fill || shares.lt(latest.instrument.minSz)) return fail("CEX 深度不够，拒绝生成");

  const now = Date.now();
  const decision = services.decideValuation({
    chainIndex: asset.chainIndex, quoteTokenAddress: asset.quoteTokenAddress, direction: "dex_buy_cex_sell", quoteAmount,
    cexCost: fill.notional, cexFee: fill.notional.mul(latest.feeRate), gasUsdt: gas, now, maxAgeMs,
    maxUsdtUsdDeviationPercent: guardrails.maxUsdtUsdDeviationPercent, maxUsdt0UsdtDeviationPercent: guardrails.maxUsdt0UsdtDeviationPercent,
  });
  if (decision.valuationStatus !== "VERIFIED" || !decision.usdtLeg || !decision.netProfitUsdt) return fail(decision.reason ?? "估值不是 VERIFIED，拒绝生成");
  const net = new Decimal(decision.netProfitUsdt);
  const invested = new Decimal(decision.usdtLeg);
  if (!netMarginOk(net, invested)) return fail(`扣完费用后净边际 ${net.div(invested).mul(100).toFixed(4)}% 低于 1% 入账缓冲`);
  const picked = selectCall({ allowance, required: amount, quoteToken: asset.quoteTokenAddress, swapTo: item.tx.to, swapData: item.tx.data });
  const call: UnsignedCall = { ...picked, chainId: "196", amount: amount.toFixed(0), slippagePercent: slippage, receiver: input.wallet };
  return { ok: true, call, summary: `净边际 ${net.div(invested).mul(100).toFixed(4)}%；CEX 可卖 ${shares.toString()} 股等值。1% 是入账等待缓冲，不含充值费和再平衡。${decision.quoteSummary ?? ""}` };
}

function routerError(router: RouterResult | undefined, asset: AssetConfig, amount: Decimal): string | null {
  if (!router || router.chainIndex !== asset.chainIndex || !Array.isArray(router.dexRouterList) || router.dexRouterList.length === 0) return "swap 路径缺失或链不匹配";
  if (!same(router.fromToken?.tokenContractAddress, asset.quoteTokenAddress) || !same(router.toToken?.tokenContractAddress, asset.tokenAddress)) return "swap 代币与固定配置不符";
  if (router.fromToken?.decimal !== undefined && Number(router.fromToken.decimal) !== asset.quoteTokenDecimals) return "swap 报价币精度不符";
  if (router.toToken?.decimal !== undefined && Number(router.toToken.decimal) !== asset.tokenDecimals) return "swap 代币精度不符";
  try {
    const input = new Decimal(router.fromTokenAmount ?? "NaN");
    const output = new Decimal(router.toTokenAmount ?? "NaN");
    if (!input.isFinite() || !input.eq(amount) || !output.isFinite() || !output.gt(0)) return "swap 数量与请求不符";
  } catch {
    return "swap 数量无法解析";
  }
  return null;
}

function parseDecimal(value: string | number | null | undefined): Decimal | null {
  if (value === undefined || value === null) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

async function readAllowance(token: string, owner: string, spender: string): Promise<Decimal | null> {
  const data = `0xdd62ed3e${owner.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}`;
  const response = await fetch(process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const json = await response.json() as { result?: string };
  if (!json.result || !/^0x[\da-f]+$/i.test(json.result)) return null;
  return new Decimal(BigInt(json.result).toString());
}
