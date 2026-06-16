#!/usr/bin/env node
// AUDIT: do the recorded paper trades reflect REAL market price action?
// For each trade we (1) confirm the entry price was actually tapped by the market,
// (2) confirm the exit happened in the EXACT real candle at closedAt and price truly
// reached the claimed exit level, and (3) independently REPLAY the trade through the
// same applyBar logic on real Delta candles and check the outcome matches what's stored.
const ENGINE = require('./engine.js');
const { applyBar } = require('./.github/scripts/paper-trade.js');

const SYM = 'BTCUSD';
const tok = process.env.GH_TOKEN;
const F = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const T = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

async function getState(file) {
  const r = await fetch(`https://api.github.com/repos/abhinavkmahaseth-boop/jarvis-bot/contents/${file}?ref=paper-data&t=${Date.now()}`,
    { headers: { Authorization: `token ${tok}`, Accept: 'application/vnd.github.raw' } });
  return r.json();
}
// Paginate real 5m history back `days`.
async function history(days) {
  const sec = 300, now = Math.floor(Date.now() / 1000), startAll = now - days * 86400;
  let end = now; const all = [];
  for (let g = 0; end > startAll && g < 60; g++) {
    const start = Math.max(startAll, end - 1900 * sec);
    const url = `https://api.india.delta.exchange/v2/history/candles?symbol=${SYM}&resolution=5m&start=${start}&end=${end}`;
    const j = await (await fetch(url)).json();
    if (!j.success || !j.result?.length) break;
    all.push(...j.result); end = start - 1;
    await new Promise(r => setTimeout(r, 120));
  }
  const m = new Map(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

const rrOf = (lng, p, e, risk) => lng ? (p - e) / risk : (e - p) / risk;

function audit(t, candles) {
  const lng = t.lng !== undefined ? t.lng : t.dir === 'LONG';
  const risk = Math.abs(t.entry - t.sl);
  const checks = [];
  const pass = (ok, msg) => checks.push({ ok, msg });

  // ── 1) ENTRY TAP: did the market actually reach the entry in the ~2h before fill?
  const wEntry = candles.filter(c => c.time * 1000 <= t.enteredAt && c.time * 1000 >= t.enteredAt - 2 * 3600e3);
  const tapped = wEntry.some(c => lng ? c.low <= t.entry : c.high >= t.entry);
  pass(tapped, `entry ${F(t.entry)} was actually tapped by price before fill ${T(t.enteredAt)}`);

  // ── 2) EXIT CANDLE: closedAt is exactly the exit candle's open-time (finishTrade sets closedAt=c.time*1000)
  const exitC = candles.find(c => c.time * 1000 === t.closedAt);
  if (!exitC) {
    pass(false, `exit candle at ${T(t.closedAt)} not found in real history`);
  } else {
    const reason = t.exitReason;
    if (reason === 'TP3') {
      pass(lng ? exitC.high >= t.tp3 : exitC.low <= t.tp3, `TP3 ${F(t.tp3)} actually reached in exit candle (H ${F(exitC.high)} / L ${F(exitC.low)})`);
    } else { // SL / BE / TP1-trail are stop exits at t.stop
      const stop = t.stop ?? t.sl;
      pass(lng ? exitC.low <= stop : exitC.high >= stop, `stop ${F(stop)} actually reached in exit candle (H ${F(exitC.high)} / L ${F(exitC.low)})`);
    }
  }

  // ── 3) INDEPENDENT REPLAY through applyBar on real candles from the entry
  const rr1 = rrOf(lng, t.tp1, t.entry, risk), rr2 = rrOf(lng, t.tp2, t.entry, risk), rr3 = rrOf(lng, t.tp3, t.entry, risk);
  const sim = { entry: t.entry, sl: t.sl, lng, stop: t.sl, stage: 0, realizedR: 0, remaining: 1,
                tp1: t.tp1, tp2: t.tp2, tp3: t.tp3, rr1, rr2, rr3 };
  let done = null;
  for (const c of candles.filter(c => c.time * 1000 >= t.enteredAt)) { done = applyBar(sim, c); if (done) break; }
  if (!done) {
    pass(false, 'replay did not close (still open on real candles)');
  } else {
    pass(done.exitReason === t.exitReason, `replay exit reason "${done.exitReason}" == recorded "${t.exitReason}"`);
    pass(Math.abs(done.totalR - t.totalR) < 0.05, `replay R ${done.totalR} == recorded ${t.totalR}`);
    pass(done.closedAt === t.closedAt, `replay exit time ${T(done.closedAt)} == recorded ${T(t.closedAt)}`);
  }
  return checks;
}

(async () => {
  console.log('Fetching real BTC 5m history…');
  const candles = await history(3);
  console.log(`real candles: ${candles.length}  (${T(candles[0].time * 1000)} → ${T(candles[candles.length - 1].time * 1000)})\n`);

  let total = 0, failed = 0;
  for (const [file, label] of [['state.json', 'Paper · Claude'], ['state-algo.json', 'Paper · Auto']]) {
    const s = await getState(file);
    const trades = [...(s.closed || []), ...(s.open || [])];
    console.log(`══════════ ${label}  (${trades.length} trade(s)) ══════════`);
    for (const t of trades) {
      const dir = t.lng ?? (t.dir === 'LONG') ? 'LONG' : 'SHORT';
      console.log(`\n▸ ${t.dir} entry ${F(t.entry)} → ${t.exitReason || 'OPEN'} ${t.totalR != null ? `(${t.totalR >= 0 ? '+' : ''}${t.totalR}R)` : ''}  ·  ${T(t.enteredAt)} → ${t.closedAt ? T(t.closedAt) : 'open'}`);
      if (!t.closedAt) { console.log('   (open position — skipping exit replay)'); continue; }
      for (const c of audit(t, candles)) { total++; if (!c.ok) failed++; console.log(`   ${c.ok ? '✅' : '❌'} ${c.msg}`); }
    }
    console.log();
  }
  console.log(`\n═══ ${total - failed}/${total} checks passed ═══`);
  console.log(failed === 0 ? '✅ ALL TRADES MATCH REAL MARKET PRICE ACTION' : `❌ ${failed} check(s) FAILED — investigate`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('audit error:', e); process.exit(1); });
