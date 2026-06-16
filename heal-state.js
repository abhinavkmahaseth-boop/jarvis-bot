#!/usr/bin/env node
// Reconcile the live paper books against CLEAN settled market data. Every closed
// trade is re-derived from its entry on real candles; if the recorded outcome does
// not match reality it is corrected, and a trade that never actually resolved is
// moved back to OPEN. Dry-run by default; pass --apply to write the corrected files.
const fs = require('fs');
const ENGINE = require('./engine.js');
const { replayTrade } = require('./.github/scripts/paper-trade.js');
const SETTLE_BARS = 1, R_DOLLAR = 20;
const APPLY = process.argv.includes('--apply');
const tok = process.env.GH_TOKEN;
const F = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const T = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });

async function getState(file) {
  const r = await fetch(`https://api.github.com/repos/abhinavkmahaseth-boop/jarvis-bot/contents/${file}?ref=paper-data&t=${Date.now()}`,
    { headers: { Authorization: `token ${tok}`, Accept: 'application/vnd.github.raw' } });
  return r.json();
}
async function history(days) {
  const sec = 300, now = Math.floor(Date.now() / 1000), startAll = now - days * 86400;
  let end = now; const all = [];
  for (let g = 0; end > startAll && g < 60; g++) {
    const start = Math.max(startAll, end - 1900 * sec);
    const j = await (await fetch(`https://api.india.delta.exchange/v2/history/candles?symbol=BTCUSD&resolution=5m&start=${start}&end=${end}`)).json();
    if (!j.success || !j.result?.length) break;
    all.push(...j.result); end = start - 1; await new Promise(r => setTimeout(r, 120));
  }
  const m = new Map(); for (const c of all) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

(async () => {
  console.log(APPLY ? '🔧 HEAL (apply)\n' : '🔎 HEAL (dry-run — no writes)\n');
  const candles = await history(3);
  const settled = SETTLE_BARS > 0 ? candles.slice(0, -SETTLE_BARS) : candles;
  console.log(`clean settled candles: ${settled.length} (… → ${T(settled[settled.length - 1].time * 1000)})\n`);

  for (const file of ['state.json', 'state-algo.json']) {
    const s = await getState(file);
    const newClosed = [], newOpen = [...(s.open || [])];
    let changed = false;
    for (const t of (s.closed || [])) {
      const { done, live } = replayTrade(t, settled);
      if (done && done.exitReason === t.exitReason && Math.abs((done.totalR ?? 0) - (t.totalR ?? 0)) < 0.05) {
        newClosed.push({ ...t, exitPrice: t.exitPrice ?? done.exitPrice });   // matches reality (backfill exitPrice)
        console.log(`  ✅ ${file}: ${t.dir} ${F(t.entry)} ${t.exitReason} ${t.totalR}R — matches real data`);
      } else if (done) {
        const corrected = { ...t, exitReason: done.exitReason, exitPrice: done.exitPrice, totalR: done.totalR, pnl: +(done.totalR * R_DOLLAR).toFixed(2), closedAt: done.closedAt };
        newClosed.push(corrected); changed = true;
        console.log(`  🔧 ${file}: ${t.dir} ${F(t.entry)} recorded ${t.exitReason} ${t.totalR}R → REAL ${done.exitReason} ${done.totalR}R @ ${F(done.exitPrice)} (${T(done.closedAt)})`);
      } else {
        const reopened = { ...t, stage: live.stage, stop: live.stop, realizedR: live.realizedR, remaining: live.remaining };
        delete reopened.exitReason; delete reopened.exitPrice; delete reopened.totalR; delete reopened.pnl; delete reopened.closedAt;
        newOpen.push(reopened); changed = true;
        console.log(`  🔁 ${file}: ${t.dir} ${F(t.entry)} recorded ${t.exitReason} ${t.totalR}R → NEVER resolved on real data → moved back to OPEN (stage ${live.stage})`);
      }
    }
    s.closed = newClosed; s.open = newOpen;
    if (APPLY && changed) {
      s.updatedAt = new Date().toISOString();
      fs.writeFileSync(`/tmp/heal-${file}`, JSON.stringify(s, null, 2));
      console.log(`  💾 wrote /tmp/heal-${file}`);
    }
    console.log(`  → ${file}: ${s.closed.length} closed, ${s.open.length} open${changed ? ' (CHANGED)' : ' (unchanged)'}\n`);
  }
})().catch(e => { console.error('heal error:', e); process.exit(1); });
