import Decimal from "decimal.js";

export const DIRECT_POOL_WINDOW_GAP_MS = 120_000;
export const DIRECT_POOL_POOL_ID_MIGRATION = "015_direct_pool_decision_pool_id";
export const DIRECT_POOL_MAX_CUSTOM_RANGE_MS = 180 * 24 * 60 * 60 * 1000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

export type DirectPoolRangePreset = "5m" | "1h" | "24h" | "custom";
export type DirectPoolRange = { from: Date; to: Date; preset: DirectPoolRangePreset; invalid: boolean };
export type WindowSample = {
  id: number; createdAt: Date; instrumentId: string; chainIndex: string; poolId: string | null;
  direction: string; sizeUsdt: string; netProfitUsdt: string | null; valuationStatus: string | null;
};
export type PositiveWindow = { startAt: Date; endAt: Date | null; key: string };

type Utc8Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function utc8Parts(date: Date): Utc8Parts {
  const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function parseUtc8Input(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - UTC8_OFFSET_MS;
  if (!Number.isFinite(utcMs)) return null;
  const date = new Date(utcMs);
  const parts = utc8Parts(date);
  if (parts.year !== year || parts.month !== month || parts.day !== day || parts.hour !== hour || parts.minute !== minute || parts.second !== second) return null;
  return date;
}

export function formatUtc8Input(date: Date): string {
  const parts = utc8Parts(date);
  const seconds = parts.second ? `:${pad(parts.second)}` : "";
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}${seconds}`;
}

export function formatUtc8Minute(date: Date): string {
  const parts = utc8Parts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function fallbackRange(now: Date): DirectPoolRange {
  return { from: new Date(now.getTime() - 60 * 60 * 1000), to: now, preset: "1h", invalid: true };
}

export function parseDirectPoolRange(params: URLSearchParams, now = new Date()): DirectPoolRange {
  const range = params.get("range");
  if (!range || range === "1h") return { from: new Date(now.getTime() - 60 * 60 * 1000), to: now, preset: "1h", invalid: false };
  if (range === "5m") return { from: new Date(now.getTime() - 5 * 60 * 1000), to: now, preset: "5m", invalid: false };
  if (range === "24h") return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now, preset: "24h", invalid: false };
  if (range !== "custom") return fallbackRange(now);
  const from = parseUtc8Input(params.get("from") ?? "");
  const to = parseUtc8Input(params.get("to") ?? "");
  if (!from || !to || from.getTime() >= to.getTime() || to.getTime() - from.getTime() > DIRECT_POOL_MAX_CUSTOM_RANGE_MS) return fallbackRange(now);
  return { from, to, preset: "custom", invalid: false };
}

export function rangeSearchParams(range: DirectPoolRange): URLSearchParams {
  const params = new URLSearchParams();
  if (range.invalid || range.preset === "1h") {
    params.set("range", "1h");
    return params;
  }
  params.set("range", range.preset);
  if (range.preset === "custom") {
    params.set("from", formatUtc8Input(range.from));
    params.set("to", formatUtc8Input(range.to));
  }
  return params;
}

export function parsePageNumber(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && String(page) === value ? page : 1;
}

export function directPoolHref(path: string, range: DirectPoolRange, extra?: Record<string, string>): string {
  const params = rangeSearchParams(range);
  if (extra) for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function directPoolQuoteBackUrl(params: URLSearchParams): string {
  const page = parsePageNumber(params.get("page") ?? params.get("quote_page"));
  return directPoolHref("/direct-pools/quotes", parseDirectPoolRange(params), page > 1 ? { page: String(page) } : undefined);
}

export function isWindowCoverageComplete(rangeFrom: Date, coverageStart: Date | null): boolean {
  return coverageStart !== null && rangeFrom.getTime() >= coverageStart.getTime();
}

function numericNet(value: string | null): Decimal | null {
  if (value === null || value.trim() === "") return null;
  try {
    const net = new Decimal(value);
    return net.isFinite() ? net : null;
  } catch {
    return null;
  }
}

function sizeKey(value: string): string {
  try { return new Decimal(value).toFixed(); } catch { return value; }
}

function groupKey(sample: WindowSample): string {
  return [sample.instrumentId, sample.chainIndex, sample.poolId, sample.direction, sizeKey(sample.sizeUsdt)].join("\0");
}

type GroupState = { open: PositiveWindow | null; pendingPositiveAt: Date | null; nonPositiveStreak: number; lastValidAt: Date | null };

function expire(state: GroupState, at: Date): void {
  if (!state.lastValidAt || at.getTime() - state.lastValidAt.getTime() <= DIRECT_POOL_WINDOW_GAP_MS) return;
  if (state.open && state.open.endAt === null) state.open.endAt = new Date(state.lastValidAt.getTime() + DIRECT_POOL_WINDOW_GAP_MS);
  state.open = null;
  state.pendingPositiveAt = null;
  state.nonPositiveStreak = 0;
  state.lastValidAt = null;
}

export function collectPositiveWindows(samples: WindowSample[], until?: Date): PositiveWindow[] {
  const ordered = samples.filter((sample) => !until || sample.createdAt.getTime() < until.getTime())
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
  const groups = new Map<string, GroupState>();
  const windows: PositiveWindow[] = [];
  for (const sample of ordered) {
    const net = sample.poolId ? numericNet(sample.netProfitUsdt) : null;
    if (!sample.poolId || !net || sample.valuationStatus?.startsWith("INVALIDATED_")) continue;
    const key = groupKey(sample);
    const state = groups.get(key) ?? { open: null, pendingPositiveAt: null, nonPositiveStreak: 0, lastValidAt: null };
    groups.set(key, state);
    expire(state, sample.createdAt);
    if (!state.open) {
      if (net.gt(0)) {
        if (state.pendingPositiveAt) {
          const opened = { startAt: state.pendingPositiveAt, endAt: null, key };
          windows.push(opened);
          state.open = opened;
          state.pendingPositiveAt = null;
          state.nonPositiveStreak = 0;
        } else state.pendingPositiveAt = sample.createdAt;
      } else state.pendingPositiveAt = null;
    } else if (net.gt(0)) state.nonPositiveStreak = 0;
    else if (++state.nonPositiveStreak >= 2) {
      state.open.endAt = sample.createdAt;
      state.open = null;
      state.nonPositiveStreak = 0;
      state.pendingPositiveAt = null;
    }
    state.lastValidAt = sample.createdAt;
  }
  if (until) for (const state of groups.values()) expire(state, until);
  return windows;
}

export function countPositiveWindows(samples: WindowSample[], from: Date, to: Date): number {
  return collectPositiveWindows(samples, to).filter((window) => window.startAt.getTime() >= from.getTime() && window.startAt.getTime() < to.getTime()).length;
}