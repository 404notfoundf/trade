import assert from "node:assert/strict";
import test from "node:test";
import { persistBeforeSubmit } from "./persist-before-submit.js";

test("does not submit an order until its intent is persisted", async () => {
  const calls: string[] = [];
  const order = await persistBeforeSubmit(
    async () => { calls.push("persist"); },
    async () => { calls.push("submit"); return "order-1"; },
  );

  assert.equal(order, "order-1");
  assert.deepEqual(calls, ["persist", "submit"]);
});

test("does not submit an order when intent persistence fails", async () => {
  let submitted = false;
  await assert.rejects(persistBeforeSubmit(
    async () => { throw new Error("database unavailable"); },
    async () => { submitted = true; return "order-1"; },
  ), /database unavailable/);
  assert.equal(submitted, false);
});
