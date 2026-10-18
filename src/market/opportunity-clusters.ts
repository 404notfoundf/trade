import Decimal from "decimal.js";

export type OpportunityQuoteSample = {
  id: number;
  observed_at: Date;
  net_profit_usdt: string | null;
  price_impact_percent: string | null;
  status: string;
  valuation_status: string;
};

export type OpportunityQuoteBucket = {
  startAt: Date;
  endAt: Date;
  inProgress: boolean;
  latestAt: Date;
  sampleCount: number;
  currentProfit: string | null;
  peakProfit: string | null;
  minPriceImpact: string | null;
};

export type OpportunityQuoteBucketRow = {
  bucket_start_ms: string | number;
  latest_at: Date;
  sample_count: string | number;
  current_profit: string | null;
  peak_profit: string | null;
  min_price_impact: string | null;
};

const BUCKET_MS = 5_000;

function decimal(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch { return null; }
}

function withProgress(bucket: OpportunityQuoteBucket, endedAt: Date | null, now: Date): OpportunityQuoteBucket {
  bucket.inProgress = endedAt === null && bucket.endAt.getTime() > now.getTime();
  return bucket;
}

export function mapOpportunityQuoteBucketRows(rows: OpportunityQuoteBucketRow[], endedAt: Date | null, now = new Date()): OpportunityQuoteBucket[] {
  return rows.map((row) => {
    const startAt = new Date(Number(row.bucket_start_ms));
    return withProgress({
      startAt, endAt: new Date(startAt.getTime() + BUCKET_MS), inProgress: false,
      latestAt: row.latest_at, sampleCount: Number(row.sample_count),
      currentProfit: decimal(row.current_profit)?.toString() ?? null,
      peakProfit: decimal(row.peak_profit)?.toString() ?? null,
      minPriceImpact: decimal(row.min_price_impact)?.toString() ?? null,
    }, endedAt, now);
  });
}

export function collectOpportunityQuoteBuckets(samples: OpportunityQuoteSample[], endedAt: Date | null, now = new Date()): OpportunityQuoteBucket[] {
  const buckets = new Map<number, OpportunityQuoteBucket>();
  for (const sample of samples.slice().sort((left, right) => left.observed_at.getTime() - right.observed_at.getTime() || left.id - right.id)) {
    const observedAt = sample.observed_at.getTime();
    if (sample.status !== "OK" || sample.valuation_status !== "VERIFIED" || !Number.isFinite(observedAt)) continue;
    const start = Math.floor(observedAt / BUCKET_MS) * BUCKET_MS;
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = {
        startAt: new Date(start), endAt: new Date(start + BUCKET_MS), inProgress: false,
        latestAt: sample.observed_at, sampleCount: 0, currentProfit: null, peakProfit: null, minPriceImpact: null,
      };
      buckets.set(start, bucket);
    }
    bucket.sampleCount++;
    if (sample.observed_at.getTime() >= bucket.latestAt.getTime()) {
      bucket.latestAt = sample.observed_at;
      bucket.currentProfit = decimal(sample.net_profit_usdt)?.toString() ?? null;
    }
    const profit = decimal(sample.net_profit_usdt);
    if (profit && (bucket.peakProfit === null || profit.gt(bucket.peakProfit))) bucket.peakProfit = profit.toString();
    const impact = decimal(sample.price_impact_percent)?.abs();
    if (impact && (bucket.minPriceImpact === null || impact.lt(bucket.minPriceImpact))) bucket.minPriceImpact = impact.toString();
  }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([, bucket]) => withProgress(bucket, endedAt, now));
}
