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
const NOTIFY = require('../../notify.js');
const DELTA  = require('./delta.js');

const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT    = process.env.TG_CHAT_ID;
const DISCORD    = process.env.DISCORD_WEBHOOK || '';
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || '';
// ── Live execution (Delta India) — DORMANT unless explicitly armed ────────────
// Two independent gates: (1) trade KEYS must be present (GitHub Secrets, server-side)
// and (2) the portal's on/off switch in live-config.json must say armed:true. Absent
// either, LIVE_ARMED is false and not a single real order is sent. Only the algo book
// trades live. Quantity is the user's `lots` from the portal, clamped to delta's cap.
const DELTA_KEY    = process.env.DELTA_API_KEY || '';
const DELTA_SECRET = process.env.DELTA_API_SECRET || '';
const LIVE_CONFIG_FILE = process.env.LIVE_CONFIG_FILE || path.join(process.cwd(), 'live-config.json');
function loadLiveConfig() {
  try { return JSON.parse(fs.readFileSync(LIVE_CONFIG_FILE, 'utf8')); }
  catch { return { armed: false, lots: 1 }; }
}
const LIVE_CFG   = loadLiveConfig();
const LIVE_KEYS  = !!DELTA_KEY && !!DELTA_SECRET;
const LIVE_ARMED = LIVE_CFG.armed === true && LIVE_KEYS;
const LIVE_LOTS  = Math.min(Math.max(1, Math.round(Number(LIVE_CFG.lots) || 1)), DELTA.MAX_LOTS);
const SYM        = 'BTCUSD';
const ALGO_MODE  = 'scalp';
const ACCOUNT    = 1000;
const RISK_PCT   = 0.02;
const R_DOLLAR   = ACCOUNT * RISK_PCT;          // $ value of 1R
const STALE_MS   = 6 * 3600 * 1000;             // cancel un-filled setups after 6h
const COOLDOWN_MS= 2 * 3600 * 1000;             // don't re-enter the same zone for 2h
const ZONE_TOL   = 0.0015;                       // 0.15% = "same zone"
// Only act on candles that have been CLOSED for at least this many extra bars. The
// most-recently-closed bar can still carry a bad tick/wick that the exchange cleans
// up within a minute or two; holding it back one bar means fills and exits are only
// booked off SETTLED price data — so the books reflect what really happened, never a
// transient bad print. (Combined with replay-from-entry below.)
const SETTLE_BARS= 1;
const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), 'state.json');
// Second, independent book: same engine + exit model, but NO Claude gate and
// Grade-A only — the live forward-test of the 60-day backtest. Separate state file.
const ALGO_STATE_FILE = process.env.ALGO_STATE_FILE || STATE_FILE.replace(/state\.json$/, 'state-algo.json');

// Two books run off the SAME 5-min scan / same candles:
//   claude → Claude-gated, grades A+B, full Telegram flow (actionable alerts)
//   algo   → no Claude, Grade-A only, close-only Telegram (passive forward-test)
const BOOKS = {
  claude: { file: STATE_FILE,      label: 'CLAUDE', claude: true,  grade: null, tag: '',         pings: 'full',      live: false },
  algo:   { file: ALGO_STATE_FILE, label: 'AUTO',   claude: false, grade: 'A',  tag: ' 🤖 AUTO', pings: 'closeonly', live: true  },
};

const F  = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const now = () => Date.now();
// Delta-style position size line: whole contracts + the BTC size + notional it implies.
function qtyInfo(t) {
  const qty = t.qty ?? ENGINE.contractQty(t.sym || SYM, t.entry, t.sl, R_DOLLAR);
  const spec = ENGINE.contractSpec(t.sym || SYM);
  const size = qty * spec.value, notional = size * t.entry;
  return `📦 Qty <b>${qty}</b> contracts  (${size.toFixed(3)} ${spec.unit} · $${F(notional)} notional · ${(notional / ACCOUNT).toFixed(1)}x)`;
}

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { pending: [], open: [], closed: [], startEquity: ACCOUNT }; }
}
function saveState(s, file) { s.updatedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(s, null, 2)); }

// Fan out an alert to every configured channel (Discord and/or Telegram).
async function tg(text) {
  const sent = await NOTIFY.notify(text, { discord: DISCORD, tgToken: TG_TOKEN, tgChat: TG_CHAT });
  if (!sent.length) console.log('[notify skipped — no channel]', NOTIFY.plain(text));
}

