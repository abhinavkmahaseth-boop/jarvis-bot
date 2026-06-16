#!/usr/bin/env node
// Offline unit tests for the two pieces of math that are subtle enough to break
// silently: orderTPs (the structural TP ladder) and applyBar (the TP1-then-trail
// exit state machine). No network. Run in CI alongside the smoke test.
const ENGINE = require('../../engine.js');
const { applyBar } = require('./paper-trade.js');

let fails = 0;
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const ok = (cond, label, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`); if (!cond) fails++; };

// ── orderTPs: strictly-ordered, capped ladder ────────────────────────────────
{
  // long: entry 100, sl 95 (risk 5). Candidates out of order + one too close.
  const t = ENGINE.orderTPs(100, 95, true, [104, 108, 130, 102.5, 108]);
  ok(t.length === 3, 'orderTPs returns 3 rungs');
  ok(t[0].p < t[1].p && t[1].p < t[2].p, 'long ladder ascending in price', t.map(x => x.p).join(', '));
  ok(t[0].rr < t[1].rr && t[1].rr < t[2].rr, 'long ladder ascending in R', t.map(x => x.rr.toFixed(2)).join(', '));
  ok(t[0].rr >= 1.5, 'TP1 ≥ 1.5R floor', t[0].rr.toFixed(2));
  ok(t[0].rr <= 5 + 1e-9, 'TP1 within 5R cap', t[0].rr.toFixed(2));
}
{
  // short: entry 100, sl 105 (risk 5). Targets below price.
  const t = ENGINE.orderTPs(100, 105, false, [96, 92, 70, 97.5]);
  ok(t[0].p > t[1].p && t[1].p > t[2].p, 'short ladder descending in price', t.map(x => x.p).join(', '));
  ok(t[0].rr < t[1].rr && t[1].rr < t[2].rr, 'short ladder ascending in R', t.map(x => x.rr.toFixed(2)).join(', '));
}
{
  // no candidates → R-multiple fallback ladder, still ordered.
  const t = ENGINE.orderTPs(100, 95, true, []);
  ok(t[0].rr < t[1].rr && t[1].rr < t[2].rr, 'fallback ladder ordered with no candidates', t.map(x => x.rr.toFixed(2)).join(', '));
}

// ── applyBar: TP1-then-trail payouts ─────────────────────────────────────────
// entry 100, sl 95 (risk 5); tp1 105 (1R), tp2 110 (2R), tp3 120 (4R).
const mk = o => Object.assign({ entry: 100, sl: 95, lng: true, stop: 95, stage: 0, realizedR: 0, remaining: 1, tp1: 105, tp2: 110, tp3: 120, rr1: 1, rr2: 2, rr3: 4 }, o);

{ // straight stop-out at stage 0 → full -1R
  const t = mk();
  const d = applyBar(t, { high: 101, low: 94, time: 1 });
  ok(d && approx(d.totalR, -1) && d.exitReason === 'SL', 'stop at stage 0 → -1R (SL)', d && `${d.totalR}R ${d.exitReason}`);
}
{ // tap TP1 (book 0.5R, stop→BE), then stop at BE → +0.5R
  const t = mk();
  ok(applyBar(t, { high: 106, low: 100, time: 1 }) === null, 'TP1 tap keeps trade open');
  ok(t.stage === 1 && approx(t.stop, 100), 'after TP1: stage 1, stop at breakeven', `stage ${t.stage} stop ${t.stop}`);
  const d = applyBar(t, { high: 101, low: 99, time: 2 });
  ok(d && approx(d.totalR, 0.5) && d.exitReason === 'BE', 'TP1 then BE → +0.5R (BE)', d && `${d.totalR}R ${d.exitReason}`);
}
{ // TP1 + TP2 (stop→TP1), then trail stop hit at TP1 → +1R total
  const t = mk();
  applyBar(t, { high: 111, low: 100, time: 1 });   // crosses TP1 and TP2 same bar
  ok(t.stage === 2 && approx(t.stop, 105), 'after TP2: stage 2, stop at TP1', `stage ${t.stage} stop ${t.stop}`);
  const d = applyBar(t, { high: 106, low: 104, time: 2 });
  ok(d && approx(d.totalR, 1) && d.exitReason === 'TP1-trail', 'TP2 then trail → +1R (TP1-trail)', d && `${d.totalR}R ${d.exitReason}`);
}
{ // runner to TP3 → 0.5*1 + 0.5*4 = 2.5R
  const t = mk();
  const d = applyBar(t, { high: 121, low: 100, time: 1 });
  ok(d && approx(d.totalR, 2.5) && d.exitReason === 'TP3', 'runner to TP3 → +2.5R (TP3)', d && `${d.totalR}R ${d.exitReason}`);
}

console.log(fails === 0 ? '\n✅ UNIT TESTS PASSED' : `\n❌ UNIT TESTS FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
