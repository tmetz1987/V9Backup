// Simple in-memory global store (persists as long as Netlify function is warm)
// For true persistence across cold starts, upgrade to Netlify Blobs or a DB
const _store = {};

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const qs = event.queryStringParameters || {};

  // ── GLOBAL SAVE (POST ?save=1) ────────────────────────────────────
  if (event.httpMethod === 'POST' && qs.save) {
    try {
      const { key, data } = JSON.parse(event.body);
      _store[key] = data;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch(e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── GLOBAL LOAD (GET ?load=1&key=...) ────────────────────────────
  if (event.httpMethod === 'GET' && qs.load) {
    const data = _store[qs.key] || null;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
  }

  // ── KALSHI (GET ?ticker=...) ──────────────────────────────────────
  if (event.httpMethod === 'GET' && qs.ticker) {
    try {
      const url = 'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5';
      const res  = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const body = await res.text();
      return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body };
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── ANTHROPIC (POST) ──────────────────────────────────────────────
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY
      },
      body: event.body
    });
    const body = await res.text();
    return { statusCode: res.status, headers: { ...CORS, 'Content-Type': 'application/json' }, body };
  } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
