#!/usr/bin/env node
// JARVIS Levels Broadcast — focused SMC level map (virgin FVGs · trend-reversal/CHoCH ·
// BSL/SSL liquidity) + a one-line brief, for ONE timeframe, fanned out to Discord/Telegram.
//
//   • 1H  → runs twice a day, ALWAYS sends (levels-1h.yml).
//   • 15M → runs every 4h, sends ONLY when the level map actually changed
//           (hash compared against a state file persisted on the `levels-data` branch).
//
// Reuses the SAME engine as the trader/report (../../engine.js) so the numbers match the
// charts, and the SAME notifier (../../notify.js) so delivery matches every other alert.

const fs     = require('fs');
const crypto = require('crypto');
const E      = require('../../engine.js');
const NOTIFY = require('../../notify.js');

const TF         = (process.env.LEVELS_TF || '1h').toLowerCase();      // '1h' | '15m'
const SYMS       = (process.env.LEVELS_SYMS || 'BTCUSD,SOLUSD,ETHUSD').split(',').map(s => s.trim()).filter(Boolean);
const DISCORD    = process.env.LEVELS_DISCORD_WEBHOOK || process.env.DISCORD_WEBHOOK || '';  // dedicated levels channel falls back to the main one
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT    = process.env.TG_CHAT_ID;
const STATE_FILE = process.env.LEVELS_STATE_FILE || '';               // set ⇒ change-detection ON (15m)
const FORCE      = process.env.LEVELS_FORCE === '1';                  // ignore state, always send
const DRY        = process.env.LEVELS_DRY === '1' || (!DISCORD && !(TG_TOKEN && TG_CHAT));
const CNT        = Number(process.env.LEVELS_CNT || 220);
const LB         = Number(process.env.LEVELS_LB || (TF === '15m' ? 3 : 5));
const MAX_FVG    = 5;                                                  // cap per side (his rule)

const TF_LABEL = ({ '1h': '1H', '15m': '15M', '4h': '4H' })[TF] || TF.toUpperCase();
const F  = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const RI = n => n == null ? 'x' : String(Math.round(Number(n)));       // rounded-int (for hashing)
const now = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// ── Per-TF SMC snapshot via the shared engine ─────────────────────────────────
async function snapshot(sym) {
  const [bars, d4h] = await Promise.all([E.fetchOHLCV(sym, TF, CNT), E.fetchOHLCV(sym, '4h', CNT)]);
  const pv  = E.pivots(bars, LB);
  const b   = E.bias(pv);
  const ch  = E.choch(pv, b);                       // trend-reversal / structure level
  const eq  = E.eqLevel(pv);
  const cp  = bars[bars.length - 1].close;
  const liq = E.liqLevels(pv, cp);
  const b4h = E.bias(E.pivots(d4h, 5));
  // FVGs on this TF (detectFVGs already drops fully-MITIGATED). Keep them, grade, split
  // around price, prefer FRESH (virgin) then nearest, cap MAX_FVG per side.
  const fvgs = E.detectFVGs(bars, TF_LABEL, pv).map(f => ({ ...f, grade: E.grade(f, b, eq) }));
  const rank = (a, c, dist) => (a.status === 'FRESH' ? 0 : 1) - (c.status === 'FRESH' ? 0 : 1) || dist(a) - dist(c);
  const up   = fvgs.filter(f => f.gL > cp).sort((a, c) => rank(a, c, f => f.gL - cp)).slice(0, MAX_FVG);
  const down = fvgs.filter(f => f.gH < cp).sort((a, c) => rank(a, c, f => cp - f.gH)).slice(0, MAX_FVG);
  return { sym, cp, b, b4h, ch, eq, liq, up, down };
}

