import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssetConfig, Config } from "../config.js";
import { execute, query, withNamedLock } from "../db.js";
import type { TradingConfig } from "./config.js";
import type { PreflightRun, PreflightTrigger } from "./preflight-store.js";

export type TradeSnapshot = {
  trading: TradingConfig;
  guardrails: Config["runtime"]["guardrails"];
  routes: Array<{ asset: AssetConfig; routeStatus: string; multiplierReady: boolean; marketReady: boolean }>;
  executionStatus: string;
  preflight: PreflightRun | null;
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]!));
type OpenCycle = { id: number; chain_index: string; status: string; client_order_id: string | null; cex_order_id: string | null; cex_order_state: string | null; chain_tx_hash: string | null; reason: string | null };

export function createTradeHandler(
  getSnapshot: () => TradeSnapshot,
  onArmedChange: (armed: boolean) => void = () => undefined,
  runPreflight: (trigger: PreflightTrigger) => Promise<PreflightRun> = async () => { throw new Error("Preflight is unavailable"); },
) {
  let armed = false;
  let armGeneration = 0;
  let notice = "";
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/trade") return false;
    if (request.method === "POST") {
      const origin = request.headers.origin;
      if (typeof origin === "string" && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("cross-origin refused");
        return true;
      }
      const form = await readForm(request);
      const action = form.get("action");
      const snapshot = getSnapshot();
      if (action === "arm") {
        const generation = ++armGeneration;
        armed = false;
        onArmedChange(false);
        try {
          const result = await runPreflight("arm");
          armed = generation === armGeneration && snapshot.trading.enabled && result.persistence === "database" && result.report.overall === "PASS";
          notice = armed ? "放行检查已通过并保存；自动交易已启动。重启后默认关闭。"
            : `放行检查未通过或报告未能保存；自动交易保持关闭。${result.report.blockers.slice(0, 3).join("；")}`;
        } catch {
          notice = "放行检查发生内部错误；自动交易保持关闭，请查看服务日志。";
        }
        onArmedChange(armed);
      } else if (action === "check") {
        try {
          const result = await runPreflight("manual_check");
          notice = `放行检查已完成：${result.report.overall}（${result.persistence === "database" ? "已保存" : "未能写入报告表，自动放行不可用"}）。`;
        } catch {
          notice = "放行检查发生内部错误，请查看服务日志。";
        }
      } else if (action === "disarm") {
        armGeneration++;
        armed = false;
        onArmedChange(false);
        notice = "已停止启动新的交易周期；若链上腿已广播，程序会继续处理对冲并记录结果。";
      } else if (action === "reconcile") {
        const id = Number(form.get("cycleId"));
        if (!Number.isSafeInteger(id) || form.get("ack") !== "I_RECONCILED_MANUALLY") {
          notice = "对账确认不匹配；交易状态未修改。";
        } else {
          const reconciled = await withNamedLock("xaapl_trade_execution", async () => {
            const active = await getOpenCycle();
            if (!active || active.id !== id) return false;
            const result = await execute("UPDATE trade_cycle SET status='RECONCILED',reason=? WHERE id=? AND status NOT IN ('COMPLETE','FAILED','RECONCILED')", [
              `${active.reason ?? ""} | Operator confirmed manual balance and order reconciliation`.slice(0, 500), id,
            ]);
            return result.affectedRows === 1;
          });
          if (reconciled === null) notice = "交易引擎正在处理周期；停止前不会修改状态，请稍后重试。";
          else if (!reconciled) notice = "交易周期状态已变化；数据库状态未修改。";
          else {
            armGeneration++;
            armed = false;
            onArmedChange(false);
            notice = `交易周期 ${id} 已标记为人工对账完成；自动交易保持关闭，请确认库存安全后手动重新启动。`;
          }
        }
      } else notice = "未知操作";
      response.writeHead(303, { location: "/trade", "cache-control": "no-store" });
      response.end();
      return true;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(render(getSnapshot(), armed, notice, await getOpenCycle()));
    return true;
  };
}

