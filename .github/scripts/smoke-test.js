#!/usr/bin/env node
// CI smoke test — proves the shared engine and the cron LOAD and RUN for BOTH
// modes without ReferenceErrors (the class of bug `node --check` cannot catch).
// Hits the live Delta read-only API. No Telegram, no Claude calls.
const path = require('path');
const engine = require(path.join(__dirname, '..', '..', 'engine.js'));
const claude = require(path.join(__dirname, '..', '..', 'claude.js'));
const report = require(path.join(__dirname, 'report.js'));   // require.main guard → main() does NOT run
const paper  = require(path.join(__dirname, 'paper-trade.js')); // require.main guard → does NOT run

const SYMS = ['BTCUSD', 'SOLUSD', 'ETHUSD'];
let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

(async () => {
  // Every module loads cleanly + exports what the others rely on.
  check(typeof report.computeAlgo === 'function' && typeof report.formatTelegram === 'function',
        'report.js loads + requires engine.js');
  check(typeof claude.verifyTrade === 'function', 'claude.js loads + exports verifyTrade');
  check(typeof paper.monitor === 'function' && typeof paper.manageTrade === 'function',
        'paper-trade.js loads + requires engine.js & claude.js');

  for (const mode of ['swing', 'scalp']) {
    for (const sym of SYMS) {
      try {
        const d = await engine.computeAlgo(sym, { mode });
        const okShape  = d && Array.isArray(d.setups) && typeof d.cp === 'number';
        const okTrig   = (d.setups || []).every(s => ['PENDING', 'AWAITING', 'CONFIRMED'].includes(s.trigger));
        const okLadder = (d.setups || []).every(s => {
          const p = s.tps.map(t => t.p);
          return s.lng ? (p[0] < p[1] && p[1] < p[2]) : (p[0] > p[1] && p[1] > p[2]);
        });
        // exercise message assembly too (catches format-path ReferenceErrors)
        const fmt = report.formatTelegram(d, (d.setups || []).map(s => ({ setup: s, verification: null })));
        const okFmt = typeof fmt === 'string' && fmt.length > 0;
        check(okShape && okTrig && okLadder && okFmt, `[${mode}] ${sym}`, `${d.setups.length} setups, b4h=${d.b4h}`);
      } catch (e) {
        check(false, `[${mode}] ${sym}`, `${e.constructor.name}: ${e.message}`);
      }
    }
  }

  console.log(failures === 0 ? '\n✅ SMOKE TEST PASSED' : `\n❌ SMOKE TEST FAILED (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
})();
