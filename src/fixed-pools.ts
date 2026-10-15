import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { PublicKey } from "@solana/web3.js";
import { Interface } from "ethers";
import WebSocket from "ws";
import type { FixedPoolConfig } from "./config.js";
import { solanaRpcFetch } from "./solana-rpc-logging.js";

const Q96 = new Decimal(2).pow(96);
const Q64 = new Decimal(2).pow(64);
const XLAYER_CONFIRMATION_DEPTH = 5;
const XLAYER_LOG_BLOCK_RANGE = 100;
const POOL_SNAPSHOT_INTERVAL_MS = 30_000;
const RAYDIUM_POOL_STATE_LEN = 1544;
const RAYDIUM_POOL_STATE_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);
const poolAbi = new Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
]);
const eventTopics = ["Swap", "Mint", "Burn"].map((name) => poolAbi.getEvent(name)!.topicHash);
const selectors = { token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43", factory: "0xc45a0155", slot0: "0x3850c7bd", liquidity: "0x1a686502", decimals: "0x313ce567" };

export function isRaydiumPoolStateLayout(data: Buffer): boolean {
  return data.length === RAYDIUM_POOL_STATE_LEN && data.subarray(0, 8).equals(RAYDIUM_POOL_STATE_DISCRIMINATOR);
}

export type PoolMonitorState = {
  poolId: string; instId: string; chainIndex: string; dex: string; address: string;
  baseTokenSymbol: string; baseTokenAddress: string; quoteTokenSymbol: string; quoteTokenAddress: string;
  status: "healthy" | "not_configured" | "unavailable" | "invalid" | "disabled" | "unknown";
  connectionStatus: "connecting" | "connected" | "disconnected" | "not_configured" | "unknown";
  rpcSnapshotStatus: "healthy" | "unavailable" | "unknown"; lastRpcSnapshotAt: number | null; rpcSnapshotError: string | null;
  latestHistoryGap: { startedAt: number; recoveredAt: number; reason: string } | null;
  finality: "provisional" | "confirmed" | null; confirmedBlockNumber: number | null;
  lastError: string | null; source: string | null; marginalPrice: string | null;
  sqrtPriceRaw: string | null; liquidityRaw: string | null; blockNumber: number | null;
  blockHash: string | null; slot: number | null; transactionHash: string | null; logIndex: number | null;
  accountDataHash: string | null; eventFingerprint: string | null; observedAt: number | null;
};
type MonitorOptions = {
  onState: (state: PoolMonitorState) => void;
  onHistoryGap: (poolId: string, startedAt: number, recoveredAt: number, reason: "websocket_disconnect" | "database_unavailable") => Promise<void>;
  onRevert: (poolId: string, fingerprint: string) => Promise<void>;
  onRevertAfter: (poolId: string, blockNumber: number) => Promise<void>;
  checkpointBlocks?: Map<string, number>;
  rpcEndpoints?: Map<string, { http: string | null; ws: string | null }>;
};
type EvmLog = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; removed?: boolean };
class PoolIdentityError extends Error {}

export function initialPoolState(pool: FixedPoolConfig, status: PoolMonitorState["status"] = "not_configured", lastError: string | null = null): PoolMonitorState {
  return {
    poolId: pool.id, instId: pool.instId, chainIndex: pool.chainIndex, dex: pool.dex, address: pool.address,
    baseTokenSymbol: pool.baseTokenSymbol, baseTokenAddress: pool.baseTokenAddress,
    quoteTokenSymbol: pool.quoteTokenSymbol, quoteTokenAddress: pool.quoteTokenAddress,
    status, connectionStatus: "unknown", rpcSnapshotStatus: "unknown", lastRpcSnapshotAt: null, rpcSnapshotError: null, latestHistoryGap: null,
    finality: null, confirmedBlockNumber: null, lastError, source: null, marginalPrice: null, sqrtPriceRaw: null, liquidityRaw: null,
    blockNumber: null, blockHash: null, slot: null, transactionHash: null, logIndex: null,
    accountDataHash: null, eventFingerprint: null, observedAt: null,
  };
}