function render(snapshot: TradeSnapshot, armed: boolean, notice: string, active: OpenCycle | null): string {
  const trading = snapshot.trading;
  const rows = snapshot.routes.map(({ asset, routeStatus, multiplierReady, marketReady }) => `<tr><td>${escapeHtml(asset.instId)}</td><td>${escapeHtml(asset.tokenSymbol)}</td><td>${escapeHtml(asset.network)}</td><td>${escapeHtml(asset.chainIndex)}</td><td>${routeStatus === "DISABLED" ? "配置已关闭" : escapeHtml(routeStatus)}</td><td>${routeStatus === "DISABLED" ? "未启用" : multiplierReady ? "就绪" : "不可用"}</td><td>${routeStatus === "DISABLED" ? "未启用" : marketReady ? "就绪" : "不可用"}</td></tr>`).join("");
  const activeCycle = active ? `<section><h2>待人工对账的交易周期</h2><p>ID ${escapeHtml(active.id)} · ${escapeHtml(active.status)} · 链 ${escapeHtml(active.chain_index)} · 客户端委托号 ${escapeHtml(active.client_order_id ?? "未创建")} · OKX 委托 ${escapeHtml(active.cex_order_id ?? "未查询到")} (${escapeHtml(active.cex_order_state ?? "未知")})</p><p>链上交易：${active.chain_tx_hash ? `<a href="${active.chain_index === "501" ? "https://solscan.io/tx/" : "https://www.oklink.com/xlayer/tx/"}${encodeURIComponent(active.chain_tx_hash)}">${escapeHtml(active.chain_tx_hash)}</a>` : "无"}</p><p>原因：${escapeHtml(active.reason ?? "未知")}</p><p><strong>先到链上和 CEX 核对实际成交与余额，并手动完成必要对冲。只有确认库存已恢复安全后，才勾选确认。</strong></p><form method="post" action="/trade"><input type="hidden" name="action" value="reconcile"><input type="hidden" name="cycleId" value="${escapeHtml(active.id)}"><label><input type="checkbox" name="ack" value="I_RECONCILED_MANUALLY" required>我已人工核对并处理该周期的链上交易、CEX 委托和余额</label><button type="submit">记录人工对账完成</button></form></section>` : "";
  const preflight = snapshot.preflight;
  const preflightRows = preflight ? [...preflight.report.checks.map((check) => ({ route: "全局", ...check })),
    ...preflight.report.routes.flatMap((route) => route.checks.map((check) => ({ route: `${route.instId}/${route.chainIndex}`, ...check })))
  ].map((check) => `<tr><td>${escapeHtml(check.route)}</td><td>${escapeHtml(check.key)}</td><td>${escapeHtml(check.status)}</td><td>${escapeHtml(check.reason)}</td><td>${escapeHtml(check.source ?? "—")}</td><td>${escapeHtml(check.observedAt ?? "—")}</td></tr>`).join("") : "";
  const preflightPanel = preflight ? `<section><h2>最近放行检查：${escapeHtml(preflight.report.overall)}</h2><p>触发：${escapeHtml(preflight.trigger)} · 检查时间：${escapeHtml(preflight.report.generatedAt)} · 配置版本：${escapeHtml(preflight.report.configVersion)} · 持久化：${escapeHtml(preflight.persistence)}</p>${preflight.report.blockers.length ? `<p><strong>阻断原因：</strong>${preflight.report.blockers.map(escapeHtml).join("；")}</p>` : ""}<table><thead><tr><th>范围</th><th>检查项</th><th>状态</th><th>说明</th><th>来源</th><th>观测时间</th></tr></thead><tbody>${preflightRows}</tbody></table></section>` : "<section><h2>尚无放行检查报告</h2><p>启动自动交易前会强制执行并保存放行检查。</p></section>";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>交易控制</title><style>body{font:14px/1.5 sans-serif;max-width:1080px;margin:32px auto;padding:0 16px;color:#172033}nav a{margin-right:12px}button{margin-right:8px;padding:8px 12px}table{border-collapse:collapse;max-width:100%}td,th{padding:8px 12px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}section{border:1px solid #d99;border-radius:8px;padding:12px;margin:16px 0;overflow:auto}label{display:block;margin:12px 0}</style></head><body><h1>双向库存交易</h1><nav><a href="/">概览</a><a href="/trade">交易</a></nav><p>配置总闸：${trading.enabled ? "开" : "关"}；自动执行开关：${armed ? "开" : "关"}；状态：${escapeHtml(snapshot.executionStatus)}。</p><p>单轮 ${escapeHtml(trading.tradeSizeUsdt)} USDT，硬顶 ${escapeHtml(trading.maxTradeSizeUsdt)} USDT；DEX 价格影响上限 ${escapeHtml(snapshot.guardrails.maxDexPriceImpactPercent)}%；最低净边际 1%。</p><p>程序按已启用的资产和链路线独立检查库存：CEX 有 USDT 且链上钱包持有对应代币时，评估 CEX IOC 买入后 DEX 卖出；链上钱包有该路线报价币且 CEX 持有对应资产时，评估 DEX 买入后 CEX IOC 卖出。每轮先确认 DEX 成交，再提交 CEX 对冲单；库存不足、路线不可用或报价未通过保护条件时会跳过。</p><p>若 DEX 已成交而 CEX 未完全成交，程序会停在人工对账状态，不会再启动新周期。关闭开关会阻止新周期；已广播的链上腿仍会继续处理对冲。</p>${notice ? `<p><strong>${escapeHtml(notice)}</strong></p>` : ""}${activeCycle}${preflightPanel}<table class="trade-routes"><thead><tr><th>交易对</th><th>链上代币</th><th>网络</th><th>Chain ID</th><th>路线状态</th><th>Multiplier</th><th>行情/费率</th></tr></thead><tbody>${rows}</tbody></table><form method="post" action="/trade"><button name="action" value="check">检查放行条件</button><button name="action" value="arm">${armed ? "重新检查并保持自动交易开启" : "启动自动交易"}</button><button name="action" value="disarm">紧急停止新交易</button></form><p>私钥只从运行时环境变量读取，不在页面显示或写入交易记录。签名所用私钥能直接控制对应钱包资产。</p></body></html>`;
}

async function getOpenCycle(): Promise<OpenCycle | null> {
  try {
    const rows = await query<OpenCycle[]>("SELECT id,chain_index,status,client_order_id,cex_order_id,cex_order_state,chain_tx_hash,reason FROM trade_cycle WHERE status NOT IN ('COMPLETE','FAILED','RECONCILED') ORDER BY id DESC LIMIT 1");
    return rows[0] ?? null;
  } catch { return null; }
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 4096) throw new Error("request body too large");
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
