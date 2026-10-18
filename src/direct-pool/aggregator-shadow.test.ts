import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidAggregatorQuote } from "./aggregator-shadow.js";
import type { AssetConfig } from "../config.js";

const asset = { chainIndex: "196", tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  quoteTokenAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } as AssetConfig;
const leg = { from: asset.tokenAddress, to: asset.quoteTokenAddress, amount: "1000000" };
const quote = {
  chainIndex: "196", fromTokenAmount: "1000000", toTokenAmount: "1200000",
  fromToken: { tokenContractAddress: asset.tokenAddress.toUpperCase().replace("0X", "0x") },
  toToken: { tokenContractAddress: asset.quoteTokenAddress }, dexRouterList: [{}],
};

test("Aggregator shadow accepts only matching chain, tokens, exact input and nonempty route", () => {
  assert.equal(isValidAggregatorQuote(quote, asset, leg), true);
  assert.equal(isValidAggregatorQuote({ ...quote, fromTokenAmount: "999999" }, asset, leg), false);
  assert.equal(isValidAggregatorQuote({ ...quote, chainIndex: "501" }, asset, leg), false);
  assert.equal(isValidAggregatorQuote({ ...quote, dexRouterList: [] }, asset, leg), false);
});
