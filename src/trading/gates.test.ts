import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { encodeApprove, netMarginOk, selectCall, swapTxError, XLAYER_DEX_ROUTER, type SwapTx } from "./gates.js";

const wallet = "0x1111111111111111111111111111111111111111";
const router = XLAYER_DEX_ROUTER;
const token = "0x3333333333333333333333333333333333333333";
const outputToken = "0x4444444444444444444444444444444444444444";
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const calldata = (minimum: string) => `0xf2c42696${word(0n)}${word(BigInt(token))}${word(BigInt(outputToken))}${word(1000n)}${word(BigInt(minimum))}`;
const expected = { fromToken: token, toToken: outputToken, amount: new Decimal("1000"), output: new Decimal("1000") };
const tx = (patch: Partial<SwapTx> = {}): SwapTx => {
  const minimum = patch.minReceiveAmount ?? "980";
  return { from: wallet, to: router, data: calldata(minimum), value: "0", slippagePercent: "2", minReceiveAmount: minimum, ...patch };
};

test("net margin of exactly 1 percent passes and less does not", () => {
  assert.equal(netMarginOk(new Decimal("1"), new Decimal("100")), true);
  assert.equal(netMarginOk(new Decimal("0.9999"), new Decimal("100")), false);
  assert.equal(netMarginOk(new Decimal("1"), new Decimal("0")), false);
});

test("non-zero value and signature data are refused", () => {
  assert.equal(swapTxError(tx(), wallet, 2, expected), null);
  assert.equal(swapTxError(tx({ value: "1" }), wallet, 2, expected), "swap tx.value 必须为 0");
  assert.equal(swapTxError(tx({ signatureData: [] }), wallet, 2, expected), null);
  assert.equal(swapTxError(tx({ signatureData: ["0x1"] }), wallet, 2, expected), "swap 需要额外签名数据，拒绝展示");
  assert.equal(swapTxError(tx({ from: wallet.toUpperCase() }), wallet, 2, expected), null);
});

test("swap target and actual minimum output are constrained", () => {
  assert.equal(swapTxError(tx({ to: "0x2222222222222222222222222222222222222222" }), wallet, 2, expected), "swap tx.to 不是已核验的 X Layer Router");
  assert.equal(swapTxError(tx({ minReceiveAmount: "979" }), wallet, 2, expected), "swap 最低输出数量不符合滑点上限");
  assert.equal(swapTxError(tx({ minReceiveAmount: "1001" }), wallet, 2, expected), "swap 最低输出数量不符合滑点上限");
  assert.equal(swapTxError(tx({ minReceiveAmount: "980" }), wallet, 2, expected), null);
  assert.equal(swapTxError(tx({ data: calldata("1") }), wallet, 2, expected), "swap 最低输出与 calldata 不符");
  assert.equal(swapTxError(tx({ data: "0xabcdef12" }), wallet, 2, expected), "swap calldata 方法不受支持");
});

test("invalid or missing slippage metadata is refused", () => {
  assert.notEqual(swapTxError(tx({ slippagePercent: undefined }), wallet, 2, expected), null);
  assert.notEqual(swapTxError(tx({ slippagePercent: "NaN" }), wallet, 2, expected), null);
  assert.notEqual(swapTxError(tx({ slippagePercent: "-1" }), wallet, 2, expected), null);
  assert.notEqual(swapTxError(tx({ slippagePercent: "2.1" }), wallet, 2, expected), null);
});

test("equal allowance selects swap; shortfall approves the exact input to tx.to", () => {
  const required = new Decimal("1000000");
  const swap = selectCall({ allowance: required, required, quoteToken: token, swapTo: router, swapData: "0xabcdef12" });
  assert.equal(swap.kind, "swap");
  const approve = selectCall({ allowance: required.minus(1), required, quoteToken: token, swapTo: router, swapData: "0xabcdef12" });
  assert.deepEqual(approve, { kind: "approve", to: token, data: encodeApprove(router, required), value: "0" });
  assert.ok(approve.data.includes(router.slice(2).toLowerCase()));
  assert.ok(approve.data.endsWith(BigInt(1000000).toString(16).padStart(64, "0")));
});
