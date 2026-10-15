import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isRaydiumPoolStateLayout } from "./fixed-pools.js";

test("Raydium CLMM layout guard accepts only PoolState discriminator and pinned account length", () => {
  const account = Buffer.alloc(1544);
  createHash("sha256").update("account:PoolState").digest().subarray(0, 8).copy(account);
  assert.equal(isRaydiumPoolStateLayout(account), true);
  account[0] = account[0]! ^ 1;
  assert.equal(isRaydiumPoolStateLayout(account), false);
  assert.equal(isRaydiumPoolStateLayout(Buffer.alloc(1543)), false);
});
