exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // ── KALSHI — fetch open markets for KXBTC15M series ──────────────
  const ticker = event.queryStringParameters && event.queryStringParameters.ticker;
  if (event.httpMethod === 'GET' && ticker) {
    try {
      // Use the markets list endpoint filtered by series — more reliable than direct ticker lookup
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
