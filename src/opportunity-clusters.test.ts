import assert from "node:assert/strict";
import test from "node:test";
import { collectOpportunityQuoteBuckets, type OpportunityQuoteSample } from "./opportunity-clusters.js";

const origin = Date.UTC(2026, 0, 1);
const sample = (id: number, offsetMs: number, profit: string | null, impact: string | null = null, patch: Partial<OpportunityQuoteSample> = {}): OpportunityQuoteSample => ({
  id, observed_at: new Date(origin + offsetMs), net_profit_usdt: profit, price_impact_percent: impact, status: "OK", valuation_status: "VERIFIED", ...patch,
});

test("groups valid opportunity quotes into fixed five-second buckets", () => {
  const buckets = collectOpportunityQuoteBuckets([
    sample(1, 100, "1.20", "-0.30"), sample(2, 4900, "1.50", "0.20"),
    sample(3, 5100, "1.10", "-0.10"), sample(4, 10_000, "9", "0.01", { status: "ERROR" }),
    sample(5, 10_100, "9", "0.01", { valuation_status: "UNKNOWN" }),
  ], null, new Date(origin + 6000));

  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets.map((bucket) => bucket.sampleCount), [2, 1]);
  assert.equal(buckets[0]?.currentProfit, "1.5");
  assert.equal(buckets[0]?.peakProfit, "1.5");
  assert.equal(buckets[0]?.minPriceImpact, "0.2");
  assert.equal(buckets[0]?.inProgress, false);
  assert.equal(buckets[1]?.inProgress, true);
});

test("closed windows have no in-progress bucket and missing metric values stay unknown", () => {
  const buckets = collectOpportunityQuoteBuckets([sample(1, 100, null)], new Date(origin + 3000), new Date(origin + 4000));
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0]?.inProgress, false);
  assert.equal(buckets[0]?.currentProfit, null);
  assert.equal(buckets[0]?.peakProfit, null);
  assert.equal(buckets[0]?.minPriceImpact, null);
});
