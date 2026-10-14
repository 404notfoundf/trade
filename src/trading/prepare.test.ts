import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import type { AssetConfig } from "../config.js";
import type { Book } from "../okx.js";
import { prepareBuy, type PrepareServices, type TradeState } from "./prepare.js";
import { XLAYER_DEX_ROUTER } from "./gates.js";

const wallet = "0x1111111111111111111111111111111111111111";
const asset: AssetConfig = {
  enabled: true,
  instId: "XAAPL-USDT",
  tokenSymbol: "AAPLx",
  network: "X Layer",
  chainIndex: "196",
  okxCurrency: "XAAPL",
  okxChain: "XAAPL-X Layer",
  tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a",
  tokenDecimals: 18,
  quoteTokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  quoteTokenDecimals: 6,
  quoteTokenSymbol: "USDT0",
  observationSizesUsdt: [100],
  gasSafetyBufferPercent: 20,
  dexQuoteIntervalMs: 5000,
};
const guardrails = {
  maxUsdtUsdDeviationPercent: 0.5,
  maxUsdt0UsdtDeviationPercent: 0.5,
  indexPriceRefreshSeconds: 15,
  indexPriceMaxAgeSeconds: 60,
  maxDexPriceImpactPercent: 2,
  maxMultiplierChangePercent: 1,
};
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const swapData = `0xf2c42696${word(0n)}${word(BigInt(asset.quoteTokenAddress))}${word(BigInt(asset.tokenAddress))}${word(100000000n)}${word(98000000000000000000n)}`;
const swapItem = {
  routerResult: {
    chainIndex: "196",
    fromTokenAmount: "100000000",
    toTokenAmount: "100000000000000000000",
    fromToken: { tokenContractAddress: asset.quoteTokenAddress, decimal: "6" },
    toToken: { tokenContractAddress: asset.tokenAddress, decimal: "18" },
    priceImpactPercent: "0.5",
    tradeFee: "0.1",
    dexRouterList: [{}],
  },
  tx: {
    from: wallet,
    to: XLAYER_DEX_ROUTER,
    data: swapData,
    value: "0",
    slippagePercent: "2",
    minReceiveAmount: "98000000000000000000",
  },
};
const valuation: ReturnType<PrepareServices["decideValuation"]> = {
  nativeAmount: "100",
  nativeSymbol: "USDT0",
  usdtRate: "1",
  conversionCostUsdt: "0",
  usdtEstimate: "2",
  grossProfitUsdt: "2",
  netProfitUsdt: "2",
  valuationStatus: "VERIFIED",
  priceSourceTime: new Date(),
  quoteSummary: null,
  reasonCode: null,
  reason: null,
  usdtLeg: "100",
};
const fakeDexSwap: PrepareServices["dexSwap"] = async <T>() => [swapItem] as unknown as T;
const baseServices: PrepareServices = {
  dexSwap: fakeDexSwap,
  decideValuation: (() => valuation) as PrepareServices["decideValuation"],
  readAllowance: async () => new Decimal(0),
};

function fixture() {
  const book: Book = {
    asks: [{ price: "1.1", size: "200" }],
    bids: [{ price: "1.1", size: "200" }],
    exchangeTime: Date.now(),
    receivedAt: Date.now(),
    seqId: 1,
    ready: true,
  };
  const state: TradeState = {
    routeStatus: "ENABLED",
    instrument: { instId: asset.instId, state: "live", lotSz: "1", minSz: "1", tickSz: "0.01" },
    feeRate: new Decimal("0.001"),
    multiplier: new Decimal(1),
    book,
  };
  return {
    book,
    input: {
      wallet,
      tradeSizeUsdt: 100,
      asset,
      guardrails,
      dex: { key: "key", secret: "secret", passphrase: "passphrase" },
      getState: () => state,
    },
  };
}

test("prepareBuy returns an exact approval after checking the final fresh book", async () => {
  const { input } = fixture();
  const result = await prepareBuy(input, baseServices);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.call.kind, "approve");
    assert.equal(result.call.to, asset.quoteTokenAddress);
    assert.equal(result.call.chainId, "196");
    assert.equal(result.call.amount, "100000000");
    assert.ok(result.call.data.endsWith(BigInt("100000000").toString(16).padStart(64, "0")));
  }
});

test("prepareBuy refuses when the book expires during the allowance request", async () => {
  const { input, book } = fixture();
  const result = await prepareBuy(input, {
    ...baseServices,
    readAllowance: async () => {
      book.receivedAt = Date.now() - 3000;
      book.exchangeTime = Date.now() - 3000;
      return new Decimal(0);
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /盘口已过期/);
});
