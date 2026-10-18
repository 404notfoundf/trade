import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../config.js";
import { directPoolDexLabel, renderDirectPoolPage } from "./direct-pool-pages.js";

const registeredPools = [
  { id: "orca-pool", instrument_id: "XSPCX", dex: "orca_whirlpool_solana", address: "ASAxmEaTT1HFe3mVC3zbKDE4tuB28W7732XQrEMBM5W2", enabled: true },
  { id: "meteora-pool", instrument_id: "XSPCX", dex: "meteora_dlmm_solana", address: "5whNk71ua6aRtNKazDqEeAimmfzuX9epJcjh4isQKprn", enabled: false },
];

const pageConfig = { marketRegistry: { pools: registeredPools } } as unknown as Config;
const helpers = {
  escapeHtml: (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!),
  formatUtc8: () => "",
  formatReportDecimal: () => "",
  formatRawTokenAmount: () => "",
  directQuoteAssetUiMultiplier: () => "1",
  fixedPoolPanel: () => "",
};

test("direct-pool pages show registered Solana adapters by readable name", () => {
  assert.equal(directPoolDexLabel("orca_whirlpool_solana"), "Orca Whirlpool");
  assert.equal(directPoolDexLabel("meteora_dlmm_solana"), "Meteora DLMM");
  assert.equal(directPoolDexLabel("raydium_clmm_solana"), "Raydium CLMM");
  assert.equal(directPoolDexLabel("unknown"), "unknown");
});

test("pool selector is shared across pages and keeps missing historical pool selections explicit", async () => {
  for (const path of ["/direct-pools", "/direct-pools/quotes", "/direct-pools/decisions"]) {
    const html = await renderDirectPoolPage({
      url: new URL(`http://localhost${path}?pool=meteora-pool`), config: pageConfig, assets: [], dbOnline: false, fixedPools: undefined, helpers,
    });
    assert.match(html, /<select name="pool">/);
    assert.match(html, /value="meteora-pool" selected/);
    assert.match(html, /XSPCX · Meteora DLMM · 5whNk71…QKprn · 已关闭/);
  }

  const html = await renderDirectPoolPage({
    url: new URL("http://localhost/direct-pools/decisions?pool=retired-pool&profit=positive&direction=dex_buy_cex_sell"),
    config: pageConfig, assets: [], dbOnline: false, fixedPools: undefined, helpers,
  });
  assert.match(html, /未登记 \/ 历史池 · retired-pool/);
  assert.match(html, /name="profit" value="positive"/);
  assert.match(html, /name="direction"/);
  assert.match(html, /value="dex_buy_cex_sell" selected/);
});
