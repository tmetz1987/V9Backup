const DROPBOX_FILE = '/btc-signal-desk/global-state.json';

async function dropboxSave(token, data) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({
        path: DROPBOX_FILE,
        mode: 'overwrite',
        autorename: false,
        mute: true
      }),
      'Content-Type': 'application/octet-stream'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Dropbox save HTTP ' + res.status);
  return true;
}

async function dropboxLoad(token) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_FILE })
    }
  });
  if (res.status === 409) return null; // file doesn't exist yet
  if (!res.ok) throw new Error('Dropbox load HTTP ' + res.status);
  const text = await res.text();
  return JSON.parse(text);
}

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const qs  = event.queryStringParameters || {};
  const DBX = process.env.DROPBOX_TOKEN;

  // ── GLOBAL SAVE (POST ?save=1) ────────────────────────────────────
  if (event.httpMethod === 'POST' && qs.save) {
    try {
      const { data } = JSON.parse(event.body);
      await dropboxSave(DBX, data);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── GLOBAL LOAD (GET ?load=1) ─────────────────────────────────────
  if (event.httpMethod === 'GET' && qs.load) {
    try {
      const data = await dropboxLoad(DBX);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
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
