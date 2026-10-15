import Decimal from "decimal.js";

const ADDRESS = /^0x[\da-f]{40}$/i;
const CALLDATA = /^0x(?:[\da-f]{2}){4,}$/i;
const SMART_SWAP_BY_ORDER_ID = "f2c42696";
// shortcut: pin the current official X Layer router; update this after an OKX router upgrade.
export const XLAYER_DEX_ROUTER = "0x7c5bee2a8091c3ef39072f64f18fac913060aeaf";

export type SwapTx = {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  signatureData?: unknown;
  slippagePercent?: string;
  minReceiveAmount?: string;
  swapReceiverAddress?: string;
};

export type UnsignedCall = {
  kind: "approve" | "swap";
  to: string;
  data: string;
  value: "0";
  chainId: "196";
  amount: string;
  slippagePercent: string;
  receiver: string;
};

export function netMarginOk(netProfit: Decimal, invested: Decimal): boolean {
  return invested.gt(0) && netProfit.isFinite() && netProfit.div(invested).gte("0.01");
}

export function swapTxError(tx: SwapTx | undefined, wallet: string, maxSlippagePercent: number, expected: { fromToken: string; toToken: string; amount: Decimal; output: Decimal }): string | null {
  if (!tx) return "swap 响应没有 tx";
  if (!ADDRESS.test(tx.from ?? "") || tx.from!.toLowerCase() !== wallet.toLowerCase()) return "swap tx.from 不是配置的钱包";
  if (!ADDRESS.test(tx.to ?? "")) return "swap tx.to 不是地址";
  if (tx.to!.toLowerCase() !== XLAYER_DEX_ROUTER.toLowerCase()) return "swap tx.to 不是已核验的 X Layer Router";
  if (!tx.data || !CALLDATA.test(tx.data)) return "swap tx.data 缺失";
  if (tx.swapReceiverAddress && tx.swapReceiverAddress.toLowerCase() !== wallet.toLowerCase()) return "swap 收款人不是配置的钱包";
  try {
    if (tx.value === undefined || tx.value.includes("x") || !new Decimal(tx.value).eq(0)) return "swap tx.value 必须为 0";
  } catch {
    return "swap tx.value 必须为 0";
  }
  const slippage = parseDecimal(tx.slippagePercent);
  if (!slippage || slippage.lt(0)) return "swap 滑点缺失或无法解析";
  if (!Number.isFinite(maxSlippagePercent) || maxSlippagePercent < 0 || maxSlippagePercent > 100 || slippage.gt(maxSlippagePercent)) return "swap 滑点比配置更松";
  if (!expected.amount.isFinite() || !expected.amount.isInteger() || !expected.amount.gt(0) || !expected.output.isFinite() || !expected.output.isInteger() || !expected.output.gt(0)) return "swap 报价数量无效";
  const minimumOutput = tx.minReceiveAmount;
  if (!minimumOutput || !/^\d+$/.test(minimumOutput)) return "swap 最低输出数量无效";
  if (tx.data.slice(2, 10).toLowerCase() !== SMART_SWAP_BY_ORDER_ID) return "swap calldata 方法不受支持";
  const words = Array.from({ length: 5 }, (_, index) => tx.data!.slice(10 + index * 64, 10 + (index + 1) * 64).toLowerCase());
  if (words.some((word) => !/^[\da-f]{64}$/.test(word))) return "swap calldata 参数缺失";
  const fromToken = words[1]!;
  const toToken = words[2]!;
  if (fromToken !== expected.fromToken.slice(2).toLowerCase().padStart(64, "0") || toToken !== expected.toToken.slice(2).toLowerCase().padStart(64, "0")) return "swap calldata 代币与报价不符";
  if (BigInt(`0x${words[3]}`) !== BigInt(expected.amount.toFixed(0))) return "swap calldata 输入数量与报价不符";
  const calldataMinimum = BigInt(`0x${words[4]}`);
  if (calldataMinimum !== BigInt(minimumOutput)) return "swap 最低输出与 calldata 不符";
  const safeMinimum = expected.output.mul(new Decimal(100).minus(slippage)).div(100).floor();
  if (new Decimal(minimumOutput).lt(safeMinimum) || new Decimal(minimumOutput).gt(expected.output)) return "swap 最低输出数量不符合滑点上限";
  if (tx.signatureData !== undefined && !(Array.isArray(tx.signatureData) && tx.signatureData.length === 0)) {
    return "swap 需要额外签名数据，拒绝展示";
  }
  return null;
}

function parseDecimal(value: string | undefined): Decimal | null {
  if (value === undefined) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

export function encodeApprove(spender: string, amount: Decimal): string {
  return `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, "0")}${BigInt(amount.toFixed(0)).toString(16).padStart(64, "0")}`;
}

export function selectCall(input: { allowance: Decimal; required: Decimal; quoteToken: string; spender: string; swapTo: string; swapData: string }): Pick<UnsignedCall, "kind" | "to" | "data" | "value"> {
  if (input.allowance.gte(input.required)) return { kind: "swap", to: input.swapTo, data: input.swapData, value: "0" };
  // shortcut: tokens requiring approve(0) still need a separate reset transaction; add it after confirming the token's behavior.
  return { kind: "approve", to: input.quoteToken, data: encodeApprove(input.spender, input.required), value: "0" };
}
