import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDirectionAudit, type DirectionAuditSample } from "./direction-audit.js";

const sample = (patch: Partial<DirectionAuditSample> = {}): DirectionAuditSample => ({
  instrumentId: "SPCX-USDT", chainIndex: "501", sizeUsdt: "100", cexPoolId: "orca-a", dexPoolId: "orca-a",
  cexBookSeqId: "42", dexBookSeqId: "42",
  cexPoolStateFingerprint: "state-1", dexPoolStateFingerprint: "state-1",
  cexNetProfitUsdt: "1", dexNetProfitUsdt: "-1", ...patch,
});

test("summarizes only same-scan, same-pool bidirectional profit pairs", () => {
  const rows = summarizeDirectionAudit([
    sample(),
    sample({ cexNetProfitUsdt: "-0.5", dexNetProfitUsdt: "0.5" }),
    sample({ cexNetProfitUsdt: "2", dexNetProfitUsdt: "1" }),
    sample({ cexPoolId: "orca-a", dexPoolId: "orca-b", cexNetProfitUsdt: "3", dexNetProfitUsdt: "2" }),
    sample({ cexNetProfitUsdt: null }),
    sample({ cexBookSeqId: "43", cexNetProfitUsdt: "1", dexNetProfitUsdt: "0" }),
    sample({ dexPoolStateFingerprint: "state-2", cexNetProfitUsdt: "1", dexNetProfitUsdt: "0" }),
  ]);

  assert.equal(rows.length, 2);
  const samePool = rows.find((row) => row.cexPoolId === "orca-a" && row.dexPoolId === "orca-a")!;
  const differentPools = rows.find((row) => row.cexPoolId === "orca-a" && row.dexPoolId === "orca-b")!;
  assert.equal(samePool.comparableSamples, 3);
  assert.equal(samePool.cexOnlyPositive, 1);
  assert.equal(samePool.dexOnlyPositive, 1);
  assert.equal(samePool.bothPositive, 1);
  assert.equal(samePool.neitherPositive, 0);
  assert.equal(samePool.incompleteSamples, 3);
  assert.equal(samePool.averageNetDeltaUsdt, "0.66666666666666666667");
  assert.equal(differentPools.comparableSamples, 0);
  assert.equal(differentPools.incompleteSamples, 1);
});
