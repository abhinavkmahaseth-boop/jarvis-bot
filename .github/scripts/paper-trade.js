#!/usr/bin/env node
// JARVIS paper-trading loop (BTC, scalp). Runs on a schedule:
//   monitor → scan, Claude-verify new setups, ping "setup ready", watch for the
//             entry tap → open a paper trade, manage it (TP1-then-trail), ping on
//             entry and on close. State persists in state.json across runs.
//   review  → post weekly performance stats to Telegram.
//
// Exit model: TP1-then-trail — book 50% at TP1 and move stop to breakeven; trail
// stop to TP1 once TP2 prints; close the runner at TP3 (or the trailed stop).
// Account: $1,000 risking 2% ($20 = 1R) per trade.
const fs = require('fs');
const path = require('path');
const ENGINE = require('../../engine.js');
const { verifyTrade } = require('../../claude.js');

const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT    = process.env.TG_CHAT_ID;
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || '';
const SYM        = 'BTCUSD';
const ALGO_MODE  = 'scalp';
const ACCOUNT    = 1000;
const RISK_PCT   = 0.02;
const R_DOLLAR   = ACCOUNT * RISK_PCT;          // $ value of 1R
const STALE_MS   = 6 * 3600 * 1000;             // cancel un-filled setups after 6h
const COOLDOWN_MS= 2 * 3600 * 1000;             // don't re-enter the same zone for 2h
const ZONE_TOL   = 0.0015;                       // 0.15% = "same zone"
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'state.json');

const F  = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const now = () => Date.now();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { pending: [], open: [], closed: [], startEquity: ACCOUNT }; }
}
function saveState(s) { s.updatedAt = new Date().toISOString(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[tg skipped]', text.replace(/<[^>]+>/g, '')); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
    });
    const j = await r.json();
    if (!j.ok) console.error('Telegram:', j.description);
  } catch (e) { console.error('Telegram error:', e.message); }
}

const equityOf = s => s.startEquity + s.closed.reduce((a, t) => a + (t.pnl || 0), 0);
const winRateOf = s => {
  const n = s.closed.length; if (!n) return 0;
  return Math.round(100 * s.closed.filter(t => t.totalR > 0).length / n);
};
const sameZone = (a, dir, entry) => a.dir === dir && Math.abs(a.entry - entry) / entry < ZONE_TOL;

function isKnown(state, dir, entry) {
  if ([...state.pending, ...state.open].some(t => sameZone(t, dir, entry))) return true;
  const cut = now() - COOLDOWN_MS;
  return state.closed.some(t => t.closedAt > cut && sameZone(t, dir, entry));
}

// ── Trade management: TP1-then-trail state machine ────────────────────────────
// applyBar processes ONE candle against an open trade (shared by the live monitor
// and the backtester); returns the closed trade or null if still open.
function applyBar(t, c) {
  const risk = Math.abs(t.entry - t.sl);
  const rAt = px => t.lng ? (px - t.entry) / risk : (t.entry - px) / risk;
  const hi = c.high, lo = c.low;
  const hitStop = t.lng ? lo <= t.stop : hi >= t.stop;       // stop checked first (pessimistic)
  if (hitStop) {
    t.realizedR += t.remaining * rAt(t.stop);
    t.remaining = 0;
    return finishTrade(t, c, t.stage === 0 ? 'SL' : t.stage === 1 ? 'BE' : 'TP1-trail');
  }
  const hitTP1 = t.lng ? hi >= t.tp1 : lo <= t.tp1;
  const hitTP2 = t.lng ? hi >= t.tp2 : lo <= t.tp2;
  const hitTP3 = t.lng ? hi >= t.tp3 : lo <= t.tp3;
  if (t.stage === 0 && hitTP1) { t.realizedR += 0.5 * t.rr1; t.remaining = 0.5; t.stop = t.entry; t.stage = 1; }
  if (t.stage === 1 && hitTP2) { t.stop = t.tp1; t.stage = 2; }
  if (t.stage >= 1 && hitTP3) {
    t.realizedR += t.remaining * t.rr3; t.remaining = 0;
    return finishTrade(t, c, 'TP3');
  }
  return null;
}
function manageTrade(t, candles) {
  for (const c of candles.filter(c => c.time * 1000 >= t.enteredAt)) {
    const done = applyBar(t, c);
    if (done) return done;
  }
  return null; // still open
}
function finishTrade(t, c, reason) {
  t.exitReason = reason;
  t.totalR = +t.realizedR.toFixed(2);
  t.pnl = +(t.totalR * R_DOLLAR).toFixed(2);
  t.closedAt = c.time * 1000;
  return t;
}

