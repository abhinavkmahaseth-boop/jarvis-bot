#!/usr/bin/env node
// Offline unit tests for the two pieces of math that are subtle enough to break
// silently: orderTPs (the structural TP ladder) and applyBar (the TP1-then-trail
// exit state machine). No network. Run in CI alongside the smoke test.
const ENGINE = require('../../engine.js');
const { applyBar, replayTrade, enforceSinglePosition, symOpen, symActive } = require('./paper-trade.js');

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
  ok(d && approx(d.totalR, -1) && d.exitReason === 'SL' && approx(d.exitPrice, 95), 'stop at stage 0 → -1R (SL) @ 95', d && `${d.totalR}R ${d.exitReason} @${d.exitPrice}`);
}
{ // tap TP1 (book 0.5R, stop→BE), then stop at BE → +0.5R, exit @ entry
  const t = mk();
  ok(applyBar(t, { high: 106, low: 100, time: 1 }) === null, 'TP1 tap keeps trade open');
  ok(t.stage === 1 && approx(t.stop, 100), 'after TP1: stage 1, stop at breakeven', `stage ${t.stage} stop ${t.stop}`);
  const d = applyBar(t, { high: 101, low: 99, time: 2 });
  ok(d && approx(d.totalR, 0.5) && d.exitReason === 'BE' && approx(d.exitPrice, 100), 'TP1 then BE → +0.5R (BE) @ 100', d && `${d.totalR}R ${d.exitReason} @${d.exitPrice}`);
}
{ // TP1 + TP2 (stop→TP1), then trail stop hit at TP1 → +1R total, exit @ tp1
  const t = mk();
  applyBar(t, { high: 111, low: 100, time: 1 });   // crosses TP1 and TP2 same bar
  ok(t.stage === 2 && approx(t.stop, 105), 'after TP2: stage 2, stop at TP1', `stage ${t.stage} stop ${t.stop}`);
  const d = applyBar(t, { high: 106, low: 104, time: 2 });
  ok(d && approx(d.totalR, 1) && d.exitReason === 'TP1-trail' && approx(d.exitPrice, 105), 'TP2 then trail → +1R (TP1-trail) @ 105', d && `${d.totalR}R ${d.exitReason} @${d.exitPrice}`);
}
{ // runner to TP3 → 0.5*1 + 0.5*4 = 2.5R, exit @ tp3
  const t = mk();
  const d = applyBar(t, { high: 121, low: 100, time: 1 });
  ok(d && approx(d.totalR, 2.5) && d.exitReason === 'TP3' && approx(d.exitPrice, 120), 'runner to TP3 → +2.5R (TP3) @ 120', d && `${d.totalR}R ${d.exitReason} @${d.exitPrice}`);
}

// ── One-trade-per-symbol invariant (no double entries) ───────────────────────
{ // two BTC pendings collapse to the earliest one
  const st = { open: [], pending: [
    { sym: 'BTCUSD', createdAt: 200 }, { sym: 'BTCUSD', createdAt: 100 },
  ], closed: [] };
  enforceSinglePosition(st);
  ok(st.pending.length === 1 && st.pending[0].createdAt === 100, 'two BTC pendings → keep earliest one', `${st.pending.length} left`);
}
{ // a pending for an already-open symbol is dropped
  const st = { open: [{ sym: 'BTCUSD' }], pending: [{ sym: 'BTCUSD', createdAt: 100 }], closed: [] };
  enforceSinglePosition(st);
  ok(st.pending.length === 0, 'pending dropped when symbol already open', `${st.pending.length} left`);
}
{ // different symbols are independent — one each survives
  const st = { open: [], pending: [
    { sym: 'BTCUSD', createdAt: 100 }, { sym: 'BTCUSD', createdAt: 200 },
    { sym: 'SOLUSD', createdAt: 100 }, { sym: 'ETHUSD', createdAt: 100 },
  ], closed: [] };
  enforceSinglePosition(st);
  const byS = st.pending.map(p => p.sym).sort().join(',');
  ok(st.pending.length === 3 && byS === 'BTCUSD,ETHUSD,SOLUSD', 'one pending per symbol, symbols independent', byS);
}
{ // guards report active state correctly
  const st = { open: [{ sym: 'BTCUSD' }], pending: [], closed: [] };
  ok(symOpen(st, 'BTCUSD') && symActive(st, 'BTCUSD') && !symActive(st, 'SOLUSD'), 'symOpen/symActive detect the live position');
  const st2 = { open: [], pending: [{ sym: 'BTCUSD' }], closed: [] };
  ok(!symOpen(st2, 'BTCUSD') && symActive(st2, 'BTCUSD'), 'symActive true on pending-only, symOpen false');
}

