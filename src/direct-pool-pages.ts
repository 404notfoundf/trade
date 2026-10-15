import Decimal from "decimal.js";
import type { AssetConfig, Config } from "./config.js";
import { query } from "./db.js";
import type { PoolMonitorState } from "./fixed-pools.js";
import { solveDirectPoolCandidates } from "./trading/market-registry.js";
import {
  collectPositiveWindows,
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
} from "./trading/direct-pool-windows.js";

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
  decision_status: string; block_reason: string | null; execution_status: string; created_at: Date;
};
type QuoteRow = {
  id: number; instrument_id: string; chain_index: string; pool_id: string; dex: string; direction: string;
  amount_in_raw: string | null; amount_out_raw: string | null; quoted_at: Date | null; request_ms: number | null;
  status: string; failure_reason: string | null; raw_response: unknown; net_profit_usdt: string | null; roi: string | null;
  valuation_status: string | null;
};
type StatRow = { positive: number; valid: number; max_net: string | null };
type OffsetRow = { offset_seconds: number };
type MigrationRow = { applied_at: Date };

const pageSize = 20;
const validEstimateSql = "net_profit_usdt IS NOT NULL AND valuation_status NOT LIKE 'INVALIDATED_%'";
const actualTime = (stored: Date, offsetSeconds: number) => new Date(stored.getTime() - offsetSeconds * 1000);
const storedTime = (utc: Date, offsetSeconds: number) => new Date(utc.getTime() + offsetSeconds * 1000);
const isInvalidated = (status: string | null) => status?.startsWith("INVALIDATED_") ?? false;