// ── Monitor ───────────────────────────────────────────────────────────────────
async function monitor() {
  const state = loadState();
  const data = await ENGINE.computeAlgo(SYM, { mode: ALGO_MODE });
  const cp = data.cp;
  const c5 = await ENGINE.fetchOHLCV(SYM, '5m', 150);
  console.log(`monitor ${SYM} cp=${cp} · pending=${state.pending.length} open=${state.open.length} closed=${state.closed.length}`);

  // 1) Manage open trades
  for (const t of [...state.open]) {
    const done = manageTrade(t, c5);
    if (done) {
      state.open = state.open.filter(x => x.id !== t.id);
      state.closed.push(done);
      const emoji = done.totalR > 0 ? '✅' : done.totalR < 0 ? '❌' : '➖';
      await tg(
        `🏁 <b>CLOSED — BTC ${done.dir}</b> ${emoji}\n` +
        `Exit: ${done.exitReason}  ·  <b>${done.totalR > 0 ? '+' : ''}${done.totalR}R</b>  ·  ${done.pnl >= 0 ? '+' : ''}$${F(done.pnl)}\n` +
        `Account: <b>$${F(equityOf(state))}</b>  ·  ${state.closed.length} trades · ${winRateOf(state)}% win`
      );
    }
  }

  // 2) Pending → fill or expire
  for (const p of [...state.pending]) {
    const bars = c5.filter(c => c.time * 1000 >= p.createdAt);
    const voided = p.invalidation != null && bars.some(c => p.lng ? c.close < p.invalidation : c.close > p.invalidation);
    const stale = now() - p.createdAt > STALE_MS;
    const tapped = bars.some(c => p.lng ? c.low <= p.entry : c.high >= p.entry);
    if (tapped) {
      state.pending = state.pending.filter(x => x.id !== p.id);
      const t = { ...p, enteredAt: now(), stage: 0, stop: p.sl, realizedR: 0, remaining: 1 };
      state.open.push(t);
      const slPct = (Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(2);
      await tg(
        `🟢 <b>ENTRY — BTC ${p.dir}</b> (paper)\n` +
        `Filled <b>${F(p.entry)}</b>  ·  SL ${F(p.sl)} (${slPct}%)  ·  risk $${F(R_DOLLAR)} (2%)\n` +
        `TP1 ${F(p.tp1)} → book 50%, SL→BE · runner trails to TP3 ${F(p.tp3)}`
      );
    } else if (voided || stale) {
      state.pending = state.pending.filter(x => x.id !== p.id);
      await tg(`🚫 <b>SETUP CANCELLED — BTC ${p.dir}</b>\n${voided ? 'Structure void (CHoCH broken)' : 'Expired (6h, no entry)'} · entry ${F(p.entry)}`);
    }
  }

  // 3) New Claude-verified setups
  for (const s of (data.setups || [])) {
    const dir = s.lng ? 'LONG' : 'SHORT';
    if (isKnown(state, dir, s.entry)) continue;
    const v = await verifyTrade(SYM, s, data, CLAUDE_KEY);
    if (!v) { console.log(`  Claude no-result for ${dir} ${s.entry}`); continue; }
    if (!v.approved) { console.log(`  Claude REJECTED ${dir} ${s.entry}: ${v.reason}`); continue; }
    const p = {
      id: `${now()}-${Math.random().toString(36).slice(2, 7)}`,
      sym: SYM, dir, lng: s.lng, grade: s.fvg.grade, tf: s.fvg.tf,
      zoneLow: s.fvg.gL, zoneHigh: s.fvg.gH, entry: s.entry, sl: s.sl,
      tp1: s.tps[0].p, tp2: s.tps[1].p, tp3: s.tps[2].p,
      rr1: s.tps[0].rr, rr2: s.tps[1].rr, rr3: s.tps[2].rr,
      invalidation: s.invalidation, trigger: s.trigger, claude: v.reason, createdAt: now(),
    };
    state.pending.push(p);
    const slPct = (Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(2);
    await tg(
      `🎯 <b>SETUP READY — BTC ${dir}</b> (Claude ✅)\n` +
      `Grade <b>${p.grade}</b> · ${p.tf} FVG · scalp\n` +
      `📍 Entry <b>${F(p.entry)}</b>  (zone ${F(p.zoneLow)}–${F(p.zoneHigh)})\n` +
      `🛑 SL ${F(p.sl)} (${slPct}%)\n` +
      `🎯 TP1 ${F(p.tp1)} · TP2 ${F(p.tp2)} · TP3 ${F(p.tp3)}\n` +
      (p.invalidation != null ? `🧱 Void if closes ${p.lng ? 'below' : 'above'} ${F(p.invalidation)}\n` : '') +
      `🤖 <i>${p.claude}</i>\n<i>Paper · waiting for entry tap…</i>`
    );
  }

  saveState(state);
  console.log('saved.');
}

// ── Weekly review ───────────────────────────────────────────────────────────────
async function review() {
  const state = loadState();
  const cl = state.closed;
  if (!cl.length) { await tg('📊 <b>WEEKLY PAPER REVIEW — BTC scalp</b>\nNo closed trades yet.'); return; }
  const wins = cl.filter(t => t.totalR > 0), losses = cl.filter(t => t.totalR < 0), be = cl.filter(t => t.totalR === 0);
  const totalR = cl.reduce((a, t) => a + t.totalR, 0);
  const grossWin = wins.reduce((a, t) => a + t.totalR, 0), grossLoss = Math.abs(losses.reduce((a, t) => a + t.totalR, 0));
  const pf = grossLoss ? (grossWin / grossLoss) : (grossWin ? Infinity : 0);
  const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
  const best = Math.max(...cl.map(t => t.totalR)), worst = Math.min(...cl.map(t => t.totalR));
  const equity = equityOf(state);
  const byGrade = ['A', 'B'].map(g => {
    const gt = cl.filter(t => t.grade === g);
    return gt.length ? `  ${g}: ${gt.length} · ${Math.round(100 * gt.filter(t => t.totalR > 0).length / gt.length)}% · ${(gt.reduce((a, t) => a + t.totalR, 0)).toFixed(1)}R` : null;
  }).filter(Boolean).join('\n');
  await tg(
    `📊 <b>WEEKLY PAPER REVIEW — BTC scalp</b>\n` +
    `Trades: <b>${cl.length}</b>  (${wins.length}W / ${losses.length}L / ${be.length}BE)\n` +
    `Win rate: <b>${winRateOf(state)}%</b>\n` +
    `Net: <b>${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R</b>  ·  ${equity - state.startEquity >= 0 ? '+' : ''}$${F(equity - state.startEquity)}\n` +
    `Profit factor: <b>${pf === Infinity ? '∞' : pf.toFixed(2)}</b>\n` +
    `Avg win +${avgWin.toFixed(2)}R · avg loss -${avgLoss.toFixed(2)}R\n` +
    `Best +${best.toFixed(2)}R · worst ${worst.toFixed(2)}R\n` +
    (byGrade ? `By grade:\n${byGrade}\n` : '') +
    `Account: $${F(state.startEquity)} → <b>$${F(equity)}</b>`
  );
}

if (require.main === module) {
  (async () => {
    const task = (process.argv[2] || 'monitor').toLowerCase();
    try {
      if (task === 'review') await review();
      else await monitor();
    } catch (e) { console.error('paper-trade error:', e); process.exit(1); }
  })();
} else {
  module.exports = { manageTrade, applyBar, finishTrade, monitor, review, R_DOLLAR };
}
