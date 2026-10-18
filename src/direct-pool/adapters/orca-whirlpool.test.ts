import assert from "node:assert/strict";
import test from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";
import { ReadOnlyWallet } from "@orca-so/common-sdk";
import { createOrcaContext } from "./orca-whirlpool.js";

test("Orca batch account fetch propagates RPC errors without an unhandled rejection", async () => {
  const connection = {
    getMultipleAccountsInfo: async () => { throw new Error("mock RPC timeout"); },
  } as unknown as Connection;
  const context = createOrcaContext(connection, new ReadOnlyWallet(PublicKey.default));

  await assert.rejects(
    context.fetcher.getPools([PublicKey.default], { timeoutInSeconds: 0.01 }),
    /mock RPC timeout/,
  );
  await assert.rejects(
    context.fetcher.getTickArrays([PublicKey.default], { timeoutInSeconds: 0.01 }),
    /mock RPC timeout/,
  );
});

test("Orca batch account fetch preserves its timeout for stalled RPCs", async () => {
  const connection = {
    getMultipleAccountsInfo: async () => new Promise<never>(() => undefined),
  } as unknown as Connection;
  const context = createOrcaContext(connection, new ReadOnlyWallet(PublicKey.default));

  await assert.rejects(
    context.fetcher.getPools([PublicKey.default], { timeoutInSeconds: 0.01 }),
    /connection.getMultipleAccountsInfo timeout/,
  );
});