// ── Live execution helpers (algo book, armed only) ────────────────────────────
function liveRec(state, ev, extra) {
  state.live = state.live || {};
  state.live.log = [...(state.live.log || []), { t: Date.now(), ev, ...extra }].slice(-30);
}
// Place a real LIVE_LOTS limit + bracket(SL,TP1) order mirroring a fresh algo setup.
async function livePlace(state, p) {
  if (!LIVE_ARMED) return;
  try {
    const pos = await DELTA.getPosition({ key: DELTA_KEY, secret: DELTA_SECRET });
    if (pos.size !== 0) { liveRec(state, 'SKIP', { why: 'Delta already has a position', size: pos.size }); return; }
    const side = p.lng ? 'buy' : 'sell';
    const o = await DELTA.placeBracketLimit({ key: DELTA_KEY, secret: DELTA_SECRET,
      side, lots: LIVE_LOTS, limitPrice: p.entry, stopPrice: p.sl, takeProfitPrice: p.tp1 });
    p.liveOrderId = o.id;
    liveRec(state, 'PLACED', { id: o.id, dir: p.dir, lots: LIVE_LOTS, entry: p.entry, sl: p.sl, tp: p.tp1 });
    await tg(`💸 <b>LIVE ORDER PLACED — BTC ${p.dir}</b> (Delta · ${LIVE_LOTS} lot${LIVE_LOTS > 1 ? 's' : ''})\nLimit ${F(p.entry)} · SL ${F(p.sl)} · TP ${F(p.tp1)} · bracket on exchange`);
  } catch (e) {
    liveRec(state, 'ERROR', { why: e.message });
    await tg(`⚠️ <b>LIVE place FAILED — BTC ${p.dir}</b>\n${e.message}`);
  }
}
// Cancel a still-resting live order when its setup voids before filling.
async function liveCancel(state, p) {
  if (!LIVE_ARMED || !p.liveOrderId) return;
  try { await DELTA.cancelOrder({ key: DELTA_KEY, secret: DELTA_SECRET, orderId: p.liveOrderId });
        liveRec(state, 'CANCELLED', { id: p.liveOrderId, dir: p.dir }); }
  catch (e) { liveRec(state, 'ERROR', { why: 'cancel: ' + e.message }); }
}
// Safety net: after the paper book closes, make sure Delta is actually flat.
async function liveEnsureFlat(state) {
  if (!LIVE_ARMED) return;
  try {
    const pos = await DELTA.getPosition({ key: DELTA_KEY, secret: DELTA_SECRET });
    if (pos.size !== 0) {
      await DELTA.closePosition({ key: DELTA_KEY, secret: DELTA_SECRET, size: pos.size, side: pos.size > 0 ? 'sell' : 'buy' });
      liveRec(state, 'FORCE-FLAT', { size: pos.size });
      await tg(`🧯 <b>LIVE safety close</b> — flattened a lingering ${pos.size > 0 ? 'long' : 'short'} (${Math.abs(pos.size)} lot)`);
    }
  } catch (e) { liveRec(state, 'ERROR', { why: 'flat: ' + e.message }); }
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

// ── One-trade-per-symbol guard (no double entries) ────────────────────────────
const symOpen   = (state, sym) => state.open.some(t => t.sym === sym);
const symActive = (state, sym) => symOpen(state, sym) || state.pending.some(t => t.sym === sym);
// Collapse a book to the invariant: drop any pending whose symbol already has an
// open position, and keep at most ONE pending per symbol (earliest). Idempotent —
// also absorbs any legacy multi-pending state left by older runs.
function enforceSinglePosition(state) {
  state.pending = state.pending.filter(p => !symOpen(state, p.sym));
  const seen = new Set();
  state.pending = [...state.pending]
    .sort((a, b) => a.createdAt - b.createdAt)
    .filter(p => (seen.has(p.sym) ? false : seen.add(p.sym)));
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
    return finishTrade(t, c, t.stage === 0 ? 'SL' : t.stage === 1 ? 'BE' : 'TP1-trail', t.stop);
  }
  const hitTP1 = t.lng ? hi >= t.tp1 : lo <= t.tp1;
  const hitTP2 = t.lng ? hi >= t.tp2 : lo <= t.tp2;
  const hitTP3 = t.lng ? hi >= t.tp3 : lo <= t.tp3;
  if (t.stage === 0 && hitTP1) { t.realizedR += 0.5 * t.rr1; t.remaining = 0.5; t.stop = t.entry; t.stage = 1; }
  if (t.stage === 1 && hitTP2) { t.stop = t.tp1; t.stage = 2; }
  if (t.stage >= 1 && hitTP3) {
    t.realizedR += t.remaining * t.rr3; t.remaining = 0;
    return finishTrade(t, c, 'TP3', t.tp3);
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
// Re-derive a trade's outcome from the ENTRY, on every run, using a FRESH simulation
// over the given (settled) candles. Because the whole life is replayed from scratch
// against the latest clean data, a bad print that briefly appeared in an earlier run
// simply never gets baked in — the recorded state always matches real price action.
// Returns { done, live }: done = the closed trade (settled) or null; live = the
// current in-progress state (stage/stop/realized/remaining) to persist for display.
function replayTrade(t, candles) {
  const risk = Math.abs(t.entry - t.sl) || t.entry * 0.001;
  const rrOf = p => t.lng ? (p - t.entry) / risk : (t.entry - p) / risk;
  const sim = {
    ...t,
    stop: t.sl, stage: 0, realizedR: 0, remaining: 1,            // reset to the moment of entry
    rr1: t.rr1 ?? rrOf(t.tp1), rr2: t.rr2 ?? rrOf(t.tp2), rr3: t.rr3 ?? rrOf(t.tp3),
    exitReason: undefined, exitPrice: undefined, totalR: undefined, pnl: undefined, closedAt: undefined,
  };
  let done = null;
  for (const c of candles.filter(c => c.time * 1000 >= t.enteredAt)) {
    done = applyBar(sim, c);
    if (done) break;
  }
  return { done, live: sim };
}
function finishTrade(t, c, reason, exitPrice) {
  t.exitReason = reason;
  t.exitPrice = exitPrice != null ? +(+exitPrice).toFixed(2) : null;
  t.totalR = +t.realizedR.toFixed(2);
  t.pnl = +(t.totalR * R_DOLLAR).toFixed(2);
  t.closedAt = c.time * 1000;
  return t;
}

// ── Per-book scan ─────────────────────────────────────────────────────────────
// One book = one independent state file. cfg decides the Claude gate, grade
// filter and how chatty Telegram is. Both books run off the SAME data/candles.
async function runBook(cfg, data, c5) {
  const state = loadState(cfg.file);
  enforceSinglePosition(state);   // absorb any legacy double-pending before processing
  // Live-execution status surface (algo book) — lets the portal show armed/disarmed.
  if (cfg.live) state.live = { ...(state.live || {}), armed: LIVE_ARMED, switchOn: LIVE_CFG.armed === true,
    lots: LIVE_LOTS, maxLots: DELTA.MAX_LOTS, mode: 'arm-and-auto', keysSet: LIVE_KEYS,
    updatedAt: new Date().toISOString() };
  // Settled candles only — drop the most-recently-closed bar so a bad print has a
  // bar to be corrected before we fill or exit off it. Everything below uses these.
  const settled = SETTLE_BARS > 0 ? c5.slice(0, -SETTLE_BARS) : c5;
  console.log(`[${cfg.label}] cp=${data.cp} · pending=${state.pending.length} open=${state.open.length} closed=${state.closed.length}${cfg.live && LIVE_ARMED ? ' · 🔴 LIVE ARMED' : ''}`);

  // 1) Manage open trades by REPLAYING each from entry on settled candles. The trade
  //    only closes when that close is confirmed by settled data; otherwise we just
  //    refresh its in-progress state. CLOSED pings on both books.
  for (const t of [...state.open]) {
    const { done, live } = replayTrade(t, settled);
    if (done) {
      state.open = state.open.filter(x => x.id !== t.id);
      state.closed.push(done);
      const emoji = done.totalR > 0 ? '✅' : done.totalR < 0 ? '❌' : '➖';
      await tg(
        `🏁 <b>CLOSED — BTC ${done.dir}</b>${cfg.tag} ${emoji}\n` +
        `Exit: ${done.exitReason} @ ${F(done.exitPrice)}  ·  <b>${done.totalR > 0 ? '+' : ''}${done.totalR}R</b>  ·  ${done.pnl >= 0 ? '+' : ''}$${F(done.pnl)}\n` +
        `Account: <b>$${F(equityOf(state))}</b>  ·  ${state.closed.length} trades · ${winRateOf(state)}% win`
      );
    } else {
      // still open — persist the freshly re-derived state for the dashboard / live P&L
      t.stage = live.stage; t.stop = live.stop; t.realizedR = live.realizedR; t.remaining = live.remaining;
    }
  }

  // 2) Pending → fill or expire (on SETTLED candles, so a bad wick can't phantom-fill)
  for (const p of [...state.pending]) {
    const bars = settled.filter(c => c.time * 1000 >= p.createdAt);
    const voided = p.invalidation != null && bars.some(c => p.lng ? c.close < p.invalidation : c.close > p.invalidation);
    const stale = now() - p.createdAt > STALE_MS;
    const tapBar = bars.find(c => p.lng ? c.low <= p.entry : c.high >= p.entry);
    if (tapBar) {
      state.pending = state.pending.filter(x => x.id !== p.id);
      // One trade per symbol: if a position for this symbol is already open (incl. one
      // just filled earlier in this same pass), skip — never stack a second entry.
      if (symOpen(state, p.sym)) {
        console.log(`  [${cfg.label}] skip fill ${p.dir} ${p.entry} — ${p.sym} already open`);
        if (cfg.pings === 'full')
          await tg(`🚫 <b>SETUP SKIPPED — BTC ${p.dir}</b>\nAlready in an open ${p.sym.replace('USD', '')} position · missed entry ${F(p.entry)}`);
        continue;
      }
      // Deterministic entry time = close of the bar that tapped, so management (and any
      // later replay/audit) reproduces the exact same candles every time.
      const enteredAt = (tapBar.time + ENGINE.TF_SEC['5m']) * 1000;
      state.open.push({ ...p, enteredAt, stage: 0, stop: p.sl, realizedR: 0, remaining: 1 });
      if (cfg.pings === 'full') {
        const slPct = (Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(2);
        await tg(
          `🟢 <b>ENTRY — BTC ${p.dir}</b> (paper)\n` +
          `Filled <b>${F(p.entry)}</b>  ·  SL ${F(p.sl)} (${slPct}%)  ·  risk $${F(R_DOLLAR)} (2%)\n` +
          `${qtyInfo(p)}\n` +
          `TP1 ${F(p.tp1)} → book 50%, SL→BE · runner trails to TP3 ${F(p.tp3)}`
        );
      }
    } else if (voided || stale) {
      state.pending = state.pending.filter(x => x.id !== p.id);
      if (cfg.live) await liveCancel(state, p);   // pull the resting Delta order if it hasn't filled
      if (cfg.pings === 'full')
        await tg(`🚫 <b>SETUP CANCELLED — BTC ${p.dir}</b>\n${voided ? 'Structure void (CHoCH broken)' : 'Expired (6h, no entry)'} · entry ${F(p.entry)}`);
    }
  }

  // 3) New setups — grade-filtered, optionally Claude-gated
  for (const s of (data.setups || [])) {
    if (cfg.grade && s.fvg.grade !== cfg.grade) continue;
    // One trade per symbol per book: if already open or pending for this symbol,
    // don't queue another. (Setups are all SYM, so once active we can stop.)
    if (symActive(state, SYM)) break;
    const dir = s.lng ? 'LONG' : 'SHORT';
    if (isKnown(state, dir, s.entry)) continue;
    let note = 'auto · no Claude';
    if (cfg.claude) {
      const v = await verifyTrade(SYM, s, data, CLAUDE_KEY);
      if (!v) { console.log(`  [${cfg.label}] Claude no-result ${dir} ${s.entry}`); continue; }
      if (!v.approved) { console.log(`  [${cfg.label}] Claude REJECTED ${dir} ${s.entry}: ${v.reason}`); continue; }
      note = v.reason;
    }
    // Snap all levels to Delta's valid tick and recompute R from the rounded levels,
    // so the trade is exactly what you'd place on Delta. Quantity = whole contracts.
    const tk = px => ENGINE.roundTick(SYM, px);
    const entry = tk(s.entry), sl = tk(s.sl), tp1 = tk(s.tps[0].p), tp2 = tk(s.tps[1].p), tp3 = tk(s.tps[2].p);
    const riskR = Math.abs(entry - sl) || entry * 0.001;
    const rrAt = px => +((s.lng ? px - entry : entry - px) / riskR).toFixed(2);
    const p = {
      id: `${now()}-${Math.random().toString(36).slice(2, 7)}`,
      sym: SYM, dir, lng: s.lng, grade: s.fvg.grade, tf: s.fvg.tf,
      zoneLow: tk(s.fvg.gL), zoneHigh: tk(s.fvg.gH), entry, sl,
      tp1, tp2, tp3, rr1: rrAt(tp1), rr2: rrAt(tp2), rr3: rrAt(tp3),
      qty: ENGINE.contractQty(SYM, entry, sl, R_DOLLAR),     // Delta contracts for 1R ($20)
      invalidation: s.invalidation != null ? tk(s.invalidation) : s.invalidation,
      trigger: s.trigger, claude: note, createdAt: now(),
    };
    state.pending.push(p);
    // LIVE: rest a real 1-lot limit + bracket at this entry on Delta (algo book, armed).
    // Delta fills it in real time at the intended price and manages the SL/TP bracket.
    if (cfg.live) await livePlace(state, p);
    if (cfg.pings === 'full') {
      const slPct = (Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(2);
      await tg(
        `🎯 <b>SETUP READY — BTC ${dir}</b> (Claude ✅)\n` +
        `Grade <b>${p.grade}</b> · ${p.tf} FVG · scalp\n` +
        `📍 Entry <b>${F(p.entry)}</b>  (zone ${F(p.zoneLow)}–${F(p.zoneHigh)})\n` +
        `🛑 SL ${F(p.sl)} (${slPct}%)\n` +
        `🎯 TP1 ${F(p.tp1)} · TP2 ${F(p.tp2)} · TP3 ${F(p.tp3)}\n` +
        `${qtyInfo(p)}\n` +
        (p.invalidation != null ? `🧱 Void if closes ${p.lng ? 'below' : 'above'} ${F(p.invalidation)}\n` : '') +
        `🤖 <i>${p.claude}</i>\n<i>Paper · waiting for entry tap…</i>`
      );
    }
  }

  // LIVE safety net: if the algo book expects NOTHING active, Delta must be flat with
  // no resting orders. This is the backstop that guarantees no surprise live position.
  if (cfg.live && LIVE_ARMED && !state.open.length && !state.pending.length) await liveEnsureFlat(state);

  saveState(state, cfg.file);
  console.log(`[${cfg.label}] saved → ${path.basename(cfg.file)}`);
}

// ── Monitor: one scan, both books ─────────────────────────────────────────────
async function monitor() {
  // Fetch each timeframe ONCE, analyze once, then run both books on the SAME data
  // (one set of API calls drives both the Claude-gated and the algo-only book).
  const [d1h, d15m, d5m] = await Promise.all([
    ENGINE.fetchOHLCV(SYM, '1h', 150),
    ENGINE.fetchOHLCV(SYM, '15m', 150),
    ENGINE.fetchOHLCV(SYM, '5m', 150),
  ]);
  const data = ENGINE.analyze(SYM, { d1h, d15m, d5m }, { lb: 5, mode: ALGO_MODE });
  await runBook(BOOKS.claude, data, d5m);
  await runBook(BOOKS.algo, data, d5m);
}

// ── Weekly review (per book) ──────────────────────────────────────────────────
async function reviewBook(cfg) {
  const state = loadState(cfg.file);
  const cl = state.closed;
  const title = `📊 <b>WEEKLY REVIEW — BTC scalp${cfg.tag}</b>`;
  if (!cl.length) { await tg(`${title}\nNo closed trades yet.`); return; }
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
    `${title}\n` +
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
async function review() { await reviewBook(BOOKS.claude); await reviewBook(BOOKS.algo); }

if (require.main === module) {
  (async () => {
    const task = (process.argv[2] || 'monitor').toLowerCase();
    try {
      if (task === 'review') await review();
      else await monitor();
    } catch (e) { console.error('paper-trade error:', e); process.exit(1); }
  })();
} else {
  module.exports = { manageTrade, applyBar, replayTrade, finishTrade, monitor, review, runBook, reviewBook,
                     enforceSinglePosition, symOpen, symActive, isKnown, R_DOLLAR };
}
