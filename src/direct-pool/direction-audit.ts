import Decimal from "decimal.js";

export type DirectionAuditSample = {
  instrumentId: string;
  chainIndex: string;
  sizeUsdt: string;
  cexPoolId: string | null;
  dexPoolId: string | null;
  cexBookSeqId: string | null;
  dexBookSeqId: string | null;
  cexPoolStateFingerprint: string | null;
  dexPoolStateFingerprint: string | null;
  cexNetProfitUsdt: string | null;
  dexNetProfitUsdt: string | null;
};

export type DirectionAuditSummary = {
  instrumentId: string;
  chainIndex: string;
  sizeUsdt: string;
  cexPoolId: string | null;
  dexPoolId: string | null;
  comparableSamples: number;
  cexOnlyPositive: number;
  dexOnlyPositive: number;
  bothPositive: number;
  neitherPositive: number;
  incompleteSamples: number;
  averageNetDeltaUsdt: string | null;
};

function decimal(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch { return null; }
}

export function summarizeDirectionAudit(samples: DirectionAuditSample[]): DirectionAuditSummary[] {
  const groups = new Map<string, DirectionAuditSummary & { deltaTotal: Decimal }>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.instrumentId, sample.chainIndex, sample.sizeUsdt, sample.cexPoolId, sample.dexPoolId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        instrumentId: sample.instrumentId, chainIndex: sample.chainIndex, sizeUsdt: sample.sizeUsdt,
        cexPoolId: sample.cexPoolId, dexPoolId: sample.dexPoolId, comparableSamples: 0,
        cexOnlyPositive: 0, dexOnlyPositive: 0, bothPositive: 0, neitherPositive: 0,
        incompleteSamples: 0, averageNetDeltaUsdt: null, deltaTotal: new Decimal(0),
      };
      groups.set(key, group);
    }

    if (!sample.cexPoolId || sample.cexPoolId !== sample.dexPoolId
      || !sample.cexBookSeqId || sample.cexBookSeqId !== sample.dexBookSeqId
      || !sample.cexPoolStateFingerprint || sample.cexPoolStateFingerprint !== sample.dexPoolStateFingerprint) {
      group.incompleteSamples++;
      continue;
    }
    const cexNet = decimal(sample.cexNetProfitUsdt);
    const dexNet = decimal(sample.dexNetProfitUsdt);
    if (!cexNet || !dexNet) {
      group.incompleteSamples++;
      continue;
    }

    group.comparableSamples++;
    group.deltaTotal = group.deltaTotal.plus(cexNet.minus(dexNet));
    if (cexNet.gt(0) && dexNet.gt(0)) group.bothPositive++;
    else if (cexNet.gt(0)) group.cexOnlyPositive++;
    else if (dexNet.gt(0)) group.dexOnlyPositive++;
    else group.neitherPositive++;
  }

  return [...groups.values()]
    .map(({ deltaTotal, ...group }) => ({
      ...group,
      averageNetDeltaUsdt: group.comparableSamples ? deltaTotal.div(group.comparableSamples).toString() : null,
    }))
    .sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)
      || left.chainIndex.localeCompare(right.chainIndex)
      || new Decimal(left.sizeUsdt).cmp(right.sizeUsdt)
      || (left.cexPoolId ?? "").localeCompare(right.cexPoolId ?? "")
      || (left.dexPoolId ?? "").localeCompare(right.dexPoolId ?? ""));
}
