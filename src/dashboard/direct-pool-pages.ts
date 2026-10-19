import Decimal from "decimal.js";
import type { AssetConfig, Config } from "../config.js";
import { query } from "../db.js";
import type { PoolMonitorState } from "../market/fixed-pools.js";
import { solveDirectPoolCandidates } from "../direct-pool/market-registry.js";
import { positiveWindowCache } from "./positive-window-cache.js";
import {
  collectPositiveWindows,
  directPoolWindowReadStart,
  DIRECT_POOL_POOL_ID_MIGRATION,
  directPoolHref,
  formatUtc8Input,
  formatUtc8Minute,
  isWindowCoverageComplete,
  parseDirectPoolRange,
  parsePageNumber,
  rangeSearchParams,
  type DirectPoolRange,
  type WindowSample,
} from "../direct-pool/windows.js";

type Helpers = {
  escapeHtml: (value: unknown) => string;
  formatUtc8: (value: Date | string | number | null | undefined) => string;
  formatReportDecimal: (value: string | null, significantDigits?: number) => string;
  formatRawTokenAmount: (value: string | null, decimals: number, multiplier?: string) => string;
  directQuoteAssetUiMultiplier: (rawResponse: unknown) => string;
  fixedPoolPanel: (pools: PoolMonitorState[] | undefined) => string;
};

type PageOptions = {
  url: URL;
  config: Config;
  assets: AssetConfig[];
  dbOnline: boolean;
  fixedPools: PoolMonitorState[] | undefined;
  helpers: Helpers;
};

type DecisionRow = {
  id: number; instrument_id: string; chain_index: string; pool_id: string | null; direction: string; size_usdt: string;
  selected_quote_id: number | null; cex_vwap: string | null; gross_profit_usdt: string | null; cex_fee_usdt: string | null;
  gas_budget_usdt: string | null; net_profit_usdt: string | null; roi: string | null; valuation_status: string;
  decision_status: string; block_reason: string | null; execution_status: string; simulation_status: string; simulation_reason: string | null; created_at: Date;
};
type QuoteRow = {
  id: number; instrument_id: string; chain_index: string; pool_id: string; dex: string; direction: string;
  amount_in_raw: string | null; amount_out_raw: string | null; quoted_at: Date | null; request_ms: number | null;
  status: string; failure_reason: string | null; raw_response: unknown; net_profit_usdt: string | null; roi: string | null;
  valuation_status: string | null;
};
type StatRow = { positive: number; valid: number; max_net: string | null };
type CountRow = { total: number };
type DirectionAuditSummaryRow = {
  instrument_id: string; chain_index: string; size_usdt: string;
  cex_pool_id: string | null; dex_pool_id: string | null;
  comparable_samples: string; cex_only_positive: string; dex_only_positive: string;
  both_positive: string; neither_positive: string; incomplete_samples: string;
  average_net_delta_usdt: string | null;
};
type OffsetRow = { offset_seconds: number };
type MigrationRow = { applied_at: Date };

