import { logger } from "./logger.js";

const requestStats = new Map<string, { count: number; totalMs: number; maxMs: number }>();
let flushTimer: ReturnType<typeof setInterval> | undefined;

function getMethods(init?: RequestInit): string[] {
  if (typeof init?.body !== "string") return ["unknown"];
  try {
    const payload: unknown = JSON.parse(init.body);
    const requests = Array.isArray(payload) ? payload : [payload];
    const methods = requests.map((request) => {
      const method = request && typeof request === "object" ? (request as { method?: unknown }).method : undefined;
      return typeof method === "string" && /^[a-zA-Z0-9_]+$/.test(method) ? method : "unknown";
    });
    return methods.length ? methods : ["unknown"];
  } catch {
    return ["unknown"];
  }
}

function record(methods: string[], status: number | "network_error", elapsedMs: number): void {
  for (const method of methods) {
    const key = `${method}/${status}`;
    const stat = requestStats.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    stat.count++;
    stat.totalMs += elapsedMs;
    stat.maxMs = Math.max(stat.maxMs, elapsedMs);
    requestStats.set(key, stat);
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      if (!requestStats.size) return;
      const summary = [...requestStats].map(([key, stat]) => `${key} count=${stat.count} avg_ms=${Math.round(stat.totalMs / stat.count)} max_ms=${stat.maxMs}`).join(" ");
      requestStats.clear();
      logger.info(`[solana-rpc] window=60s ${summary}`);
    }, 60_000);
    flushTimer.unref();
  }
}

// shortcut: this records HTTP RPC only; add WebSocket metrics if provider traffic still does not reconcile.
export const solanaRpcFetch: typeof fetch = async (input, init) => {
  const methods = getMethods(init);
  const startedAt = performance.now();
  try {
    const response = await globalThis.fetch(input, init);
    const elapsedMs = Math.round(performance.now() - startedAt);
    record(methods, response.status, elapsedMs);
    if (response.status === 429) {
      logger.warn(`[solana-rpc] methods=${[...new Set(methods)].join(",").slice(0, 180)} status=429 elapsed_ms=${elapsedMs}`);
    }
    return response;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    record(methods, "network_error", elapsedMs);
    logger.warn(`[solana-rpc] methods=${[...new Set(methods)].join(",").slice(0, 180)} status=network_error elapsed_ms=${elapsedMs}`);
    throw error;
  }
};
