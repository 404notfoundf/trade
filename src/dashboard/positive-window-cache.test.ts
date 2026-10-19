import assert from "node:assert/strict";
import { test } from "node:test";
import type { PositiveWindow } from "../direct-pool/windows.js";
import { createPositiveWindowCache } from "./positive-window-cache.js";

test("positive-window cache expires entries after ten seconds", () => {
  let now = 0;
  const cache = createPositiveWindowCache(() => now);
  const windows: PositiveWindow[] = [];
  cache.set("range", windows);
  assert.equal(cache.get("range"), windows);
  now = 10_000;
  assert.equal(cache.get("range"), undefined);
});

test("positive-window cache stays bounded and evicts least-recently-used entries", () => {
  const cache = createPositiveWindowCache(() => 0);
  for (let i = 0; i < 16; i++) cache.set(String(i), []);
  cache.get("0");
  cache.set("16", []);
  assert.equal(cache.get("0")?.length, 0);
  assert.equal(cache.get("1"), undefined);
});