const pageSize = 20;
const validEstimateSql = "net_profit_usdt IS NOT NULL AND valuation_status NOT LIKE 'INVALIDATED_%'";
const actualTime = (stored: Date, offsetSeconds: number) => new Date(stored.getTime() - offsetSeconds * 1000);
const storedTime = (utc: Date, offsetSeconds: number) => new Date(utc.getTime() + offsetSeconds * 1000);
const fixedRange = (range: DirectPoolRange): DirectPoolRange => ({ from: range.from, to: range.to, preset: "custom", invalid: false });
const isInvalidated = (status: string | null) => status?.startsWith("INVALIDATED_") ?? false;
function formatWindowSpan(startAt: Date, lastObservedAt: Date): string {
  const seconds = Math.max(0, Math.floor((lastObservedAt.getTime() - startAt.getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}小时${minutes}分` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}
export const directPoolSimulationLabel = (status: string | null | undefined): string => ({
  NOT_REQUESTED: "未请求", NOT_APPLICABLE: "不适用", DISABLED: "未开启", NOT_QUALIFIED: "未达触发条件",
  COOLDOWN: "冷却中", SKIPPED: "已跳过", PASSED: "模拟通过", FAILED: "模拟失败",
} as Record<string, string>)[status ?? ""] ?? status ?? "未知";
export const directPoolDexLabel = (dex: string | null | undefined): string => ({
  uniswap_v3_xlayer: "Uniswap V3", raydium_clmm_solana: "Raydium CLMM", orca_whirlpool_solana: "Orca Whirlpool", meteora_dlmm_solana: "Meteora DLMM", byreal_clmm_solana: "Byreal CLMM",
} as Record<string, string>)[dex ?? ""] ?? dex ?? "未知";

type DecisionFilters = { positiveOnly: boolean; assetPool: string; direction: string; poolId: string };

function decisionFilterParams(filters?: DecisionFilters): Record<string, string> {
  return filters ? {
    ...(filters.poolId ? { pool: filters.poolId } : {}),
    ...(filters.positiveOnly ? { profit: "positive" } : {}),
    ...(filters.assetPool ? { assetPool: filters.assetPool } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
  } : {};
}

function subNav(path: string, range: DirectPoolRange, poolId: string, filters?: DecisionFilters): string {
  const items: Array<[string, string]> = [["/direct-pools", "收益总览"], ["/direct-pools/quotes", "报价记录"], ["/direct-pools/decisions", "收益明细"]];
  return `<nav class="direct-subnav" aria-label="指定池收益页面">${items.map(([href, label]) => `<a href="${directPoolHref(href, range, { ...(poolId ? { pool: poolId } : {}), ...(href === path ? decisionFilterParams(filters) : {}) })}"${path === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function directionControl(direction: string): string {
  return `<label>交易方向<select name="direction"><option value="">全部方向</option><option value="cex_buy_dex_sell"${direction === "cex_buy_dex_sell" ? " selected" : ""}>CEX 买入 · DEX 卖出</option><option value="dex_buy_cex_sell"${direction === "dex_buy_cex_sell" ? " selected" : ""}>DEX 买入 · CEX 卖出</option></select></label>`;
}

function rangeControl(path: string, range: DirectPoolRange, poolId: string, pools: Config["marketRegistry"]["pools"], escapeHtml: Helpers["escapeHtml"], filters?: DecisionFilters, windowDirection = ""): string {
  const positiveOnly = filters?.positiveOnly ?? false;
  const knownPool = pools.some((pool) => pool.id === poolId);
  const poolOptions = pools.map((pool) => {
    const address = pool.address.length > 14 ? `${pool.address.slice(0, 7)}…${pool.address.slice(-5)}` : pool.address;
    const label = `${pool.instrument_id} · ${directPoolDexLabel(pool.dex)} · ${address}${pool.enabled ? "" : " · 已关闭"}`;
    return `<option value="${escapeHtml(pool.id)}"${poolId === pool.id ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  const missingPool = poolId && !knownPool ? `<option value="${escapeHtml(poolId)}" selected>未登记 / 历史池 · ${escapeHtml(poolId.length > 20 ? `${poolId.slice(0, 8)}…${poolId.slice(-6)}` : poolId)}</option>` : "";
  const poolField = `<label>池子<select name="pool"><option value=""${poolId ? "" : " selected"}>所有池</option>${poolOptions}${missingPool}</select></label>`;
  const decisionFields = filters ? `<label>资产 / 池地址<input type="search" name="assetPool" value="${escapeHtml(filters.assetPool)}" maxlength="128" placeholder="输入资产代码或池地址片段"></label>${directionControl(filters.direction)}` : path === "/direct-pools/windows" ? directionControl(windowDirection) : "";
  const dateTimeField = (name: "from" | "to", label: string, date: Date) => {
    return `<input class="direct-datetime-input" type="datetime-local" name="${name}" step="1" value="${escapeHtml(formatUtc8Input(date))}" aria-label="${label}（UTC+8）">`;
  };
  return `<form class="direct-range direct-range-improved" action="${path}" method="get">${positiveOnly ? '<input type="hidden" name="profit" value="positive">' : ""}<label class="direct-range-preset">时间范围<select name="range"><option value="5m"${range.preset === "5m" ? " selected" : ""}>最近 5 分钟</option><option value="1h"${range.preset === "1h" ? " selected" : ""}>最近 1 小时</option><option value="24h"${range.preset === "24h" ? " selected" : ""}>最近 24 小时</option><option value="custom"${range.preset === "custom" ? " selected" : ""}>自定义时间</option></select></label><div class="direct-custom-range"><span class="direct-range-label">时间区间（UTC+8）</span><div class="direct-range-control">${dateTimeField("from", "开始时间", range.from)}<span class="direct-range-separator" aria-hidden="true">~</span>${dateTimeField("to", "结束时间", range.to)}<button class="direct-range-calendar" type="button" aria-label="编辑自定义时间"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 3v3M13.5 3v3M3.5 8h13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></div></div>${poolField}${decisionFields}<button type="submit">应用筛选</button></form>
  <script>
    (() => {
      const form = document.currentScript.previousElementSibling;
      const preset = form.querySelector('[name="range"]');
      const panel = form.querySelector('.direct-custom-range');
      const sync = () => {
        const active = preset.value === "custom";
        panel.classList.toggle("is-disabled", !active);
        panel.querySelectorAll(".direct-datetime-input").forEach((input) => { input.required = active; input.disabled = !active; });
      };
      preset.addEventListener("change", sync);
      sync();
      panel.querySelector(".direct-range-calendar").addEventListener("click", () => {
        preset.value = "custom";
        sync();
        const picker = panel.querySelector(".direct-datetime-input");
        if (typeof picker.showPicker === "function") picker.showPicker();
        else picker.focus();
      });
      panel.querySelectorAll(".direct-datetime-input").forEach((picker) => picker.addEventListener("click", () => {
        if (typeof picker.showPicker === "function") {
          try { picker.showPicker(); } catch {}
        }
      }));
    })();
  </script>
  <style>
    .direct-range.direct-range-improved{align-items:flex-end;flex-wrap:wrap;gap:12px;margin:0 0 16px}
    .direct-range.direct-range-improved label{display:grid;gap:6px;color:#53627a;font-size:12px;font-weight:600}
    .direct-range.direct-range-improved select,.direct-range.direct-range-improved input{box-sizing:border-box;height:40px;padding:0 11px;border:1px solid #d5deeb;border-radius:8px;background:#fff;color:#26364f;font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
    .direct-range.direct-range-improved select{min-width:180px;cursor:pointer}
    .direct-range.direct-range-improved input{width:100%;min-width:0;font-variant-numeric:tabular-nums}
    .direct-range.direct-range-improved .direct-custom-range{display:grid;gap:6px;flex:0 1 auto;min-width:0;padding:0;border:0;border-radius:0;background:transparent}
    .direct-range.direct-range-improved .direct-range-label{color:#53627a;font-size:12px;font-weight:600}
    .direct-range.direct-range-improved .direct-custom-range.is-disabled .direct-datetime-input{opacity:.55}
    .direct-range.direct-range-improved .direct-range-control{box-sizing:border-box;display:flex;align-items:center;width:460px;max-width:100%;height:40px;padding:0 8px;border:1px solid #d5deeb;border-radius:8px;background:#fff;transition:border-color .15s,box-shadow .15s}
    .direct-range.direct-range-improved .direct-range-control:focus-within{border-color:#6b93dc;box-shadow:0 0 0 3px #9bb9f433}
    .direct-range.direct-range-improved .direct-datetime-input{flex:1 1 0;width:0;min-width:0;height:34px;padding:0 4px;border:0;border-radius:5px;background:transparent;font-size:12px;cursor:pointer}
    .direct-range.direct-range-improved .direct-datetime-input::-webkit-calendar-picker-indicator{display:none}
    .direct-range.direct-range-improved .direct-datetime-input:focus{outline:0}
    .direct-range.direct-range-improved .direct-range-separator{padding:0 5px;color:#758198}
    .direct-range.direct-range-improved .direct-range-calendar{display:grid;place-items:center;flex:0 0 28px;width:28px;height:34px;margin-left:auto;padding:0;border:0;border-left:1px solid #e8edf4;border-radius:0;background:transparent;color:#71809a;cursor:pointer}
    .direct-range.direct-range-improved .direct-range-calendar svg{width:18px;height:18px}
    .direct-range.direct-range-improved .direct-range-calendar:hover{background:#f2f6fc;color:#315fba}
    .direct-range.direct-range-improved button{height:40px;padding:0 18px;border:0;border-radius:8px;background:#315fba;color:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .direct-range.direct-range-improved button:hover{background:#274f9f}
    .direct-range.direct-range-improved select:focus-visible,.direct-range.direct-range-improved input:focus-visible,.direct-range.direct-range-improved button:focus-visible{outline:3px solid #9bb9f4;outline-offset:2px}
    @media(max-width:700px){.direct-range.direct-range-improved{align-items:stretch;flex-direction:column}.direct-range.direct-range-improved select{width:100%}.direct-range.direct-range-improved .direct-custom-range{width:100%;flex:auto}.direct-range.direct-range-improved .direct-range-control{width:100%;box-sizing:border-box}.direct-range.direct-range-improved .direct-datetime-input{font-size:11px}.direct-range.direct-range-improved button{width:100%}.direct-range.direct-range-improved .direct-range-control>.direct-range-calendar{width:28px;flex-basis:28px}}
  </style>`;
}

function pagination(path: string, range: DirectPoolRange, page: number, total: number, label: string, extra?: Record<string, string>): string {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const previous = page > 1 ? `<a href="${directPoolHref(path, range, { ...extra, page: String(page - 1) })}">上一页</a>` : "";
  const next = page < totalPages ? `<a href="${directPoolHref(path, range, { ...extra, page: String(page + 1) })}">下一页</a>` : "";
  const params = rangeSearchParams(range);
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  const hidden = [...params].map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`).join("");
  const jump = `<form class="pagination-jump" action="${path}" method="get" style="display:flex;align-items:center;gap:6px;margin:0">${hidden}<label>跳至第 <input type="number" name="page" value="${page}" min="1" max="${totalPages}" step="1" required aria-label="跳转到页码" style="width:68px;padding:5px 7px"> / ${totalPages} 页</label><button type="submit">跳转</button></form>`;
  return `<nav class="direct-pagination" aria-label="${label}"><span>第 ${page} / ${totalPages} 页 · 共 ${total} 条 · 每页 ${pageSize} 条</span><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${previous}${next}${jump}</div></nav>`;
}

function pageStyle(): string {
  return `<style>.direct-subnav{display:flex;gap:8px;margin:12px 0 18px}.direct-subnav a{padding:7px 10px;border-radius:7px;text-decoration:none;color:#53627a}.direct-subnav a[aria-current="page"]{background:#e9eef8;color:#234a87;box-shadow:inset 0 -2px #315fba}.direct-range{display:flex;align-items:flex-end;gap:8px;margin:0 0 16px}.direct-range label{display:grid;gap:4px;font-size:12px}.direct-custom-range{position:relative;padding:7px 10px;border:1px solid #d8dfeb;border-radius:7px;background:#fff;color:#53627a;font-size:12px}.direct-custom-range summary{cursor:pointer}.direct-custom-range>div{display:flex;gap:8px;padding-top:8px}.direct-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.direct-cards article{min-height:92px;padding:14px 16px;border:1px solid #e5eaf2;border-radius:10px;background:#f9fbfe}.direct-cards>article>small{display:block;color:#758198;font-size:12px}.direct-cards>article>strong{display:block;margin-top:9px;font-size:22px;line-height:1.15;font-variant-numeric:tabular-nums}.direct-cards .window-card{display:flex;flex-direction:column}.direct-cards .window-card .coverage-status{display:inline-flex;align-self:flex-start;margin-top:10px;padding:4px 8px;border-radius:999px;background:#fff1e9;color:#b45722;font-size:13px;font-weight:650;line-height:1.15}.direct-cards .window-card .coverage-start{margin-top:7px;color:#65738a;font-size:11px;line-height:1.45}.direct-pool-status{padding:0}.direct-pool-status>summary{padding:14px 16px;cursor:pointer}.direct-pool-status>summary small{margin-left:8px;color:#758198;font-weight:400}.direct-pool-summary{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px}.direct-pool-summary span{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:6px 9px;border:1px solid #e5eaf2;border-radius:7px;background:#f9fbfe;font-size:12px}.direct-pool-summary strong{color:#315fba}.direct-pool-summary code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.direct-pool-summary em{font-style:normal;color:#65738a}.direct-pool-status .fixed-pools{margin:0;border-radius:0;border-width:1px 0 0}.direct-pool-status .fixed-pools h2{font-size:17px}.direct-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 2px;color:#758198;font-size:12px}.direct-pagination>div{display:flex;gap:8px}.direct-pagination a{padding:6px 10px;border:1px solid #dfe5ef;border-radius:7px;background:#fff;text-decoration:none}.profit-positive{color:#13815c}.profit-negative{color:#b42318}.direct-record-note{font-size:12px;color:#65738a}.direct-record-table small{display:block;margin-top:3px;color:#758198;font-size:11px}.direct-decision-table{table-layout:fixed;min-width:720px}.direct-decision-table th,.direct-decision-table td{white-space:normal;overflow-wrap:anywhere}.direct-decision-table th:nth-child(1){width:16%}.direct-decision-table th:nth-child(2){width:22%}.direct-decision-table th:nth-child(3){width:15%}.direct-decision-table th:nth-child(4){width:10%}.direct-decision-table th:nth-child(5){width:20%}.direct-decision-table th:nth-child(6){width:17%}@media(max-width:700px){.direct-range{align-items:stretch}.direct-custom-range>div{flex-direction:column}}</style>`;
}

function decisionProfit(row: DecisionRow, helpers: Helpers): { text: string; className: string } {
  if (isInvalidated(row.valuation_status)) return { text: "估值失效", className: "" };
  if (row.net_profit_usdt === null) return { text: "未估算", className: "" };
  const text = `${helpers.formatReportDecimal(row.net_profit_usdt, 6)} USDT${row.roi === null ? "" : ` · ${helpers.formatReportDecimal(new Decimal(row.roi).mul(100).toString(), 4)}%`}`;
  return { text, className: new Decimal(row.net_profit_usdt).gt(0) ? "profit-positive" : row.net_profit_usdt === "0" ? "" : "profit-negative" };
}

function correctedDecision(row: DecisionRow, offsetSeconds: number): DecisionRow {
  return { ...row, created_at: actualTime(row.created_at, offsetSeconds) };
}

async function databaseOffset(): Promise<number> {
  const [row] = await query<OffsetRow[]>("SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), CURRENT_TIMESTAMP(3)) offset_seconds");
  return Number(row?.offset_seconds ?? 0);
}

export async function renderDirectPoolPage(options: PageOptions): Promise<string> {
  const { url, config, assets, dbOnline, fixedPools, helpers } = options;
  const { escapeHtml, formatUtc8, formatReportDecimal, formatRawTokenAmount, directQuoteAssetUiMultiplier, fixedPoolPanel } = helpers;
  const path = url.pathname;
  const range = parseDirectPoolRange(url.searchParams);
  const poolId = (url.searchParams.get("pool") ?? "").trim().slice(0, 128);
  const requestedDirection = url.searchParams.get("direction");
  const selectedDirection = requestedDirection === "cex_buy_dex_sell" || requestedDirection === "dex_buy_cex_sell" ? requestedDirection : "";
  const filters: DecisionFilters | undefined = path === "/direct-pools/decisions" ? {
    positiveOnly: url.searchParams.get("profit") === "positive",
    assetPool: (url.searchParams.get("assetPool") ?? "").trim().slice(0, 128),
    direction: selectedDirection,
    poolId,
  } : undefined;
  const windowDirection = path === "/direct-pools/windows" ? selectedDirection : "";
  const positiveOnly = filters?.positiveOnly ?? false;
  const filterParams = decisionFilterParams(filters);
  const invalidRange = range.invalid ? '<p class="guard-alert">时间范围无效，已回退为最近 1 小时。</p>' : "";
  const positiveShortcut = path === "/direct-pools" ? `<p><a href="${directPoolHref("/direct-pools/decisions", range, { ...(poolId ? { pool: poolId } : {}), profit: "positive" })}">查看逐条正收益观测样本 →</a></p>` : "";
  const header = path === "/direct-pools/window"
    ? `<h2>正收益窗口样本</h2><p><a href="${directPoolHref("/direct-pools", range, poolId ? { pool: poolId } : undefined)}">← 返回收益总览</a></p>`
    : path === "/direct-pools/windows"
      ? `<h2>全部正收益窗口</h2><p><a href="${directPoolHref("/direct-pools", range, poolId ? { pool: poolId } : undefined)}">← 返回收益总览</a></p>${rangeControl(path, range, poolId, config.marketRegistry.pools, escapeHtml, undefined, windowDirection)}${invalidRange}`
    : `<h2>${path === "/direct-pools/quotes" ? "Exact-In 报价记录" : path === "/direct-pools/decisions" ? "收益明细" : "指定池收益总览"}</h2>${subNav(path, range, poolId, filters)}${rangeControl(path, range, poolId, config.marketRegistry.pools, escapeHtml, filters)}${positiveShortcut}${invalidRange}`;
  if (!dbOnline) return `${header}<p class="guard-alert">数据库不可用，暂时无法读取 Direct Pool 观察数据。</p>${pageStyle()}`;

  let offsetSeconds: number;
  try { offsetSeconds = await databaseOffset(); } catch { return `${header}<p class="guard-alert">指定池数据表尚不可用；请先执行 npm run db:migrate。</p>${pageStyle()}`; }
  const fromStored = storedTime(range.from, offsetSeconds);
  const toStored = storedTime(range.to, offsetSeconds);

  try {
    if (path === "/direct-pools/window") {
      const fromMsValue = url.searchParams.get("window_from_ms") ?? "";
      const toMsValue = url.searchParams.get("window_to_ms") ?? "";
      const instrumentId = (url.searchParams.get("window_instrument") ?? "").trim().slice(0, 32);
      const chainIndex = (url.searchParams.get("window_chain") ?? "").trim().slice(0, 16);
      const windowPoolId = (url.searchParams.get("pool") ?? "").trim().slice(0, 128);
      const direction = url.searchParams.get("direction") ?? "";
      const sizeUsdt = (url.searchParams.get("window_size") ?? "").trim();
      const closedValue = url.searchParams.get("window_closed") ?? "";
      const firstId = url.searchParams.get("window_first_id") ?? "";
      const lastId = url.searchParams.get("window_last_id") ?? "";
      const positiveCountValue = url.searchParams.get("window_positive_count") ?? "";
      const positiveCount = Number(positiveCountValue);
      const validSize = sizeUsdt.length <= 31 && /^\d+(?:\.\d{1,12})?$/.test(sizeUsdt) && new Decimal(sizeUsdt).gt(0);
      const validIds = /^\d{1,20}$/.test(firstId) && /^\d{1,20}$/.test(lastId)
        && (firstId.length < lastId.length || firstId.length === lastId.length && firstId <= lastId);
      const fromMs = Number(fromMsValue);
      const toMs = Number(toMsValue);
      const closed = closedValue === "1";
      const validWindow = /^\d{13}$/.test(fromMsValue) && /^\d{13}$/.test(toMsValue)
        && Number.isSafeInteger(fromMs) && Number.isSafeInteger(toMs) && (closed ? fromMs <= toMs : fromMs < toMs)
        && instrumentId !== "" && chainIndex !== "" && windowPoolId !== ""
        && (closedValue === "0" || closedValue === "1")
        && (direction === "cex_buy_dex_sell" || direction === "dex_buy_cex_sell") && validSize && validIds
        && /^\d{1,9}$/.test(positiveCountValue) && Number.isSafeInteger(positiveCount);
      if (!validWindow) return `${header}<p class="guard-alert">窗口参数无效，请从收益总览重新打开。</p>${pageStyle()}`;
      const from = new Date(fromMs);
      const to = new Date(toMs);
      const page = parsePageNumber(url.searchParams.get("page"));
      const windowWhere = "id >= ? AND id <= ? AND instrument_id = ? AND chain_index = ? AND pool_id = ? AND direction = ? AND size_usdt = ?";
      const windowParameters = [firstId, lastId, instrumentId, chainIndex, windowPoolId, direction, sizeUsdt];
      const [rows, countRows] = await Promise.all([
        query<DecisionRow[]>(`SELECT id,instrument_id,chain_index,pool_id,direction,CAST(size_usdt AS CHAR) size_usdt,selected_quote_id,CAST(cex_vwap AS CHAR) cex_vwap,CAST(gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(gas_budget_usdt AS CHAR) gas_budget_usdt,CAST(net_profit_usdt AS CHAR) net_profit_usdt,CAST(roi AS CHAR) roi,valuation_status,decision_status,block_reason,execution_status,simulation_status,simulation_reason,created_at FROM direct_pool_decision WHERE ${windowWhere} ORDER BY created_at ASC,id ASC LIMIT ? OFFSET ?`, [...windowParameters, pageSize + 1, (page - 1) * pageSize]),
        query<CountRow[]>(`SELECT COUNT(*) total FROM direct_pool_decision WHERE ${windowWhere}`, windowParameters),
      ]);
      const total = Number(countRows[0]?.total ?? 0);
      const windowParams = {
        pool: windowPoolId, direction, window_instrument: instrumentId, window_chain: chainIndex, window_size: sizeUsdt,
        window_from_ms: fromMsValue, window_to_ms: toMsValue, window_closed: closed ? "1" : "0", window_first_id: firstId, window_last_id: lastId, window_positive_count: positiveCountValue,
      };
      const recordRows = rows.slice(0, pageSize).map((raw) => {
        const row = correctedDecision(raw, offsetSeconds);
        const profit = decisionProfit(row, helpers);
        const positive = !isInvalidated(row.valuation_status) && row.net_profit_usdt !== null && new Decimal(row.net_profit_usdt).gt(0);
        const included = positive ? "计入正收益窗口指标" : row.net_profit_usdt !== null && !isInvalidated(row.valuation_status) ? "非正收益，仅用于连续性判断" : "无有效收益估值，不计入窗口判断";
        const quote = row.selected_quote_id === null ? "原始报价已过保留期或未关联" : `<a href="${directPoolHref("/direct-pools/quote", range, { id: String(row.selected_quote_id), back: "window", ...windowParams, ...(page > 1 ? { page: String(page) } : {}) })}">报价拆分详情 →</a>`;
        return `<tr><td>${escapeHtml(formatUtc8(row.created_at))}</td><td class="numeric ${profit.className}"><strong>${escapeHtml(profit.text)}</strong></td><td class="numeric">${escapeHtml(row.cex_vwap === null ? "—" : formatReportDecimal(row.cex_vwap, 8))}</td><td class="numeric">${escapeHtml(row.gross_profit_usdt === null ? "—" : `${formatReportDecimal(row.gross_profit_usdt, 6)} USDT`)}</td><td class="numeric">${escapeHtml(row.cex_fee_usdt === null ? "—" : `${formatReportDecimal(row.cex_fee_usdt, 6)} USDT`)}</td><td class="numeric">${escapeHtml(row.gas_budget_usdt === null ? "—" : `${formatReportDecimal(row.gas_budget_usdt, 6)} USDT`)}</td><td>${escapeHtml(included)}<small>${escapeHtml(row.decision_status)} · ${escapeHtml(row.valuation_status)} · ${escapeHtml(row.execution_status)}${row.block_reason ? ` · ${escapeHtml(row.block_reason)}` : ""}</small></td><td>${quote}</td></tr>`;
      }).join("");
      const directionLabel = direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出";
      return `${header}<div class="window-detail-meta"><div><small>资产</small><strong>${escapeHtml(instrumentId)}</strong></div><div><small>链 / 池</small><strong>${escapeHtml(chainIndex)} · ${escapeHtml(windowPoolId)}</strong></div><div><small>方向</small><strong>${escapeHtml(directionLabel)}</strong></div><div><small>规模</small><strong>${escapeHtml(formatReportDecimal(sizeUsdt, 8))} USDT</strong></div><div><small>正收益样本数</small><strong>${positiveCount}</strong></div><div class="window-range"><small>窗口范围（UTC+8）</small><strong>${escapeHtml(formatUtc8(from))} 至 ${escapeHtml(formatUtc8(to))}${closed ? " · 结束确认时间" : " · 当前查询截止"}</strong></div></div><p class="window-detail-note">按时间正序展示窗口内的收益观测。正收益样本计入窗口指标；零/负收益样本用于连续性判断；无法估值样本仅供诊断。结果是观察估算，不代表可成交或实际收益。</p><section class="overview"><div class="section-heading"><h3>窗口内全部样本</h3><span>每页 20 条</span></div><div class="table-wrap"><table class="direct-record-table window-sample-table"><thead><tr><th>时间（UTC+8）</th><th>净收益 / ROI</th><th>CEX VWAP</th><th>毛收益</th><th>CEX 手续费</th><th>Gas 预算</th><th>窗口统计 / 状态</th><th>详情</th></tr></thead><tbody>${recordRows || `<tr><td class="window-sample-empty" colspan="8">${positiveCount ? `明细查询未返回记录，但摘要统计有 ${positiveCount} 个正收益样本。` : "该窗口没有可显示的收益样本。"}</td></tr>`}</tbody></table></div>${pagination(path, range, page, total, "窗口收益样本分页", windowParams)}</section>${pageStyle()}<style>.window-detail-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:16px 0;padding:14px 16px;border:1px solid #e5eaf2;border-radius:10px;background:#fff}.window-detail-meta>div{min-width:0}.window-detail-meta small{display:block;margin-bottom:3px;color:#758198;font-size:11px}.window-detail-meta strong{display:block;overflow-wrap:anywhere;color:#26364f;font-size:13px}.window-detail-meta .window-range{grid-column:1/-1}.window-detail-note{margin:0 0 14px;color:#65738a;font-size:12px;line-height:1.55}.window-sample-table{table-layout:fixed;min-width:1040px}.window-sample-table th,.window-sample-table td{padding:10px 8px;white-space:normal;overflow-wrap:anywhere;line-height:1.45}.window-sample-table th:nth-child(1){width:14%}.window-sample-table th:nth-child(2){width:15%}.window-sample-table th:nth-child(3){width:11%}.window-sample-table th:nth-child(4){width:11%}.window-sample-table th:nth-child(5){width:12%}.window-sample-table th:nth-child(6){width:10%}.window-sample-table th:nth-child(7){width:20%}.window-sample-table th:nth-child(8){width:7%}.window-sample-empty{padding:22px!important;color:#65738a;text-align:center!important}@media(max-width:700px){.window-detail-meta{grid-template-columns:1fr 1fr}.window-sample-table{min-width:960px}}</style>`;
    }

    if (path === "/direct-pools/quotes") {
      const page = parsePageNumber(url.searchParams.get("page"));
      const poolPredicate = poolId ? " AND q.pool_id = ?" : "";
      const quoteWhere = `((q.quoted_at >= ? AND q.quoted_at < ?) OR (q.quoted_at IS NULL AND q.created_at >= ? AND q.created_at < ?))${poolPredicate}`;
      const quoteParameters = [range.from, range.to, fromStored, toStored, ...(poolId ? [poolId] : [])];
      const [rows, countRows] = await Promise.all([
        query<QuoteRow[]>(`SELECT q.id,q.instrument_id,q.chain_index,q.pool_id,q.dex,q.direction,q.amount_in_raw,q.amount_out_raw,q.quoted_at,q.request_ms,q.status,q.failure_reason,q.raw_response,CAST(d.net_profit_usdt AS CHAR) net_profit_usdt,CAST(d.roi AS CHAR) roi,d.valuation_status FROM direct_pool_quote q LEFT JOIN direct_pool_decision d ON d.selected_quote_id=q.id WHERE ${quoteWhere} ORDER BY q.id DESC LIMIT ? OFFSET ?`, [...quoteParameters, pageSize + 1, (page - 1) * pageSize]),
        query<CountRow[]>(`SELECT COUNT(*) total FROM direct_pool_quote q WHERE ${quoteWhere}`, quoteParameters),
      ]);
      const total = Number(countRows[0]?.total ?? 0);
      const visible = rows.slice(0, pageSize);
      const tooOld = range.from.getTime() < Date.now() - config.marketdata.directQuoteRetentionDays * 86_400_000;
      const recordRows = visible.map((row) => {
        const pool = config.marketRegistry.pools.find((item) => item.id === row.pool_id);
        const monitor = fixedPools?.find((item) => item.poolId === row.pool_id);
        const assetMultiplier = pool?.chain === "solana" ? directQuoteAssetUiMultiplier(row.raw_response) : "1";
        const inputIsAsset = row.direction === "cex_buy_dex_sell";
        const asset = monitor?.baseTokenSymbol ?? pool?.instrument_id ?? "asset";
        const quote = monitor?.quoteTokenSymbol ?? "quote";
        const amounts = pool ? `${formatRawTokenAmount(row.amount_in_raw, inputIsAsset ? pool.token_in_out.asset_decimals : pool.token_in_out.quote_decimals, inputIsAsset ? assetMultiplier : "1")} ${inputIsAsset ? asset : quote} → ${formatRawTokenAmount(row.amount_out_raw, inputIsAsset ? pool.token_in_out.quote_decimals : pool.token_in_out.asset_decimals, inputIsAsset ? "1" : assetMultiplier)} ${inputIsAsset ? quote : asset}` : "—";
        const invalidated = isInvalidated(row.valuation_status);
        const profit = invalidated || row.net_profit_usdt === null ? "—" : `${formatReportDecimal(row.net_profit_usdt, 6)} USDT${row.roi === null ? "" : ` · ${formatReportDecimal(new Decimal(row.roi).mul(100).toString(), 4)}%`}`;
        const detail = directPoolHref("/direct-pools/quote", range, { id: String(row.id), ...(poolId ? { pool: poolId } : {}), ...(page > 1 ? { page: String(page) } : {}) });
        return `<tr><td>${escapeHtml(formatUtc8(row.quoted_at))}</td><td><strong>${escapeHtml(row.instrument_id)}</strong><small>${escapeHtml(row.pool_id)} · ${escapeHtml(directPoolDexLabel(row.dex))}</small></td><td>${escapeHtml(row.direction)}</td><td class="numeric">${escapeHtml(amounts)}</td><td>${row.status === "OK" ? `<span class="badge ${invalidated ? "unhealthy" : "fresh"}">${invalidated ? "估值失效" : "已报价"}</span>` : `<span class="badge unhealthy">失败</span><small>${escapeHtml(row.failure_reason ?? "报价失败")}</small>`}</td><td class="numeric">${escapeHtml(profit)}</td><td><a href="${detail}">详情 →</a></td></tr>`;
      }).join("");
      return `${header}${tooOld ? `<p class="guard-alert">报价原始记录只保留 ${config.marketdata.directQuoteRetentionDays} 天；所选范围可能早于可用数据。</p>` : ""}<p class="direct-record-note">Exact-In 成功与失败报价；原始响应只在详情页显示。</p><section class="overview"><div class="table-wrap"><table class="direct-record-table"><thead><tr><th>时间 <small>(UTC+8)</small></th><th>路线</th><th>方向</th><th>输入 → 输出</th><th>状态</th><th>净收益 / ROI</th><th></th></tr></thead><tbody>${recordRows || '<tr><td colspan="7">当前范围没有报价记录。</td></tr>'}</tbody></table></div>${pagination(path, range, page, total, "报价记录分页", poolId ? { pool: poolId } : undefined)}</section>${pageStyle()}`;
    }

    if (path === "/direct-pools/decisions") {
      const page = parsePageNumber(url.searchParams.get("page"));
      const decisionPredicates: string[] = [];
      const decisionParameters: Array<string | number | Date> = [fromStored, toStored];
      if (poolId) {
        decisionPredicates.push("pool_id = ?");
        decisionParameters.push(poolId);
      }
      if (filters!.assetPool) {
        decisionPredicates.push("(instrument_id LIKE ? ESCAPE '!' OR pool_id LIKE ? ESCAPE '!')");
        const search = `%${filters!.assetPool.replace(/[!%_]/g, (character) => `!${character}`)}%`;
        decisionParameters.push(search, search);
      }
      if (filters!.direction) {
        decisionPredicates.push("direction = ?");
        decisionParameters.push(filters!.direction);
      }
      if (positiveOnly) decisionPredicates.push(`${validEstimateSql} AND net_profit_usdt > 0`);
      const filterSql = decisionPredicates.map((predicate) => ` AND ${predicate}`).join("");
      const [rows, countRows] = await Promise.all([
        query<DecisionRow[]>(`SELECT id,instrument_id,chain_index,pool_id,direction,CAST(size_usdt AS CHAR) size_usdt,selected_quote_id,CAST(cex_vwap AS CHAR) cex_vwap,CAST(gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(gas_budget_usdt AS CHAR) gas_budget_usdt,CAST(net_profit_usdt AS CHAR) net_profit_usdt,CAST(roi AS CHAR) roi,valuation_status,decision_status,block_reason,execution_status,simulation_status,simulation_reason,created_at FROM direct_pool_decision WHERE created_at >= ? AND created_at < ?${filterSql} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [...decisionParameters, pageSize + 1, (page - 1) * pageSize]),
        query<CountRow[]>(`SELECT COUNT(*) total FROM direct_pool_decision WHERE created_at >= ? AND created_at < ?${filterSql}`, decisionParameters),
      ]);
      const total = Number(countRows[0]?.total ?? 0);
      const recordRows = rows.slice(0, pageSize).map((raw) => {
        const row = correctedDecision(raw, offsetSeconds);
        const profit = decisionProfit(row, helpers);
        const quoteLink = row.selected_quote_id === null ? (row.net_profit_usdt === null && !isInvalidated(row.valuation_status) ? "无关联报价" : "原始报价已过保留期") : `<a href="${directPoolHref("/direct-pools/quote", range, { id: String(row.selected_quote_id), back: "decisions", ...filterParams, ...(page > 1 ? { page: String(page) } : {}) })}">报价详情 →</a>`;
        const quote = `${quoteLink}<small>模拟：${escapeHtml(directPoolSimulationLabel(row.simulation_status))}${row.simulation_reason ? ` · ${escapeHtml(row.simulation_reason)}` : ""}</small>`;
        const direction = row.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出";
        return `<tr><td>${escapeHtml(formatUtc8(row.created_at))}</td><td><strong>${escapeHtml(row.instrument_id)}</strong><small>${escapeHtml(row.chain_index)} · ${escapeHtml(row.pool_id ?? "池 ID 不可用")}</small></td><td>${escapeHtml(direction)}</td><td class="numeric">${escapeHtml(formatReportDecimal(row.size_usdt, 8))} USDT</td><td class="numeric ${profit.className}"><strong>${escapeHtml(profit.text)}</strong></td><td>${quote}</td></tr>`;
      }).join("");
      const profitFilter = `<nav class="direct-subnav direct-profit-filter" aria-label="收益筛选"><a href="${directPoolHref(path, range, decisionFilterParams({ ...filters!, positiveOnly: false }))}"${positiveOnly ? "" : ' aria-current="page"'}>全部收益</a><a href="${directPoolHref(path, range, decisionFilterParams({ ...filters!, positiveOnly: true }))}"${positiveOnly ? ' aria-current="page"' : ""}>净收益大于 0</a></nav>`;
      const decisionNote = `<div class="direct-decision-note"><span>${positiveOnly ? "筛选结果：净收益为正且估值有效。" : "筛选结果：所选时间范围内的全部收益记录。"}</span><span>观察估算 · NOT_EXECUTABLE</span><span>CEX VWAP、收益拆分与估值口径见“报价详情”；保留 ${config.marketdata.directDecisionRetentionDays} 天，每页 20 条。</span></div>`;
      const emptyMessage = positiveOnly ? "当前时间范围没有净收益大于 0 的有效观察记录。" : "当前范围没有观察决策。";
      return `${header}${profitFilter}${decisionNote}<section class="overview"><div class="table-wrap"><table class="direct-record-table direct-decision-table"><thead><tr><th>时间 <small>(UTC+8)</small></th><th>资产 / 链 / 池</th><th>方向</th><th>规模</th><th>净收益 / ROI</th><th>详情</th></tr></thead><tbody>${recordRows || `<tr><td colspan="6">${emptyMessage}</td></tr>`}</tbody></table></div>${pagination(path, range, page, total, "收益明细分页", filterParams)}</section>${pageStyle()}<style>.direct-profit-filter{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;margin:14px 0 10px;padding:4px;border:1px solid #e3e9f2;border-radius:10px;background:#f4f6fa}.direct-profit-filter a{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:0 13px;border-radius:7px;font-size:13px;font-weight:600;white-space:nowrap}.direct-profit-filter a[aria-current="page"]{background:#fff;color:#234a87;box-shadow:0 1px 3px #243b5a1a,inset 0 -2px #315fba}.direct-decision-note{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin:0 0 14px;padding:10px 12px;border:1px solid #e7ecf3;border-radius:8px;background:#f8fafd;color:#65738a;font-size:12px;line-height:1.55}.direct-decision-note span{min-width:0;overflow-wrap:anywhere}.direct-decision-note span+span{padding-left:14px;border-left:1px solid #dce3ed}@media(max-width:700px){.direct-decision-note{align-items:flex-start;flex-direction:column;gap:4px}.direct-decision-note span+span{padding-left:0;border-left:0}}</style>`;
    }

    const poolPredicate = poolId ? " AND pool_id = ?" : "";
    const poolParameters = poolId ? [poolId] : [];
    const auditPoolFilter = poolId ? `AND EXISTS (
      SELECT 1 FROM direct_pool_decision selected
      WHERE selected.scan_id=d.scan_id AND selected.instrument_id=d.instrument_id AND selected.chain_index=d.chain_index
        AND selected.size_usdt=d.size_usdt AND selected.pool_id=?
    )` : "";
    const [statsRows, migrationRows, auditRows] = await Promise.all([
      path === "/direct-pools/windows" ? Promise.resolve<StatRow[]>([]) : query<StatRow[]>(`SELECT COALESCE(SUM(net_profit_usdt > 0),0) positive,COUNT(*) valid,CAST(MAX(net_profit_usdt) AS CHAR) max_net FROM direct_pool_decision WHERE created_at >= ? AND created_at < ? AND ${validEstimateSql}${poolPredicate}`, [fromStored, toStored, ...poolParameters]),
      query<MigrationRow[]>("SELECT applied_at FROM schema_migrations WHERE version=? LIMIT 1", [DIRECT_POOL_POOL_ID_MIGRATION]),
      path === "/direct-pools/windows" ? Promise.resolve<DirectionAuditSummaryRow[]>([]) : query<DirectionAuditSummaryRow[]>(`WITH per_scan AS (
          SELECT d.scan_id,d.instrument_id,d.chain_index,d.size_usdt,
            MAX(CASE WHEN d.direction='cex_buy_dex_sell' THEN d.pool_id END) cex_pool_id,
            MAX(CASE WHEN d.direction='dex_buy_cex_sell' THEN d.pool_id END) dex_pool_id,
            CAST(MAX(CASE WHEN d.direction='cex_buy_dex_sell' THEN d.cex_seq_id END) AS CHAR) cex_book_seq_id,
            CAST(MAX(CASE WHEN d.direction='dex_buy_cex_sell' THEN d.cex_seq_id END) AS CHAR) dex_book_seq_id,
            MAX(CASE WHEN d.direction='cex_buy_dex_sell' THEN d.selected_quote_id END) cex_quote_id,
            MAX(CASE WHEN d.direction='dex_buy_cex_sell' THEN d.selected_quote_id END) dex_quote_id,
            MAX(CASE WHEN d.direction='cex_buy_dex_sell' AND d.valuation_status NOT LIKE 'INVALIDATED_%' AND d.decision_status NOT IN ('BLOCKED','HIGH_PRICE_IMPACT') THEN d.net_profit_usdt END) cex_net_profit_usdt,
            MAX(CASE WHEN d.direction='dex_buy_cex_sell' AND d.valuation_status NOT LIKE 'INVALIDATED_%' AND d.decision_status NOT IN ('BLOCKED','HIGH_PRICE_IMPACT') THEN d.net_profit_usdt END) dex_net_profit_usdt
          FROM direct_pool_decision d
          WHERE d.created_at >= UTC_TIMESTAMP(3)-INTERVAL 1 HOUR ${auditPoolFilter}
          GROUP BY d.scan_id,d.instrument_id,d.chain_index,d.size_usdt
        ), paired AS (
          SELECT p.*,cex_quote.pool_state_fingerprint cex_pool_state_fingerprint,dex_quote.pool_state_fingerprint dex_pool_state_fingerprint
          FROM per_scan p
          LEFT JOIN direct_pool_quote cex_quote ON cex_quote.id=p.cex_quote_id
          LEFT JOIN direct_pool_quote dex_quote ON dex_quote.id=p.dex_quote_id
        ), classified AS (
          SELECT paired.*,
            CASE WHEN cex_pool_id IS NOT NULL AND BINARY cex_pool_id=BINARY dex_pool_id
              AND cex_book_seq_id IS NOT NULL AND cex_book_seq_id=dex_book_seq_id
              AND cex_pool_state_fingerprint IS NOT NULL AND BINARY cex_pool_state_fingerprint=BINARY dex_pool_state_fingerprint
              AND cex_net_profit_usdt IS NOT NULL AND dex_net_profit_usdt IS NOT NULL THEN 1 ELSE 0 END is_comparable
          FROM paired
        )
        SELECT instrument_id,chain_index,CAST(size_usdt AS CHAR) size_usdt,MAX(cex_pool_id) cex_pool_id,MAX(dex_pool_id) dex_pool_id,
          CAST(SUM(is_comparable) AS CHAR) comparable_samples,
          CAST(SUM(CASE WHEN is_comparable=1 AND cex_net_profit_usdt>0 AND dex_net_profit_usdt<=0 THEN 1 ELSE 0 END) AS CHAR) cex_only_positive,
          CAST(SUM(CASE WHEN is_comparable=1 AND cex_net_profit_usdt<=0 AND dex_net_profit_usdt>0 THEN 1 ELSE 0 END) AS CHAR) dex_only_positive,
          CAST(SUM(CASE WHEN is_comparable=1 AND cex_net_profit_usdt>0 AND dex_net_profit_usdt>0 THEN 1 ELSE 0 END) AS CHAR) both_positive,
          CAST(SUM(CASE WHEN is_comparable=1 AND cex_net_profit_usdt<=0 AND dex_net_profit_usdt<=0 THEN 1 ELSE 0 END) AS CHAR) neither_positive,
          CAST(SUM(CASE WHEN is_comparable=0 THEN 1 ELSE 0 END) AS CHAR) incomplete_samples,
          CAST(AVG(CASE WHEN is_comparable=1 THEN cex_net_profit_usdt-dex_net_profit_usdt END) AS CHAR) average_net_delta_usdt
        FROM classified
        GROUP BY instrument_id,chain_index,size_usdt,BINARY cex_pool_id,BINARY dex_pool_id
        ORDER BY instrument_id,chain_index,size_usdt,cex_pool_id,dex_pool_id`, poolId ? [poolId] : []),
    ]);
    const directionAudit = auditRows.map((row) => ({
      instrumentId: row.instrument_id, chainIndex: row.chain_index, sizeUsdt: row.size_usdt,
      cexPoolId: row.cex_pool_id, dexPoolId: row.dex_pool_id,
      comparableSamples: Number(row.comparable_samples), cexOnlyPositive: Number(row.cex_only_positive),
      dexOnlyPositive: Number(row.dex_only_positive), bothPositive: Number(row.both_positive),
      neitherPositive: Number(row.neither_positive), incompleteSamples: Number(row.incomplete_samples),
      averageNetDeltaUsdt: row.average_net_delta_usdt,
    }));
    const stats = statsRows[0] ?? { positive: 0, valid: 0, max_net: null };
    const coverageStart = migrationRows[0] ? actualTime(migrationRows[0].applied_at, offsetSeconds) : null;
    const coverageComplete = isWindowCoverageComplete(range.from, coverageStart);
    let positiveWindows: ReturnType<typeof collectPositiveWindows> = [];
    if (coverageStart) {
      const cacheKey = JSON.stringify([fromStored.getTime(), toStored.getTime(), offsetSeconds, poolId, windowDirection, coverageStart.getTime(), coverageComplete]);
      const cachedWindows = positiveWindowCache.get(cacheKey);
      if (cachedWindows) positiveWindows = cachedWindows;
      else {
        const windowDirectionPredicate = windowDirection ? " AND direction = ?" : "";
        const windowParameters = [storedTime(directPoolWindowReadStart(range.from, coverageStart), offsetSeconds), toStored, ...poolParameters, ...(windowDirection ? [windowDirection] : [])];
        const windowRows = await query<WindowSample[]>(`SELECT id,created_at createdAt,instrument_id instrumentId,chain_index chainIndex,pool_id poolId,direction,CAST(size_usdt AS CHAR) sizeUsdt,CAST(net_profit_usdt AS CHAR) netProfitUsdt,valuation_status valuationStatus,selected_quote_id selectedQuoteId FROM direct_pool_decision WHERE created_at >= ? AND created_at < ? AND pool_id IS NOT NULL AND ${validEstimateSql}${poolPredicate}${windowDirectionPredicate} ORDER BY created_at ASC,id ASC`, windowParameters);
        const samples = windowRows.map((row) => ({ ...row, createdAt: actualTime(row.createdAt, offsetSeconds) }));
        positiveWindows = collectPositiveWindows(samples, range.to, coverageComplete).filter((item) => item.startAt >= range.from && item.startAt < range.to);
        positiveWindowCache.set(cacheKey, positiveWindows);
      }
    }
    const audit = directionAudit.map((row) => {
      const samePool = row.cexPoolId !== null && row.cexPoolId === row.dexPoolId;
      const route = samePool ? row.cexPoolId! : `CEX: ${row.cexPoolId ?? "未选择"} / DEX: ${row.dexPoolId ?? "未选择"}`;
      const avgDelta = row.averageNetDeltaUsdt === null ? "—" : `${new Decimal(row.averageNetDeltaUsdt).gt(0) ? "+" : ""}${formatReportDecimal(row.averageNetDeltaUsdt, 6)} USDT`;
      return `<tr><td><strong>${escapeHtml(row.instrumentId)}</strong><small>${escapeHtml(row.chainIndex)}</small></td><td>${escapeHtml(route)}</td><td class="numeric">${escapeHtml(formatReportDecimal(row.sizeUsdt, 8))} USDT</td><td class="numeric">${row.comparableSamples}</td><td class="numeric">${row.cexOnlyPositive}</td><td class="numeric">${row.dexOnlyPositive}</td><td class="numeric">${row.bothPositive} / ${row.neitherPositive}</td><td class="numeric">${escapeHtml(avgDelta)}</td><td class="numeric">${row.incompleteSamples}</td></tr>`;
    }).join("");
    const directionAuditSection = `<section class="overview"><div class="section-heading"><h3>同一扫描、同盘口、同池状态双方向对照</h3><span>最近 1 小时</span></div><p class="direct-audit-note">只统计 CEX 买 → DEX 卖 与 DEX 买 → CEX 卖 在同一扫描中选到同一池、使用相同 CEX 盘口序号且 DEX 池状态指纹一致的样本。平均差值 = 前者净收益 − 后者净收益；跨池、盘口或池状态不同、估值缺失、深度不足或高价格影响样本不参与方向胜负统计。</p><div class="table-wrap"><table class="direct-record-table"><thead><tr><th>资产 / 链</th><th>池匹配</th><th>规模</th><th>同池同状态可比样本</th><th>CEX买方向单独为正</th><th>DEX买方向单独为正</th><th>都为正 / 都非正</th><th>平均净收益差</th><th>不可比</th></tr></thead><tbody>${audit || '<tr><td colspan="9">最近 1 小时暂无双向扫描记录。</td></tr>'}</tbody></table></div></section>`;
    const registered = config.marketRegistry.pools.map((pool) => `<span><strong>${escapeHtml(pool.instrument_id)}</strong><code title="${escapeHtml(pool.id)}">${escapeHtml(pool.id)}</code><em>${escapeHtml(pool.enabled ? pool.mode : "已关闭")}</em></span>`).join("");
    const candidates = solveDirectPoolCandidates(config.marketRegistry, assets);
    const percentage = Number(stats.valid) ? `${(Number(stats.positive) / Number(stats.valid) * 100).toFixed(1)}%` : "—";
    const coverageCard = coverageComplete
      ? `<strong>${positiveWindows.length}</strong>`
      : coverageStart
        ? `<span class="coverage-status">部分覆盖</span><strong>${positiveWindows.length}</strong><span class="coverage-start">仅统计 ${escapeHtml(formatUtc8Minute(coverageStart))} UTC+8 之后可确认的窗口</span>`
        : `<span class="coverage-status">覆盖起点未知</span>`;
    const orderedWindows = positiveWindows.slice().sort((a, b) => b.startAt.getTime() - a.startAt.getTime() || b.firstSampleId - a.firstSampleId);
    const renderWindowRows = (windows: typeof orderedWindows) => windows.map((window) => {
      const latestProfit = new Decimal(window.latestNetProfitUsdt);
      const latestProfitClass = latestProfit.gt(0) ? "profit-positive" : latestProfit.lt(0) ? "profit-negative" : "";
      const direction = window.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出";
      const windowDetail = directPoolHref("/direct-pools/window", range, {
        pool: window.poolId, direction: window.direction, window_instrument: window.instrumentId, window_chain: window.chainIndex,
        window_size: window.sizeUsdt, window_from_ms: String(window.startAt.getTime()),
        window_to_ms: String((window.endAt ?? range.to).getTime()), window_closed: window.endAt ? "1" : "0",
        window_first_id: String(window.firstSampleId), window_last_id: String(window.lastSampleId), window_positive_count: String(window.sampleCount),
      });
      const detail = `<a href="${windowDetail}">全部收益样本 →</a>`;
      return `<tr><td>${escapeHtml(formatUtc8(window.startAt))}<small>至末次正收益 ${escapeHtml(formatUtc8(window.lastObservedAt))}<br>${window.endAt ? `结束确认 ${escapeHtml(formatUtc8(window.endAt))}` : "窗口仍在观察"}</small></td><td><strong>${escapeHtml(window.instrumentId)}</strong><small>${escapeHtml(window.chainIndex)} · ${escapeHtml(window.poolId)}</small></td><td>${escapeHtml(direction)}</td><td class="numeric">${escapeHtml(formatReportDecimal(window.sizeUsdt, 8))} USDT</td><td class="numeric ${latestProfitClass}"><strong>末次正收益 ${escapeHtml(formatReportDecimal(window.latestNetProfitUsdt, 6))} USDT</strong><small>窗口峰值 ${escapeHtml(formatReportDecimal(window.peakNetProfitUsdt, 6))} USDT</small></td><td class="numeric">${escapeHtml(formatWindowSpan(window.startAt, window.lastObservedAt))}<small>${window.sampleCount} 个正收益样本</small></td><td>${window.endAt ? "已结束" : "观察中"}<small>观察估算 · NOT_EXECUTABLE</small></td><td>${detail}</td></tr>`;
    }).join("");
    const windowTableHead = `<thead><tr><th>正收益观测区间 <small>(UTC+8)</small></th><th>资产 / 链 / 池</th><th>方向</th><th>规模</th><th>末次正收益 / 窗口峰值</th><th>正收益跨度 / 样本数</th><th>状态</th><th>详情</th></tr></thead>`;
    if (path === "/direct-pools/windows") {
      if (!coverageStart) return `${header}<p class="guard-alert">窗口历史覆盖起点未知，暂不展示窗口；请检查数据库迁移记录。</p>${pageStyle()}`;
      const page = parsePageNumber(url.searchParams.get("page"));
      const offset = (page - 1) * pageSize;
      const visibleWindows = orderedWindows.slice(offset, offset + pageSize);
      const recordRows = renderWindowRows(visibleWindows);
      const pageParams = { ...(poolId ? { pool: poolId } : {}), ...(windowDirection ? { direction: windowDirection } : {}) };
      const empty = orderedWindows.length === 0
        ? coverageComplete ? "当前筛选范围没有满足连续性条件的正收益窗口；孤立正收益样本可在收益明细中查看。" : "覆盖起点之后暂无可确认的正收益窗口；边界状态确认前的窗口不会计入摘要。"
        : `第 ${page} 页没有窗口。<a href="${directPoolHref(path, range, pageParams)}">返回第 1 页</a>`;
      const coverageNote = coverageComplete ? "" : `<p class="guard-alert">所选范围早于完整覆盖起点；这里只展示 ${escapeHtml(formatUtc8Minute(coverageStart))} UTC+8 之后、经过连续性确认的窗口。</p>`;
      return `${header}${coverageNote}<p class="direct-record-note">窗口是重复报价的观察估算，不代表成交、累计利润或可执行性。末次收益、峰值和样本数只统计正收益观测；非正收益样本仅用于连续性判断。</p><section class="overview"><div class="section-heading"><h3>正收益窗口</h3><span>共 ${orderedWindows.length} 个 · 每页 ${pageSize} 个</span></div><div class="table-wrap"><table class="direct-record-table">${windowTableHead}<tbody>${recordRows || `<tr><td colspan="8">${empty}</td></tr>`}</tbody></table></div>${pagination(path, fixedRange(range), page, orderedWindows.length, "全部正收益窗口分页", pageParams)}</section>${pageStyle()}`;
    }
    const windowRows = renderWindowRows(orderedWindows.slice(0, pageSize));
    const windowTable = windowRows || (coverageComplete
      ? "当前范围没有满足连续性条件的正收益窗口；孤立正收益样本可在收益明细中查看。"
      : coverageStart
        ? `覆盖起点 ${formatUtc8Minute(coverageStart)} 之后暂无可确认的窗口。`
        : "窗口覆盖起点未知；可在收益明细中查看逐条正收益样本。");
    const allWindowsLink = coverageStart && orderedWindows.length ? `<a href="${directPoolHref("/direct-pools/windows", fixedRange(range), poolId ? { pool: poolId } : undefined)}">查看全部 ${orderedWindows.length} 个窗口 →</a>` : "";
    const coverageNote = coverageComplete ? "" : coverageStart
      ? `<p class="direct-record-note">窗口摘要仅统计 ${escapeHtml(formatUtc8Minute(coverageStart))} UTC+8 之后可确认的区间；覆盖边界状态尚未确认的窗口会暂时略过。</p>`
      : `<p class="guard-alert">窗口覆盖起点未知，暂不展示窗口摘要；可在收益明细中查看逐条正收益样本。</p>`;
    return `${header}<p>范围内的数字是重复报价的观察估算，不代表实际成交或累计利润；所有结果均为 <strong>NOT_EXECUTABLE</strong>。已登记交易候选：${candidates.length}。</p><section class="overview"><div class="direct-cards"><article><small>正收益估算样本</small><strong class="profit-positive">${Number(stats.positive)}</strong></article><article class="window-card"><small>正收益窗口</small>${coverageCard}</article><article><small>正收益率</small><strong>${percentage}</strong></article><article><small>单笔最高净收益估算</small><strong>${escapeHtml(stats.max_net === null ? "—" : `${formatReportDecimal(stats.max_net, 6)} USDT`)}</strong></article></div></section>${directionAuditSection}<section class="overview"><div class="section-heading"><h3>正收益窗口 <small>最近 20 个</small></h3>${allWindowsLink}</div>${coverageNote}<p class="direct-record-note">末次净收益、峰值和样本数只统计正收益观测；连续非正样本仅用于确认窗口结束，不计入这些指标。结束确认时间与末次正收益时间分开显示。所有结果均为观察估算，不代表可成交或实际收益。</p><div class="table-wrap"><table class="direct-record-table">${windowTableHead}<tbody>${windowRows ? windowRows : `<tr><td colspan="8">${escapeHtml(windowTable)}</td></tr>`}</tbody></table></div></section><details class="overview direct-pool-status"><summary><strong>已登记池与监控状态</strong><small>${config.marketRegistry.pools.length} 个登记池 · 点击展开</small></summary><div class="direct-pool-summary">${registered || "没有登记池。"}</div>${fixedPoolPanel(fixedPools)}</details>${pageStyle()}<style>.direct-audit-note{margin:8px 0 12px;color:#65738a;font-size:12px;line-height:1.6}.direct-record-table td small{display:block;color:#758198;font-size:11px;margin-top:3px}</style>`;
  } catch {
    return `${header}<p class="guard-alert">指定池数据表尚不可用；请先执行 npm run db:migrate。</p>${pageStyle()}`;
  }
}