export async function startFixedPoolMonitors(pools: FixedPoolConfig[], options: MonitorOptions): Promise<() => Promise<void>> {
  const stops: Array<() => Promise<void>> = [];
  for (const pool of pools) {
    if (!pool.enabled) { options.onState(initialPoolState(pool, "disabled")); continue; }
    let stopped = false;
    let retryTimer: NodeJS.Timeout | undefined;
    let retryDelay = 1000;
    let stopCurrent: (() => Promise<void>) | undefined;
    const attempt = async () => {
    try {
        stopCurrent = pool.chainIndex === "196" ? await startEvmPool(pool, options) : await startSolanaPool(pool, options);
        retryDelay = 1000;
      } catch (error) {
        const invalid = error instanceof PoolIdentityError;
        options.onState(initialPoolState(pool, invalid ? "invalid" : "unavailable", errorMessage(error)));
        if (!stopped && !invalid) {
          retryTimer = setTimeout(() => { void attempt(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      }
    };
    await attempt();
    stops.push(async () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      await stopCurrent?.();
    });
  }
  return async () => { await Promise.allSettled(stops.map((stop) => stop())); };
}

async function startEvmPool(pool: FixedPoolConfig, options: MonitorOptions): Promise<() => Promise<void>> {
  const endpoint = options.rpcEndpoints?.get(pool.id);
  const httpUrl = endpoint ? endpoint.http ?? "" : process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";
  const wsUrl = endpoint ? endpoint.ws : process.env.XLAYER_RPC_WS;
  if (!wsUrl || !httpUrl) {
    options.onState({ ...initialPoolState(pool, "not_configured", "X Layer RPC HTTP/WS endpoint is not configured"), connectionStatus: "not_configured" });
    return async () => undefined;
  }
  const headResult = await evmRpc(httpUrl, "eth_blockNumber", []) as string;
  if (BigInt(await evmRpc(httpUrl, "eth_chainId", []) as string) !== 196n) throw new PoolIdentityError("Configured X Layer RPC is not chain 196");
  const token0IsBase = await validateEvmPool(pool, httpUrl, headResult);
  let stopped = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let finalityTimer: NodeJS.Timeout | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = 1000;
  let lastPongAt = 0;
  let subscriptionId: string | undefined;
  let hadInitialSync = false;
  let disconnectedAt: number | null = null;
  const currentHead = Number(BigInt(headResult));
  const checkpoint = options.checkpointBlocks?.get(pool.id);
  let lastBlock = Math.min(checkpoint ?? Math.max(0, currentHead - XLAYER_CONFIRMATION_DEPTH), currentHead);
  let latestPosition = { block: lastBlock, logIndex: Number.MAX_SAFE_INTEGER };
  let serial = Promise.resolve();
  let latest = initialPoolState(pool);
  const emit = (state: PoolMonitorState) => {
    if (state.connectionStatus === "unknown" && latest.connectionStatus !== "unknown") state = { ...state, connectionStatus: latest.connectionStatus };
    if (state.rpcSnapshotStatus === "unknown" && latest.rpcSnapshotStatus !== "unknown") state = { ...state, rpcSnapshotStatus: latest.rpcSnapshotStatus };
    if (state.lastRpcSnapshotAt === null) state = { ...state, lastRpcSnapshotAt: latest.lastRpcSnapshotAt };
    if (state.rpcSnapshotError === null) state = { ...state, rpcSnapshotError: latest.rpcSnapshotError };
    if (state.latestHistoryGap === null) state = { ...state, latestHistoryGap: latest.latestHistoryGap };
    if (state.sqrtPriceRaw === null && latest.sqrtPriceRaw !== null) {
      state = { ...latest, status: state.status, lastError: state.lastError, connectionStatus: state.connectionStatus, rpcSnapshotStatus: state.rpcSnapshotStatus, lastRpcSnapshotAt: state.lastRpcSnapshotAt, rpcSnapshotError: state.rpcSnapshotError, latestHistoryGap: state.latestHistoryGap };
    }
    latest = state;
    options.onState(state);
  };
  const enqueue = (work: () => Promise<void>) => {
    serial = serial.then(work).catch((error) => {
      const invalid = error instanceof PoolIdentityError;
      emit({ ...latest, status: invalid ? "invalid" : "unavailable", lastError: errorMessage(error) });
      if (!invalid) socket?.close();
    });
  };
  const saveSnapshot = async (source: string, blockNumber?: number) => {
    const head = blockNumber ?? Number(BigInt(await evmRpc(httpUrl, "eth_blockNumber", []) as string));
    const tag = "0x" + head.toString(16);
    const [block, slot0Raw, liquidityRaw] = await Promise.all([
      evmRpc<{ hash: string } | null>(httpUrl, "eth_getBlockByNumber", [tag, false]),
      evmRpc<string>(httpUrl, "eth_call", [{ to: pool.address, data: selectors.slot0 }, tag]),
      evmRpc<string>(httpUrl, "eth_call", [{ to: pool.address, data: selectors.liquidity }, tag]),
    ]);
    if (!block) throw new Error("X Layer block " + head + " is unavailable");
    const sqrt = BigInt("0x" + slot0Raw.slice(2, 66));
    const fingerprint = "snapshot:" + block.hash;
    const decimals0 = token0IsBase ? pool.baseTokenDecimals : pool.quoteTokenDecimals;
    const decimals1 = token0IsBase ? pool.quoteTokenDecimals : pool.baseTokenDecimals;
    const confirmedHead = Math.max(0, head - XLAYER_CONFIRMATION_DEPTH);
    emit({
      ...makePoolState(pool, sqrt, BigInt(liquidityRaw), source, token0IsBase, decimals0, decimals1, head, block.hash, fingerprint),
      connectionStatus: latest.connectionStatus, rpcSnapshotStatus: "healthy", lastRpcSnapshotAt: Date.now(), rpcSnapshotError: null,
      finality: head <= confirmedHead ? "confirmed" : "provisional", confirmedBlockNumber: confirmedHead,
    });
    if (source !== "rpc_snapshot") {
      lastBlock = confirmedHead;
      latestPosition = { block: head, logIndex: Number.MAX_SAFE_INTEGER };
    }
  };
  const processLog = async (log: EvmLog, confirmedHead?: number) => {
    const blockNumber = Number(BigInt(log.blockNumber));
    const logIndex = Number(BigInt(log.logIndex));
    const fingerprint = log.blockHash + ":" + log.transactionHash + ":" + logIndex;
    if (log.removed) {
      await options.onRevert(pool.id, fingerprint);
      await saveSnapshot("resync");
      lastBlock = Math.max(lastBlock, blockNumber);
      return;
    }
    if (blockNumber < latestPosition.block || (blockNumber === latestPosition.block && logIndex <= latestPosition.logIndex)) return;
    let source = "resync";
    let sqrt: bigint;
    let liquidity: bigint;
    const parsed = poolAbi.parseLog({ topics: log.topics, data: log.data });
    if (parsed?.name === "Swap") {
      source = "swap";
      sqrt = BigInt(parsed.args.sqrtPriceX96);
      liquidity = BigInt(parsed.args.liquidity);
    } else if (parsed?.name === "Mint" || parsed?.name === "Burn") {
      source = parsed.name.toLowerCase();
      const slot0 = await evmRpc(httpUrl, "eth_call", [{ to: pool.address, data: selectors.slot0 }, log.blockNumber]) as string;
      const poolLiquidity = await evmRpc(httpUrl, "eth_call", [{ to: pool.address, data: selectors.liquidity }, log.blockNumber]) as string;
      sqrt = BigInt("0x" + slot0.slice(2, 66));
      liquidity = BigInt(poolLiquidity);
    } else return;
    const decimals0 = token0IsBase ? pool.baseTokenDecimals : pool.quoteTokenDecimals;
    const decimals1 = token0IsBase ? pool.quoteTokenDecimals : pool.baseTokenDecimals;
    emit({
      ...makePoolState(pool, sqrt, liquidity, source, token0IsBase, decimals0, decimals1, blockNumber, log.blockHash, fingerprint, undefined, log.transactionHash, logIndex),
      finality: confirmedHead !== undefined && blockNumber <= confirmedHead ? "confirmed" : "provisional",
      confirmedBlockNumber: confirmedHead ?? latest.confirmedBlockNumber,
    });
    latestPosition = { block: blockNumber, logIndex };
  };
  const backfill = async () => {
    const head = Number(BigInt(await evmRpc(httpUrl, "eth_blockNumber", []) as string));
    const confirmedHead = Math.max(0, head - XLAYER_CONFIRMATION_DEPTH);
    const checkpointBlock = Math.min(lastBlock, confirmedHead);
    await options.onRevertAfter(pool.id, checkpointBlock);
    lastBlock = checkpointBlock;
    latestPosition = { block: checkpointBlock, logIndex: Number.MAX_SAFE_INTEGER };
    for (let from = lastBlock + 1; from <= head; from += XLAYER_LOG_BLOCK_RANGE) {
      const to = Math.min(head, from + XLAYER_LOG_BLOCK_RANGE - 1);
      const logs = await evmRpc(httpUrl, "eth_getLogs", [{
        address: pool.address, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [eventTopics],
      }]) as EvmLog[];
      for (const log of logs) await processLog(log, confirmedHead);
    }
    lastBlock = confirmedHead;
    await saveSnapshot("resync", head);
    if (hadInitialSync && disconnectedAt !== null) {
      await options.onHistoryGap(pool.id, disconnectedAt, Date.now(), "websocket_disconnect");
      disconnectedAt = null;
    }
    hadInitialSync = true;
  };
  const refreshFinality = async () => {
    const head = Number(BigInt(await evmRpc(httpUrl, "eth_blockNumber", []) as string));
    const confirmedHead = Math.max(0, head - XLAYER_CONFIRMATION_DEPTH);
    lastBlock = Math.max(lastBlock, confirmedHead);
    const finality = latest.blockNumber !== null && latest.blockNumber <= confirmedHead ? "confirmed" : "provisional";
    if (latest.confirmedBlockNumber !== confirmedHead || latest.finality !== finality) emit({ ...latest, confirmedBlockNumber: confirmedHead, finality });
  };
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(wsUrl);
    socket.on("open", () => {
      reconnectDelay = 1000;
      lastPongAt = Date.now();
      emit({ ...latest, status: "unavailable", connectionStatus: "connected", lastError: "X Layer subscription is synchronizing" });
      socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", { address: pool.address, topics: [eventTopics] }] }));
      heartbeat = setInterval(() => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongAt > 45_000) { socket.terminate(); return; }
        try { socket.ping(); } catch { socket.terminate(); }
      }, 20_000);
    });
    socket.on("pong", () => { lastPongAt = Date.now(); });
    socket.on("message", (raw) => {
      let message: { id?: number; result?: string; error?: { message?: string }; params?: { result?: EvmLog } };
      try { message = JSON.parse(raw.toString()) as typeof message; } catch { return; }
      if (message.id === 1) {
        if (message.error) {
          emit({ ...latest, status: "unavailable", connectionStatus: "disconnected", lastError: message.error.message ?? "X Layer log subscription failed" });
          socket?.close();
        } else {
          subscriptionId = message.result;
          enqueue(backfill);
        }
      }
      if (message.params?.result) enqueue(() => processLog(message.params!.result!));
    });
    socket.on("error", (error) => emit({ ...latest, status: "unavailable", connectionStatus: "disconnected", lastError: errorMessage(error) }));
    socket.on("close", () => {
      subscriptionId = undefined;
      if (heartbeat) clearInterval(heartbeat);
      if (stopped) return;
      if (hadInitialSync && disconnectedAt === null) disconnectedAt = Date.now();
      emit({ ...latest, status: "unavailable", connectionStatus: "disconnected", lastError: "X Layer WebSocket disconnected; reconnecting" });
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
  };
  emit({ ...latest, status: "unavailable", connectionStatus: "connecting", lastError: "Waiting for X Layer WebSocket subscription" });
  connect();
  finalityTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN && subscriptionId) enqueue(refreshFinality);
  }, 5000);
  snapshotTimer = setInterval(() => {
    enqueue(async () => {
      try { await saveSnapshot("rpc_snapshot"); }
      catch (error) { emit({ ...latest, rpcSnapshotStatus: "unavailable", rpcSnapshotError: errorMessage(error) }); }
    });
  }, POOL_SNAPSHOT_INTERVAL_MS);
  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (finalityTimer) clearInterval(finalityTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (socket?.readyState === WebSocket.OPEN && subscriptionId) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_unsubscribe", params: [subscriptionId] }));
    socket?.close();
    await serial;
  };
}