// ── Deterministic one-line brief (no LLM — free & reproducible) ────────────────
function brief(s) {
  const { b, b4h, ch, liq, up, down } = s;
  const aligned = b === b4h && b !== 'NEUTRAL';
  let t = `${TF_LABEL} <b>${b}</b>` + (b4h !== 'NEUTRAL' ? (aligned ? ` (aligned w/ 4H ${b4h})` : ` vs 4H ${b4h} — counter-trend, caution`) : '') + '. ';
  if (ch != null) t += `Flips ${b === 'BULLISH' ? 'bearish below' : b === 'BEARISH' ? 'bullish above' : 'on a break of'} <b>${F(ch)}</b>. `;
  if (b === 'BULLISH') { t += `Draw → BSL ${F(liq.nearBSL)}. `; if (down[0]) t += `Buy interest ${F(down[0].gL)}–${F(down[0].gH)}.`; }
  else if (b === 'BEARISH') { t += `Draw → SSL ${F(liq.nearSSL)}. `; if (up[0]) t += `Sell interest ${F(up[0].gL)}–${F(up[0].gH)}.`; }
  else { t += `Range ${F(liq.nearSSL)}–${F(liq.nearBSL)}; wait for a break.`; }
  return t;
}

// ── Message (Telegram-HTML; notify.js converts to Discord markdown) ────────────
function fmt(s) {
  const name = s.sym.replace('USD', '');
  const fvgLine = f => `   • <code>${F(f.gL)}–${F(f.gH)}</code>  [${f.status === 'FRESH' ? 'virgin' : 'tapped'}·${f.grade}]${f.swept ? ' swept' : ''}`;
  let m = `📐 <b>JARVIS LEVELS — ${name} · ${TF_LABEL}</b>\n`;
  m += `💰 <b>${F(s.cp)}</b>  ·  ${now()} IST\n\n`;
  m += `🔀 Trend Reversal (CHoCH): <b>${F(s.ch)}</b>\n`;
  m += `💧 BSL: <b>${F(s.liq.nearBSL)}</b> near · ${F(s.liq.majBSL)} major\n`;
  m += `💧 SSL: <b>${F(s.liq.nearSSL)}</b> near · ${F(s.liq.majSSL)} major\n`;
  m += `\n🟥 <b>Upside FVGs</b> (target):\n` + (s.up.length ? s.up.map(fvgLine).join('\n') : '   • —') + '\n';
  m += `🟩 <b>Downside FVGs</b> (support):\n` + (s.down.length ? s.down.map(fvgLine).join('\n') : '   • —') + '\n';
  m += `\n📝 ${brief(s)}`;
  return m;
}

// ── Change signature: round everything so noise doesn't retrigger ─────────────
function sig(s) {
  const fv = arr => arr.map(f => `${f.type}${RI(f.gL)}-${RI(f.gH)}${f.status[0]}`).join(',');
  const payload = [s.b, RI(s.ch), RI(s.liq.nearBSL), RI(s.liq.majBSL), RI(s.liq.nearSSL), RI(s.liq.majSSL), fv(s.up), fv(s.down)].join('|');
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = st => { if (STATE_FILE) fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); };

async function send(text) {
  if (DRY) { console.log('\n--- DRY (no channel) ---\n' + NOTIFY.plain(text) + '\n'); return ['dry']; }
  return NOTIFY.notify(text, { discord: DISCORD, tgToken: TG_TOKEN, tgChat: TG_CHAT });
}

async function main() {
  console.log(`JARVIS levels — ${TF_LABEL} — ${SYMS.join(', ')} — ${now()} IST${STATE_FILE ? ' — change-detect ON' : ''}${DRY ? ' — DRY' : ''}`);
  const st = STATE_FILE ? loadState() : {};
  let sent = 0, skipped = 0;

  for (const sym of SYMS) {
    try {
      const snap = await snapshot(sym);
      if (STATE_FILE && !FORCE) {
        const h = sig(snap);
        if (st[sym] === h) { console.log(`  ${sym}: unchanged — skip`); skipped++; continue; }
        st[sym] = h;
      }
      await send(fmt(snap));
      console.log(`  ${sym}: sent`);
      sent++;
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error(`  ${sym} failed:`, e.message);
      if (!DRY) await send(`⚠️ <b>${sym.replace('USD', '')} ${TF_LABEL}</b> levels — error: ${e.message}`).catch(() => {});
    }
  }

  saveState(st);
  console.log(`Done — sent ${sent}, skipped ${skipped}.`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
else module.exports = { snapshot, fmt, brief, sig };
