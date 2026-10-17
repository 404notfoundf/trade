import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { TradingConfig } from "./config.js";
import type { PreflightRun } from "./preflight-store.js";
import { createTradeHandler } from "./page.js";

const snapshot = {
  trading: { enabled: true, tradeSizeUsdt: 10, maxTradeSizeUsdt: 20 } as TradingConfig,
  guardrails: { maxDexPriceImpactPercent: 1 } as never,
  routes: [],
  executionStatus: "healthy",
  preflight: null,
};

function run(report: PreflightRun["report"], persistence: PreflightRun["persistence"] = "database"): PreflightRun {
  return { id: 1, trigger: "arm", persistence, report };
}

const passReport: PreflightRun["report"] = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), configVersion: "a".repeat(64), overall: "PASS", checks: [],
  routes: [{ instId: "AAA-USDT", chainIndex: "196", enabled: true, checks: [] }], blockers: [],
};
const blockedReport: PreflightRun["report"] = { ...passReport, overall: "BLOCKED", blockers: ["route blocked"] };

async function post(handler: ReturnType<typeof createTradeHandler>, action: string): Promise<number> {
  const request = Readable.from([Buffer.from(new URLSearchParams({ action }).toString())]) as IncomingMessage;
  request.method = "POST";
  request.headers = {};
  let status = 0;
  const response = {
    writeHead(code: number) { status = code; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  await handler(request, response, new URL("http://localhost/trade"));
  return status;
}

test("manual preflight checks readiness without arming", async () => {
  const armed: boolean[] = [];
  const triggers: string[] = [];
  const handler = createTradeHandler(() => snapshot, (value) => armed.push(value), async (trigger) => {
    triggers.push(trigger);
    return run(passReport);
  });

  assert.equal(await post(handler, "check"), 303);
  assert.deepEqual(triggers, ["manual_check"]);
  assert.deepEqual(armed, []);
});

test("arm remains disarmed when preflight is blocked or not persisted", async () => {
  for (const result of [run(blockedReport), run(passReport, "log")]) {
    const armed: boolean[] = [];
    const handler = createTradeHandler(() => snapshot, (value) => armed.push(value), async () => result);
    assert.equal(await post(handler, "arm"), 303);
    assert.deepEqual(armed, [false, false]);
  }
});

test("arm enables trading only after a passing persisted preflight", async () => {
  const armed: boolean[] = [];
  const handler = createTradeHandler(() => snapshot, (value) => armed.push(value), async () => run(passReport));

  assert.equal(await post(handler, "arm"), 303);
  assert.deepEqual(armed, [false, true]);
});

test("disarm wins over an in-flight arm preflight", async () => {
  let finishPreflight!: (result: PreflightRun) => void;
  const preflight = new Promise<PreflightRun>((resolve) => { finishPreflight = resolve; });
  const armed: boolean[] = [];
  const handler = createTradeHandler(() => snapshot, (value) => armed.push(value), async () => preflight);
  const armRequest = post(handler, "arm");
  await post(handler, "disarm");
  finishPreflight(run(passReport));
  await armRequest;

  assert.deepEqual(armed, [false, false, false]);
});
