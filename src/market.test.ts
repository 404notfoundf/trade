import assert from "node:assert/strict";
import Decimal from "decimal.js";
import test from "node:test";
import { vwap } from "./market.js";

test("vwap crosses price levels and rejects insufficient depth", () => {
  const levels = [{ price: "10", size: "1" }, { price: "11", size: "2" }];
  const fill = vwap(levels, new Decimal("2"));

  assert.equal(fill?.quantity.toString(), "2");
  assert.equal(fill?.notional.toString(), "21");
  assert.equal(fill?.vwap.toString(), "10.5");
  assert.equal(vwap(levels, new Decimal("4")), null);
});
