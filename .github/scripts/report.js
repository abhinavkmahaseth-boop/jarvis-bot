#!/usr/bin/env node
// JARVIS Scheduled Algo Report — runs on GitHub Actions

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = process.env.TG_CHAT_ID;
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || '';
const MODE     = process.env.REPORT_MODE || 'swing';
const SYMS     = (process.env.REPORT_SYMS || 'BTCUSD,SOLUSD,ETHUSD').split(',');
const CNT      = 150;
const LB       = 5;

const TF_SEC = { '4h': 14400, '1h': 3600, '15m': 900, '5m': 300 };

// ── Data fetch ────────────────────────────────────────────────────────────────
async function fetchOHLCV(sym, res, count) {
  const sec   = TF_SEC[res];
  const now   = Math.floor(Date.now() / 1000);
  const start = now - Math.floor(count * sec * 1.4);
  const url   = `https://api.india.delta.exchange/v2/history/candles?symbol=${sym}&resolution=${res}&start=${start}&end=${now}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.success || !j.result?.length) throw new Error(`No data: ${sym} ${res}`);
  const bars = j.result.sort((a, b) => a.time - b.time);
  // Drop the still-forming candle so structure/FVG detection never repaints on an open bar.
  const last = bars[bars.length - 1];
  if (last && (last.time + sec) > now) bars.pop();
  return bars;
}

// ── SMC Engine ────────────────────────────────────────────────────────────────
function pivots(c, lb) {
  const h = [], l = [];
  for (let i = lb; i < c.length - lb; i++) {
    let iH = true, iL = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) iH = false;
      if (c[j].low  <= c[i].low)  iL = false;
    }
    if (iH) h.push({ i, p: c[i].high });
    if (iL) l.push({ i, p: c[i].low  });
  }
  return { h, l };
}

function bias(pv) {
  // Direction of the most recent break of structure over the chronologically
  // merged swing sequence (higher-high = bullish BOS, lower-low = bearish BOS).
  // Keep IN SYNC with bias() in index.html.
  const seq = [...pv.h.map(x => ({ i: x.i, p: x.p, t: 'H' })),
               ...pv.l.map(x => ({ i: x.i, p: x.p, t: 'L' }))]
              .sort((a, b) => a.i - b.i);
  let lastBull = -1, lastBear = -1, prevH = null, prevL = null;
  seq.forEach((s, k) => {
    if (s.t === 'H') { if (prevH != null && s.p > prevH) lastBull = k; prevH = s.p; }
    else             { if (prevL != null && s.p < prevL) lastBear = k; prevL = s.p; }
  });
  if (lastBull < 0 && lastBear < 0) return 'NEUTRAL';
  return lastBull > lastBear ? 'BULLISH' : 'BEARISH';
}

function eqLevel(pv) {
  const { h, l } = pv;
  if (!h.length || !l.length) return null;
  return (Math.max(...h.slice(-3).map(x => x.p)) + Math.min(...l.slice(-3).map(x => x.p))) / 2;
}

function choch(pv, b) {
  if (b === 'BEARISH') return pv.h.length ? pv.h[pv.h.length-1].p : null;
  if (b === 'BULLISH') return pv.l.length ? pv.l[pv.l.length-1].p : null;
  return null;
}

function avgBody(c, idx, lb = 5) {
  let s = 0, n = 0;
  for (let i = Math.max(0, idx - lb); i < idx; i++) { s += Math.abs(c[i].close - c[i].open); n++; }
  return n ? s / n : 0;
}

function fvgStat(c, fi, type, gH, gL, ce) {
  // Classify by deepest penetration across ALL later candles (not just the first
  // touch), so a gap tapped then fully mitigated later reads as MITIGATED.
  let touched = false;
  for (let i = fi + 1; i < c.length; i++) {
    if (type === 'bull') {
      if (c[i].low  <= gH) { touched = true; if (c[i].low  <= ce) return 'MITIGATED'; }
    } else {
      if (c[i].high >= gL) { touched = true; if (c[i].high >= ce) return 'MITIGATED'; }
    }
  }
  return touched ? 'TAPPED' : 'FRESH';
}

function hasSweep(c, fi, type, pv) {
  const s = Math.max(0, fi - 6);
  if (type === 'bull') {
    const nl = pv.l.filter(x => x.i < fi - 2 && x.i >= s - 5);
    return nl.length && c.slice(s, fi - 2).some(x => x.low < nl[nl.length-1].p);
  } else {
    const nh = pv.h.filter(x => x.i < fi - 2 && x.i >= s - 5);
    return nh.length && c.slice(s, fi - 2).some(x => x.high > nh[nh.length-1].p);
  }
}

function detectFVGs(c, tfLbl, pv) {
  const out = [], ref = c[c.length-1].close, MIN = 0.0003;
  for (let i = 2; i < c.length; i++) {
    const [c1, c2, c3] = [c[i-2], c[i-1], c[i]];
    const b2 = Math.abs(c2.close - c2.open), ab = avgBody(c, i-1, 5);
    if (!(ab > 0 && b2 >= ab)) continue;
    if (c1.high < c3.low) {
      const [gH, gL] = [c3.low, c1.high], ce = (gH + gL) / 2;
      if ((gH - gL) / ref >= MIN) {
        const st = fvgStat(c, i, 'bull', gH, gL, ce);
        if (st !== 'MITIGATED') out.push({ type:'bull', tf:tfLbl, gH, gL, ce, status:st, swept:hasSweep(c,i,'bull',pv), dr:b2/(ab||1), fi:i });
      }
    }
    if (c1.low > c3.high) {
      const [gH, gL] = [c1.low, c3.high], ce = (gH + gL) / 2;
      if ((gH - gL) / ref >= MIN) {
        const st = fvgStat(c, i, 'bear', gH, gL, ce);
        if (st !== 'MITIGATED') out.push({ type:'bear', tf:tfLbl, gH, gL, ce, status:st, swept:hasSweep(c,i,'bear',pv), dr:b2/(ab||1), fi:i });
      }
    }
  }
  return out;
}

function grade(fvg, b, eqv) {
  if (b === 'NEUTRAL') return 'C';
  if (b === 'BULLISH' && fvg.type === 'bear') return 'C';
  if (b === 'BEARISH' && fvg.type === 'bull') return 'C';
  let sc = 0;
  if (fvg.status === 'FRESH') sc++;
  if (fvg.swept) sc++;
  if (eqv != null) {
    if (fvg.type === 'bear' && fvg.ce > eqv) sc++;
    if (fvg.type === 'bull' && fvg.ce < eqv) sc++;
  }
  if (fvg.dr >= 1.5) sc++;
  return sc >= 3 ? 'A' : 'B';
}

function liqLevels(pv, cp) {
  const { h, l } = pv;
  const majBSL  = h.length ? Math.max(...h.map(x => x.p)) : null;
  const majSSL  = l.length ? Math.min(...l.map(x => x.p)) : null;
  const nearBSL = h.filter(x => x.p > cp).sort((a, b) => a.p - b.p)[0]?.p || majBSL;
  const nearSSL = l.filter(x => x.p < cp).sort((a, b) => b.p - a.p)[0]?.p || majSSL;
  const mag  = Math.pow(10, Math.floor(Math.log10(cp)));
  const step = cp > 10000 ? mag : mag / 2;
  return { majBSL, majSSL, nearBSL, nearSSL, psych: Math.round(cp / step) * step };
}

function calcSL(fvg, pv, cp) {
  const buf = cp * 0.0012;
  if (fvg.type === 'bull') {
    const nl = pv.l.filter(x => x.p < fvg.gL);
    return Math.min(fvg.gL, nl.length ? Math.max(...nl.map(x => x.p)) : fvg.gL) - buf;
  } else {
    const nh = pv.h.filter(x => x.p > fvg.gH);
    return Math.max(fvg.gH, nh.length ? Math.min(...nh.map(x => x.p)) : fvg.gH) + buf;
  }
}

// Strictly-ordered, de-duplicated 3-rung TP ladder measured from entry.
// Keep IN SYNC with orderTPs() in index.html.
function orderTPs(entry, sl, lng, candidates) {
  const risk  = Math.abs(entry - sl) || entry * 0.001;
  const rrOf  = p => lng ? (p - entry) / risk : (entry - p) / risk;
  const minRR = [1.5, 2.5, 4];
  const capRR = [5, 8, 12];
  const lbls  = ['nearest liquidity', 'mid structure', 'extended magnet'];
  const levels = [...new Set(candidates)]
    .filter(p => p != null && isFinite(p) && (lng ? p > entry : p < entry))
    .map(p => ({ p, rr: rrOf(p) }))
    .sort((a, b) => a.rr - b.rr);
  const tps = [];
  let floor = 0;
  for (let i = 0; i < 3; i++) {
    const need = Math.max(minRR[i], floor + 0.4);
    let pick = levels.find(x => x.rr >= need && x.rr <= capRR[i] && !tps.some(t => Math.abs(t.p - x.p) < risk * 0.1));
    if (!pick) {
      const mult = Math.max(minRR[i], floor + 0.6);
      pick = { p: lng ? entry + mult * risk : entry - mult * risk, rr: mult };
    }
    tps.push({ p: pick.p, rr: pick.rr, lbl: lbls[i] });
    floor = pick.rr;
  }
  return tps;
}

function calcTPs(fvg, entry, sl, allFVGs, liq, pv4h) {
  const lng = fvg.type === 'bull';
  const oppFVGs = allFVGs.filter(f => f.type !== fvg.type && f.status !== 'MITIGATED').map(f => f.ce);
  const htf = (lng ? pv4h.h : pv4h.l).map(x => x.p);
  const candidates = [lng ? liq.nearBSL : liq.nearSSL, lng ? liq.majBSL : liq.majSSL, liq.psych, ...oppFVGs, ...htf];
  return orderTPs(entry, sl, lng, candidates);
}

function buildSetups(fvgs, b4h, cp, liq, pvByTf) {
  if (b4h === 'NEUTRAL') return [];
  const setups = [];
  for (const fvg of fvgs.filter(f => (f.grade === 'A' || f.grade === 'B') && f.status !== 'MITIGATED')) {
    const lng = fvg.type === 'bull';
    if (lng  && (fvg.gH < cp * 0.82 || fvg.gL > cp)) continue;
    if (!lng && (fvg.gL > cp * 1.18 || fvg.gH < cp)) continue;
    const entry = fvg.ce;
    // Entry must be on the correct side of price: longs at/below (discount), shorts at/above (premium).
    if (lng  && entry > cp * 1.001) continue;
    if (!lng && entry < cp * 0.999) continue;
    // SL from the FVG's OWN timeframe structure, not always 4H.
    const pv = pvByTf[fvg.tf] || pvByTf['4H'];
    const sl = calcSL(fvg, pv, cp);
    if (Math.abs(entry - sl) / entry > 0.06) continue;
    const tps = calcTPs(fvg, entry, sl, fvgs, liq, pvByTf['4H']);
    if (tps[0].rr < 1.5) continue;
    setups.push({ fvg, entry, sl, tps, lng });
  }
  setups.sort((a, b) => a.fvg.grade !== b.fvg.grade ? (a.fvg.grade === 'A' ? -1 : 1) : b.tps[0].rr - a.tps[0].rr);
  return setups.slice(0, 3);
}

function calcSLScalp(fvg) {
  const buf = Math.abs(fvg.gH - fvg.gL) * 0.15;
  return fvg.type === 'bull' ? fvg.gL - buf : fvg.gH + buf;
}

function calcTPsScalp(fvg, entry, sl, allFVGs, liq) {
  const lng = fvg.type === 'bull';
  const oppFVGs = allFVGs.filter(f => f.type !== fvg.type && f.status !== 'MITIGATED').map(f => f.ce);
  const candidates = [lng ? liq.nearBSL : liq.nearSSL, lng ? liq.majBSL : liq.majSSL, liq.psych, ...oppFVGs];
  return orderTPs(entry, sl, lng, candidates);
}

function buildSetupsScalp(fvgs, b1h, cp, liq) {
  if (b1h === 'NEUTRAL') return [];
  const setups = [];
  for (const fvg of fvgs.filter(f => (f.grade === 'A' || f.grade === 'B') && f.status !== 'MITIGATED')) {
    const lng = fvg.type === 'bull';
    if (lng  && (fvg.gH < cp * 0.99 || fvg.gL > cp * 1.003)) continue;
    if (!lng && (fvg.gL > cp * 1.01 || fvg.gH < cp * 0.997)) continue;
    const entry = fvg.ce, sl = calcSLScalp(fvg);
    // Entry must be on the correct side of price: longs at/below, shorts at/above.
    if (lng  && entry > cp * 1.001) continue;
    if (!lng && entry < cp * 0.999) continue;
    if (Math.abs(entry - sl) / entry > 0.005) continue;
    const tps = calcTPsScalp(fvg, entry, sl, fvgs, liq);
    if (tps[0].rr < 1.5) continue;
    setups.push({ fvg, entry, sl, tps, lng });
  }
  setups.sort((a, b) => a.fvg.grade !== b.fvg.grade ? (a.fvg.grade === 'A' ? -1 : 1) : b.tps[0].rr - a.tps[0].rr);
  return setups.slice(0, 3);
}

// ── Compute ───────────────────────────────────────────────────────────────────
async function computeAlgo(sym) {
  const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

  if (MODE === 'scalp') {
    const [d1h, d15m, d5m] = await Promise.all([
      fetchOHLCV(sym, '1h', CNT), fetchOHLCV(sym, '15m', CNT), fetchOHLCV(sym, '5m', CNT),
    ]);
    const cp = d5m[d5m.length-1].close;
    const pv1h = pivots(d1h, LB), pv15m = pivots(d15m, Math.max(3, LB-2)), pv5m = pivots(d5m, 3);
    const b1h = bias(pv1h), b15m = bias(pv15m), b5m = bias(pv5m);
    const eq1h = eqLevel(pv1h), eq15m = eqLevel(pv15m);
    const ch1h = choch(pv1h, b1h), ch15m = choch(pv15m, b15m);
    const liq = liqLevels(pv15m, cp);
    const fvgs = [...detectFVGs(d15m,'15M',pv15m).slice(-6), ...detectFVGs(d5m,'5M',pv5m).slice(-4)];
    fvgs.forEach(v => { v.grade = grade(v, b1h, eq1h); });
    const setups = buildSetupsScalp(fvgs, b1h, cp, liq);
    return { mode:'scalp', sym, cp, b4h:b1h, b1h:b15m, b15m:b5m, eq4h:eq1h, eq1h:eq15m, ch4h:ch1h, ch1h:ch15m, liq, setups, ts };
  }

  const [d4h, d1h, d15m] = await Promise.all([
    fetchOHLCV(sym, '4h', CNT), fetchOHLCV(sym, '1h', CNT), fetchOHLCV(sym, '15m', CNT),
  ]);
  const cp = d1h[d1h.length-1].close;
  const pv4h = pivots(d4h, LB), pv1h = pivots(d1h, LB), pv15m = pivots(d15m, Math.max(3, LB-2));
  const b4h = bias(pv4h), b1h = bias(pv1h), b15m = bias(pv15m);
  const eq4h = eqLevel(pv4h), eq1h = eqLevel(pv1h);
  const ch4h = choch(pv4h, b4h), ch1h = choch(pv1h, b1h);
  const liq = liqLevels(pv4h, cp);
  const fvgs = [...detectFVGs(d4h,'4H',pv4h).slice(-3), ...detectFVGs(d1h,'1H',pv1h).slice(-5), ...detectFVGs(d15m,'15M',pv15m).slice(-3)];
  fvgs.forEach(v => { v.grade = grade(v, b4h, eq4h); });
  const setups = buildSetups(fvgs, b4h, cp, liq, {'4H':pv4h, '1H':pv1h, '15M':pv15m});
  return { mode:'swing', sym, cp, b4h, b1h, b15m, eq4h, eq1h, ch4h, ch1h, liq, setups, ts };
}

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
      if (verification?.reason) msg += `✅ <i>${verification.reason}</i>\n`;
    });
  }
  return msg;
}

// ── Claude verification (server-side) ─────────────────────────────────────────
async function verifyTrade(sym, setup, data) {
  if (!CLAUDE_KEY) return null;
  const { fvg, entry, sl, tps, lng } = setup;
  const risk = Math.abs(entry - sl);
  const rr = (Math.abs(tps[0].p - entry) / risk).toFixed(2);
  const slPct = ((risk / entry) * 100).toFixed(2);
  const hour = new Date().getUTCHours();
  const timeCtx = hour < 8 ? 'Asian session' : hour < 16 ? 'European/US session' : 'overnight/low liquidity';
  const aligned = (lng && data.b1h === 'BULLISH') || (!lng && data.b1h === 'BEARISH');
  const prompt = `You are a professional crypto trader reviewing an SMC trade setup. Decide if it is worth taking.

Symbol: ${sym}.P (Delta Exchange India perp)
Direction: ${lng ? 'LONG' : 'SHORT'}
Current price: ${data.cp}
Bias — ${data.mode === 'scalp' ? '1H' : '4H'}: ${data.b4h}, ${data.mode === 'scalp' ? '15M' : '1H'}: ${data.b1h}
FVG: ${fvg.type === 'bull' ? 'bullish/demand' : 'bearish/supply'} on ${fvg.tf}, status ${fvg.status}${fvg.swept ? ', swept' : ''}, grade ${fvg.grade}
Entry ${entry.toFixed(2)} (FVG center) | SL ${sl.toFixed(2)} (${slPct}% risk) | R:R to TP1 1:${rr}
TP1 ${tps[0].p.toFixed(2)} (1:${tps[0].rr.toFixed(2)}) · TP2 ${tps[1].p.toFixed(2)} (1:${tps[1].rr.toFixed(2)}) · TP3 ${tps[2].p.toFixed(2)} (1:${tps[2].rr.toFixed(2)})
Time: ${timeCtx} | Aligned with shorter-TF bias: ${aligned ? 'yes' : 'no'}

Check: R:R acceptable (>1.5)? setup logic sound? entry reachable from price? SL reasonable? market/time supportive?
Respond with exactly one line: "APPROVED - <short reason>" or "REJECTED - <short reason>".`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) { console.error(`  Claude HTTP ${r.status}`); return null; }
    const j = await r.json();
    const text = (j.content?.[0]?.text || '').trim();
    if (!text) return null;
    const approved = text.toUpperCase().startsWith('APPROVED');
    const reason = text.replace(/^\s*(APPROVED|REJECTED)\s*[-–:]?\s*/i, '').trim();
    return { approved, reason: reason || (approved ? 'passed review' : 'rejected') };
  } catch (e) { console.error('  Claude error:', e.message); return null; }
}

// Returns [{setup, verification}] — approved-only when a Claude key is set
// (fails closed on errors), otherwise all setups with verification:null.
async function verifySetups(sym, data) {
  if (!CLAUDE_KEY || !data.setups?.length) {
    return (data.setups || []).map(setup => ({ setup, verification: null }));
  }
  const out = [];
  for (const setup of data.setups) {
    const v = await verifyTrade(sym, setup, data);
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

main().catch(e => { console.error(e); process.exit(1); });
