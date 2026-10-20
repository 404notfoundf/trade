import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Decimal from "decimal.js";
import type { AssetConfig, Config } from "../config.js";
import { query, type Health } from "../db.js";
import type { ValuationView } from "../market/valuation.js";
import { logger } from "../logger.js";
import type { PoolMonitorState } from "../market/fixed-pools.js";
import { directPoolDexLabel, directPoolSimulationLabel, renderDirectPoolPage } from "./direct-pool-pages.js";
import { directPoolQuoteBackUrl } from "../direct-pool/windows.js";
import { mapOpportunityQuoteBucketRows, type OpportunityQuoteBucketRow } from "../market/opportunity-clusters.js";

type OpportunityRow = { id: number; opened_at: Date; observed_at: Date; ended_at: Date | null; close_reason: string | null; executable_status: string; execution_reason: string | null; execution_buffer_usdt: string | null; executable_profit_usdt: string | null; peak_profit_usdt: string | null; inst_id: string; chain_index: string; route_status: string; direction: string; size_usdt: string; shares: string | null; cex_vwap: string | null; dex_usdt_amount: string | null; cex_fee_usdt: string | null; gas_usdt: string | null; gross_profit_usdt: string | null; net_profit_usdt: string | null; rebalance_cost_usdt: string | null; net_profit_after_rebalance_usdt: string | null; roi: string | null; price_impact_percent: string | null; is_stale: number; status: string; native_quote_amount: string | null; native_quote_symbol: string | null; valuation_status: string; usdt_estimate: string | null };
type OpportunityListRow = Pick<OpportunityRow, "id" | "opened_at" | "ended_at" | "close_reason" | "executable_status" | "execution_reason" | "peak_profit_usdt" | "inst_id" | "chain_index" | "direction" | "size_usdt" | "net_profit_usdt" | "roi" | "is_stale" | "valuation_status"> & { last_updated_at: Date | null; duration_seconds: number | string; sample_count: number | string };
type QuoteCompareRow = { observed_at: Date; inst_id: string; chain_index: string; route_status: string; direction: string; size_usdt: string; shares: string | null; cex_vwap: string | null; native_quote_amount: string | null; native_quote_symbol: string | null; usdt_rate: string | null; valuation_status: string | null; net_profit_usdt: string | null; net_profit_after_rebalance_usdt: string | null; usdt_estimate: string | null };
type ReportRow = { period_type: string; period_start: Date; inst_id: string; chain_index: string; direction: string; size_usdt: string; opportunity_count: number; monitor_only_count: number; max_profit: string | null; median_profit: string | null; collected: number; longest_positive_seconds: number; legacy_nominal: number };
type BlockedRow = { id: string; observed_at: Date; inst_id: string; chain_index: string; direction: string | null; size_usdt: string; reason_code: string; reason: string; cex_ts: Date | null; quote_response: unknown };
type BlockedSummaryRow = Pick<BlockedRow, "id" | "observed_at" | "inst_id" | "chain_index" | "direction" | "size_usdt" | "reason_code">;
type DirectQuoteRow = { id: number; scan_id: string; instrument_id: string; chain_index: string; pool_id: string; dex: string; direction: string; amount_in_raw: string | null; amount_out_raw: string | null; minimum_amount_out_raw: string | null; price_impact_percent: string | null; network_fee_usdt: string | null; block_number: string | null; slot: string | null; quoted_at: Date | null; cex_book_at: Date | null; cex_received_at: Date | null; request_ms: number | null; status: string; failure_code: string | null; failure_reason: string | null; raw_response: unknown; valuation_inputs: unknown; cex_vwap: string | null; gross_profit_usdt: string | null; net_profit_usdt: string | null; cex_fee_usdt: string | null; gas_budget_usdt: string | null; roi: string | null; valuation_status: string | null; decision_status: string | null; block_reason: string | null; simulation_status: string | null; simulation_reason: string | null; simulation_at: Date | null; simulation_input_debited_raw: string | null; simulation_output_credited_raw: string | null; simulation_network_fee_native_raw: string | null; simulation_compute_units: number | null };
type DirectDecisionRow = { id: number; scan_id: string; instrument_id: string; chain_index: string; direction: string; size_usdt: string; selected_quote_id: number | null; cex_vwap: string | null; gross_profit_usdt: string | null; cex_fee_usdt: string | null; gas_budget_usdt: string | null; net_profit_usdt: string | null; roi: string | null; valuation_status: string; decision_status: string; block_reason: string | null; execution_status: string; created_at_utc8: string | null };
type DirectOverviewRow = Pick<DirectDecisionRow, "instrument_id" | "chain_index" | "direction" | "size_usdt" | "selected_quote_id" | "cex_vwap" | "gross_profit_usdt" | "cex_fee_usdt" | "gas_budget_usdt" | "net_profit_usdt" | "roi" | "valuation_status" | "decision_status" | "block_reason" | "created_at_utc8"> & { pool_id: string | null; slot: string | null; simulation_status: string; simulation_reason: string | null; valuation_inputs: unknown };
type DirectPoolQuoteStatusRow = { id: string; pool_id: string; status: string; failure_code: string | null; quoted_at_utc8: string | null };
export type RouteDashboardState = { asset: AssetConfig; status: "ENABLED" | "MONITOR_ONLY" | "BLOCKED" | "DISABLED" | "UNKNOWN"; reason: string | null; multiplier?: Decimal; instrumentReady: boolean; feeReady: boolean; bookReady: boolean };
export type DashboardState = {
  health: Map<string, Health>;
  dbOnline: boolean;
  routes: RouteDashboardState[];
  fixedPools?: PoolMonitorState[];
  valuation?: ValuationView;
  collection?: { running: boolean; updatedAt: number | null };
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const shown = (value: unknown) => value === null || value === undefined || value === "" ? "未知" : escapeHtml(value);
const beijingTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function formatUtc8(value: Date | string | number | null | undefined, milliseconds = false): string {
  if (value === null || value === undefined || value === "") return "未知";
  const date = value instanceof Date ? value : typeof value === "string"
    ? new Date(/[z]|[+-]\d{2}:?\d{2}$/i.test(value) ? value : `${value.replace(" ", "T")}Z`)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const parts = Object.fromEntries(beijingTimeFormatter.formatToParts(date).map(({ type, value: part }) => [type, part])) as Record<string, string>;
  const formatted = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  return milliseconds ? `${formatted}.${String(date.getUTCMilliseconds()).padStart(3, "0")}` : formatted;
}
function formatReportDecimal(value: string | null, significantDigits = 8): string {
  if (value === null) return "—";
  try {
    const fixed = new Decimal(value).toSignificantDigits(significantDigits).toFixed();
    return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  } catch {
    return "—";
  }
}
function formatRawTokenAmount(value: string | null, decimals: number, multiplier = "1"): string {
  if (value === null) return "—";
  try {
    const formatted = new Decimal(value).div(new Decimal(10).pow(decimals)).mul(multiplier).toSignificantDigits(10).toFixed();
    return formatted.includes(".") ? formatted.replace(/0+$/, "").replace(/\.$/, "") : formatted;
  } catch {
    return "—";
  }
}
function directQuoteAssetUiMultiplier(rawResponse: unknown): string {
  try {
    const raw = typeof rawResponse === "string" ? JSON.parse(rawResponse) as unknown : rawResponse;
    if (!raw || typeof raw !== "object") return "1";
    const value = (raw as Record<string, unknown>).assetUiMultiplier;
    if (typeof value !== "string" && typeof value !== "number") return "1";
    const multiplier = new Decimal(String(value));
    return multiplier.isFinite() && multiplier.gt(0) ? multiplier.toString() : "1";
  } catch { return "1"; }
}
function directPoolSolanaGasPrice(valuationInputs: unknown): string | null {
  try {
    const inputs = typeof valuationInputs === "string" ? JSON.parse(valuationInputs) as unknown : valuationInputs;
    if (!inputs || typeof inputs !== "object") return null;
    const pricing = (inputs as Record<string, unknown>).solanaGasPricing;
    if (!pricing || typeof pricing !== "object") return null;
    const { feeLamports, midPx } = pricing as Record<string, unknown>;
    if (typeof feeLamports !== "string" || !/^\d+$/.test(feeLamports)) return null;
    if (typeof midPx !== "string" && typeof midPx !== "number") return null;
    const feeSol = new Decimal(feeLamports).div(1_000_000_000);
    const solUsdt = new Decimal(String(midPx));
    if (!feeSol.gt(0) || !solUsdt.isFinite() || !solUsdt.gt(0)) return null;
    return `${formatReportDecimal(feeSol.toString(), 8)} SOL × ${formatReportDecimal(solUsdt.toString(), 8)} USDT/SOL`;
  } catch { return null; }
}
function formatReportDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds === 0) return "0 秒";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [days ? `${days} 天` : "", hours ? `${hours} 小时` : "", minutes ? `${minutes} 分` : "", remainder ? `${remainder} 秒` : ""].filter(Boolean).join(" ");
}
const statusBadge = (status: string) => {
  const label = status === "healthy" ? "HEALTHY" : ["blocked", "unavailable", "invalid"].includes(status) ? "UNHEALTHY" : status === "VERIFIED" ? "VERIFIED" : status === "LEGACY_NOMINAL" ? "LEGACY_NOMINAL" : status.toUpperCase();
  const cls = ["HEALTHY", "VERIFIED", "CONFIRMED", "CONNECTED"].includes(label) ? "fresh" : ["PROVISIONAL", "STALE", "CONNECTING"].includes(label) ? "stale" : label === "UNHEALTHY" || label === "DISCONNECTED" ? "unhealthy" : "unknown";
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
};
const usdtCell = (status: string | null | undefined, value: string | null | undefined) => status === "VERIFIED" ? shown(value) : status === "LEGACY_NOMINAL" ? `${shown(value)}（LEGACY_NOMINAL）` : "未知";
const closeReasonLabels: Record<string, string> = {
  PROFIT_BELOW_ZERO: "连续两次报价收益不为正",
  COLLECTOR_RESTART: "采集器重启",
  DATABASE_RECONNECTED: "数据库重新连接",
  ROUTE_BLOCKED: "交易路线不可用",
  DEX_CREDENTIALS_MISSING: "DEX API 凭据缺失",
  CEX_INSTRUMENT_UNAVAILABLE: "CEX 交易标的不可用",
  CEX_FEE_UNAVAILABLE: "CEX 手续费不可用",
  MULTIPLIER_UNAVAILABLE: "Multiplier 不可用",
  CEX_BOOK_UNAVAILABLE: "CEX 盘口不可用",
  CEX_BOOK_STALE: "CEX 盘口未及时更新",
  CEX_DEPTH_INSUFFICIENT: "CEX 盘口深度不足",
  MULTIPLIER_CHANGED: "Multiplier 发生变化",
  DEX_QUOTE_SLOW: "DEX 报价超时",
  TOKEN_IDENTITY_MISMATCH: "代币身份不匹配",
  DEX_QUOTE_INVALID: "DEX 报价无效",
  TOKEN_TAX_UNSUPPORTED: "不支持含税代币",
  PRICE_IMPACT_UNKNOWN: "DEX 价格影响未知",
  PRICE_IMPACT_LIMIT: "DEX 价格影响超过上限",
  DEX_QUOTE_UNAVAILABLE: "DEX 报价不可用",
  GAS_UNKNOWN: "Gas 成本未知",
  USDT_DEVIATION_LIMIT: "USDT/USD 偏差超过上限",
  USDT_PRICE_STALE: "USDT 指数价格过期",
  USDT_PRICE_SOURCE_UNAVAILABLE: "USDT 指数价格不可用",
  USDT0_PARITY_LIMIT: "USDT0/USDT 偏差超过上限",
  USDT_CONVERSION_UNAVAILABLE: "USDT 折算不可用",
  USDT0_PROTOCOL_MISMATCH: "X Layer 报价币不匹配",
  MULTIPLIER_JUMP: "Multiplier 变化超过上限",
};
const closeReasonLabel = (reason: string | null) => reason ? closeReasonLabels[reason] ?? reason : "未知原因";
function valuationPanel(view: ValuationView | undefined): string {
  const row = (name: string, status: string, price: string | null, deviation: string | null, sourceTime: number | null) => `<tr><td>${escapeHtml(name)}</td><td>${statusBadge(status)}</td><td class="numeric">${shown(price)}</td><td class="numeric">${shown(deviation)}</td><td>${escapeHtml(formatUtc8(sourceTime))}</td></tr>`;
  if (!view) return "<p>稳定币偏离检查尚未刷新。</p>";
  const usdt0PerUsdt = view.usdt0.price && view.usdtUsd.price ? new Decimal(view.usdt0.price).div(view.usdtUsd.price).toString() : null;
  const paritySourceTime = view.usdt0.sourceTime !== null && view.usdtUsd.sourceTime !== null
    ? Math.min(view.usdt0.sourceTime, view.usdtUsd.sourceTime)
    : view.parity.sourceTime;
  return `<div class="section-heading"><h3>稳定币偏离检查</h3><span>OKX 综合指数；仅用于锚定风险保护，不用于收益换算</span></div><div class="table-wrap"><table><thead><tr><th>检查</th><th>状态</th><th class="numeric">参考价 / 比价</th><th class="numeric">偏离 %</th><th>数据时间 <small>(UTC + 8)</small></th></tr></thead><tbody>${row("Ethereum USDT / USD", view.usdtUsd.status, view.usdtUsd.price, view.usdtUsd.deviationPercent, view.usdtUsd.sourceTime)}${row("Solana USDT / USD", view.solUsdt.status, view.solUsdt.price, view.solUsdt.deviationPercent, view.solUsdt.sourceTime)}${row("X Layer USDT0 / USDT", view.parity.status, usdt0PerUsdt, view.parity.deviationPercent, paritySourceTime)}</tbody></table></div>${view.refreshError ? `<p class="guard-alert">指数刷新失败，仍新鲜的价格会继续使用：${escapeHtml(view.refreshError)}</p>` : ""}<p>报价收益仍按 USDT 与 USDT0 的 1:1 数量计算；这里只检查稳定币是否偏离锚定价格。</p>`;
}