function subNav(path: string, range: DirectPoolRange): string {
  const items: Array<[string, string]> = [["/direct-pools", "收益总览"], ["/direct-pools/quotes", "报价记录"], ["/direct-pools/decisions", "收益明细"]];
  return `<nav class="direct-subnav" aria-label="指定池收益页面">${items.map(([href, label]) => `<a href="${directPoolHref(href, range)}"${path === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

function rangeControl(path: string, range: DirectPoolRange, escapeHtml: Helpers["escapeHtml"]): string {
  return `<form class="direct-range" action="${path}" method="get"><label>时间范围 <select name="range"><option value="5m"${range.preset === "5m" ? " selected" : ""}>最近 5 分钟</option><option value="1h"${range.preset === "1h" ? " selected" : ""}>最近 1 小时</option><option value="24h"${range.preset === "24h" ? " selected" : ""}>最近 24 小时</option><option value="custom"${range.preset === "custom" ? " selected" : ""}>自定义范围</option></select></label><details class="direct-custom-range"${range.preset === "custom" ? " open" : ""}><summary>自定义起止时间</summary><div><label>开始（UTC+8）<input type="datetime-local" name="from" value="${escapeHtml(formatUtc8Input(range.from))}"></label><label>结束（UTC+8）<input type="datetime-local" name="to" value="${escapeHtml(formatUtc8Input(range.to))}"></label></div></details><button type="submit">应用</button></form>`;
}

function pagination(path: string, range: DirectPoolRange, page: number, hasNext: boolean, label: string): string {
  const previous = page > 1 ? `<a href="${directPoolHref(path, range, { page: String(page - 1) })}">上一页</a>` : "";
  const next = hasNext ? `<a href="${directPoolHref(path, range, { page: String(page + 1) })}">下一页</a>` : "";
  return `<nav class="direct-pagination" aria-label="${label}"><span>第 ${page} 页 · 每页 ${pageSize} 条</span><div>${previous}${next}</div></nav>`;
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
  const invalidRange = range.invalid ? '<p class="guard-alert">时间范围无效，已回退为最近 1 小时。</p>' : "";
  const header = `<h2>${path === "/direct-pools/quotes" ? "Exact-In 报价记录" : path === "/direct-pools/decisions" ? "收益明细" : "指定池收益总览"}</h2>${subNav(path, range)}${rangeControl(path, range, escapeHtml)}${invalidRange}`;
  if (!dbOnline) return `${header}<p class="guard-alert">数据库不可用，暂时无法读取 Direct Pool 观察数据。</p>${pageStyle()}`;

  let offsetSeconds: number;
  try { offsetSeconds = await databaseOffset(); } catch { return `${header}<p class="guard-alert">指定池数据表尚不可用；请先执行 npm run db:migrate。</p>${pageStyle()}`; }
  const fromStored = storedTime(range.from, offsetSeconds);
  const toStored = storedTime(range.to, offsetSeconds);

  try {
    if (path === "/direct-pools/quotes") {
      const page = parsePageNumber(url.searchParams.get("page"));
      const rows = await query<QuoteRow[]>(`SELECT q.id,q.instrument_id,q.chain_index,q.pool_id,q.dex,q.direction,q.amount_in_raw,q.amount_out_raw,q.quoted_at,q.request_ms,q.status,q.failure_reason,q.raw_response,CAST(d.net_profit_usdt AS CHAR) net_profit_usdt,CAST(d.roi AS CHAR) roi,d.valuation_status FROM direct_pool_quote q LEFT JOIN direct_pool_decision d ON d.selected_quote_id=q.id WHERE (q.quoted_at >= ? AND q.quoted_at < ?) OR (q.quoted_at IS NULL AND q.created_at >= ? AND q.created_at < ?) ORDER BY q.id DESC LIMIT ? OFFSET ?`, [range.from, range.to, fromStored, toStored, pageSize + 1, (page - 1) * pageSize]);
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
        const detail = directPoolHref("/direct-pools/quote", range, { id: String(row.id), ...(page > 1 ? { page: String(page) } : {}) });
        return `<tr><td>${escapeHtml(formatUtc8(row.quoted_at))}</td><td><strong>${escapeHtml(row.instrument_id)}</strong><small>${escapeHtml(row.pool_id)} · ${escapeHtml(row.dex)}</small></td><td>${escapeHtml(row.direction)}</td><td class="numeric">${escapeHtml(amounts)}</td><td>${row.status === "OK" ? `<span class="badge ${invalidated ? "unhealthy" : "fresh"}">${invalidated ? "估值失效" : "已报价"}</span>` : `<span class="badge unhealthy">失败</span><small>${escapeHtml(row.failure_reason ?? "报价失败")}</small>`}</td><td class="numeric">${escapeHtml(profit)}</td><td><a href="${detail}">详情 →</a></td></tr>`;
      }).join("");
      return `${header}${tooOld ? `<p class="guard-alert">报价原始记录只保留 ${config.marketdata.directQuoteRetentionDays} 天；所选范围可能早于可用数据。</p>` : ""}<p class="direct-record-note">Exact-In 成功与失败报价；原始响应只在详情页显示。</p><section class="overview"><div class="table-wrap"><table class="direct-record-table"><thead><tr><th>时间 <small>(UTC+8)</small></th><th>路线</th><th>方向</th><th>输入 → 输出</th><th>状态</th><th>净收益 / ROI</th><th></th></tr></thead><tbody>${recordRows || '<tr><td colspan="7">当前范围没有报价记录。</td></tr>'}</tbody></table></div>${pagination(path, range, page, rows.length > pageSize, "报价记录分页")}</section>${pageStyle()}`;
    }

    if (path === "/direct-pools/decisions") {
      const page = parsePageNumber(url.searchParams.get("page"));
      const rows = await query<DecisionRow[]>(`SELECT id,instrument_id,chain_index,pool_id,direction,CAST(size_usdt AS CHAR) size_usdt,selected_quote_id,CAST(cex_vwap AS CHAR) cex_vwap,CAST(gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(gas_budget_usdt AS CHAR) gas_budget_usdt,CAST(net_profit_usdt AS CHAR) net_profit_usdt,CAST(roi AS CHAR) roi,valuation_status,decision_status,block_reason,execution_status,created_at FROM direct_pool_decision WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, [fromStored, toStored, pageSize + 1, (page - 1) * pageSize]);
      const recordRows = rows.slice(0, pageSize).map((raw) => {
        const row = correctedDecision(raw, offsetSeconds);
        const profit = decisionProfit(row, helpers);
        const quote = row.selected_quote_id === null ? (row.net_profit_usdt === null && !isInvalidated(row.valuation_status) ? "无关联报价" : "原始报价已过保留期") : `<a href="${directPoolHref("/direct-pools/quote", range, { id: String(row.selected_quote_id) })}">报价详情 →</a>`;
        const direction = row.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出";
        return `<tr><td>${escapeHtml(formatUtc8(row.created_at))}</td><td><strong>${escapeHtml(row.instrument_id)}</strong><small>${escapeHtml(row.chain_index)} · ${escapeHtml(row.pool_id ?? "池 ID 不可用")}</small></td><td>${escapeHtml(direction)}</td><td class="numeric">${escapeHtml(formatReportDecimal(row.size_usdt, 8))} USDT</td><td class="numeric ${profit.className}"><strong>${escapeHtml(profit.text)}</strong></td><td>${quote}</td></tr>`;
      }).join("");
      return `${header}<p class="direct-record-note">仅保留判断时最重要的信息；CEX VWAP、毛收益、手续费、Gas 与估值口径可在“报价详情”查看。全部记录均为观察估算，固定为 NOT_EXECUTABLE；决策保留 ${config.marketdata.directDecisionRetentionDays} 天。</p><section class="overview"><div class="table-wrap"><table class="direct-record-table direct-decision-table"><thead><tr><th>时间 <small>(UTC+8)</small></th><th>资产 / 链 / 池</th><th>方向</th><th>规模</th><th>净收益 / ROI</th><th>详情</th></tr></thead><tbody>${recordRows || '<tr><td colspan="6">当前范围没有观察决策。</td></tr>'}</tbody></table></div>${pagination(path, range, page, rows.length > pageSize, "收益明细分页")}</section>${pageStyle()}`;
    }

    const [statsRows, positiveRows, migrationRows] = await Promise.all([
      query<StatRow[]>(`SELECT COALESCE(SUM(net_profit_usdt > 0),0) positive,COUNT(*) valid,CAST(MAX(net_profit_usdt) AS CHAR) max_net FROM direct_pool_decision WHERE created_at >= ? AND created_at < ? AND ${validEstimateSql}`, [fromStored, toStored]),
      query<DecisionRow[]>(`SELECT id,instrument_id,chain_index,pool_id,direction,CAST(size_usdt AS CHAR) size_usdt,selected_quote_id,CAST(cex_vwap AS CHAR) cex_vwap,CAST(gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(gas_budget_usdt AS CHAR) gas_budget_usdt,CAST(net_profit_usdt AS CHAR) net_profit_usdt,CAST(roi AS CHAR) roi,valuation_status,decision_status,block_reason,execution_status,created_at FROM direct_pool_decision WHERE created_at >= ? AND created_at < ? AND ${validEstimateSql} AND net_profit_usdt > 0 ORDER BY created_at DESC,id DESC LIMIT 20`, [fromStored, toStored]),
      query<MigrationRow[]>("SELECT applied_at FROM schema_migrations WHERE version=? LIMIT 1", [DIRECT_POOL_POOL_ID_MIGRATION]),
    ]);
    const stats = statsRows[0] ?? { positive: 0, valid: 0, max_net: null };
    const coverageStart = migrationRows[0] ? actualTime(migrationRows[0].applied_at, offsetSeconds) : null;
    const coverageComplete = isWindowCoverageComplete(range.from, coverageStart);
    let windowCount: number | null = null;
    if (coverageComplete && coverageStart) {
      // shortcut: loads raw decisions from coverage start; add a summary table only if 180-day reads are measured too slow.
      const windowRows = await query<WindowSample[]>(`SELECT id,created_at createdAt,instrument_id instrumentId,chain_index chainIndex,pool_id poolId,direction,CAST(size_usdt AS CHAR) sizeUsdt,CAST(net_profit_usdt AS CHAR) netProfitUsdt,valuation_status valuationStatus FROM direct_pool_decision WHERE created_at >= ? AND created_at < ? AND pool_id IS NOT NULL AND ${validEstimateSql} ORDER BY created_at ASC,id ASC`, [storedTime(coverageStart, offsetSeconds), toStored]);
      const samples = windowRows.map((row) => ({ ...row, createdAt: actualTime(row.createdAt, offsetSeconds) }));
      windowCount = collectPositiveWindows(samples, range.to).filter((item) => item.startAt >= range.from && item.startAt < range.to).length;
    }
    const positive = positiveRows.map((raw) => {
      const row = correctedDecision(raw, offsetSeconds);
      const profit = decisionProfit(row, helpers);
      const detail = row.selected_quote_id === null ? "原始报价已过保留期" : `<a href="${directPoolHref("/direct-pools/quote", range, { id: String(row.selected_quote_id) })}">报价详情 →</a>`;
      return `<tr><td>${escapeHtml(formatUtc8(row.created_at))}</td><td><strong>${escapeHtml(row.instrument_id)}</strong><small>${escapeHtml(row.chain_index)} · ${escapeHtml(row.pool_id ?? "池 ID 不可用")}</small></td><td>${escapeHtml(row.direction)}</td><td class="numeric">${escapeHtml(formatReportDecimal(row.size_usdt, 8))} USDT</td><td class="numeric ${profit.className}"><strong>${escapeHtml(profit.text)}</strong></td><td>${escapeHtml(row.decision_status)} / ${escapeHtml(row.valuation_status)}<small>观察估算 · NOT_EXECUTABLE</small></td><td>${detail}</td></tr>`;
    }).join("");
    const registered = config.marketRegistry.pools.map((pool) => `<span><strong>${escapeHtml(pool.instrument_id)}</strong><code title="${escapeHtml(pool.id)}">${escapeHtml(pool.id)}</code><em>${escapeHtml(pool.enabled ? pool.mode : "已关闭")}</em></span>`).join("");
    const candidates = solveDirectPoolCandidates(config.marketRegistry, assets);
    const percentage = Number(stats.valid) ? `${(Number(stats.positive) / Number(stats.valid) * 100).toFixed(1)}%` : "—";
    const coverageCard = coverageComplete
      ? `<strong>${windowCount ?? 0}</strong>`
      : `<span class="coverage-status">数据不完整</span>${coverageStart ? `<span class="coverage-start">完整窗口统计始于<br>${escapeHtml(formatUtc8Minute(coverageStart))} UTC+8</span>` : ""}`;
    return `${header}<p>范围内的数字是重复报价的观察估算，不代表实际成交或累计利润；所有结果均为 <strong>NOT_EXECUTABLE</strong>。已登记交易候选：${candidates.length}。</p><section class="overview"><div class="direct-cards"><article><small>正收益估算样本</small><strong class="profit-positive">${Number(stats.positive)}</strong></article><article class="window-card"><small>正收益窗口</small>${coverageCard}</article><article><small>正收益率</small><strong>${percentage}</strong></article><article><small>单笔最高净收益估算</small><strong>${escapeHtml(stats.max_net === null ? "—" : `${formatReportDecimal(stats.max_net, 6)} USDT`)}</strong></article></div></section><section class="overview"><h3>净收益估算为正 <small>最近 20 条</small></h3><div class="table-wrap"><table class="direct-record-table"><thead><tr><th>时间 <small>(UTC+8)</small></th><th>资产 / 链 / 池</th><th>方向</th><th>规模</th><th>净收益 / ROI</th><th>状态</th><th>详情</th></tr></thead><tbody>${positive || '<tr><td colspan="7">当前范围没有净收益大于 0 的有效观察估算。</td></tr>'}</tbody></table></div></section><details class="overview direct-pool-status"><summary><strong>已登记池与监控状态</strong><small>${config.marketRegistry.pools.length} 个登记池 · 点击展开</small></summary><div class="direct-pool-summary">${registered || "没有登记池。"}</div>${fixedPoolPanel(fixedPools)}</details>${pageStyle()}`;
  } catch {
    return `${header}<p class="guard-alert">指定池数据表尚不可用；请先执行 npm run db:migrate。</p>${pageStyle()}`;
  }
}
