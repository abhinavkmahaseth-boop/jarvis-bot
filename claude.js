// Shared Claude trade verifier — the SINGLE source of truth for the verification
// prompt + verdict parsing, used by the cron report, the paper-trader AND the
// browser (index.html). UMD: Node `require`s it, the browser gets JARVIS_CLAUDE.
//
//   buildVerifyPrompt(sym, setup, data) → the exact prompt string (one prompt)
//   parseVerdict(text)                  → { approved, reason }
//   verifyTrade(sym, setup, data, key)  → { approved, reason } | null
//                                         (no key / API error → null = fail closed)
//
// The browser keeps its own fetch wrapper (it needs the CORS header + UI logging)
// but builds the prompt and parses the verdict through THIS module, so every
// environment asks Claude the identical question and reads the answer the same way.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.JARVIS_CLAUDE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function buildVerifyPrompt(sym, setup, data) {
    const { fvg, entry, sl, tps, lng } = setup;
    const risk = Math.abs(entry - sl);
    const rr = (Math.abs(tps[0].p - entry) / risk).toFixed(2);
    const slPct = ((risk / entry) * 100).toFixed(2);
    const hour = new Date().getUTCHours();
    const timeCtx = hour < 8 ? 'Asian session' : hour < 16 ? 'European/US session' : 'overnight/low liquidity';
    const aligned = (lng && data.b1h === 'BULLISH') || (!lng && data.b1h === 'BEARISH');
    const trig = setup.trigger === 'CONFIRMED' ? 'CONFIRMED (price tapped the zone and displaced in-direction)'
      : setup.trigger === 'AWAITING' ? 'AWAITING (price at the zone, no reversal confirmed yet)'
      : setup.trigger === 'PENDING' ? 'PENDING (price has not reached the zone yet)' : 'n/a';
    return `You are a professional crypto trader reviewing an SMC trade setup. Decide if it is worth taking.

Symbol: ${sym}.P (Delta Exchange India perp)
Direction: ${lng ? 'LONG' : 'SHORT'}
Current price: ${data.cp}
Bias — 4H: ${data.b4h}, 1H: ${data.b1h}
FVG: ${fvg.type === 'bull' ? 'bullish/demand' : 'bearish/supply'} on ${fvg.tf}, status ${fvg.status}${fvg.swept ? ', swept' : ''}, grade ${fvg.grade}
Entry ${entry.toFixed(2)} (FVG center) | SL ${sl.toFixed(2)} (${slPct}% risk) | R:R to TP1 1:${rr}
TP1 ${tps[0].p.toFixed(2)} (1:${tps[0].rr.toFixed(2)}) · TP2 ${tps[1].p.toFixed(2)} (1:${tps[1].rr.toFixed(2)}) · TP3 ${tps[2].p.toFixed(2)} (1:${tps[2].rr.toFixed(2)})
Time: ${timeCtx} | Aligned with shorter-TF bias: ${aligned ? 'yes' : 'no'}
Lower-TF entry trigger: ${trig}
Structural invalidation (CHoCH): void if price closes ${lng ? 'below' : 'above'} ${setup.invalidation != null ? setup.invalidation.toFixed(2) : 'n/a'} (where trend character flips against this trade)

Check: R:R acceptable (>1.5)? setup logic sound? entry reachable from price? SL reasonable (swing stops sit beyond the prior structural swing)? market/time supportive?
Respond with exactly one line: "APPROVED - <short reason>" or "REJECTED - <short reason>".`;
  }

  // Tolerant of "APPROVED - reason" and "APPROVED\nreason"; collapses whitespace.
  function parseVerdict(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const approved = /^\s*APPROVED/i.test(t);
    const reason = t.replace(/^\s*(APPROVED|REJECTED)/i, '').replace(/^[\s\-–:]+/, '').replace(/\s+/g, ' ').trim();
    return { approved, reason: reason || (approved ? 'passed review' : 'rejected') };
  }

  async function verifyTrade(sym, setup, data, apiKey) {
    if (!apiKey) return null;
    const prompt = buildVerifyPrompt(sym, setup, data);
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) { console.error(`  Claude HTTP ${r.status}`); return null; }
      const j = await r.json();
      return parseVerdict((j.content?.[0]?.text || '').trim());
    } catch (e) { console.error('  Claude error:', e.message); return null; }
  }

  return { buildVerifyPrompt, parseVerdict, verifyTrade };
});