async function validateEvmPool(pool: FixedPoolConfig, url: string, blockNumber: string): Promise<boolean> {
  const calls = [
    { to: pool.address, data: selectors.token0 },
    { to: pool.address, data: selectors.token1 },
    { to: pool.address, data: selectors.fee },
    { to: pool.address, data: selectors.factory },
    { to: pool.baseTokenAddress, data: selectors.decimals },
    { to: pool.quoteTokenAddress, data: selectors.decimals },
  ];
  const values = await Promise.all(calls.map((tx) => evmRpc<string>(url, "eth_call", [tx, blockNumber])));
  const address = (raw: string) => ("0x" + raw.slice(-40)).toLowerCase();
  const token0 = address(values[0]!);
  const token1 = address(values[1]!);
  const base = pool.baseTokenAddress.toLowerCase();
  const quote = pool.quoteTokenAddress.toLowerCase();
  if (!((token0 === base && token1 === quote) || (token0 === quote && token1 === base))) throw new PoolIdentityError("X Layer pool token addresses do not match the fixed-pool allowlist");
  if (Number(BigInt(values[2]!)) !== pool.expectedFee) throw new PoolIdentityError("X Layer pool fee does not match the fixed-pool allowlist");
  if (address(values[3]!) !== pool.expectedFactory!.toLowerCase()) throw new PoolIdentityError("X Layer pool factory does not match the fixed-pool allowlist");
  if (Number(BigInt(values[4]!)) !== pool.baseTokenDecimals || Number(BigInt(values[5]!)) !== pool.quoteTokenDecimals) throw new PoolIdentityError("X Layer token decimals do not match the fixed-pool allowlist");
  return token0 === base;
}

