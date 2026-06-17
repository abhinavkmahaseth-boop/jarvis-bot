// JARVIS notifier — the SINGLE place alerts go out. UMD: the cron scripts require
// it, the browser gets JARVIS_NOTIFY. Messages are composed once in Telegram-HTML;
// this fans them out to every configured channel (Discord and/or Telegram),
// converting markup per channel. Add a channel here and every alert gets it.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.JARVIS_NOTIFY = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Telegram-HTML → Discord markdown (Discord renders no HTML).
  function toDiscord(s) {
    return String(s)
      .replace(/<\/?b>/gi, '**')
      .replace(/<\/?i>/gi, '*')
      .replace(/<\/?u>/gi, '__')
      .replace(/<\/?code>/gi, '`')
      .replace(/<[^>]+>/g, '');
  }
  const plain = s => String(s).replace(/<[^>]+>/g, '');

  async function sendTelegram(token, chat, text) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error('Telegram: ' + (j.description || r.status));
    return true;
  }
  async function sendDiscord(url, text) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: toDiscord(text).slice(0, 1990) }),  // Discord cap 2000
    });
    if (!r.ok && r.status !== 204) throw new Error('Discord: HTTP ' + r.status);
    return true;
  }

  // Fan out to every configured channel. cfg = { discord, tgToken, tgChat }.
  // Returns the list of channels that delivered; never throws.
  async function notify(text, cfg) {
    cfg = cfg || {};
    const jobs = [];
    if (cfg.discord)            jobs.push(['discord',  sendDiscord(cfg.discord, text)]);
    if (cfg.tgToken && cfg.tgChat) jobs.push(['telegram', sendTelegram(cfg.tgToken, cfg.tgChat, text)]);
    const ok = [];
    for (const [name, p] of jobs) {
      try { await p; ok.push(name); }
      catch (e) { if (typeof console !== 'undefined') console.error(`${name} send failed:`, e.message); }
    }
    if (!ok.length && typeof console !== 'undefined') console.log('[notify: no channel]', plain(text));
    return ok;
  }

  return { toDiscord, plain, sendTelegram, sendDiscord, notify };
});
