#!/usr/bin/env node
// Algorithmic backtest — BTC SWING (4H trend · 1H/15M FVGs · 15M/5M entry),
// Grade-A only, NO Claude approval.
// Walk-forward replay over `days` of history with no look-ahead: each 5m bar's
// decision sees only candles that had CLOSED by that bar's close. Reuses the live
// engine.analyze (setup detection) and paper.applyBar (TP1-then-trail exits) so the
// backtest behaves identically to the live paper-trader. Writes backtest.json.
const fs = require('fs');
const path = require('path');
const ENGINE = require('../../engine.js');
const { applyBar, R_DOLLAR } = require('./paper-trade.js');

const SYM   = 'BTCUSD';
const DAYS  = parseInt(process.env.BT_DAYS || process.argv[2] || '60', 10);
const GRADE = 'A';
const TG_TOKEN = process.env.TG_TOKEN, TG_CHAT = process.env.TG_CHAT_ID, DISCORD = process.env.DISCORD_WEBHOOK || '';
const NOTIFY = require('../../notify.js');
const OUT   = process.env.BT_OUT || path.join(process.cwd(), 'backtest.json');
const STALE_MS = 6 * 3600 * 1000, COOLDOWN_MS = 2 * 3600 * 1000, ZONE_TOL = 0.0015, WARM = 120;
const F = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Paginate Delta history (≈1900 bars/request) back `days`, dedup by time, sort asc.
async function fetchHistory(sym, res, days) {
  const sec = ENGINE.TF_SEC[res], now = Math.floor(Date.now() / 1000), startAll = now - days * 86400;
  const CHUNK = 1900; let end = now; const all = [];
  for (let g = 0; end > startAll && g < 80; g++) {
    const start = Math.max(startAll, end - CHUNK * sec);
    const url = `https://api.india.delta.exchange/v2/history/candles?symbol=${sym}&resolution=${res}&start=${start}&end=${end}`;
    const j = await (await fetch(url)).json();
    if (!j.success || !j.result?.length) break;
    all.push(...j.result);
    end = start - 1;
    await sleep(120);
  }
  const map = new Map(); for (const c of all) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

async function tg(text) {
  const ok = await NOTIFY.notify(text, { discord: DISCORD, tgToken: TG_TOKEN, tgChat: TG_CHAT });
  if (!ok.length) console.log('[notify]', NOTIFY.plain(text));
}

(async () => {
  console.log(`Backtest ${SYM} swing · Grade ${GRADE} · ${DAYS}d · no Claude`);
  const [d4h, d1h, d15m, d5m] = await Promise.all([
    fetchHistory(SYM, '4h', DAYS), fetchHistory(SYM, '1h', DAYS), fetchHistory(SYM, '15m', DAYS), fetchHistory(SYM, '5m', DAYS),
  ]);
  console.log(`candles: 4h=${d4h.length} 1h=${d1h.length} 15m=${d15m.length} 5m=${d5m.length}`);
  if (d5m.length < 300) { console.error('not enough data'); process.exit(1); }

  const pending = [], open = [], closed = [];
  let nextId = 1, p4h = -1, p1h = -1, p15 = -1;

  for (let i = 0; i < d5m.length; i++) {
    const bar = d5m[i];
    const decClose = bar.time + ENGINE.TF_SEC['5m'];   // this 5m bar's close time (sec)
    const decMs = decClose * 1000;
    while (p4h + 1 < d4h.length && d4h[p4h + 1].time + 14400 <= decClose) p4h++;  // last 4h bar closed
    while (p1h + 1 < d1h.length && d1h[p1h + 1].time + 3600 <= decClose) p1h++;   // last 1h bar closed
    while (p15 + 1 < d15m.length && d15m[p15 + 1].time + 900 <= decClose) p15++;  // last 15m bar closed

    // 1) manage open trades with this just-closed bar
    for (let k = open.length - 1; k >= 0; k--) {
      const done = applyBar(open[k], bar);
      if (done) { closed.push(done); open.splice(k, 1); }
    }
    // 2) pending: fill on entry tap, else expire (CHoCH void / 6h stale)
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k];
      const tapped = p.lng ? bar.low <= p.entry : bar.high >= p.entry;
      const voided = p.invalidation != null && (p.lng ? bar.close < p.invalidation : bar.close > p.invalidation);
      if (tapped) { pending.splice(k, 1); open.push({ ...p, enteredAt: decMs, stage: 0, stop: p.sl, realizedR: 0, remaining: 1 }); }
      else if (voided || decMs - p.createdAt > STALE_MS) pending.splice(k, 1);
    }
    // 3) analyze (every 5m bar, once warmed up) for new Grade-A setups
    if (p4h < WARM || p1h < WARM || p15 < WARM) continue;
    const c = {
      d4h: d4h.slice(Math.max(0, p4h - 149), p4h + 1),
      d1h: d1h.slice(Math.max(0, p1h - 149), p1h + 1),
      d15m: d15m.slice(Math.max(0, p15 - 149), p15 + 1),
      d5m: d5m.slice(Math.max(0, i - 149), i + 1),
    };
    let data; try { data = ENGINE.analyze(SYM, c, { lb: 5, mode: 'swing' }); } catch { continue; }
    for (const s of data.setups || []) {
      if (s.fvg.grade !== GRADE) continue;
      const dir = s.lng ? 'LONG' : 'SHORT';
      const dup = [...pending, ...open].some(t => t.dir === dir && Math.abs(t.entry - s.entry) / s.entry < ZONE_TOL)
        || closed.some(t => decMs - t.closedAt < COOLDOWN_MS && t.dir === dir && Math.abs(t.entry - s.entry) / s.entry < ZONE_TOL);
      if (dup) continue;
      pending.push({
        id: nextId++, sym: SYM, dir, lng: s.lng, grade: s.fvg.grade, tf: s.fvg.tf,
        zoneLow: s.fvg.gL, zoneHigh: s.fvg.gH, entry: s.entry, sl: s.sl,
        tp1: s.tps[0].p, tp2: s.tps[1].p, tp3: s.tps[2].p,
        rr1: s.tps[0].rr, rr2: s.tps[1].rr, rr3: s.tps[2].rr,
        invalidation: s.invalidation, trigger: s.trigger, createdAt: decMs,
      });
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const startEquity = 1000;
  const wins = closed.filter(t => t.totalR > 0), losses = closed.filter(t => t.totalR < 0), be = closed.filter(t => t.totalR === 0);
  const totalR = +closed.reduce((a, t) => a + t.totalR, 0).toFixed(2);
  const netPnl = +closed.reduce((a, t) => a + t.pnl, 0).toFixed(2);
  const equity = +(startEquity + netPnl).toFixed(2);
  const gW = wins.reduce((a, t) => a + t.totalR, 0), gL = Math.abs(losses.reduce((a, t) => a + t.totalR, 0));
  const pf = gL ? +(gW / gL).toFixed(2) : (gW ? null : 0);   // null = ∞
  const winRate = closed.length ? Math.round(100 * wins.length / closed.length) : 0;
  let eq = startEquity, peak = startEquity, maxDD = 0; const curve = [startEquity];
  for (const t of closed) { eq += t.pnl; curve.push(+eq.toFixed(2)); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }

  const result = {
    meta: { sym: SYM, mode: 'swing', grade: GRADE, days: DAYS, claude: false, generatedAt: new Date().toISOString(),
      periodStart: new Date(d5m[0].time * 1000).toISOString(), periodEnd: new Date(d5m[d5m.length - 1].time * 1000).toISOString(),
      candles: { '4h': d4h.length, '1h': d1h.length, '15m': d15m.length, '5m': d5m.length },
      account: startEquity, riskPct: 2, rDollar: R_DOLLAR, exit: 'TP1-then-trail', stillOpen: open.length },
    stats: { trades: closed.length, wins: wins.length, losses: losses.length, be: be.length, winRate,
      totalR, netPnl, equity, startEquity, profitFactor: pf, maxDrawdown: +maxDD.toFixed(2),
      avgWin: +(wins.length ? gW / wins.length : 0).toFixed(2), avgLoss: +(losses.length ? gL / losses.length : 0).toFixed(2),
      best: closed.length ? Math.max(...closed.map(t => t.totalR)) : 0, worst: closed.length ? Math.min(...closed.map(t => t.totalR)) : 0 },
    equityCurve: curve,
    closed: closed.map(t => ({ dir: t.dir, grade: t.grade, tf: t.tf, entry: t.entry, sl: t.sl, exitReason: t.exitReason, exitPrice: t.exitPrice, totalR: t.totalR, pnl: t.pnl, openedAt: t.enteredAt, closedAt: t.closedAt })),
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\n=== RESULT ===\ntrades=${closed.length} win=${winRate}% net=${totalR}R ($${netPnl}) PF=${pf === null ? '∞' : pf} maxDD=$${maxDD.toFixed(2)} stillOpen=${open.length}`);

  await tg(
    `🧪 <b>BACKTEST — BTC swing · Grade A · ${DAYS}d</b>\n` +
    `<i>algorithmic · no Claude</i>\n\n` +
    `Trades: <b>${closed.length}</b>  (${wins.length}W / ${losses.length}L / ${be.length}BE)\n` +
    `Win rate: <b>${winRate}%</b>\n` +
    `Net: <b>${totalR >= 0 ? '+' : ''}${totalR}R</b>  ·  ${netPnl >= 0 ? '+' : ''}$${F(netPnl)}\n` +
    `Profit factor: <b>${pf === null ? '∞' : pf}</b>  ·  Max DD: $${F(maxDD)}\n` +
    `Avg win +${result.stats.avgWin}R · avg loss -${result.stats.avgLoss}R\n` +
    `Account: $${F(startEquity)} → <b>$${F(equity)}</b>\n` +
    `<i>Full curve + trades in the Backtest tab.</i>`
  );
})().catch(e => { console.error('backtest error:', e); process.exit(1); });