async function startSolanaPool(pool: FixedPoolConfig, options: MonitorOptions): Promise<() => Promise<void>> {
  const endpoint = options.rpcEndpoints?.get(pool.id);
  const wsUrl = endpoint ? endpoint.ws : process.env.SOLANA_RPC_WS;
  const httpUrl = endpoint ? endpoint.http ?? "" : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  if (!wsUrl || !httpUrl) {
    options.onState({ ...initialPoolState(pool, "not_configured", "Solana RPC HTTP/WS endpoint is not configured"), connectionStatus: "not_configured" });
    return async () => undefined;
  }
  let address: string;
  try { address = new PublicKey(pool.address).toBase58(); }
  catch { throw new PoolIdentityError("Solana pool address is not a valid public key"); }
  let socket: WebSocket | undefined;
  let subscriptionId: number | undefined;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let reconnectDelay = 1000;
  let lastPongAt = 0;
  let hadInitialSync = false;
  let disconnectedAt: number | null = null;
  let lastSlot = 0;
  let serial = Promise.resolve();
  let latest = initialPoolState(pool);
  const emit = (state: PoolMonitorState) => {
    if (state.connectionStatus === "unknown" && latest.connectionStatus !== "unknown") state = { ...state, connectionStatus: latest.connectionStatus };
    if (state.rpcSnapshotStatus === "unknown" && latest.rpcSnapshotStatus !== "unknown") state = { ...state, rpcSnapshotStatus: latest.rpcSnapshotStatus };
    if (state.lastRpcSnapshotAt === null) state = { ...state, lastRpcSnapshotAt: latest.lastRpcSnapshotAt };
    if (state.rpcSnapshotError === null) state = { ...state, rpcSnapshotError: latest.rpcSnapshotError };
    if (state.latestHistoryGap === null) state = { ...state, latestHistoryGap: latest.latestHistoryGap };
    if (state.sqrtPriceRaw === null && latest.sqrtPriceRaw !== null) {
      state = { ...latest, status: state.status, lastError: state.lastError, connectionStatus: state.connectionStatus, rpcSnapshotStatus: state.rpcSnapshotStatus, lastRpcSnapshotAt: state.lastRpcSnapshotAt, rpcSnapshotError: state.rpcSnapshotError, latestHistoryGap: state.latestHistoryGap };
    }
    latest = state;
    options.onState(state);
  };
  const enqueue = (work: () => Promise<void>) => {
    serial = serial.then(work).catch((error) => {
      const invalid = error instanceof PoolIdentityError;
      emit({ ...latest, status: invalid ? "invalid" : "unavailable", lastError: errorMessage(error) });
      if (!invalid) socket?.close();
    });
  };
  const processAccount = (data: Buffer, owner: string, slot: number, source: string): boolean => {
    // shortcut: Solana account notifications expose slots but not same-slot ordering; rely on ordered WebSocket delivery unless transaction-level history is required.
    if (slot < lastSlot) return false;
    if (owner !== pool.expectedProgramId) throw new PoolIdentityError("Solana pool owner program does not match the fixed-pool allowlist");
    if (!isRaydiumPoolStateLayout(data)) throw new PoolIdentityError("Raydium CLMM pool account length or discriminator does not match the pinned PoolState layout (" + data.length + " bytes)");
    const mint0 = new PublicKey(data.subarray(73, 105)).toBase58();
    const mint1 = new PublicKey(data.subarray(105, 137)).toBase58();
    const decimals0 = data[233]!;
    const decimals1 = data[234]!;
    const baseIsToken0 = mint0 === pool.baseTokenAddress;
    const matches = (baseIsToken0 && mint1 === pool.quoteTokenAddress) || (mint0 === pool.quoteTokenAddress && mint1 === pool.baseTokenAddress);
    if (!matches) throw new PoolIdentityError("Solana pool mint addresses do not match the fixed-pool allowlist");
    const baseDecimals = baseIsToken0 ? decimals0 : decimals1;
    const quoteDecimals = baseIsToken0 ? decimals1 : decimals0;
    if (baseDecimals !== pool.baseTokenDecimals || quoteDecimals !== pool.quoteTokenDecimals) throw new PoolIdentityError("Solana pool mint decimals do not match the fixed-pool allowlist");
    const liquidity = readU128LE(data, 237);
    const sqrtPrice = readU128LE(data, 253);
    const hash = createHash("sha256").update(data).digest("hex");
    if (slot === lastSlot && hash === latest.accountDataHash) return true;
    emit(makePoolState(pool, sqrtPrice, liquidity, source, baseIsToken0, decimals0, decimals1, undefined, undefined, slot + ":" + hash, slot, undefined, undefined, hash));
    lastSlot = Math.max(lastSlot, slot);
    return true;
  };
  const loadAccountSnapshot = async (source: string): Promise<boolean> => {
    const result = await solanaRpc<{ context: { slot: number }; value: { data: [string, string]; owner: string } | null }>(httpUrl, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    if (!result.value) throw new Error("Solana pool account does not exist");
    if (result.value.data[1] !== "base64") throw new Error("Solana RPC returned an unsupported account encoding");
    const accepted = processAccount(Buffer.from(result.value.data[0], "base64"), result.value.owner, result.context.slot, source);
    if (!accepted) return false;
    emit({ ...latest, rpcSnapshotStatus: "healthy", lastRpcSnapshotAt: Date.now(), rpcSnapshotError: null });
    return true;
  };
  const resync = async () => {
    const reconnecting = hadInitialSync;
    if (!await loadAccountSnapshot(reconnecting ? "resync" : "startup_snapshot")) throw new Error("Solana RPC snapshot is older than the latest observed slot");
    if (reconnecting && disconnectedAt !== null) {
      await options.onHistoryGap(pool.id, disconnectedAt, Date.now(), "websocket_disconnect");
      disconnectedAt = null;
    }
    hadInitialSync = true;
  };
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(wsUrl);
    socket.on("open", () => {
      lastPongAt = Date.now();
      emit({ ...latest, connectionStatus: "connected" });
      socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [address, { commitment: "confirmed", encoding: "base64" }] }));
      heartbeat = setInterval(() => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongAt > 45_000) { socket.terminate(); return; }
        try { socket.ping(); } catch { socket.terminate(); }
      }, 20_000);
    });
    socket.on("pong", () => { lastPongAt = Date.now(); });
    socket.on("message", (raw) => {
      let message: {
        id?: number; result?: number; error?: { message?: string };
        params?: { subscription?: number; result?: { context?: { slot?: number }; value?: { data?: [string, string]; owner?: string } } };
      };
      try { message = JSON.parse(raw.toString()) as typeof message; } catch { return; }
      if (message.id === 1) {
        if (message.error || message.result === undefined) {
          emit({ ...latest, status: "unavailable", connectionStatus: "disconnected", lastError: message.error?.message ?? "Solana account subscription failed" });
          socket?.close();
        } else {
          subscriptionId = message.result;
          enqueue(resync);
        }
      }
      const notification = message.params?.result;
      if (notification && message.params?.subscription === subscriptionId && notification.context?.slot !== undefined && notification.value?.owner && notification.value.data?.[1] === "base64") {
        enqueue(async () => {
          try { processAccount(Buffer.from(notification.value!.data![0], "base64"), notification.value!.owner!, notification.context!.slot!, "account_change"); }
          catch (error) { emit(initialPoolState(pool, error instanceof PoolIdentityError ? "invalid" : "unavailable", errorMessage(error))); }
        });
      }
    });
    socket.on("error", (error) => emit({ ...latest, status: "unavailable", connectionStatus: "disconnected", lastError: errorMessage(error) }));
    socket.on("close", () => {
      subscriptionId = undefined;
      if (heartbeat) clearInterval(heartbeat);
      if (stopped) return;
      if (hadInitialSync && disconnectedAt === null) disconnectedAt = Date.now();
      emit({ ...latest, status: "unavailable", connectionStatus: "disconnected", lastError: "Solana WebSocket disconnected; reconnecting" });
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
  };
  emit({ ...latest, status: "unknown", connectionStatus: "connecting", lastError: "Waiting for Solana account subscription" });
  snapshotTimer = setInterval(() => {
    enqueue(async () => {
      try {
        if (!await loadAccountSnapshot("rpc_snapshot")) emit({ ...latest, rpcSnapshotStatus: "unavailable", rpcSnapshotError: "Solana RPC snapshot is older than the latest observed slot" });
      } catch (error) { emit({ ...latest, rpcSnapshotStatus: "unavailable", rpcSnapshotError: errorMessage(error) }); }
    });
  }, POOL_SNAPSHOT_INTERVAL_MS);
  connect();
  return async () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (socket?.readyState === WebSocket.OPEN && subscriptionId) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "accountUnsubscribe", params: [subscriptionId] }));
    socket?.close();
    await serial;
  };
}

