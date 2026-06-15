#!/usr/bin/env node
// JARVIS Scheduled Algo Report — runs on GitHub Actions

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = process.env.TG_CHAT_ID;
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || '';
const MODE     = process.env.REPORT_MODE || 'swing';
const SYMS     = (process.env.REPORT_SYMS || 'BTCUSD,SOLUSD,ETHUSD').split(',');
const CNT      = 150;
const LB       = 5;

// SMC engine — single source of truth shared with the browser (../../engine.js).
const ENGINE = require('../../engine.js');
const { trigLabel } = ENGINE;
const computeAlgo = (sym) => ENGINE.computeAlgo(sym, { cnt: CNT, lb: LB, mode: MODE });
// Claude verifier — shared with the paper-trader (../../claude.js).
const { verifyTrade } = require('../../claude.js');

// ── Format ────────────────────────────────────────────────────────────────────
const F  = n => n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const RR = n => `1:${Number(n).toFixed(2)}`;

function formatTelegram(data, verifiedSetups) {
  const { sym, cp, b4h, b1h, b15m, eq4h, eq1h, ch4h, ch1h, liq, ts } = data;
  const isScalp = data.mode === 'scalp';
  const modeTag = isScalp ? '⚡ SCALP' : '📈 SWING';
  const tf1 = isScalp ? '1H' : '4H', tf2 = isScalp ? '15M' : '1H', tf3 = isScalp ? '5M' : '15M';
  const eq  = isScalp ? eq1h : eq4h;
  const ch  = isScalp ? ch1h : ch4h;
  const name = sym.replace('USD', '');
  const usingClaude = !!CLAUDE_KEY;

  let msg = `📊 <b>JARVIS — ${name}</b>  [${modeTag}]\n`;
  msg += `💰 Price: <b>${F(cp)}</b>  ·  ${ts}\n\n`;
  msg += `<b>${tf1}:</b> ${b4h}  ·  <b>${tf2}:</b> ${b1h}  ·  <b>${tf3}:</b> ${b15m}\n`;
  msg += `EQ: ${F(eq)}  ·  CHoCH: ${F(ch)}\n`;
  msg += `BSL: <b>${F(liq.majBSL)}</b>  ·  SSL: <b>${F(liq.majSSL)}</b>  ·  Psych: ${F(liq.psych)}\n`;

  if (!verifiedSetups.length) {
    msg += usingClaude
      ? `\n❌ <b>NO TRADE</b> — No setups passed Claude verification`
      : `\n❌ <b>NO SETUP</b> — No valid trade near current price`;
  } else {
    msg += `\n✅ <b>${verifiedSetups.length} ${usingClaude ? 'Verified ' : ''}Setup${verifiedSetups.length > 1 ? 's' : ''}</b>\n`;
    verifiedSetups.forEach((item, i) => {
      const { setup, verification } = item;
      const { fvg, entry, sl, tps, lng } = setup;
      const slPct = (Math.abs(entry - sl) / entry * 100).toFixed(2);
      msg += `\n━━━━━━━━━━━━━━━━\n`;
      msg += `${lng ? '🟢 LONG' : '🔴 SHORT'} Setup ${i+1} · Grade <b>${fvg.grade}</b> · ${fvg.tf} FVG${fvg.swept ? ' ✓ Swept' : ''}\n`;
      msg += `📍 Entry zone: <b>${F(fvg.gL)} – ${F(fvg.gH)}</b>\n`;
      msg += `🛑 SL: <b>${F(sl)}</b>  (${slPct}%)\n`;
      msg += `🎯 TP1: ${F(tps[0].p)}  ${RR(tps[0].rr)}\n`;
      msg += `🎯 TP2: ${F(tps[1].p)}  ${RR(tps[1].rr)}\n`;
      msg += `🎯 TP3: ${F(tps[2].p)}  ${RR(tps[2].rr)}\n`;
      if (setup.trigger) msg += `${trigLabel(setup.trigger)}\n`;
      if (setup.invalidation != null) msg += `🧱 Void if price closes ${lng ? 'below' : 'above'} ${F(setup.invalidation)} (CHoCH)\n`;
      if (verification?.reason) msg += `✅ <i>${verification.reason}</i>\n`;
    });
  }
  return msg;
}

// Returns [{setup, verification}] — approved-only when a Claude key is set
// (fails closed on errors), otherwise all setups with verification:null.
async function verifySetups(sym, data) {
  if (!CLAUDE_KEY || !data.setups?.length) {
    return (data.setups || []).map(setup => ({ setup, verification: null }));
  }
  const out = [];
  for (const setup of data.setups) {
    const v = await verifyTrade(sym, setup, data, CLAUDE_KEY);
    if (v?.approved) out.push({ setup, verification: v });
    await new Promise(r => setTimeout(r, 400));
  }
  return out;
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function sendTg(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram: ${j.description}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!TG_TOKEN || !TG_CHAT) {
    console.error('Missing TG_TOKEN or TG_CHAT_ID');
    process.exit(1);
  }

  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: true,
    weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });

  console.log(`JARVIS report — ${MODE} — ${SYMS.join(', ')} — ${now} IST`);

  const claudeTag = CLAUDE_KEY ? ' · 🤖 Claude-verified' : '';
  await sendTg(`🤖 <b>JARVIS Scheduled Report</b>\n📅 ${now} IST\nMode: ${MODE.toUpperCase()} (${SYMS.map(s => s.replace('USD','')).join(' · ')})${claudeTag}`);

  for (const sym of SYMS) {
    try {
      console.log(`  ${sym}...`);
      const data = await computeAlgo(sym);
      const verifiedSetups = await verifySetups(sym, data);
      await sendTg(formatTelegram(data, verifiedSetups));
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error(`  ${sym} failed:`, e.message);
      await sendTg(`⚠️ <b>${sym.replace('USD','')}</b> — error: ${e.message}`).catch(() => {});
    }
  }

  console.log('Done.');
}

// Only auto-run when invoked directly (node report.js). When required (e.g. by the
// CI smoke test) just expose the functions so they can be exercised without sending.
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
} else {
  module.exports = { computeAlgo, verifySetups, formatTelegram, verifyTrade };
}