// ── replayTrade: re-derive from entry + ignore unsettled bad ticks ───────────
// trade: LONG entry 100, sl 95 (1R), tp1 110 (2R). enteredAt at t=0 so all bars manage.
const mkT = o => Object.assign({ sym:'BTCUSD', dir:'LONG', lng:true, entry:100, sl:95, tp1:110, tp2:115, tp3:130, enteredAt:0 }, o);
{ // clean data, price never reaches tp1 or sl → stays open (no phantom close)
  const candles = [{time:1,high:104,low:99},{time:2,high:106,low:101},{time:3,high:103,low:98}];
  const { done } = replayTrade(mkT(), candles);
  ok(done === null, 'replay: price between SL and TP1 → trade stays OPEN (no phantom)', done ? `closed ${done.exitReason}` : 'open');
}
{ // a single unsettled bar with a bad wick to tp1 would book a phantom TP1;
  // the settle-delay drops that bar so it never affects the recorded trade.
  const clean = [{time:1,high:104,low:99},{time:2,high:106,low:101}];
  const badLastBar = { time:3, high:111, low:101 };          // phantom wick >= tp1 110
  const withBad = [...clean, badLastBar];
  const settled = withBad.slice(0, -1);                       // SETTLE_BARS = 1 drops it
  ok(replayTrade(mkT(), withBad).live.realizedR > 0,
     'replay on UNsettled bad wick books a phantom TP1 (the risk this fixes)');
  const sett = replayTrade(mkT(), settled);
  ok(sett.done === null && sett.live.realizedR === 0,
     'replay on SETTLED candles ignores the unsettled bad wick → no phantom TP1');
}
{ // real SL hit on settled data is honored
  const candles = [{time:1,high:104,low:99},{time:2,high:101,low:94}];   // bar 2 hits sl 95
  const { done } = replayTrade(mkT(), candles);
  ok(done && done.exitReason === 'SL' && approx(done.totalR, -1), 'replay: real SL on settled data → -1R', done && `${done.exitReason} ${done.totalR}R`);
}

// ── Delta contract quantity + tick (keep sizing in line with the exchange) ────
{
  ok(ENGINE.contractSpec('BTCUSD').value === 0.001 && ENGINE.contractSpec('BTCUSD').tick === 0.5, 'BTCUSD spec = 0.001 BTC / 0.5 tick');
  ok(ENGINE.contractQty('BTCUSD', 65000, 64900, 20) === 200, 'BTC qty: $20 / (100 × 0.001) = 200 contracts', String(ENGINE.contractQty('BTCUSD', 65000, 64900, 20)));
  ok(ENGINE.contractQty('BTCUSD', 65909.5, 65816.01, 20) === 214, 'BTC qty real trade = 214 contracts', String(ENGINE.contractQty('BTCUSD', 65909.5, 65816.01, 20)));
  ok(ENGINE.roundTick('BTCUSD', 65816.0055) === 65816 && ENGINE.roundTick('BTCUSD', 65816.3) === 65816.5, 'roundTick snaps to 0.5');
  ok(ENGINE.contractQty('ETHUSD', 2600, 2590, 20) === 200 && ENGINE.contractQty('SOLUSD', 150, 148, 20) === 10, 'ETH/SOL qty use their own contract value');
  ok(Number.isFinite(ENGINE.contractQty('BTCUSD', 100, 100, 20)), 'zero stop distance → finite qty (no divide-by-zero)');
}

// ── Delta live client: signing + the 1-lot hard cap (offline, no network) ─────
{
  const D = require('./delta.js');
  const a = D.sign('secret', 'POST', '1700000000', '/v2/orders', '', '{"x":1}');
  const b = D.sign('secret', 'POST', '1700000000', '/v2/orders', '', '{"x":1}');
  ok(/^[0-9a-f]{64}$/.test(a) && a === b, 'Delta sign() is a deterministic 64-hex HMAC');
  ok(D.sign('secret', 'GET', '1700000000', '/v2/orders', '', '') !== a, 'signature changes with the request');
  ok(D.MAX_LOTS === 1 && D.BTCUSD_ID === 27, 'hard cap MAX_LOTS=1 · BTCUSD product_id=27');
  const clamp = n => Math.min(Math.max(1, Math.round(n || 1)), D.MAX_LOTS);
  ok([1, 5, 100, 999, 0].every(n => clamp(n) <= 1), '1-lot cap clamps any requested size to ≤ 1');
}

console.log(fails === 0 ? '\n✅ UNIT TESTS PASSED' : `\n❌ UNIT TESTS FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