function makePoolState(
  pool: FixedPoolConfig, sqrtPrice: bigint, liquidity: bigint, source: string, baseIsToken0: boolean,
  decimals0: number, decimals1: number, blockNumber?: number, blockHash?: string, fingerprint?: string, slot?: number,
  transactionHash?: string, logIndex?: number, accountDataHash?: string,
): PoolMonitorState {
  if (sqrtPrice <= 0n) throw new PoolIdentityError("Pool sqrt price is zero");
  const token1PerToken0 = new Decimal(sqrtPrice.toString()).div(pool.chainIndex === "196" ? Q96 : Q64).pow(2)
    .mul(new Decimal(10).pow(decimals0 - decimals1));
  const price = baseIsToken0 ? token1PerToken0 : new Decimal(1).div(token1PerToken0);
  return {
    ...initialPoolState(pool, "healthy"), finality: pool.chainIndex === "501" ? "confirmed" : "provisional", source, marginalPrice: price.toSignificantDigits(30).toString(),
    sqrtPriceRaw: sqrtPrice.toString(), liquidityRaw: liquidity.toString(),
    blockNumber: blockNumber ?? null, blockHash: blockHash ?? null, slot: slot ?? null,
    transactionHash: transactionHash ?? null, logIndex: logIndex ?? null, accountDataHash: accountDataHash ?? null,
    eventFingerprint: fingerprint ?? null, observedAt: Date.now(),
  };
}

function readU128LE(data: Buffer, offset: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
}

async function evmRpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("X Layer RPC HTTP " + response.status);
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(payload.error.message ?? "X Layer RPC " + method + " failed");
  return payload.result as T;
}

async function solanaRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await solanaRpcFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Solana RPC HTTP " + response.status);
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? "Solana RPC " + method + " failed");
  return payload.result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
