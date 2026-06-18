// Delta Exchange India — authenticated trade client (server-side only; needs the
// API secret to sign, so this NEVER runs in the browser). Used by the live executor
// to place/cancel/close real orders for the algo book. Every entry path is capped at
// MAX_LOTS so the code physically cannot size beyond 1 lot (0.001 BTC), no matter what.
const crypto = require('crypto');

const BASE        = 'https://api.india.delta.exchange';
const BTCUSD_ID   = 27;            // product_id for BTCUSD perp (verified via /v2/products)
const MAX_LOTS    = 1;             // HARD cap — 1 contract = 0.001 BTC. Do not raise without review.
const UA          = 'jarvis-bot';

// Delta signature: hex(HMAC_SHA256(secret, method + timestamp + path + query + body))
function sign(secret, method, ts, path, query, body) {
  const data = method + ts + path + (query || '') + (body || '');
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

async function req(method, path, { key, secret, query = '', body = null } = {}) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = body ? JSON.stringify(body) : '';
  const headers = {
    'api-key': key,
    'signature': sign(secret, method, ts, path, query ? '?' + query : '', payload),
    'timestamp': ts,
    'User-Agent': UA,
    'Content-Type': 'application/json',
  };
  const url = BASE + path + (query ? '?' + query : '');
  const r = await fetch(url, { method, headers, body: payload || undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok || j.success === false) {
    const msg = j.error?.code || j.error || j.message || `HTTP ${r.status}`;
    throw new Error(`Delta ${method} ${path}: ${typeof msg === 'object' ? JSON.stringify(msg) : msg}`);
  }
  return j.result !== undefined ? j.result : j;
}

// Signed read — proves the key works and trading is reachable.
async function testConnection({ key, secret }) {
  const bal = await req('GET', '/v2/wallet/balances', { key, secret });
  const usd = Array.isArray(bal) ? bal.find(b => (b.asset_symbol || '').toUpperCase().includes('USD')) : null;
  return { ok: true, balance: usd ? usd.available_balance : (bal[0]?.available_balance ?? null) };
}

// Current signed position for a product (size>0 long, <0 short, 0 flat).
async function getPosition({ key, secret, productId = BTCUSD_ID }) {
  const p = await req('GET', '/v2/positions', { key, secret, query: `product_id=${productId}` });
  const size = Array.isArray(p) ? (p[0]?.size ?? 0) : (p?.size ?? 0);
  return { size: Number(size) || 0 };
}

// Place a LIMIT entry of `lots` (≤ MAX_LOTS) with an attached bracket SL + TP, so the
// exchange fills at the intended price and manages the stop/target in real time —
// immune to the bot's cycle lag. Returns the created order (incl. id).
async function placeBracketLimit({ key, secret, productId = BTCUSD_ID, side, lots, limitPrice, stopPrice, takeProfitPrice }) {
  const size = Math.min(Math.max(1, Math.round(lots || 1)), MAX_LOTS);   // HARD cap
  const body = {
    product_id: productId,
    size,
    side,                                   // 'buy' (long) | 'sell' (short)
    order_type: 'limit_order',
    limit_price: String(limitPrice),
    time_in_force: 'gtc',
    bracket_stop_loss_price: String(stopPrice),
    bracket_take_profit_price: String(takeProfitPrice),
    bracket_stop_trigger_method: 'last_traded_price',
  };
  return req('POST', '/v2/orders', { key, secret, body });
}

async function cancelOrder({ key, secret, orderId, productId = BTCUSD_ID }) {
  return req('DELETE', '/v2/orders', { key, secret, body: { id: orderId, product_id: productId } });
}

// Flatten a position with a reduce-only market order (used as a safety close).
async function closePosition({ key, secret, productId = BTCUSD_ID, size, side }) {
  const lots = Math.min(Math.abs(size), MAX_LOTS);
  if (!lots) return { flat: true };
  return req('POST', '/v2/orders', { key, secret, body: {
    product_id: productId, size: lots, side, order_type: 'market_order', reduce_only: true,
  } });
}

module.exports = { BASE, BTCUSD_ID, MAX_LOTS, sign, req, testConnection, getPosition, placeBracketLimit, cancelOrder, closePosition };
