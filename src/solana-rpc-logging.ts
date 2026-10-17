import { logger } from "./logger.js";

type RpcRequest = { method: string; id?: string | number | null };
const requestStats = new Map<string, { count: number; totalMs: number; maxMs: number; contextSlotMin?: number; contextSlotMax?: number }>();
let flushTimer: ReturnType<typeof setInterval> | undefined;

function getRequests(init?: RequestInit): RpcRequest[] {
  if (typeof init?.body !== "string") return [{ method: "unknown" }];
  try {
    const payload: unknown = JSON.parse(init.body);
    const requests = Array.isArray(payload) ? payload : [payload];
    const parsed = requests.map((request): RpcRequest => {
      const rpcRequest = request && typeof request === "object" ? request as { method?: unknown; id?: unknown } : undefined;
      const method = rpcRequest?.method;
      const id = rpcRequest?.id;
      return {
        method: typeof method === "string" && /^[a-zA-Z0-9_]+$/.test(method) ? method : "unknown",
        ...(typeof id === "string" || typeof id === "number" || id === null ? { id } : {}),
      };
    });
    return parsed.length ? parsed : [{ method: "unknown" }];
  } catch {
    return [{ method: "unknown" }];
  }
}

function getContextSlots(payload: unknown, requests: RpcRequest[]): Array<number | undefined> {
  const responses = Array.isArray(payload) ? payload : [payload];
  const responseById = new Map<string, unknown>();
  for (const response of responses) {
    if (!response || typeof response !== "object") continue;
    const id = (response as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number" || id === null) responseById.set(JSON.stringify(id), response);
  }
  return requests.map((request, index) => {
    if (request.method !== "getAccountInfo" && request.method !== "getMultipleAccounts") return undefined;
    const response = request.id !== undefined ? responseById.get(JSON.stringify(request.id)) : responses[index];
    if (!response || typeof response !== "object") return undefined;
    const result = (response as { result?: unknown }).result;
    if (!result || typeof result !== "object") return undefined;
    const context = (result as { context?: unknown }).context;
    if (!context || typeof context !== "object") return undefined;
    const slot = (context as { slot?: unknown }).slot;
    return typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0 ? slot : undefined;
  });
}

function record(requests: RpcRequest[], status: number | "network_error", elapsedMs: number): void {
  for (const request of requests) {
    const method = request.method;
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
      const summary = [...requestStats].map(([key, stat]) => {
        const slots = stat.contextSlotMin === undefined ? "" : ` context_slot_min=${stat.contextSlotMin} context_slot_max=${stat.contextSlotMax}`;
        return `${key} count=${stat.count} avg_ms=${Math.round(stat.totalMs / stat.count)} max_ms=${stat.maxMs}${slots}`;
      }).join(" ");
      requestStats.clear();
      logger.info(`[solana-rpc] window=60s ${summary}`);
    }, 60_000);
    flushTimer.unref();
  }
}

function recordContextSlots(requests: RpcRequest[], status: number, contextSlots: Array<number | undefined>): void {
  for (const [index, request] of requests.entries()) {
    const contextSlot = contextSlots[index];
    const stat = requestStats.get(`${request.method}/${status}`);
    if (contextSlot === undefined || !stat) continue;
    stat.contextSlotMin = stat.contextSlotMin === undefined ? contextSlot : Math.min(stat.contextSlotMin, contextSlot);
    stat.contextSlotMax = stat.contextSlotMax === undefined ? contextSlot : Math.max(stat.contextSlotMax, contextSlot);
  }
}

// shortcut: this records HTTP RPC only; add WebSocket metrics if provider traffic still does not reconcile.
export const solanaRpcFetch: typeof fetch = async (input, init) => {
  const requests = getRequests(init);
  const methods = requests.map(({ method }) => method);
  const startedAt = performance.now();
  try {
    const response = await globalThis.fetch(input, init);
    const elapsedMs = Math.round(performance.now() - startedAt);
    record(requests, response.status, elapsedMs);
    if (response.ok && requests.some(({ method }) => method === "getAccountInfo" || method === "getMultipleAccounts")) {
      void response.clone().json()
        .then((payload: unknown) => recordContextSlots(requests, response.status, getContextSlots(payload, requests)))
        .catch(() => { /* Optional logging must not fail quote requests. */ });
    }
    if (response.status === 429) {
      logger.warn(`[solana-rpc] methods=${[...new Set(methods)].join(",").slice(0, 180)} status=429 elapsed_ms=${elapsedMs}`);
    }
    return response;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    record(requests, "network_error", elapsedMs);
    logger.warn(`[solana-rpc] methods=${[...new Set(methods)].join(",").slice(0, 180)} status=network_error elapsed_ms=${elapsedMs}`);
    throw error;
  }
};
