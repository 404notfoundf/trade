import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  collectPositiveWindows,
  countPositiveWindows,
  DIRECT_POOL_MAX_CUSTOM_RANGE_MS,
  DIRECT_POOL_WINDOW_GAP_MS,
  directPoolQuoteBackUrl,
  isWindowCoverageComplete,
  parseDirectPoolRange,
  parsePageNumber,
  parseUtc8Input,
  type WindowSample,
} from "./direct-pool-windows.js";

const base = Date.UTC(2026, 9, 15, 0, 0, 0);
const at = (offsetMs: number) => new Date(base + offsetMs);
const sample = (id: number, offsetMs: number, net: string | null, patch: Partial<WindowSample> = {}): WindowSample => ({
  id, createdAt: at(offsetMs), instrumentId: "X", chainIndex: "1", poolId: "pool-a", direction: "buy", sizeUsdt: "100", netProfitUsdt: net, valuationStatus: "VERIFIED", ...patch,
});

test("two positive samples open once and two non-positive samples close", () => {
  const windows = collectPositiveWindows([sample(1, 0, "1"), sample(2, 1, "2"), sample(3, 2, "0"), sample(4, 3, "-1")]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.startAt.getTime(), at(0).getTime());
  assert.equal(windows[0]?.endAt?.getTime(), at(3).getTime());
});

test("a non-positive sample breaks a pending positive and four positives remain one window", () => {
  const broken = collectPositiveWindows([sample(1, 0, "1"), sample(2, 1, "0"), sample(3, 2, "1"), sample(4, 3, "1")]);
  assert.equal(broken.length, 1);
  assert.equal(broken[0]?.startAt.getTime(), at(2).getTime());
  assert.equal(collectPositiveWindows([sample(1, 0, "1"), sample(2, 1, "1"), sample(3, 2, "1"), sample(4, 3, "1")]).length, 1);
});

test("gap timeout is strictly greater than two minutes", () => {
  const atLimit = collectPositiveWindows([sample(1, 0, "1"), sample(2, 1, "1")], at(DIRECT_POOL_WINDOW_GAP_MS));
  assert.equal(atLimit[0]?.endAt, null);
  const timedOut = collectPositiveWindows([sample(1, 0, "1"), sample(2, 1, "1")], at(DIRECT_POOL_WINDOW_GAP_MS + 2));
  assert.equal(timedOut[0]?.endAt?.getTime(), at(DIRECT_POOL_WINDOW_GAP_MS + 1).getTime());
  assert.equal(collectPositiveWindows([sample(1, 0, "1"), sample(2, DIRECT_POOL_WINDOW_GAP_MS + 1, "1")]).length, 0);
});

test("invalid samples neither close nor reset a window", () => {
  const windows = collectPositiveWindows([
    sample(1, 0, "1"), sample(2, 1, "1"), sample(3, 2, null), sample(4, 3, "1", { valuationStatus: "INVALIDATED_MULTIPLIER" }),
    sample(5, 4, "0"), sample(6, 5, "0"),
  ]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.endAt?.getTime(), at(5).getTime());
});

test("window counts use start time in the selected half-open range", () => {
  const samples = [
    sample(1, 0, "1"), sample(2, 1, "1"), sample(3, 2, "0"), sample(4, 3, "0"),
    sample(5, 10, "1"), sample(6, 11, "1"),
  ];
  assert.equal(countPositiveWindows(samples, at(0), at(10)), 1);
  assert.equal(countPositiveWindows(samples, at(10), at(12)), 1);
  assert.equal(countPositiveWindows(samples, at(11), at(12)), 0);
  assert.equal(isWindowCoverageComplete(at(10), at(10)), true);
  assert.equal(isWindowCoverageComplete(at(9), at(10)), false);
  assert.equal(isWindowCoverageComplete(at(10), null), false);
});

test("pool, direction, instrument, chain, and normalized size do not merge unrelated streams", () => {
  const windows = collectPositiveWindows([
    sample(1, 0, "1", { sizeUsdt: "100" }), sample(2, 1, "1", { sizeUsdt: "100.000" }),
    sample(3, 2, "1", { poolId: "pool-b" }), sample(4, 3, "1", { direction: "sell" }),
    sample(5, 4, "1", { instrumentId: "Y" }), sample(6, 5, "1", { chainIndex: "2" }), sample(7, 6, "1", { poolId: null }),
  ]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.startAt.getTime(), at(0).getTime());
});

test("UTC+8 custom range parsing validates calendar dates, bounds, and safe pages", () => {
  assert.equal(parseUtc8Input("2026-02-29T10:00"), null);
  assert.equal(parseUtc8Input("2026-10-15T08:00")?.toISOString(), "2026-10-15T00:00:00.000Z");
  const now = at(0);
  const exact = new URLSearchParams({ range: "custom", from: "2026-04-18T08:00", to: "2026-10-15T08:00" });
  assert.equal(parseDirectPoolRange(exact, now).to.getTime() - parseDirectPoolRange(exact, now).from.getTime(), DIRECT_POOL_MAX_CUSTOM_RANGE_MS);
  const tooLong = new URLSearchParams({ range: "custom", from: "2026-04-18T07:59", to: "2026-10-15T08:00" });
  assert.equal(parseDirectPoolRange(tooLong, now).invalid, true);
  assert.equal(parseDirectPoolRange(new URLSearchParams({ range: "custom", from: "2026-10-15T08:00", to: "2026-10-15T08:00" }), now).invalid, true);
  assert.equal(parsePageNumber("9007199254740993"), 1);
  assert.equal(parsePageNumber("02"), 1);
});

test("quote detail back links retain the selected pool", () => {
  assert.equal(
    directPoolQuoteBackUrl(new URLSearchParams("pool=meteora-pool&page=2&range=24h")),
    "/direct-pools/quotes?range=24h&page=2&pool=meteora-pool",
  );
  assert.equal(
    directPoolQuoteBackUrl(new URLSearchParams("back=decisions&pool=orca-pool&profit=positive&direction=dex_buy_cex_sell")),
    "/direct-pools/decisions?range=1h&pool=orca-pool&profit=positive&direction=dex_buy_cex_sell",
  );
});

test("015 migration stores and backfills pool_id without deriving it from attempts", async () => {
  const migration = await readFile(new URL("../../migrations/015_direct_pool_decision_pool_id.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN pool_id VARCHAR\(128\) NULL/);
  assert.match(migration, /JOIN direct_pool_quote q ON q\.id = d\.selected_quote_id/);
  assert.doesNotMatch(migration, /attempts/i);
});
