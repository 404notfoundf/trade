import assert from "node:assert/strict";
import { reserveDexRequestSlot } from "./okx.js";

const started = Date.now();
const first = reserveDexRequestSlot().then(() => Date.now() - started);
const second = reserveDexRequestSlot().then(() => Date.now() - started);
await new Promise((resolve) => setTimeout(resolve, 50));
const late = reserveDexRequestSlot().then(() => Date.now() - started);
const firstAt = await first;
const secondAt = await second;
const lateAt = await late;
assert.ok(firstAt < 300, `first slot should start immediately, got ${firstAt}`);
assert.ok(secondAt >= 1_000 && secondAt < 1_500, `paired slot should stay at +1100, got ${secondAt}`);
assert.ok(lateAt >= 2_000 && lateAt < 2_700, `late caller should stay behind both reserved slots, got ${lateAt}`);
assert.ok(lateAt - secondAt >= 900, `late caller cut between the paired slots: second=${secondAt} late=${lateAt}`);