const nowUtc8 = () => formatUtc8(new Date());

export function startDashboard(config: Config, assets: AssetConfig[], getState: () => DashboardState | Promise<DashboardState>, handleTrade?: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>): Server {
  async function renderPage(url: URL): Promise<string> {
    const state = await getState();
    const page = url.pathname;
    const activePage = page === "/opportunity" ? "/opportunities" : page.startsWith("/direct-pools") ? "/direct-pools" : page === "/blocked/detail" ? "/blocked" : page;
    const morePage = ["/blocked", "/blocked/detail", "/health"].includes(page) || (page === "/reports" && config.marketdata.quoteProvider === "aggregator");
    const navLink = (href: string, label: string) => {
      if (config.marketdata.quoteProvider === "direct_pool" && ["/opportunities", "/reports"].includes(href)) return "";
      const navLabel = href === "/direct-pools" && config.marketdata.quoteProvider === "direct_pool" ? "收益估算" : label;
      return `<a href="${href}"${activePage === href ? ' class="active" aria-current="page"' : ""}>${navLabel}</a>`;
    };
    let body = "";
    if (["/direct-pools", "/direct-pools/quotes", "/direct-pools/decisions", "/direct-pools/windows", "/direct-pools/window"].includes(page)) {
      body = await renderDirectPoolPage({
        url, config, assets, dbOnline: state.dbOnline, fixedPools: state.fixedPools,
        helpers: { escapeHtml, formatUtc8, formatReportDecimal, formatRawTokenAmount, directQuoteAssetUiMultiplier },
      });
    } else if (page === "/direct-pools/quote") {
      const id = url.searchParams.get("id");
      const backUrl = directPoolQuoteBackUrl(url.searchParams);
      if (!state.dbOnline) body = `<h2>Exact-In 报价详情</h2><p class="guard-alert">数据库不可用，暂时无法读取报价。</p><a href="${backUrl}">← 返回报价列表</a>`;
      else if (!id || !/^\d+$/.test(id)) body = `<h2>Exact-In 报价详情</h2><p class="guard-alert">报价编号无效。</p><a href="${backUrl}">← 返回报价列表</a>`;
      else {
        try {
          const [row] = await query<DirectQuoteRow[]>("SELECT q.id,q.scan_id,q.instrument_id,q.chain_index,q.pool_id,q.dex,q.direction,q.amount_in_raw,q.amount_out_raw,q.minimum_amount_out_raw,CAST(q.price_impact_percent AS CHAR) price_impact_percent,CAST(q.network_fee_usdt AS CHAR) network_fee_usdt,CAST(q.block_number AS CHAR) block_number,CAST(q.slot AS CHAR) slot,q.quoted_at,d.cex_book_at,d.cex_received_at,q.request_ms,q.status,q.failure_code,q.failure_reason,q.raw_response,d.valuation_inputs,CAST(d.cex_vwap AS CHAR) cex_vwap,CAST(d.gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(d.net_profit_usdt AS CHAR) net_profit_usdt,CAST(d.cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(d.gas_budget_usdt AS CHAR) gas_budget_usdt,CAST(d.roi AS CHAR) roi,d.valuation_status,d.decision_status,d.block_reason,d.simulation_status,d.simulation_reason,d.simulation_at,d.simulation_input_debited_raw,d.simulation_output_credited_raw,d.simulation_network_fee_native_raw,d.simulation_compute_units FROM direct_pool_quote q LEFT JOIN direct_pool_decision d ON d.selected_quote_id=q.id WHERE q.id=? LIMIT 1", [id]);
          if (!row) body = `<h2>Exact-In 报价详情</h2><p>没有找到这条报价。</p><a href="${backUrl}">← 返回报价列表</a>`;
          else {
           row.dex = directPoolDexLabel(row.dex);
          const pool = config.marketRegistry.pools.find((item) => item.id === row.pool_id);
          const monitor = pool && state.fixedPools?.find((item) => item.poolId === pool.id);
          const inputIsAsset = row.direction === "cex_buy_dex_sell";
          const assetUiMultiplier = pool?.chain === "solana" ? directQuoteAssetUiMultiplier(row.raw_response) : "1";
          const assetSymbol = monitor?.baseTokenSymbol ?? pool?.instrument_id ?? "asset";
          const quoteSymbol = monitor?.quoteTokenSymbol ?? "quote";
          const input = pool ? `${formatRawTokenAmount(row.amount_in_raw, inputIsAsset ? pool.token_in_out.asset_decimals : pool.token_in_out.quote_decimals, inputIsAsset ? assetUiMultiplier : "1")} ${inputIsAsset ? assetSymbol : quoteSymbol}` : "—";
          const output = pool ? `${formatRawTokenAmount(row.amount_out_raw, inputIsAsset ? pool.token_in_out.quote_decimals : pool.token_in_out.asset_decimals, inputIsAsset ? "1" : assetUiMultiplier)} ${inputIsAsset ? quoteSymbol : assetSymbol}` : "—";
          const minimumOut = pool && row.minimum_amount_out_raw !== null ? `${formatRawTokenAmount(row.minimum_amount_out_raw, inputIsAsset ? pool.token_in_out.quote_decimals : pool.token_in_out.asset_decimals, inputIsAsset ? "1" : assetUiMultiplier)} ${inputIsAsset ? quoteSymbol : assetSymbol}` : "—";
          const dexUnitPrice = (() => {
            if (!pool || row.amount_in_raw === null || row.amount_out_raw === null) return "—";
            try {
              const inputAmount = new Decimal(row.amount_in_raw).div(new Decimal(10).pow(inputIsAsset ? pool.token_in_out.asset_decimals : pool.token_in_out.quote_decimals)).mul(inputIsAsset ? assetUiMultiplier : "1");
              const outputAmount = new Decimal(row.amount_out_raw).div(new Decimal(10).pow(inputIsAsset ? pool.token_in_out.quote_decimals : pool.token_in_out.asset_decimals)).mul(inputIsAsset ? "1" : assetUiMultiplier);
              const assetAmount = inputIsAsset ? inputAmount : outputAmount;
              const quoteAmount = inputIsAsset ? outputAmount : inputAmount;
              return assetAmount.gt(0) ? `${formatReportDecimal(quoteAmount.div(assetAmount).toString(), 8)} ${quoteSymbol}/${assetSymbol}` : "—";
            } catch { return "—"; }
          })();
          const cexPriceLabel = row.direction === "cex_buy_dex_sell" ? "CEX 买入 VWAP" : "CEX 卖出 VWAP";
          const dexPriceLabel = row.direction === "cex_buy_dex_sell" ? "DEX 卖出均价" : "DEX 买入均价";
          const cexUnitPrice = row.cex_vwap === null ? "—" : `${formatReportDecimal(row.cex_vwap, 8)} USDT/${row.instrument_id}`;
          const cexReceiveDelta = (() => {
            if (!row.cex_received_at || !row.quoted_at) return "—";
            const deltaMs = row.cex_received_at.getTime() - row.quoted_at.getTime();
            const relation = deltaMs < 0 ? "CEX 盘口先收到" : deltaMs > 0 ? "DEX 报价先完成" : "同一毫秒";
            return `${deltaMs > 0 ? "+" : ""}${deltaMs} ms（${relation}）`;
          })();
          const invalidated = row.valuation_status?.startsWith("INVALIDATED_") ?? false;
          const profit = invalidated || row.net_profit_usdt === null ? "—" : `${formatReportDecimal(row.net_profit_usdt, 8)} USDT${row.roi === null ? "" : ` · ${formatReportDecimal(new Decimal(row.roi).mul(10_000).toString(), 6)} bp`}`;
          const raw = row.raw_response === null ? "—" : JSON.stringify(row.raw_response, null, 2);
          const direction = row.direction === "dex_buy_cex_sell" ? "quote → asset（DEX 买入 · CEX 卖出）" : "asset → quote（CEX 买入 · DEX 卖出）";
          const quoteField = (label: string, value: unknown) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "—")}</dd></div>`;
          const quoteCodeField = (label: string, value: unknown) => `<div><dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value ?? "—")}</code></dd></div>`;
          const statusClass = row.status === "OK" ? "fresh" : row.status === "FAILED" ? "unhealthy" : "unknown";
          const solanaGasPrice = pool?.chain === "solana" ? directPoolSolanaGasPrice(row.valuation_inputs) : null;
          const profitBreakdown = invalidated ? row.block_reason ?? "估值失效" : row.net_profit_usdt === null ? "—" : `毛 ${formatReportDecimal(row.gross_profit_usdt ?? "0", 8)} · CEX 费 ${formatReportDecimal(row.cex_fee_usdt ?? "0", 8)} · Gas ${formatReportDecimal(row.gas_budget_usdt ?? "0", 8)} USDT${solanaGasPrice ? `（${solanaGasPrice}）` : ""}`;
          body = `<h2>Exact-In 报价详情</h2><p class="direct-quote-back"><a href="${backUrl}">← 返回报价列表</a></p><section class="overview direct-quote-detail"><header class="direct-quote-heading"><div><p>报价记录 #${escapeHtml(row.id)} · ${escapeHtml(row.dex)}</p><h3>${escapeHtml(row.instrument_id)}</h3><span>${escapeHtml(row.pool_id)}</span></div><span class="badge ${statusClass}">${escapeHtml(row.status)}</span></header><div class="direct-quote-flow"><div><small>输入</small><strong>${escapeHtml(input)}</strong></div><span aria-hidden="true">→</span><div><small>报价输出</small><strong>${escapeHtml(output)}</strong></div></div><div class="direct-quote-minimum"><span>最低到手</span><strong>${escapeHtml(minimumOut)}</strong></div><section class="direct-quote-block"><h4>两边单位价格（估算）</h4><dl class="direct-quote-fields">${quoteField(cexPriceLabel, cexUnitPrice)}${quoteField(dexPriceLabel, dexUnitPrice)}</dl><p class="direct-record-note">CEX 为同规模盘口 VWAP；DEX 按本次 Exact-In 输入和输出折算。都是报价估算，不是实际成交价。</p></section><section class="direct-quote-block"><h4>报价信息</h4><dl class="direct-quote-fields">${quoteField("报价时间 (UTC + 8)", formatUtc8(row.quoted_at))}${quoteField("方向", direction)}${quoteField("状态版本", row.block_number ? `block ${row.block_number}` : row.slot ? `slot ${row.slot}` : "未知")}${quoteField("报价采集耗时", row.request_ms === null ? "—" : `${row.request_ms} ms`)}${quoteField("价格影响", row.price_impact_percent === null ? "—" : `${formatReportDecimal(row.price_impact_percent, 8)}%`)}${quoteField("Token-2022 UI multiplier", assetUiMultiplier)}</dl></section><section class="direct-quote-block"><h4>盘口与池报价时间对照</h4><dl class="direct-quote-fields">${quoteField("DEX Exact-In 报价完成时间", formatUtc8(row.quoted_at, true))}${quoteField("CEX 行情源时间", formatUtc8(row.cex_book_at, true))}${quoteField("CEX 盘口本机接收时间", formatUtc8(row.cex_received_at, true))}${quoteField("本机接收时间 − DEX 报价完成", cexReceiveDelta)}</dl><p class="direct-record-note">时间差使用本机接收时间与 DEX 报价完成时间比较；行情源时间来自交易所时钟，可能存在时钟偏差。时间接近不代表两边来自同一瞬间，也不代表实际成交时仍有该价差。</p></section><section class="direct-quote-block"><h4>收益估算</h4><dl class="direct-quote-fields">${quoteField("估值 / 结论", `${row.valuation_status ?? "—"} / ${row.decision_status ?? "—"}`)}${quoteField("净收益 / ROI (bp)", profit)}${quoteField("收益拆分", profitBreakdown)}${quoteField("状态说明", row.failure_reason ?? row.block_reason ?? "—")}</dl></section><section class="direct-quote-block"><h4>链上模拟（不广播）</h4><dl class="direct-quote-fields">${quoteField("模拟状态", directPoolSimulationLabel(row.simulation_status))}${quoteField("模拟说明", row.simulation_reason)}${quoteField("实际输入扣款 raw", row.simulation_input_debited_raw)}${quoteField("实际输出到账 raw", row.simulation_output_credited_raw)}${quoteField("估算网络费 raw (lamports)", row.simulation_network_fee_native_raw)}${quoteField("计算单元", row.simulation_compute_units)}${quoteField("模拟时间 (UTC + 8)", formatUtc8(row.simulation_at))}</dl><p class="direct-record-note">模拟通过只说明此时该指定池交易通过模拟；收益仍按 USDC/USDT 1:1 估算，执行资格仍是 NOT_EXECUTABLE。</p></section><details class="direct-quote-raw"><summary><strong>链上 raw 数量与 RPC 响应</strong><span>展开查看</span></summary><dl class="direct-quote-fields">${quoteCodeField("输入 raw", row.amount_in_raw)}${quoteCodeField("输出 raw", row.amount_out_raw)}${quoteCodeField("最小输出 raw", row.minimum_amount_out_raw)}${quoteCodeField("scan ID", row.scan_id)}</dl><h4>原始 RPC 响应</h4><pre class="direct-raw-response">${escapeHtml(raw)}</pre></details></section><style>.direct-quote-back{margin:0 0 16px;font-size:12px}.direct-quote-back a{text-decoration:none}.direct-quote-detail{padding:26px}.direct-quote-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.direct-quote-heading>div{min-width:0}.direct-quote-heading p{margin:0 0 4px;color:#758198;font-size:11px}.direct-quote-heading h3{margin:0;font-size:18px;overflow-wrap:anywhere}.direct-quote-heading>div>span{display:block;margin-top:3px;color:#65738a;font-size:12px;overflow-wrap:anywhere}.direct-quote-heading>.badge{flex:none}.direct-quote-flow{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:14px;padding:18px;border:1px solid #e2e9f3;border-radius:12px;background:#f8fafd}.direct-quote-flow>div{min-width:0}.direct-quote-flow small,.direct-quote-minimum span{display:block;color:#758198;font-size:11px}.direct-quote-flow strong{display:block;margin-top:5px;font-size:17px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.direct-quote-flow>span{color:#98a2b3;font-size:20px}.direct-quote-minimum{display:flex;justify-content:space-between;gap:12px;margin-top:8px;padding:10px 14px;border-radius:8px;background:#f3f7fd}.direct-quote-minimum strong{font-size:13px;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}.direct-quote-block{margin-top:22px}.direct-quote-block h4,.direct-quote-raw h4{margin:0 0 10px;font-size:13px}.direct-quote-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0}.direct-quote-fields>div{min-width:0;padding:11px 13px;border:1px solid #e8edf4;border-radius:9px;background:#fff}.direct-quote-fields dt{color:#758198;font-size:11px}.direct-quote-fields dd{margin:4px 0 0;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.direct-quote-fields code{white-space:normal;overflow-wrap:anywhere}.direct-quote-raw{margin-top:22px;padding-top:14px;border-top:1px solid #e7ebf2}.direct-quote-raw summary{display:flex;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.direct-quote-raw summary::-webkit-details-marker{display:none}.direct-quote-raw summary span{color:#758198;font-size:11px}.direct-quote-raw[open] summary{margin-bottom:12px}.direct-quote-raw h4{margin-top:14px}.direct-raw-response{max-height:460px;overflow:auto;margin:0;padding:12px;background:#f7f9fc;border:1px solid #e1e7f0;border-radius:8px;font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:700px){.direct-quote-detail{padding:16px}.direct-quote-flow{gap:8px;padding:13px}.direct-quote-flow strong{font-size:14px}.direct-quote-fields{grid-template-columns:1fr}}</style>`;
          }
        } catch {
          body = `<h2>Exact-In 报价详情</h2><p class="guard-alert">指定池数据表尚不可用；请先执行 npm run db:migrate。</p><a href="${backUrl}">← 返回报价列表</a>`;
        }
      }
    } else if (page === "/trade") {
      body = "<h2>交易控制</h2><p>独立看板为只读模式。交易开关依赖采集进程，请使用一体启动方式打开交易控制。</p>";
    } else if (page === "/health") {
      body = `<h2>依赖健康状态</h2><table><tr><th>依赖</th><th>状态</th><th>最近成功 (UTC + 8)</th><th>最近错误</th></tr>${[...state.health.values()].map((h) => `<tr><td>${escapeHtml(h.dependency)}</td><td>${escapeHtml(h.status)}</td><td>${escapeHtml(formatUtc8(h.lastSuccess))}</td><td>${escapeHtml(h.lastError)}</td></tr>`).join("")}</table>${valuationPanel(state.valuation)}`;
    } else if (page === "/blocked/detail") {
      const recordId = url.searchParams.get("id");
      if (!state.dbOnline) body = `<h2>拦截诊断</h2><p class="guard-alert">数据库不可用，暂时无法读取记录。</p><a href="/blocked">返回被拦截观察</a>`;
      else if (!recordId || !/^\d+$/.test(recordId)) body = `<h2>拦截诊断</h2><p>记录编号无效。</p><a href="/blocked">返回被拦截观察</a>`;
      else {
        const [r] = await query<BlockedRow[]>("SELECT CAST(id AS CHAR) id,observed_at,inst_id,chain_index,direction,CAST(size_usdt AS CHAR) size_usdt,reason_code,reason,cex_ts,quote_response FROM risk_event WHERE id=? AND decision='BLOCK' LIMIT 1", [recordId]);
        if (!r) body = `<h2>拦截诊断</h2><p>没有找到这条记录。</p><a href="/blocked">返回被拦截观察</a>`;
        else {
          const network = assets.find((asset) => asset.chainIndex === r.chain_index)?.network ?? r.chain_index;
          const direction = r.direction === "cex_buy_dex_sell" ? "CEX 买入 · DEX 卖出" : r.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : r.direction === "multiplier_check" ? "Multiplier 核验" : "未知方向";
          const rawQuote = r.quote_response == null ? "<p>无原始报价数据。</p>" : `<pre>${escapeHtml(JSON.stringify(r.quote_response, null, 2))}</pre>`;
          body = `<h2>拦截诊断</h2><p><a href="/blocked">← 返回被拦截观察</a></p><section class="overview"><h3>记录信息</h3><table class="detail-table"><tbody><tr><th>观察时间 <small>(UTC + 8)</small></th><td>${escapeHtml(formatUtc8(r.observed_at))}</td></tr><tr><th>资产 / 网络</th><td>${escapeHtml(r.inst_id)} · ${escapeHtml(network)}</td></tr><tr><th>方向</th><td>${direction}</td></tr><tr><th>规模</th><td>${escapeHtml(new Decimal(r.size_usdt).toFixed(2))} USDT</td></tr><tr><th>拦截原因</th><td><span class="badge unhealthy">${escapeHtml(closeReasonLabel(r.reason_code))}</span></td></tr><tr><th>原因代码</th><td><code>${escapeHtml(r.reason_code)}</code></td></tr><tr><th>原因说明</th><td>${escapeHtml(r.reason)}</td></tr><tr><th>CEX 行情时间 <small>(UTC + 8)</small></th><td>${escapeHtml(formatUtc8(r.cex_ts))}</td></tr></tbody></table><h3>原始报价</h3>${rawQuote}</section>`;
        }
      }
    } else if (page === "/blocked") {
      const blocked = state.dbOnline ? await query<BlockedSummaryRow[]>("SELECT CAST(id AS CHAR) id,observed_at,inst_id,chain_index,direction,CAST(size_usdt AS CHAR) size_usdt,reason_code FROM risk_event WHERE decision='BLOCK' ORDER BY observed_at DESC LIMIT 500") : [];
      const blockedRows = blocked.map((r) => {
        const network = assets.find((asset) => asset.chainIndex === r.chain_index)?.network ?? r.chain_index;
        const direction = r.direction === "cex_buy_dex_sell" ? "CEX 买入 · DEX 卖出" : r.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : r.direction === "multiplier_check" ? "Multiplier 核验" : "未知方向";
        return `<tr><td class="numeric">${escapeHtml(formatUtc8(r.observed_at))}</td><td><strong>${escapeHtml(r.inst_id)}</strong><br><small>${escapeHtml(network)}</small></td><td>${direction}</td><td class="numeric">${escapeHtml(new Decimal(r.size_usdt).toFixed(2))} USDT</td><td><span class="badge unhealthy">${escapeHtml(closeReasonLabel(r.reason_code))}</span></td><td><a href="/blocked/detail?id=${encodeURIComponent(r.id)}">查看 →</a></td></tr>`;
      }).join("");
      body = `<h2>被拦截的观察</h2><p>这些记录不会计入正收益机会；点击“查看”进入单条诊断页面。</p>${!state.dbOnline ? '<p class="guard-alert">数据库不可用，暂时无法读取记录。</p>' : `<div class="table-wrap"><table class="blocked-table" style="min-width:980px"><thead><tr><th>时间 <small>(UTC + 8)</small></th><th>资产 / 网络</th><th>方向</th><th>规模</th><th>拦截原因</th><th>详情</th></tr></thead><tbody>${blockedRows || '<tr><td class="empty-state" colspan="6">暂无被拦截的观察</td></tr>'}</tbody></table></div>`}`;
    } else if (page === "/reports") {
      const conditions: string[] = [];
      const values: unknown[] = [];
      const day = url.searchParams.get("day");
      const type = url.searchParams.get("type");
      const direction = url.searchParams.get("direction");
      const size = url.searchParams.get("size");
      const chain = url.searchParams.get("chain");
      const instId = url.searchParams.get("asset");
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const from = new Date(`${day}T00:00:00+08:00`);
        if (Number.isFinite(from.getTime()) && from.toISOString().slice(0, 10) === day) {
          const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
          conditions.push("period_start>=? AND period_start<?");
          values.push(from, to);
        } else conditions.push("1=0");
      }
      if (type === "hourly" || type === "daily") { conditions.push("period_type=?"); values.push(type); }
      if (direction === "cex_buy_dex_sell" || direction === "dex_buy_cex_sell") { conditions.push("direction=?"); values.push(direction); }
      if (size && ["100", "250", "500"].includes(size)) { conditions.push("size_usdt=?"); values.push(size); }
      if (chain && assets.some((asset) => asset.chainIndex === chain)) { conditions.push("chain_index=?"); values.push(chain); }
      if (instId && assets.some((asset) => asset.instId === instId)) { conditions.push("inst_id=?"); values.push(instId); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const reports = state.dbOnline ? await query<ReportRow[]>(`SELECT period_type,period_start,inst_id,chain_index,CAST(size_usdt AS CHAR) size_usdt,direction,opportunity_count,monitor_only_count,CAST(max_profit AS CHAR) max_profit,CAST(median_profit AS CHAR) median_profit,collected,longest_positive_seconds,legacy_nominal FROM report ${where} ORDER BY period_start DESC LIMIT 500`, values) : [];
      const reportRows = reports.map((r) => {
        const period = r.period_type === "hourly" ? "小时" : r.period_type === "daily" ? "日报" : r.period_type;
        const network = assets.find((asset) => asset.chainIndex === r.chain_index)?.network ?? r.chain_index;
        const directionLabel = r.direction === "cex_buy_dex_sell" ? "CEX 买入 · DEX 卖出" : "DEX 买入 · CEX 卖出";
        return `<tr><td>${escapeHtml(period)}</td><td class="numeric">${escapeHtml(formatUtc8(r.period_start))}</td><td><strong>${escapeHtml(r.inst_id)}</strong><br><small>${escapeHtml(network)}</small></td><td>${directionLabel}</td><td class="numeric">${escapeHtml(new Decimal(r.size_usdt).toFixed(2))}</td><td class="numeric">${r.opportunity_count}</td><td class="numeric">${r.monitor_only_count}</td><td class="numeric">${escapeHtml(formatReportDecimal(r.max_profit))}</td><td class="numeric">${escapeHtml(formatReportDecimal(r.median_profit))}</td><td>${escapeHtml(formatReportDuration(r.longest_positive_seconds))}</td><td><span class="badge ${r.collected ? "fresh" : "unknown"}">${r.collected ? "已采集" : "未采集"}</span></td><td><span class="badge ${r.legacy_nominal ? "unknown" : "fresh"}">${r.legacy_nominal ? "旧口径" : "新口径"}</span></td></tr>`;
      }).join("");
      body = `<h2>小时报与日报</h2><form class="report-filters"><label>日期（UTC + 8）<input type="date" name="day" value="${escapeHtml(day)}"></label><label>周期<select name="type"><option value="">全部</option><option value="hourly" ${type === "hourly" ? "selected" : ""}>小时</option><option value="daily" ${type === "daily" ? "selected" : ""}>日报</option></select></label><label>资产<select name="asset"><option value="">全部</option>${[...new Set(assets.map((asset) => asset.instId))].map((item) => `<option value="${escapeHtml(item)}" ${instId === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></label><label>网络<select name="chain"><option value="">全部</option>${[...new Map(assets.map((asset) => [asset.chainIndex, asset.network] as const)).entries()].map(([chainIndex, network]) => `<option value="${escapeHtml(chainIndex)}" ${chain === chainIndex ? "selected" : ""}>${escapeHtml(network)}</option>`).join("")}</select></label><label>方向<select name="direction"><option value="">全部</option><option value="cex_buy_dex_sell" ${direction === "cex_buy_dex_sell" ? "selected" : ""}>CEX 买入 · DEX 卖出</option><option value="dex_buy_cex_sell" ${direction === "dex_buy_cex_sell" ? "selected" : ""}>DEX 买入 · CEX 卖出</option></select></label><label>规模<select name="size"><option value="">全部</option><option ${size === "100" ? "selected" : ""}>100</option><option ${size === "250" ? "selected" : ""}>250</option><option ${size === "500" ? "selected" : ""}>500</option></select></label><button>筛选</button></form><div class="table-wrap report-table-wrap"><table class="report-table" style="min-width:1240px"><thead><tr><th>周期</th><th>起始时间 <small>(UTC + 8)</small></th><th>资产 / 网络</th><th>方向</th><th>规模 <small>USDT</small></th><th title="通过交易执行评估的正收益窗口">可执行窗口</th><th title="仅观察或未通过执行评估的正收益窗口">观察 / 未通过</th><th>峰值净收益 <small>USDT</small></th><th>中位净收益 <small>USDT</small></th><th>最长正收益</th><th>采集</th><th>口径</th></tr></thead><tbody>${reportRows || '<tr><td class="empty-state" colspan="12">当前筛选下没有报表数据</td></tr>'}</tbody></table></div>`;
    } else if (page === "/opportunities") {
      const pageSize = 50;
      const requestedPage = Number(url.searchParams.get("page"));
      const requestedValuation = url.searchParams.get("valuation");
      const valuationFilter = requestedValuation === "VERIFIED" || requestedValuation === "LEGACY_NOMINAL" ? requestedValuation : "all";
      const search = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
      const chainOptions = [...new Map(assets.map((asset) => [asset.chainIndex, asset.network] as const)).entries()];
      const requestedChain = url.searchParams.get("chain") ?? "";
      const chain = chainOptions.some(([chainIndex]) => chainIndex === requestedChain) ? requestedChain : "";
      const requestedDirection = url.searchParams.get("direction");
      const directionFilter = requestedDirection === "cex_buy_dex_sell" || requestedDirection === "dex_buy_cex_sell" ? requestedDirection : "";
      const conditions = ["o.legacy_sample=0"];
      const values: unknown[] = [];
      if (valuationFilter !== "all") { conditions.push("q.valuation_status=?"); values.push(valuationFilter); }
      if (search) { conditions.push("q.inst_id LIKE ?"); values.push(`%${search}%`); }
      if (chain) { conditions.push("q.chain_index=?"); values.push(chain); }
      if (directionFilter) { conditions.push("o.direction=?"); values.push(directionFilter); }
      const where = `WHERE ${conditions.join(" AND ")}`;
      const statusCounts = state.dbOnline ? await query<Array<{ valuation_status: string; total: number; filtered_total: number | string }>>(`SELECT q.valuation_status,COUNT(*) AS total,SUM(CASE WHEN ${conditions.join(" AND ")} THEN 1 ELSE 0 END) AS filtered_total FROM opportunity o JOIN quote_observation q ON q.id=o.quote_observation_id WHERE o.legacy_sample=0 GROUP BY q.valuation_status`, values) : [];
      const countFor = (status: string) => statusCounts.find((row) => row.valuation_status === status)?.total ?? 0;
      const verifiedCount = countFor("VERIFIED");
      const legacyCount = countFor("LEGACY_NOMINAL");
      const allCount = statusCounts.reduce((sum, row) => sum + row.total, 0);
      const otherCount = allCount - verifiedCount - legacyCount;
      const total = statusCounts.reduce((sum, row) => sum + Number(row.filtered_total), 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
      const rows = state.dbOnline ? await query<OpportunityListRow[]>(`SELECT o.id,o.observed_at opened_at,o.ended_at,o.close_reason,o.executable_status,o.execution_reason,CAST(o.peak_profit_usdt AS CHAR) peak_profit_usdt,q.inst_id,q.chain_index,o.direction,CAST(o.size_usdt AS CHAR) size_usdt,CAST(o.net_profit_usdt AS CHAR) net_profit_usdt,CAST(o.roi AS CHAR) roi,q.is_stale,q.valuation_status,
        (SELECT MAX(s.observed_at) FROM quote_observation s WHERE s.inst_id=o.inst_id AND s.chain_index=o.chain_index AND s.direction=o.direction AND s.size_usdt=o.size_usdt AND s.observed_at>=o.observed_at AND s.observed_at<=COALESCE(o.ended_at,UTC_TIMESTAMP(3)) AND s.status='OK' AND s.valuation_status='VERIFIED') last_updated_at,
        (SELECT COUNT(*) FROM quote_observation s WHERE s.inst_id=o.inst_id AND s.chain_index=o.chain_index AND s.direction=o.direction AND s.size_usdt=o.size_usdt AND s.observed_at>=o.observed_at AND s.observed_at<=COALESCE(o.ended_at,UTC_TIMESTAMP(3)) AND s.status='OK' AND s.valuation_status='VERIFIED') sample_count,
        TIMESTAMPDIFF(SECOND,o.observed_at,COALESCE(o.ended_at,UTC_TIMESTAMP(3))) duration_seconds
        FROM opportunity o JOIN quote_observation q ON q.id=o.quote_observation_id ${where} ORDER BY o.observed_at DESC LIMIT ? OFFSET ?`, [...values, pageSize, (currentPage - 1) * pageSize]) : [];
      const filterParams = new URLSearchParams();
      if (search) filterParams.set("q", search);
      if (chain) filterParams.set("chain", chain);
      if (directionFilter) filterParams.set("direction", directionFilter);
      if (valuationFilter !== "all") filterParams.set("valuation", valuationFilter);
      const pageHref = (pageNumber: number) => { const params = new URLSearchParams(filterParams); params.set("page", String(pageNumber)); return `/opportunities?${params.toString()}`; };
      const jumpFields = [...filterParams].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
      const pageJump = `<form class="pagination-jump" method="get" action="/opportunities" style="display:flex;align-items:center;gap:6px;margin:0">${jumpFields}<label>跳至第 <input type="number" name="page" value="${currentPage}" min="1" max="${totalPages}" step="1" required aria-label="跳转到页码" style="width:68px;padding:5px 7px"> 页</label><button type="submit">跳转</button></form>`;
      const filterForm = `<form method="get" class="opportunity-filters"><label>标的搜索 <input type="search" name="q" value="${escapeHtml(search)}" placeholder="代币 / 交易对"></label><label>网络 / 链 <select name="chain"><option value="">全部</option>${chainOptions.map(([chainIndex, network]) => `<option value="${escapeHtml(chainIndex)}" ${chain === chainIndex ? "selected" : ""}>${escapeHtml(network)} · ${escapeHtml(chainIndex)}</option>`).join("")}</select></label><label>方向 <select name="direction"><option value="">全部</option><option value="cex_buy_dex_sell" ${directionFilter === "cex_buy_dex_sell" ? "selected" : ""}>CEX 买入 · DEX 卖出</option><option value="dex_buy_cex_sell" ${directionFilter === "dex_buy_cex_sell" ? "selected" : ""}>DEX 买入 · CEX 卖出</option></select></label><label>估值口径 <select name="valuation"><option value="all" ${valuationFilter === "all" ? "selected" : ""}>全部（${allCount}）</option><option value="VERIFIED" ${valuationFilter === "VERIFIED" ? "selected" : ""}>已核验（${verifiedCount}）</option><option value="LEGACY_NOMINAL" ${valuationFilter === "LEGACY_NOMINAL" ? "selected" : ""}>旧口径（${legacyCount}）</option></select></label><button>筛选</button><a href="/opportunities">清除条件</a></form>`;
body = `<section class="overview"><h2>机会窗口</h2><p>数据库共 ${allCount} 个正收益窗口：${verifiedCount} 个已核验，${legacyCount} 个旧口径${otherCount ? `，${otherCount} 个其他状态` : ""}。同一标的、网络、方向和规模的连续正收益合并为一个窗口；连续两次报价不盈利时结束。详情按 5 秒片段展示窗口内变化，片段不是独立机会或成交记录。执行评估会检查安全缓冲、路线和库存；交易未启用时不评估。</p>${filterForm}<div class="table-wrap"><table class="opportunities"><thead><tr><th>开始时间 <small>(UTC + 8)</small></th><th>标的 / 网络</th><th>方向</th><th class="numeric">规模</th><th class="numeric">当前 / 峰值收益</th><th>最近有效报价 <small>(UTC + 8)</small></th><th>持续时间</th><th>样本数</th><th>窗口状态</th><th>执行评估</th></tr></thead><tbody>${rows.length ? rows.map((r) => {
        const direction = r.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出";
        const network = assets.find((asset) => asset.instId === r.inst_id && asset.chainIndex === r.chain_index)?.network ?? r.chain_index;
        const profit = r.net_profit_usdt === null ? "未知" : `${new Decimal(r.net_profit_usdt).toFixed(4)} / ${new Decimal(r.peak_profit_usdt ?? r.net_profit_usdt).toFixed(4)} USDT`;
        const verified = r.valuation_status === "VERIFIED";
        const status = r.ended_at
          ? `<span class="badge stale" title="原始原因：${escapeHtml(r.close_reason ?? "未知原因")}">已结束 · ${escapeHtml(closeReasonLabel(r.close_reason))}</span>`
          : `<span class="badge fresh">持续中</span>`;
        const executable = r.executable_status === "EXECUTABLE" ? "库存与缓冲通过" : r.executable_status === "NOT_EVALUATED" ? "交易未启用 · 未评估" : `不可执行 · ${escapeHtml(r.execution_reason ?? "条件未通过")}`;
        const recordStatus = verified ? "USDT 已核验" : r.valuation_status === "LEGACY_NOMINAL" ? "旧口径 · 未核验" : r.valuation_status;
        return `<tr><td><a class="time-link" href="/opportunity?id=${r.id}">${escapeHtml(formatUtc8(r.opened_at))}</a></td><td><a href="/opportunity?id=${r.id}"><strong>${escapeHtml(r.inst_id)}</strong></a><br><small>${escapeHtml(network)} · ${escapeHtml(recordStatus)}</small></td><td>${direction}</td><td class="numeric">${new Decimal(r.size_usdt).toFixed(2)} USDT</td><td class="numeric profit">${escapeHtml(profit)}</td><td>${escapeHtml(formatUtc8(r.last_updated_at))}</td><td>${escapeHtml(formatReportDuration(Number(r.duration_seconds)))}</td><td>${Number(r.sample_count).toLocaleString("en-US")}</td><td>${status}${r.is_stale ? `<br><span class="badge stale">盘口过期</span>` : ""}</td><td>${executable}</td></tr>`;
      }).join("") : `<tr><td colspan="10">${state.dbOnline ? "当前筛选下没有机会窗口。" : "数据库未连接，暂时无法读取机会记录。"}</td></tr>`}</tbody></table></div><div class="pagination"><span>第 ${currentPage} / ${totalPages} 页，共 ${total} 条</span><div>${currentPage > 1 ? `<a href="${escapeHtml(pageHref(currentPage - 1))}">← 上一页</a>` : "<span class=\"disabled\">← 上一页</span>"}${currentPage < totalPages ? `<a href="${escapeHtml(pageHref(currentPage + 1))}">下一页 →</a>` : "<span class=\"disabled\">下一页 →</span>"}${pageJump}</div></div></section>`;
    } else if (page === "/opportunity") {
      const detail = state.dbOnline ? await query<Array<{ inst_id: string; direction: string; chain_index: string; route_status: string; size_usdt: string; shares: string; token_amount: string; cex_vwap: string; cex_fee_rate: string; cex_fee_usdt: string; gas_usdt: string; gas_native_raw: string; gas_source: string; gross_profit_usdt: string | null; net_profit_usdt: string; rebalance_cost_usdt: string | null; net_profit_after_rebalance_usdt: string | null; multiplier: string; multiplier_raw: unknown; cex_ts: Date | null; cex_received_at: Date | null; dex_ts: Date; dex_request_started_at: Date | null; dex_request_ms: string | null; dex_queue_wait_ms: string | null; observed_at: Date; opened_at: Date; ended_at: Date | null; close_reason: string | null; peak_profit_usdt: string; executable_status: string; execution_buffer_usdt: string | null; executable_profit_usdt: string | null; execution_reason: string | null; is_stale: number; price_impact_percent: string | null; from_token_unit_price_usd: string | null; to_token_unit_price_usd: string | null; paid_value_usd: string | null; received_value_usd: string | null; raw_response: unknown; native_quote_amount: string | null; native_quote_symbol: string | null; usdt_rate: string | null; conversion_cost_usdt: string | null; usdt_estimate: string | null; valuation_status: string; price_source_time: Date | null; quote_summary: string | null }>>(`SELECT q.inst_id,q.direction,q.chain_index,q.route_status,CAST(q.size_usdt AS CHAR) size_usdt,CAST(q.shares AS CHAR) shares,CAST(q.token_amount AS CHAR) token_amount,CAST(q.cex_vwap AS CHAR) cex_vwap,CAST(q.cex_fee_rate AS CHAR) cex_fee_rate,CAST(q.cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(q.gas_usdt AS CHAR) gas_usdt,q.gas_native_raw,q.gas_source,CAST(q.gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(q.net_profit_usdt AS CHAR) net_profit_usdt,CAST(q.rebalance_cost_usdt AS CHAR) rebalance_cost_usdt,CAST(q.net_profit_after_rebalance_usdt AS CHAR) net_profit_after_rebalance_usdt,CAST(q.multiplier AS CHAR) multiplier,q.multiplier_raw,q.cex_ts,q.cex_received_at,q.dex_ts,q.dex_request_started_at,CAST(q.dex_request_ms AS CHAR) dex_request_ms,CAST(q.dex_queue_wait_ms AS CHAR) dex_queue_wait_ms,q.observed_at,o.observed_at opened_at,o.ended_at,o.close_reason,CAST(o.peak_profit_usdt AS CHAR) peak_profit_usdt,o.executable_status,CAST(o.execution_buffer_usdt AS CHAR) execution_buffer_usdt,CAST(o.executable_profit_usdt AS CHAR) executable_profit_usdt,o.execution_reason,q.is_stale,CAST(q.price_impact_percent AS CHAR) price_impact_percent,CAST(q.from_token_unit_price_usd AS CHAR) from_token_unit_price_usd,CAST(q.to_token_unit_price_usd AS CHAR) to_token_unit_price_usd,CAST(q.paid_value_usd AS CHAR) paid_value_usd,CAST(q.received_value_usd AS CHAR) received_value_usd,q.raw_response,CAST(q.native_quote_amount AS CHAR) native_quote_amount,q.native_quote_symbol,CAST(q.usdt_rate AS CHAR) usdt_rate,CAST(q.conversion_cost_usdt AS CHAR) conversion_cost_usdt,CAST(q.usdt_estimate AS CHAR) usdt_estimate,q.valuation_status,q.price_source_time,q.quote_summary FROM opportunity o JOIN quote_observation q ON q.id=o.quote_observation_id WHERE o.id=?`, [url.searchParams.get("id")]) : [];
      const row = detail[0];
      if (!row) {
  body = `<section class="overview"><h2>未找到机会记录</h2><p>该记录可能已删除，或链接中的编号无效。</p><p><a href="/opportunities">← 返回机会列表</a></p></section>`;
      } else {
        const now = new Date();
        const history = await query<OpportunityQuoteBucketRow[]>(`WITH bucketed AS (
          SELECT FLOOR(TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00.000000',observed_at)/5000000) bucket_index,
            id,observed_at,COALESCE(net_profit_after_rebalance_usdt,net_profit_usdt) net_profit_usdt,price_impact_percent
          FROM quote_observation
          WHERE inst_id=? AND chain_index=? AND direction=? AND size_usdt=? AND observed_at>=? AND observed_at<=?
            AND status='OK' AND valuation_status='VERIFIED'
        ), ranked AS (
          SELECT bucket_index,observed_at,net_profit_usdt,
            COUNT(*) OVER (PARTITION BY bucket_index) sample_count,
            MAX(net_profit_usdt) OVER (PARTITION BY bucket_index) peak_profit,
            MIN(ABS(price_impact_percent)) OVER (PARTITION BY bucket_index) min_price_impact,
            ROW_NUMBER() OVER (PARTITION BY bucket_index ORDER BY observed_at DESC,id DESC) row_number
          FROM bucketed
        )
        SELECT CAST(bucket_index*5000 AS CHAR) bucket_start_ms,observed_at latest_at,CAST(sample_count AS CHAR) sample_count,
          CAST(net_profit_usdt AS CHAR) current_profit,CAST(peak_profit AS CHAR) peak_profit,CAST(min_price_impact AS CHAR) min_price_impact
        FROM ranked WHERE row_number=1 ORDER BY bucket_index ASC`, [
          row.inst_id, row.chain_index, row.direction, row.size_usdt, row.opened_at, row.ended_at ?? now,
        ]);
        const quoteBuckets = mapOpportunityQuoteBucketRows(history, row.ended_at, now);
        const historySampleCount = quoteBuckets.reduce((total, bucket) => total + bucket.sampleCount, 0);
        const lastUpdatedAt = quoteBuckets.at(-1)?.latestAt ?? row.observed_at;
        const durationSeconds = Math.max(0, Math.floor(((row.ended_at ?? now).getTime() - row.opened_at.getTime()) / 1000));
        const convertedShares = new Decimal(row.token_amount).mul(row.multiplier);
        const direction = row.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出";
        const cexBuy = row.direction === "cex_buy_dex_sell";
        const asset = assets.find((item) => item.instId === row.inst_id && item.chainIndex === row.chain_index);
        const tokenSymbol = asset?.tokenSymbol ?? row.inst_id.split("-")[0] ?? "Token";
        const cexQuoteSymbol = row.inst_id.split("-").at(-1) ?? "USDT";
        const dexQuoteSymbol = row.native_quote_symbol ?? asset?.quoteTokenSymbol ?? "报价币";
        const shares = new Decimal(row.shares);
        const tokenAmount = new Decimal(row.token_amount);
        const cexPrice = new Decimal(row.cex_vwap);
        const cexTotal = shares.mul(cexPrice);
        const dexTotal = row.native_quote_amount === null ? null : new Decimal(row.native_quote_amount);
        const dexPricePerToken = dexTotal && tokenAmount.gt(0) ? dexTotal.div(tokenAmount) : null;
        const dexPricePerShare = dexPricePerToken?.div(row.multiplier) ?? null;
        const dexPriceUsdtPerShare = row.valuation_status === "VERIFIED" && dexPricePerShare && row.usdt_rate ? dexPricePerShare.mul(row.usdt_rate) : null;
        const formatAmount = (value: Decimal | null) => value?.isFinite() ? escapeHtml(value.toSignificantDigits(8).toString()) : "未知";
        const cexAction = cexBuy ? "买入" : "卖出";
        const dexAction = cexBuy ? "卖出" : "买入";
        const cexLeg = `<article class="trade-leg ${cexBuy ? "buy" : "sell"}"><h3>${cexAction} · CEX 盘口</h3><div class="leg-amount">${formatAmount(shares)} 股</div><p>VWAP：<strong>${formatAmount(cexPrice)} ${escapeHtml(cexQuoteSymbol)}/股</strong></p><p class="leg-total">${cexBuy ? "预计支付（未扣手续费）" : "预计收入（未扣手续费）"}：${formatAmount(cexTotal)} ${escapeHtml(cexQuoteSymbol)}</p></article>`;
        const dexUsdtPriceLabel = dexPriceUsdtPerShare
          ? ` · ${dexQuoteSymbol === "USDT0" ? row.quote_summary?.includes("quoteOFT/quoteSend full fee") ? "历史赎回净额" : row.quote_summary?.includes("valued 1:1") ? "按 1:1 估值" : "按记录汇率" : ""} ${formatAmount(dexPriceUsdtPerShare)} USDT/股`
          : "";
        const dexLeg = `<article class="trade-leg ${cexBuy ? "sell" : "buy"}"><h3>${dexAction} · DEX 聚合报价</h3><div class="leg-amount">${formatAmount(tokenAmount)} ${escapeHtml(tokenSymbol)} <small>≈ ${formatAmount(convertedShares)} 股等值</small></div><p>单 Token 价格：<strong>${formatAmount(dexPricePerToken)} ${escapeHtml(dexQuoteSymbol)}/${escapeHtml(tokenSymbol)}</strong></p><p>每股原生报价：<strong>${formatAmount(dexPricePerShare)} ${escapeHtml(dexQuoteSymbol)}/股</strong>${dexUsdtPriceLabel}</p><p class="leg-total">${dexAction === "买入" ? "聚合报价支付" : "聚合报价收入"}：${formatAmount(dexTotal)} ${escapeHtml(dexQuoteSymbol)}</p></article>`;
        const valuationNote = row.valuation_status === "LEGACY_NOMINAL"
          ? "旧口径名义 1:1 记录，不纳入新的 USDT 折算统计。"
          : row.valuation_status === "VERIFIED"
            ? "USDT 折算通过价格检查；以下仍是报价估算，不代表可成交利润。"
            : "USDT 折算未知，因此不显示为 0，也不计入正收益。";
        const formatUtc = (value: Date | null) => value ? `${formatUtc8(value)} (UTC + 8)` : "未知";
        const detailSection = (title: string, fields: Record<string, unknown>) => `<section class="overview"><h3>${escapeHtml(title)}</h3><table class="detail-table"><tbody>${Object.entries(fields).map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${shown(value)}</td></tr>`).join("")}</tbody></table></section>`;
        const routeLabel = row.route_status === "ENABLED" ? "采集时网络状态可用" : `仅监控 · ${row.route_status}`;
        const executionLabel = row.executable_status === "EXECUTABLE" ? "通过库存与安全缓冲检查" : row.executable_status === "NOT_EVALUATED" ? "交易模块关闭，未评估" : `未通过 · ${row.execution_reason ?? "条件未满足"}`;
        const netEstimate = row.valuation_status === "VERIFIED" ? row.usdt_estimate : null;
        const timingComparison = (() => {
          if (!row.cex_received_at || !row.dex_request_started_at) return "旧记录没有本机采集时间，无法对照";
          const cexReceivedAt = row.cex_received_at.getTime();
          const requestStartedAt = row.dex_request_started_at.getTime();
          const responseAt = row.dex_ts.getTime();
          if (cexReceivedAt < requestStartedAt) return `CEX 盘口在 DEX 请求开始前 ${Math.round(requestStartedAt - cexReceivedAt)} ms 收到`;
          if (cexReceivedAt > responseAt) return `CEX 盘口在 DEX 响应收齐后 ${Math.round(cexReceivedAt - responseAt)} ms 收到`;
          return "CEX 盘口在 DEX 请求期间收到";
        })();
        const formatMs = (value: string | null) => value === null ? "未知" : `${new Decimal(value).toFixed(0)} ms`;
        const timingSection = detailSection("CEX 与 DEX 采集时间对照", {
          "CEX 行情源时间": formatUtc(row.cex_ts),
          "CEX 盘口收到时间（本机）": formatUtc(row.cex_received_at),
          "DEX 排队等待": formatMs(row.dex_queue_wait_ms),
          "DEX 请求开始（本机）": formatUtc(row.dex_request_started_at),
          "DEX 响应收齐（本机）": formatUtc(row.dex_ts),
          "DEX 接口耗时": formatMs(row.dex_request_ms),
          "CEX 盘口相对 DEX 请求窗口": timingComparison,
          "时间口径": "DEX 聚合 API 未提供报价源端时间；请求窗口只表示本机发出请求到收齐响应的区间，不能证明聚合器内部池状态的精确时刻。",
        });
  body = `<section class="overview">
          <p><a href="/opportunities">← 返回机会列表</a></p>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
            <div><h2>${escapeHtml(row.inst_id)} · 机会详情</h2><p class="summary">${escapeHtml(asset?.network ?? row.chain_index)} · ${direction} · 开始 ${formatUtc(row.opened_at)} · 最近有效报价 ${formatUtc(lastUpdatedAt)} · 持续 ${escapeHtml(formatReportDuration(durationSeconds))} · ${historySampleCount} 个有效样本</p></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap"><span class="badge ${row.route_status === "ENABLED" ? "fresh" : "unknown"}">${escapeHtml(routeLabel)}</span>${statusBadge(row.valuation_status)}${row.is_stale ? `<span class="badge stale">盘口过期</span>` : ""}</div>
          </div>
          <p class="guard-alert">${valuationNote} 窗口：${row.ended_at ? `已结束（${escapeHtml(closeReasonLabel(row.close_reason))}）` : "持续中"}；峰值净收益 ${escapeHtml(row.peak_profit_usdt)} USDT。执行评估：${escapeHtml(executionLabel)}；安全缓冲 ${escapeHtml(row.execution_buffer_usdt ?? "未知")} USDT，缓冲后净收益 ${escapeHtml(row.executable_profit_usdt ?? "未知")} USDT。报价不代表已成交，也不模拟转账时延、后续滑点变化或部分成交。</p>
          <div class="trade-legs">
            ${cexBuy ? `${cexLeg}${dexLeg}` : `${dexLeg}${cexLeg}`}
          </div>
          <div class="summary"><span>观察规模：${shown(row.size_usdt)} USDT</span><span>USDT 净收益估算：<strong>${shown(netEstimate)} USDT</strong></span>
          </div>
        </section>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:16px;margin-top:16px">
          ${detailSection("收益拆分（估算）", { "毛价差": row.gross_profit_usdt, "CEX 手续费": row.cex_fee_usdt, "DEX 预估 Gas（含安全缓冲）": row.gas_usdt, "净收益（未含再平衡）": row.net_profit_usdt, "再平衡摊销成本": row.rebalance_cost_usdt ?? "未配置，未计入", "扣再平衡后收益": row.net_profit_after_rebalance_usdt ?? "未知" })}
          ${detailSection("成交与股数换算", { "交易方向": direction, "DEX Token 数量": row.token_amount, "Multiplier": row.multiplier, "理论股数（Token 数量 × Multiplier）": convertedShares.toString(), "CEX 实际股数（按 lotSz 取整）": row.shares, "CEX VWAP": row.cex_vwap, "CEX 手续费率": row.cex_fee_rate })}
          ${detailSection("稳定币估值", { "估值状态": row.valuation_status, "原生报价": `${row.native_quote_amount ?? "未知"} ${row.native_quote_symbol ?? ""}`.trim(), "USDT 汇率": row.valuation_status === "VERIFIED" ? row.usdt_rate : null, "折算成本（USDT）": row.valuation_status === "VERIFIED" ? row.conversion_cost_usdt : null, "USDT 净收益估算": netEstimate, "价格源时间": formatUtc(row.price_source_time), "折算摘要": row.quote_summary })}
          ${detailSection("行情与报价质量", { "采集时路线状态": routeLabel, "盘口是否过期": row.is_stale ? "是" : "否", "CEX 行情源时间": formatUtc(row.cex_ts), "DEX 响应收齐时间（本机）": formatUtc(row.dex_ts), "Gas 原生数量": row.gas_native_raw, "Gas 来源": row.gas_source, "价格影响率（%）": row.price_impact_percent })}
          ${detailSection("DEX 报价参考值（仅参考）", { "输入 Token 单价（USD）": row.from_token_unit_price_usd, "输出 Token 单价（USD）": row.to_token_unit_price_usd, "支付价值（名义 USD）": row.paid_value_usd, "收到价值（名义 USD）": row.received_value_usd })}
        </div>
        <section class="overview" style="margin-top:16px"><h3>机会变化片段（每 5 秒）</h3><p>每行汇总同一连续机会内 5 秒的有效报价；空区间不显示。这些片段是观察估算，不代表多个可分别成交的机会或实际成交。</p><div class="table-wrap"><table><thead><tr><th>片段开始 <small>(UTC + 8)</small></th><th>片段结束 <small>(UTC + 8)</small></th><th>样本数</th><th>当前净收益估算 <small>USDT</small></th><th>峰值净收益估算 <small>USDT</small></th><th>最低价格影响</th><th>最新报价 <small>(UTC + 8)</small></th></tr></thead><tbody>${quoteBuckets.length ? quoteBuckets.map((bucket) => `<tr><td>${escapeHtml(formatUtc8(bucket.startAt))}</td><td>${bucket.inProgress ? "进行中" : escapeHtml(formatUtc8(bucket.endAt))}</td><td>${bucket.sampleCount}</td><td class="numeric">${escapeHtml(formatReportDecimal(bucket.currentProfit, 8))}</td><td class="numeric">${escapeHtml(formatReportDecimal(bucket.peakProfit, 8))}</td><td class="numeric">${bucket.minPriceImpact === null ? "未知" : `${escapeHtml(formatReportDecimal(bucket.minPriceImpact, 8))}%`}</td><td>${escapeHtml(formatUtc8(bucket.latestAt))}</td></tr>`).join("") : '<tr><td colspan="7">该窗口没有已核验且状态正常的报价片段。</td></tr>'}</tbody></table></div></section>
        <details class="overview" style="margin-top:16px"><summary>查看原始诊断数据</summary><h3>Multiplier 原始快照</h3><pre>${escapeHtml(JSON.stringify(row.multiplier_raw, null, 2))}</pre><h3>DEX 原始 Quote</h3><pre>${escapeHtml(JSON.stringify(row.raw_response, null, 2))}</pre></details>`;
      }
    } else if (config.marketdata.quoteProvider === "direct_pool") {
      const monitoredPools = state.fixedPools ?? [];
      const healthyPools = monitoredPools.filter((pool) => pool.status === "healthy" && pool.connectionStatus === "connected" && pool.rpcSnapshotStatus === "healthy").length;
      const poolIds = monitoredPools.map((pool) => pool.poolId);
      let latest: DirectOverviewRow[] = [];
      let totals: { total: number; positive: number; negative: number; blocked: number } | undefined;
      let latestPoolQuotes: DirectPoolQuoteStatusRow[] = [];
      let storageError = "";
      if (state.dbOnline) {
        try {
          [latest, totals, latestPoolQuotes] = await Promise.all([
            query<DirectOverviewRow[]>("SELECT d.instrument_id,d.chain_index,d.direction,CAST(d.size_usdt AS CHAR) size_usdt,d.selected_quote_id,CAST(d.cex_vwap AS CHAR) cex_vwap,CAST(d.gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(d.cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(d.gas_budget_usdt AS CHAR) gas_budget_usdt,CAST(d.net_profit_usdt AS CHAR) net_profit_usdt,CAST(d.roi AS CHAR) roi,d.valuation_status,d.valuation_inputs,d.decision_status,d.block_reason,d.simulation_status,d.simulation_reason,COALESCE(d.pool_id,q.pool_id) pool_id,CAST(q.slot AS CHAR) slot,DATE_FORMAT(CONVERT_TZ(d.created_at,@@session.time_zone,'+08:00'),'%Y-%m-%d %H:%i:%s') created_at_utc8 FROM direct_pool_decision d LEFT JOIN direct_pool_quote q ON q.id=d.selected_quote_id ORDER BY d.id DESC LIMIT 12"),
            query<Array<{ total: number; positive: number; negative: number; blocked: number }>>("SELECT COUNT(*) total,COALESCE(SUM(net_profit_usdt>0 AND valuation_status NOT LIKE 'INVALIDATED_%'),0) positive,COALESCE(SUM(net_profit_usdt<0 AND valuation_status NOT LIKE 'INVALIDATED_%'),0) negative,COALESCE(SUM(decision_status='BLOCKED'),0) blocked FROM direct_pool_decision WHERE created_at>=UTC_TIMESTAMP(3)-INTERVAL 5 MINUTE").then((rows) => rows[0]),
            poolIds.length ? query<DirectPoolQuoteStatusRow[]>(`SELECT CAST(q.id AS CHAR) id,q.pool_id,q.status,q.failure_code,DATE_FORMAT(CONVERT_TZ(COALESCE(q.quoted_at,q.created_at),@@session.time_zone,'+08:00'),'%Y-%m-%d %H:%i:%s') quoted_at_utc8 FROM direct_pool_quote q JOIN (SELECT pool_id,MAX(id) id FROM direct_pool_quote WHERE pool_id IN (${poolIds.map(() => "?").join(",")}) GROUP BY pool_id) latest ON latest.id=q.id`, poolIds) : Promise.resolve([]),
          ]);
        } catch { storageError = "Direct Pool 数据表不可用；请先执行 npm run db:migrate。"; }
      }
      const latestQuoteByPool = new Map(latestPoolQuotes.map((quote) => [quote.pool_id, quote]));
      const latestRows = latest.map((row) => {
        const invalidated = row.valuation_status.startsWith("INVALIDATED_");
        const profit = invalidated ? "估值失效" : row.net_profit_usdt === null ? "未估算" : `${formatReportDecimal(row.net_profit_usdt, 6)} USDT${row.roi === null ? "" : ` · ${formatReportDecimal(new Decimal(row.roi).mul(10_000).toString(), 4)} bp`}`;
        const profitClass = invalidated || row.net_profit_usdt === null ? "" : new Decimal(row.net_profit_usdt).gte(0) ? "profit-positive" : "profit-negative";
        const solanaGasPrice = row.chain_index === "501" ? directPoolSolanaGasPrice(row.valuation_inputs) : null;
        const costBreakdown = invalidated ? "" : [
          row.gross_profit_usdt === null ? null : `毛 ${formatReportDecimal(row.gross_profit_usdt, 6)} USDT`,
          row.cex_fee_usdt === null ? null : `CEX 费 ${formatReportDecimal(row.cex_fee_usdt, 6)} USDT`,
          row.gas_budget_usdt === null ? null : `Gas ${formatReportDecimal(row.gas_budget_usdt, 8)} USDT${solanaGasPrice ? `（${solanaGasPrice}）` : ""}`,
        ].filter((value): value is string => value !== null).join(" · ");
        const direction = row.direction === "dex_buy_cex_sell" ? "DEX 买入 → CEX 卖出" : "CEX 买入 → DEX 卖出";
        const decision = row.decision_status === "OBSERVED" ? "已观察" : row.decision_status === "BLOCKED" ? "已拦截" : row.decision_status === "NO_OPPORTUNITY" ? "无净收益" : row.decision_status;
        const quoteLink = row.selected_quote_id === null ? "" : `<a href="/direct-pools/quote?id=${row.selected_quote_id}">查看报价</a>`;
        return `<tr><td>${escapeHtml(row.created_at_utc8 ?? "未知")}</td><td><strong>${escapeHtml(row.instrument_id)}</strong><small>${escapeHtml(row.pool_id ?? `${row.chain_index} · 池 ID 不可用`)}</small></td><td>${escapeHtml(direction)}</td><td class="numeric">${escapeHtml(formatReportDecimal(row.size_usdt, 8))} USDT</td><td class="numeric"><strong>${escapeHtml(profit)}</strong>${costBreakdown ? `<small>${escapeHtml(costBreakdown)}</small>` : ""}</td><td>${escapeHtml(decision)}${row.block_reason ? `<small>${escapeHtml(row.block_reason)}</small>` : ""}<small>模拟：${escapeHtml(directPoolSimulationLabel(row.simulation_status))}${row.simulation_reason ? ` · ${escapeHtml(row.simulation_reason)}` : ""}</small> ${quoteLink}</td></tr>`;
      }).join("");
      const poolRows = monitoredPools.map((pool) => {
        const poolStatus = pool.status === "healthy" ? "健康" : pool.status === "not_configured" ? "未配置" : pool.status === "unavailable" ? "不可用" : pool.status === "invalid" ? "身份校验失败" : pool.status === "disabled" ? "已关闭" : "未知";
        const poolStatusClass = pool.status === "healthy" ? "fresh" : pool.status === "unavailable" || pool.status === "invalid" ? "unhealthy" : "unknown";
        const connectionStatus = pool.connectionStatus === "connected" ? "已连接" : pool.connectionStatus === "connecting" ? "连接中" : pool.connectionStatus === "disconnected" ? "已断开" : pool.connectionStatus === "not_configured" ? "未配置" : "未知";
        const rpcStatus = pool.rpcSnapshotStatus === "healthy" ? "正常" : pool.rpcSnapshotStatus === "unavailable" ? "失败" : "未知";
        const quote = latestQuoteByPool.get(pool.poolId);
        const quoteStatus = !quote ? "暂无报价" : quote.status === "OK" ? "成功" : `失败${quote.failure_code ? ` · ${quote.failure_code}` : ""}`;
        const quoteClass = !quote ? "unknown" : quote.status === "OK" ? "fresh" : "unhealthy";
        const quoteDetail = quote ? `<a href="/direct-pools/quote?id=${encodeURIComponent(quote.id)}">详情</a>` : "";
        return `<tr><td><strong>${escapeHtml(pool.instId)}</strong><small>${escapeHtml(pool.poolId)}</small></td><td>${escapeHtml(directPoolDexLabel(pool.dex))}</td><td><span class="badge ${poolStatusClass}">${poolStatus}</span></td><td>${escapeHtml(connectionStatus)}</td><td>${escapeHtml(rpcStatus)}<small>${pool.lastRpcSnapshotAt === null ? "无快照" : `快照 ${escapeHtml(formatUtc8(pool.lastRpcSnapshotAt))}`}</small></td><td><span class="badge ${quoteClass}">${escapeHtml(quoteStatus)}</span>${quote ? `<small>${escapeHtml(quote.quoted_at_utc8 ?? "时间未知")} ${quoteDetail}</small>` : ""}</td></tr>`;
      }).join("");
      body = `<section class="overview direct-overview"><div class="section-heading"><div><h2>Direct Pool 观察总览</h2><p>展示指定池 Exact-In 报价与估算结果；所有记录均为只读观察，不能视为可成交收益。</p></div><a href="/direct-pools">收益总览 →</a></div>${!state.dbOnline ? '<p class="guard-alert">数据库不可用，暂时无法读取 Direct Pool 观察数据。</p>' : storageError ? `<p class="guard-alert">${escapeHtml(storageError)}</p>` : ""}<div class="direct-summary-cards"><article><small>监控池</small><strong>${monitoredPools.length}</strong></article><article><small>池监控健康</small><strong>${healthyPools} / ${monitoredPools.length}</strong></article><article><small>近 5 分钟正收益样本</small><strong class="profit-positive">${Number(totals?.positive ?? 0)}</strong></article><article><small>近 5 分钟负收益样本</small><strong class="profit-negative">${Number(totals?.negative ?? 0)}</strong></article><article><small>近 5 分钟拦截</small><strong>${Number(totals?.blocked ?? 0)}</strong></article></div><p class="direct-assumption-note">收益使用当前 OKX 盘口，扣除 CEX 手续费与 X Layer 固定 Gas 预算、Solana 5,000 lamports 基础费估算；SOL-USDT 价格不可用时净收益留空。Solana 估算不含优先费或 ATA 租金；USDC / USDT 暂按 1:1。正收益样本只表示报价差，未包含真实成交、稳定币兑换、跨链调拨与提现成本。</p><div class="section-heading"><h3>各池监控状态</h3><span>连接、RPC 快照与最近 Exact-In 报价</span></div><div class="table-wrap"><table class="direct-pool-health-table"><thead><tr><th>资产 / 池</th><th>DEX</th><th>监控</th><th>WebSocket</th><th>RPC 快照</th><th>最近报价</th></tr></thead><tbody>${poolRows || '<tr><td colspan="6">当前没有已启用的池监控状态。</td></tr>'}</tbody></table></div><div class="section-heading"><h3>最近观察结果</h3><span>收益行含毛收益、CEX 费和 Gas 拆分</span><a href="/direct-pools/decisions">所有报价和历史分页 →</a></div><div class="table-wrap"><table class="direct-overview-table"><thead><tr><th>时间 <small>(UTC + 8)</small></th><th>资产 / 池</th><th>方向</th><th>规模</th><th>净收益 / ROI (bp)</th><th>状态 / 详情</th></tr></thead><tbody>${latestRows || `<tr><td colspan="6">${state.dbOnline ? "还没有 Direct Pool 观察记录。" : "数据库未连接。"}</td></tr>`}</tbody></table></div></section><style>.direct-summary-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0}.direct-summary-cards article{padding:14px 16px;border:1px solid #e5eaf2;border-radius:10px;background:#f9fbfe}.direct-summary-cards small,.direct-overview-table small,.direct-pool-health-table small{display:block;margin-top:4px;color:#758198;font-size:11px}.direct-summary-cards strong{display:block;margin-top:6px;font-size:22px;font-variant-numeric:tabular-nums}.direct-assumption-note{padding:10px 12px;border-radius:8px;background:#f7f9fc;color:#65738a;font-size:12px}.direct-overview-table td,.direct-pool-health-table td{white-space:normal}.direct-overview-table td:nth-child(2){min-width:170px}.direct-overview-table a,.direct-pool-health-table a{font-size:12px;white-space:nowrap}.direct-pool-health-table{min-width:850px}.direct-pool-health-table td:first-child{text-align:left}</style>`;
    } else {
      const commonSizes = assets[0]?.observationSizesUsdt.filter((size) => assets.every((asset) => asset.observationSizesUsdt.includes(size))) ?? [];
      const compareSize = commonSizes.sort((a, b) => a - b)[0];
      const instIds = [...new Set(assets.map((asset) => asset.instId))];
      const comparisons = state.dbOnline && compareSize !== undefined ? await query<QuoteCompareRow[]>(
        `SELECT observed_at,inst_id,chain_index,route_status,direction,CAST(size_usdt AS CHAR) size_usdt,CAST(shares AS CHAR) shares,CAST(cex_vwap AS CHAR) cex_vwap,CAST(native_quote_amount AS CHAR) native_quote_amount,native_quote_symbol,CAST(usdt_rate AS CHAR) usdt_rate,valuation_status,CAST(net_profit_usdt AS CHAR) net_profit_usdt,CAST(net_profit_after_rebalance_usdt AS CHAR) net_profit_after_rebalance_usdt,CAST(usdt_estimate AS CHAR) usdt_estimate FROM (
           SELECT observed_at,inst_id,chain_index,route_status,direction,size_usdt,shares,cex_vwap,native_quote_amount,native_quote_symbol,usdt_rate,valuation_status,net_profit_usdt,net_profit_after_rebalance_usdt,usdt_estimate,
             ROW_NUMBER() OVER (PARTITION BY inst_id,chain_index,direction,size_usdt ORDER BY observed_at DESC) row_num
           FROM quote_observation WHERE inst_id IN (${instIds.map(() => "?").join(",")}) AND size_usdt=? AND direction IN ('cex_buy_dex_sell','dex_buy_cex_sell') AND observed_at >= UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE
         ) latest WHERE row_num=1 ORDER BY inst_id,chain_index,direction`, [...instIds, String(compareSize)]) : [];
      const activeAssetGuard = (instId: string, chainIndex: string) => ["guardrail", "multiplier_guard"].map((prefix) => state.health.get(`${prefix}_${chainIndex}_${instId}`)).find((item) => item && item.status !== "healthy");
      const renderComparison = (asset: AssetConfig, direction: string) => {
        const identity = `<strong>${escapeHtml(asset.instId)}</strong><br><small>${escapeHtml(asset.network)} · ${escapeHtml(asset.quoteTokenSymbol)}</small>`;
        const directionLabel = direction === "dex_buy_cex_sell" ? "DEX 买 · CEX 卖" : "CEX 买 · DEX 卖";
        if (!asset.enabled) return `<tr><td>${identity}</td><td>${directionLabel}</td><td>配置已关闭</td><td class="numeric">暂无报价</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td>—</td></tr>`;
        const guard = activeAssetGuard(asset.instId, asset.chainIndex);
        if (guard) return `<tr><td>${identity}</td><td>${directionLabel}</td><td>异常保护</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td>—</td></tr>`;
        const row = comparisons.find((item) => item.inst_id === asset.instId && item.chain_index === asset.chainIndex && item.direction === direction);
        if (!row) {
          const routeStatus = state.routes.find((route) => route.asset.instId === asset.instId && route.asset.chainIndex === asset.chainIndex)?.status ?? "未知";
          return `<tr><td>${identity}</td><td>${directionLabel}</td><td>${escapeHtml(routeStatus)}</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td>—</td></tr>`;
        }
        if (!row.shares || !row.cex_vwap) return `<tr><td>${identity}</td><td>${directionLabel}</td><td>${escapeHtml(row.route_status)}</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td class="numeric">—</td><td>${escapeHtml(formatUtc8(row.observed_at))}</td></tr>`;
        const shares = new Decimal(row.shares);
        const cexPrice = new Decimal(row.cex_vwap);
        const native = row.native_quote_amount ? new Decimal(row.native_quote_amount) : null;
        const nativePerShare = native && shares.gt(0) ? native.div(shares) : null;
        const verified = row.valuation_status === "VERIFIED";
        const usdtPerShare = verified && native && row.usdt_rate && shares.gt(0) ? native.mul(row.usdt_rate).div(shares) : null;
        const spread = usdtPerShare ? (direction === "cex_buy_dex_sell" ? usdtPerShare.minus(cexPrice) : cexPrice.minus(usdtPerShare)) : null;
        const spreadPercent = spread && cexPrice.gt(0) ? spread.div(cexPrice).mul(100) : null;
        const nativeText = nativePerShare ? `${nativePerShare.toSignificantDigits(8).toString()} ${row.native_quote_symbol ?? asset.quoteTokenSymbol}` : "未知";
        const netProfit = row.net_profit_after_rebalance_usdt ?? row.usdt_estimate ?? row.net_profit_usdt;
        return `<tr><td>${identity}</td><td>${directionLabel}</td><td>${escapeHtml(row.route_status)}</td><td class="numeric">${cexPrice.toSignificantDigits(8).toString()}</td><td class="numeric">${escapeHtml(nativeText)}</td><td class="numeric">${spreadPercent !== null ? `${spreadPercent.toFixed(3)}%` : "未知"}</td><td class="numeric">${usdtCell(row.valuation_status, netProfit === null ? null : formatReportDecimal(netProfit, 6))}</td><td>${escapeHtml(formatUtc8(row.observed_at))}</td></tr>`;
      };
      const latest = state.dbOnline ? await query<OpportunityRow[]>("SELECT o.id,o.observed_at opened_at,o.ended_at,o.close_reason,o.executable_status,o.execution_reason,CAST(o.execution_buffer_usdt AS CHAR) execution_buffer_usdt,CAST(o.executable_profit_usdt AS CHAR) executable_profit_usdt,CAST(o.peak_profit_usdt AS CHAR) peak_profit_usdt,q.observed_at,q.inst_id,q.chain_index,q.route_status,o.direction,CAST(o.size_usdt AS CHAR) size_usdt,CAST(q.shares AS CHAR) shares,CAST(q.cex_vwap AS CHAR) cex_vwap,CAST(q.dex_usdt_amount AS CHAR) dex_usdt_amount,CAST(q.cex_fee_usdt AS CHAR) cex_fee_usdt,CAST(q.gas_usdt AS CHAR) gas_usdt,CAST(q.gross_profit_usdt AS CHAR) gross_profit_usdt,CAST(o.net_profit_usdt AS CHAR) net_profit_usdt,CAST(q.rebalance_cost_usdt AS CHAR) rebalance_cost_usdt,CAST(q.net_profit_after_rebalance_usdt AS CHAR) net_profit_after_rebalance_usdt,CAST(o.roi AS CHAR) roi,q.is_stale,q.status,q.native_quote_amount,q.native_quote_symbol,q.valuation_status,CAST(q.usdt_estimate AS CHAR) usdt_estimate FROM opportunity o JOIN quote_observation q ON q.id=o.quote_observation_id WHERE o.ended_at IS NULL AND o.legacy_sample=0 AND q.observed_at >= UTC_TIMESTAMP(3) - INTERVAL 10 MINUTE AND q.valuation_status='VERIFIED' ORDER BY o.observed_at DESC LIMIT 20") : [];
      const activeGuards = [...state.health.values()].filter((item) => /^(guardrail_|multiplier_guard_|index_price$|usdt_usd$|sol_usdt$|usdt0_usdt$)/.test(item.dependency) && item.status !== "healthy");
      const latestVisible = latest.filter((row) => state.routes.some((route) => route.asset.enabled && route.asset.instId === row.inst_id && route.asset.chainIndex === row.chain_index) && !activeAssetGuard(row.inst_id, row.chain_index));
      body = `<section class="overview"><p class="summary"><span>运行状态：${state.dbOnline ? "数据库已连接" : "数据库未就绪"}</span><span>页面时间 UTC + 8 ${escapeHtml(nowUtc8())}</span></p>${activeGuards.length ? `<p class="guard-alert">估值或异常保护未通过：${activeGuards.map((item) => `${escapeHtml(item.dependency)} · ${escapeHtml(item.lastError ?? item.status)}`).join("；")}。未通过的 USDT 折算不计入正收益，查看 <a href="/health">健康状态</a> 与 <a href="/blocked">拦截记录</a>。</p>` : ""}<div class="section-heading"><h3>持续中的正收益窗口（最近 10 min 有报价）</h3><a href="/opportunities">查看历史记录 →</a></div><div class="table-wrap"><table class="opportunities"><thead><tr><th>窗口开始 <small>(UTC + 8)</small></th><th>资产</th><th>网络</th><th>路线状态</th><th>交易方向</th><th class="numeric">规模 <small>USDT</small></th><th class="numeric">当前 / 峰值收益</th><th>执行评估</th></tr></thead><tbody>${latestVisible.length ? latestVisible.map((r) => `<tr><td><a class="time-link" href="/opportunity?id=${r.id}">${escapeHtml(formatUtc8(r.opened_at))}</a></td><td>${escapeHtml(r.inst_id)}</td><td>${escapeHtml(r.chain_index)}</td><td>${r.route_status === "ENABLED" ? "可转账" : "仅监控估算"}</td><td><span class="direction">${r.direction === "dex_buy_cex_sell" ? "DEX 买入 · CEX 卖出" : "CEX 买入 · DEX 卖出"}</span></td><td class="numeric">${escapeHtml(r.size_usdt)}</td><td class="numeric profit">${escapeHtml(r.net_profit_usdt)} / ${escapeHtml(r.peak_profit_usdt)} USDT</td><td>${r.executable_status === "EXECUTABLE" ? `可执行估算 · ${escapeHtml(r.executable_profit_usdt)} USDT` : r.executable_status === "NOT_EVALUATED" ? "交易未启用 · 未评估" : `不可执行 · ${escapeHtml(r.execution_reason ?? "条件未满足")}`}</td></tr>`).join("") : "<tr><td colspan=\"8\">最近 10 min 没有持续中的有效正收益窗口。</td></tr>"}</tbody></table></div><p>机会是连续报价形成的观察窗口；可执行估算仍不代表成交结果。自动交易须在配置总闸和交易页开关都打开后运行。</p><div class="section-heading"><h3>同规模报价对比</h3><span>规模 ${compareSize ?? "无共同档位"} USDT</span></div><div class="table-wrap"><table class="opportunities"><thead><tr><th>资产 / 网络</th><th>方向</th><th>路线状态</th><th class="numeric">CEX 价 / 股</th><th class="numeric">DEX 报价 / 股</th><th class="numeric" title="单股报价差占 CEX 价格的比例；未扣 CEX 手续费、DEX 网络费或再平衡成本">价差率（扣费前）</th><th class="numeric">净收益估算 (USDT)</th><th>报价时间 (UTC + 8)</th></tr></thead><tbody>${compareSize === undefined ? "<tr><td colspan=\"8\">各路线没有相同的观察规模。</td></tr>" : assets.flatMap((asset) => [renderComparison(asset, "cex_buy_dex_sell"), renderComparison(asset, "dex_buy_cex_sell")]).join("")}</tbody></table></div><p>DEX 路由报价已反映兑换费用和滑点；净收益扣 CEX 手续费、DEX 预估网络费及已配置的再平衡成本。跨链转账/提币费用未单独估算。</p></section>`;
    }
    const collectionBanner = state.collection ? `<p class="guard-alert">${state.collection.running ? "正在采集" : "采集已停止，当前显示历史记录"}${state.collection.updatedAt === null ? "" : `；最后状态快照（UTC + 8）：${escapeHtml(formatUtc8(state.collection.updatedAt))}`}</p>` : "";
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cross-Market Opportunity Monitor</title><style>
      *{box-sizing:border-box}body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:1440px;margin:32px auto;padding:0 24px;color:#172033;background:#f5f7fb}h1{font-size:22px;letter-spacing:-.02em;margin:0}h2{font-size:20px;margin:0 0 16px}nav{display:flex;gap:8px;margin:18px 0 22px;padding-bottom:14px;border-bottom:1px solid #e2e7f0}nav a{padding:7px 12px;border-radius:8px;color:#53627a;text-decoration:none;font-weight:550}nav a:hover{background:#e9eef8;color:#234a87}nav a.active{background:#e9eef8;color:#234a87;box-shadow:inset 0 -2px #315fba}nav a:focus-visible{outline:2px solid #315fba;outline-offset:2px}a{color:#315fba}body>p{color:#8490a3;font-size:12px;margin-top:22px}
      .overview{background:#fff;border:1px solid #e5eaf2;border-radius:14px;padding:24px;box-shadow:0 8px 24px #243b5a0a}.summary{display:flex;flex-wrap:wrap;gap:8px 22px;color:#65738a;margin:6px 0}.summary strong{color:#16805b}.guard-alert{padding:10px 12px;border:1px solid #f2c98d;border-radius:8px;background:#fff8e9;color:#875710}.trade-legs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:16px 0}.trade-leg{min-width:0;border:1px solid #dfe5ef;border-radius:12px;padding:18px 20px;background:#fff}.trade-leg.buy{border-color:#a9c8fa;background:#f5f9ff}.trade-leg.sell{border-color:#a9dfc1;background:#f3fbf6}.trade-leg h3{font-size:14px;margin:0 0 12px;color:#53627a}.trade-leg p{margin:9px 0;color:#53627a}.trade-leg strong{color:#172033}.leg-amount{font-size:23px;font-weight:750;font-variant-numeric:tabular-nums;color:#172033}.leg-amount small{font-size:12px;font-weight:500;color:#65738a}.leg-total{padding-top:8px;border-top:1px solid #dfe5ef;font-weight:650}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:26px 0 12px}.section-heading h3{font-size:15px;margin:0}.section-heading>a{font-size:12px;text-decoration:none;font-weight:600}.table-wrap{overflow-x:auto;border:1px solid #e7ebf2;border-radius:10px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:12px 14px;text-align:center;white-space:nowrap;vertical-align:middle}th{background:#f7f9fc;color:#758198;font-size:11px;font-weight:650;letter-spacing:.04em}th small{font-size:10px;font-weight:500;letter-spacing:0;color:#98a2b3}tbody tr+tr{border-top:1px solid #edf0f5}tbody tr:hover{background:#fafcff}.detail-table{table-layout:fixed}.detail-table th,.detail-table td{white-space:normal;overflow-wrap:anywhere}.detail-table th{width:45%}.detail-table td{width:55%}.numeric{font-variant-numeric:tabular-nums}.time-link{color:#52627b;text-decoration:none;font-variant-numeric:tabular-nums}.time-link:hover{color:#315fba;text-decoration:underline}.direction{color:#394861}.profit{font-weight:650;color:#13815c}.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600}.fresh{background:#e9f7ef;color:#16805b}.stale{background:#fff1e9;color:#b45722}.unhealthy{background:#fdecec;color:#b42318}.unknown{background:#eef1f6;color:#5c6b82}
      body>table{background:#fff;border:1px solid #e5eaf2;border-radius:10px;overflow:hidden}body>table th{background:#f7f9fc}body>table th,body>table td{border-bottom:1px solid #e7ebf2}body>table tbody tr:last-child td{border-bottom:0}.pagination{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:14px 2px;color:#758198;font-size:12px}.pagination>div{display:flex;gap:8px}.pagination a,.pagination .disabled{padding:7px 11px;border:1px solid #dfe5ef;border-radius:7px;text-decoration:none}.pagination a{background:#fff;color:#315fba}.pagination .disabled{color:#a5afbd}td{overflow-wrap:anywhere}form{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:16px 0}label{color:#53627a}input,select,button{font:inherit;padding:7px 10px;border:1px solid #d8dfeb;border-radius:7px;background:#fff}button{background:#315fba;color:#fff;border-color:#315fba;cursor:pointer}pre{max-width:100%;overflow:auto}
      @media(max-width:700px){body{margin:20px auto;padding:0 12px}.overview{padding:16px}.section-heading{align-items:flex-start}.trade-legs{grid-template-columns:1fr}.trade-leg{padding:15px}table{min-width:680px}nav{gap:2px}nav a{padding:7px 9px}}
    nav .nav-more{position:relative}nav .nav-more>summary{display:block;list-style:none;cursor:pointer;padding:7px 12px;border-radius:8px;color:#53627a;font-weight:550}nav .nav-more>summary::-webkit-details-marker{display:none}nav .nav-more>summary:hover,nav .nav-more[open]>summary{background:#e9eef8;color:#234a87}nav .nav-more.is-active>summary{background:#e9eef8;color:#234a87;box-shadow:inset 0 -2px #315fba}nav .nav-more>summary:focus-visible{outline:2px solid #315fba;outline-offset:2px}.nav-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:10;display:grid;min-width:144px;padding:6px;background:#fff;border:1px solid #e2e7f0;border-radius:8px;box-shadow:0 8px 24px #243b5a1a}nav .nav-menu a{padding:8px 10px}</style><script>document.addEventListener("click",event=>{const menu=document.querySelector(".nav-more");if(menu?.open&&!menu.contains(event.target))menu.open=false});document.addEventListener("keydown",event=>{const menu=document.querySelector(".nav-more");if(event.key==="Escape"&&menu?.open){menu.open=false;menu.querySelector("summary")?.focus()}})</script></head><body><h1>Cross-Market Opportunity Monitor</h1><nav>${navLink("/", "概览")}${navLink("/opportunities", "机会")}${navLink("/direct-pools", "指定池机会")}${config.trading.enabled && handleTrade ? navLink("/trade", "交易") : ""}<details class="nav-more${morePage ? " is-active" : ""}"><summary>更多</summary><div class="nav-menu">${navLink("/reports", "报告")}${navLink("/blocked", "被拦截")}${navLink("/health", "健康")}</div></details></nav>${collectionBanner}${body}<p>仅用于行情观察；预计收益不等于可成交或实际收益。</p></body></html>`;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://127.0.0.1:${config.port}`);
      if (handleTrade && await handleTrade(request, response, url)) return;
      const html = await renderPage(url);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html);
    } catch (error) { logger.error(`Dashboard request failed: ${request.url ?? "/"}`, error); response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); response.end(error instanceof Error ? error.message : "unknown error"); }
  });
  server.on("error", (error) => { logger.error("Dashboard HTTP server failed", error); if (!server.listening) process.exit(1); });
  const host = process.env.DASHBOARD_HOST || "127.0.0.1";
  server.listen(config.port, host, () => logger.info(`Observer UI listening on http://${host}:${config.port}`));
  return server;
}
