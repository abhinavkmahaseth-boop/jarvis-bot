// JARVIS SMC engine — the SINGLE source of truth shared by the browser
// (index.html, via <script src="engine.js">) and the cron (report.js, via
// require). Pure logic + data fetch only: no DOM, no localStorage, no env.
// All environment-specific config (candle count, lookback, mode) is injected
// into computeAlgo(sym, opts). Do NOT fork this file — edit it once.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.JARVIS_ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TF_SEC = { '4h': 14400, '1h': 3600, '15m': 900, '5m': 300 };

  // ── Data fetch ──────────────────────────────────────────────────────────────
  async function fetchOHLCV(sym, res, count) {
    const sec = TF_SEC[res];
    const now = Math.floor(Date.now() / 1000);
    const start = now - Math.floor(count * sec * 1.4);
    const url = `https://api.india.delta.exchange/v2/history/candles?symbol=${sym}&resolution=${res}&start=${start}&end=${now}`;
    // Delta occasionally returns a 5xx/Cloudflare HTML page instead of JSON; one
    // bad response used to crash the whole monitor cycle. Retry up to 3 times with
    // backoff and only accept a real JSON body, so a transient blip is absorbed.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${sym} ${res}`);
        const text = await r.text();
        if (/^\s*</.test(text)) throw new Error(`non-JSON (HTML) response for ${sym} ${res}`);
        const j = JSON.parse(text);
        if (!j.success || !j.result?.length) throw new Error(`No data: ${sym} ${res}`);
        const bars = j.result.sort((a, b) => a.time - b.time);
        // Drop the still-forming candle so structure/FVG detection never repaints on an open bar.
        const last = bars[bars.length - 1];
        if (last && (last.time + sec) > now) bars.pop();
        return bars;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  // ── Market structure ────────────────────────────────────────────────────────
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
    // Equilibrium of the current dealing range (most recent swing high/low, last 2 each).
    const { h, l } = pv;
    if (!h.length || !l.length) return null;
    const hi = Math.max(...h.slice(-2).map(x => x.p));
    const lo = Math.min(...l.slice(-2).map(x => x.p));
    return (hi + lo) / 2;
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

  // ── FVGs ────────────────────────────────────────────────────────────────────
  function fvgStat(c, fi, type, gH, gL, ce) {
    // Scan ALL later candles by deepest penetration. MITIGATED only on a full fill
    // through the far edge (gL bull / gH bear); a tap to CE (the entry) stays TAPPED.
    let touched = false;
    for (let i = fi + 1; i < c.length; i++) {
      if (type === 'bull') {
        if (c[i].low  <= gH) { touched = true; if (c[i].low  <= gL) return 'MITIGATED'; }
      } else {
        if (c[i].high >= gL) { touched = true; if (c[i].high >= gH) return 'MITIGATED'; }
      }
    }
    return touched ? 'TAPPED' : 'FRESH';
  }
  function hasSweep(c, fi, type, pv) {
    // Real sweep: in the candles forming/preceding the gap, price wicks BEYOND a prior
    // swing level then CLOSES back through it (grab + reclaim).
    const w0 = Math.max(0, fi - 4), w1 = Math.min(c.length - 1, fi);
    if (type === 'bull') {
      const lows = pv.l.filter(x => x.i < w0);
      if (!lows.length) return false;
      const lvl = lows[lows.length - 1].p;
      let swept = false;
      for (let i = w0; i <= w1; i++) {
        if (c[i].low < lvl) swept = true;
        if (swept && c[i].close > lvl) return true;
      }
      return false;
    } else {
      const highs = pv.h.filter(x => x.i < w0);
      if (!highs.length) return false;
      const lvl = highs[highs.length - 1].p;
      let swept = false;
      for (let i = w0; i <= w1; i++) {
        if (c[i].high > lvl) swept = true;
        if (swept && c[i].close < lvl) return true;
      }
      return false;
    }
  }
  function detectFVGs(c, tfLbl, pv) {
    const out = [], ref = c[c.length-1].close, MIN = 0.0003;
    for (let i = 2; i < c.length; i++) {
      const [c1, c2, c3] = [c[i-2], c[i-1], c[i]];
      const b2 = Math.abs(c2.close - c2.open), ab = avgBody(c, i-1, 5);
      // Require genuine displacement: gap-forming body ≥1.3× the recent average.
      if (!(ab > 0 && b2 >= ab * 1.3)) continue;
      if (c1.high < c3.low) {
        const [gH, gL] = [c3.low, c1.high], ce = (gH + gL) / 2;
        if ((gH - gL) / ref >= MIN) {
          const st = fvgStat(c, i, 'bull', gH, gL, ce);
          if (st !== 'MITIGATED') out.push({ type:'bull', tf:tfLbl, gH, gL, ce, status:st, swept:hasSweep(c,i,'bull',pv), dr:b2/ab, fi:i });
        }
      }
      if (c1.low > c3.high) {
        const [gH, gL] = [c1.low, c3.high], ce = (gH + gL) / 2;
        if ((gH - gL) / ref >= MIN) {
          const st = fvgStat(c, i, 'bear', gH, gL, ce);
          if (st !== 'MITIGATED') out.push({ type:'bear', tf:tfLbl, gH, gL, ce, status:st, swept:hasSweep(c,i,'bear',pv), dr:b2/ab, fi:i });
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

  // ── Liquidity ───────────────────────────────────────────────────────────────
  function equalLevels(arr, tol) {
    const used = new Array(arr.length).fill(false), out = [];
    for (let i = 0; i < arr.length; i++) {
      if (used[i]) continue;
      const cluster = [arr[i].p];
      for (let j = i + 1; j < arr.length; j++) {
        if (!used[j] && Math.abs(arr[j].p - arr[i].p) / arr[i].p <= tol) { cluster.push(arr[j].p); used[j] = true; }
      }
      if (cluster.length >= 2) out.push(cluster.reduce((a, b) => a + b, 0) / cluster.length);
    }
    return out;
  }
  function psychLevel(cp) {
    const target = cp / 15;
    const mag = Math.pow(10, Math.floor(Math.log10(target)));
    const cand = [1, 2, 2.5, 5, 10].map(m => m * mag);
    const step = cand.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
    return Math.round(cp / step) * step;
  }
  function liqLevels(pv, cp) {
    const { h, l } = pv;
    const majBSL  = h.length ? Math.max(...h.map(x => x.p)) : null;
    const majSSL  = l.length ? Math.min(...l.map(x => x.p)) : null;
    const nearBSL = h.filter(x => x.p > cp).sort((a, b) => a.p - b.p)[0]?.p || majBSL;
    const nearSSL = l.filter(x => x.p < cp).sort((a, b) => b.p - a.p)[0]?.p || majSSL;
    const eqh = equalLevels(h, 0.0015);   // equal highs → buy-side liquidity pools
    const eql = equalLevels(l, 0.0015);   // equal lows  → sell-side liquidity pools
    return { majBSL, majSSL, nearBSL, nearSSL, eqh, eql, psych: psychLevel(cp) };
  }

  // ── Stops & targets ─────────────────────────────────────────────────────────
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
    const candidates = [lng ? liq.nearBSL : liq.nearSSL, lng ? liq.majBSL : liq.majSSL, liq.psych, ...(lng ? liq.eqh : liq.eql), ...oppFVGs, ...htf];
    return orderTPs(entry, sl, lng, candidates);
  }
  function calcSLScalp(fvg, cp) {
    const buf = Math.max(Math.abs(fvg.gH - fvg.gL) * 0.25, cp * 0.001);
    return fvg.type === 'bull' ? fvg.gL - buf : fvg.gH + buf;
  }
  function calcTPsScalp(fvg, entry, sl, allFVGs, liq) {
    const lng = fvg.type === 'bull';
    const oppFVGs = allFVGs.filter(f => f.type !== fvg.type && f.status !== 'MITIGATED').map(f => f.ce);
    const candidates = [lng ? liq.nearBSL : liq.nearSSL, lng ? liq.majBSL : liq.majSSL, liq.psych, ...(lng ? liq.eqh : liq.eql), ...oppFVGs];
    return orderTPs(entry, sl, lng, candidates);
  }
  function dedupeSetups(setups) {
    const out = [];
    for (const s of setups) {
      if (!out.some(d => d.lng === s.lng && Math.abs(d.entry - s.entry) / s.entry < 0.003)) out.push(s);
    }
    return out;
  }
  function buildSetups(fvgs, b4h, cp, liq, pvByTf, chLevel) {
    if (b4h === 'NEUTRAL') return [];
    const setups = [];
    for (const fvg of fvgs.filter(f => (f.grade === 'A' || f.grade === 'B') && f.status !== 'MITIGATED')) {
      const lng = fvg.type === 'bull';
      // Proximity: entry zone within ~12% of price.
      if (lng  && (fvg.gH < cp * 0.88 || fvg.gL > cp)) continue;
      if (!lng && (fvg.gL > cp * 1.12 || fvg.gH < cp)) continue;
      const entry = fvg.ce;
      // Entry on the correct side of price: longs at/below (discount), shorts at/above (premium).
      if (lng  && entry > cp * 1.001) continue;
      if (!lng && entry < cp * 0.999) continue;
      // CHoCH gate: don't trade continuation once price has broken character against the
      // trade (the bias-TF structure already flipped, even if the lagging pivots haven't).
      if (chLevel != null && (lng ? cp < chLevel : cp > chLevel)) continue;
      const pv = pvByTf[fvg.tf] || pvByTf['4H'];   // SL from the FVG's OWN timeframe structure
      const sl = calcSL(fvg, pv, cp);
      if (Math.abs(entry - sl) / entry > 0.06) continue;
      const tps = calcTPs(fvg, entry, sl, fvgs, liq, pvByTf['4H']);
      if (tps[0].rr < 1.5) continue;
      setups.push({ fvg, entry, sl, tps, lng, invalidation: chLevel });
    }
    setups.sort((a, b) => a.fvg.grade !== b.fvg.grade ? (a.fvg.grade === 'A' ? -1 : 1) : b.tps[0].rr - a.tps[0].rr);
    return dedupeSetups(setups).slice(0, 3);
  }
  function buildSetupsScalp(fvgs, b1h, cp, liq, chLevel) {
    if (b1h === 'NEUTRAL') return [];
    const setups = [];
    for (const fvg of fvgs.filter(f => (f.grade === 'A' || f.grade === 'B') && f.status !== 'MITIGATED')) {
      const lng = fvg.type === 'bull';
      if (lng  && (fvg.gH < cp * 0.99 || fvg.gL > cp * 1.003)) continue;
      if (!lng && (fvg.gL > cp * 1.01 || fvg.gH < cp * 0.997)) continue;
      const entry = fvg.ce, sl = calcSLScalp(fvg, cp);
      if (lng  && entry > cp * 1.001) continue;
      if (!lng && entry < cp * 0.999) continue;
      // CHoCH gate: skip continuation once price has broken character against the trade.
      if (chLevel != null && (lng ? cp < chLevel : cp > chLevel)) continue;
      if (Math.abs(entry - sl) / entry > 0.005) continue;
      const tps = calcTPsScalp(fvg, entry, sl, fvgs, liq);
      if (tps[0].rr < 1.5) continue;
      setups.push({ fvg, entry, sl, tps, lng, invalidation: chLevel });
    }
    setups.sort((a, b) => a.fvg.grade !== b.fvg.grade ? (a.fvg.grade === 'A' ? -1 : 1) : b.tps[0].rr - a.tps[0].rr);
    return dedupeSetups(setups).slice(0, 3);
  }

  // ── Lower-timeframe entry trigger ─────────────────────────────────────────────
  function entryTrigger(cc, lng, zL, zH) {
    if (!cc || cc.length < 3) return 'AWAITING';
    const n = cc.length, look = Math.min(n, 14);
    let tapIdx = -1;
    for (let i = n - look; i < n; i++) {
      if (lng) { if (cc[i].low  <= zH && cc[i].low  >= zL * 0.999) tapIdx = i; }
      else     { if (cc[i].high >= zL && cc[i].high <= zH * 1.001) tapIdx = i; }
    }
    if (tapIdx < 0) return 'PENDING';
    const after = cc.slice(tapIdx);
    if (lng) {
      const tapHigh = Math.max(...cc.slice(Math.max(0, tapIdx - 1), tapIdx + 1).map(x => x.high));
      return after.some(x => x.close > tapHigh) ? 'CONFIRMED' : 'AWAITING';
    } else {
      const tapLow = Math.min(...cc.slice(Math.max(0, tapIdx - 1), tapIdx + 1).map(x => x.low));
      return after.some(x => x.close < tapLow) ? 'CONFIRMED' : 'AWAITING';
    }
  }
  function trigLabel(t) {
    return t === 'CONFIRMED' ? '✅ Entry confirmed (LTF shift)'
         : t === 'AWAITING'  ? '⏳ At zone — awaiting LTF confirmation'
         : t === 'PENDING'   ? '🕒 Pending — price not at zone yet'
         : '—';
  }

  // ── Pure analysis ─────────────────────────────────────────────────────────────
  // Runs the full SMC pipeline on already-fetched candle sets. No network, no
  // look-ahead beyond what's passed in — so the live path AND the backtester
  // (which feeds sliced history) share one identical analysis.
  // c = { d4h, d1h, d15m, d5m }; opts = { lb=5, mode='swing' }
  function analyze(sym, c, opts) {
    const lb = (opts && opts.lb) || 5;
    const mode = (opts && opts.mode) || 'swing';
    const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

    if (mode === 'scalp') {
      const { d1h, d15m, d5m } = c;
      const cp = d5m[d5m.length-1].close;
      const pv1h = pivots(d1h,lb), pv15m = pivots(d15m,Math.max(3,lb-2)), pv5m = pivots(d5m,3);
      const b1h = bias(pv1h), b15m = bias(pv15m), b5m = bias(pv5m);
      const eq1h = eqLevel(pv1h), eq15m = eqLevel(pv15m), eq5m = eqLevel(pv5m);
      const ch1h = choch(pv1h,b1h), ch15m = choch(pv15m,b15m), ch5m = choch(pv5m,b5m);
      const liq = liqLevels(pv15m, cp);
      const fvgs = [...detectFVGs(d15m,'15M',pv15m).slice(-6), ...detectFVGs(d5m,'5M',pv5m).slice(-4)];
      const eqByTfS = {'15M':eq15m, '5M':eq5m};
      fvgs.forEach(v => { v.grade = grade(v, b1h, eqByTfS[v.tf] ?? eq1h); });
      const setups = buildSetupsScalp(fvgs, b1h, cp, liq, ch1h);
      const confS = {'15M':d5m, '5M':d5m};
      setups.forEach(s => { s.trigger = entryTrigger(confS[s.fvg.tf] || d5m, s.lng, s.fvg.gL, s.fvg.gH); });
      return {mode:'scalp', sym, cp, b4h:b1h, b1h:b15m, b15m:b5m, eq4h:eq1h, eq1h:eq15m, eq15m:eq5m, ch4h:ch1h, ch1h:ch15m, ch15m:ch5m, liq, setups, ts};
    }

    const { d4h, d1h, d15m, d5m } = c;
    const cp = d1h[d1h.length-1].close;
    const pv4h = pivots(d4h,lb), pv1h = pivots(d1h,lb), pv15m = pivots(d15m,Math.max(3,lb-2));
    const b4h = bias(pv4h), b1h = bias(pv1h), b15m = bias(pv15m);
    const eq4h = eqLevel(pv4h), eq1h = eqLevel(pv1h), eq15m = eqLevel(pv15m);
    const ch4h = choch(pv4h,b4h), ch1h = choch(pv1h,b1h), ch15m = choch(pv15m,b15m);
    const liq = liqLevels(pv4h, cp);
    const fvgs = [...detectFVGs(d4h,'4H',pv4h).slice(-3), ...detectFVGs(d1h,'1H',pv1h).slice(-5), ...detectFVGs(d15m,'15M',pv15m).slice(-3)];
    const eqByTf = {'4H':eq4h, '1H':eq1h, '15M':eq15m};
    fvgs.forEach(v => { v.grade = grade(v, b4h, eqByTf[v.tf] ?? eq4h); });
    const setups = buildSetups(fvgs, b4h, cp, liq, {'4H':pv4h, '1H':pv1h, '15M':pv15m}, ch4h);
    const conf = {'4H':d15m, '1H':d15m, '15M':d5m};
    setups.forEach(s => { s.trigger = entryTrigger(conf[s.fvg.tf] || d15m, s.lng, s.fvg.gL, s.fvg.gH); });
    return {mode:'swing', sym, cp, b4h, b1h, b15m, eq4h, eq1h, eq15m, ch4h, ch1h, ch15m, liq, setups, ts};
  }

  // ── Live orchestration: fetch latest candles → analyze ────────────────────────
  async function computeAlgo(sym, opts) {
    const cnt = (opts && opts.cnt) || 150;
    const mode = (opts && opts.mode) || 'swing';
    const lb = (opts && opts.lb) || 5;
    if (mode === 'scalp') {
      const [d1h, d15m, d5m] = await Promise.all([fetchOHLCV(sym,'1h',cnt), fetchOHLCV(sym,'15m',cnt), fetchOHLCV(sym,'5m',cnt)]);
      return analyze(sym, { d1h, d15m, d5m }, { lb, mode });
    }
    const [d4h, d1h, d15m, d5m] = await Promise.all([fetchOHLCV(sym,'4h',cnt), fetchOHLCV(sym,'1h',cnt), fetchOHLCV(sym,'15m',cnt), fetchOHLCV(sym,'5m',cnt)]);
    return analyze(sym, { d4h, d1h, d15m, d5m }, { lb, mode });
  }

  return { TF_SEC, fetchOHLCV, pivots, bias, eqLevel, choch, avgBody, fvgStat, hasSweep,
           detectFVGs, grade, equalLevels, psychLevel, liqLevels, calcSL, orderTPs, calcTPs,
           calcSLScalp, calcTPsScalp, dedupeSetups, buildSetups, buildSetupsScalp, analyze,
           entryTrigger, trigLabel, computeAlgo };
});
