const DROPBOX_FILE     = '/btc-signal-desk/global-state.json';
const DROPBOX_TRADES   = '/btc-signal-desk/trade-log.json';

// ── Dropbox helpers ───────────────────────────────────────────────
async function dropboxSave(token, path, data) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false, mute: true }),
      'Content-Type': 'application/octet-stream'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Dropbox save HTTP ' + res.status);
  return true;
}

async function dropboxLoad(token, path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error('Dropbox load HTTP ' + res.status);
  return JSON.parse(await res.text());
}

// ── Telegram helper ───────────────────────────────────────────────
async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── Kalshi helpers ────────────────────────────────────────────────
async function kalshiGetBalance(apiKey) {
  const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/portfolio/balance', {
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('Kalshi balance HTTP ' + res.status);
  const data = await res.json();
  // balance is in cents
  return (data.balance || 0) / 100;
}

async function kalshiPlaceTrade(apiKey, ticker, side, amountCents) {
  // Get current orderbook to find best price
  const mktRes = await fetch(
    `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5`,
    { headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' } }
  );
  const mktData = await mktRes.json();
  const markets = mktData.markets || [];
  const now = Date.now() / 1000;
  const mkt = markets.find(m => m.close_time > now) || markets[0];
  if (!mkt) throw new Error('No active Kalshi market found');

  const marketTicker = mkt.ticker;
  const yesPrice = mkt.yes_ask || mkt.yes_price || 50;
  const noPrice  = mkt.no_ask  || mkt.no_price  || 50;
  const price    = side === 'yes' ? yesPrice : noPrice;

  // Calculate contracts (each contract costs price¢, pays 100¢)
  const contracts = Math.max(1, Math.floor((amountCents / price)));

  const orderRes = await fetch('https://api.elections.kalshi.com/trade-api/v2/portfolio/orders', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      action:  'buy',
      side:    side,        // 'yes' or 'no'
      ticker:  marketTicker,
      count:   contracts,
      type:    'limit',
      yes_price: side === 'yes' ? price : undefined,
      no_price:  side === 'no'  ? price : undefined,
    })
  });

  if (!orderRes.ok) {
    const err = await orderRes.text();
    throw new Error('Kalshi order failed: ' + err);
  }
  const orderData = await orderRes.json();
  return { marketTicker, side, contracts, price, order: orderData };
}

// ── Build Kalshi ticker (ET timezone, ceiling to 15-min boundary) ─
function buildKalshiTicker() {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
  const etOffsetHours = isDST ? -4 : -5;
  const etMs = now.getTime() + (now.getTimezoneOffset() + etOffsetHours * 60) * 60000;
  const et = new Date(etMs);
  const totalMins = et.getHours() * 60 + et.getMinutes();
  const ceilMins  = Math.ceil((totalMins + 1) / 15) * 15;
  const closeDate = new Date(etMs + (ceilMins - totalMins) * 60000);
  const yy  = String(closeDate.getFullYear()).slice(2);
  const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][closeDate.getMonth()];
  const dd  = String(closeDate.getDate()).padStart(2,'0');
  const hh  = String(closeDate.getHours()).padStart(2,'0');
  const mi  = String(closeDate.getMinutes()).padStart(2,'0');
  return 'KXBTC15M-' + yy + mon + dd + hh + mi;
}

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version, x-api-key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const qs      = event.queryStringParameters || {};
  const DBX     = process.env.DROPBOX_TOKEN;
  const TG_TOK  = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
  const KAL_KEY = process.env.KALSHI_API_KEY;

  // ── GLOBAL SAVE ───────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && qs.save) {
    try {
      const { data } = JSON.parse(event.body);
      await dropboxSave(DBX, DROPBOX_FILE, data);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── GLOBAL LOAD ───────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && qs.load) {
    try {
      const data = await dropboxLoad(DBX, DROPBOX_FILE);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── FIRE TRADE (POST ?trade=1) ────────────────────────────────────
  // Called by website when snapshot is taken (10-min mark)
  // Body: { signal: 'UP'|'DOWN'|'PASS', conf: 75, price: 68000, strike: 67800 }
  if (event.httpMethod === 'POST' && qs.trade) {
    try {
      const { signal, conf, price, strike, botEnabled } = JSON.parse(event.body);

      if (signal === 'PASS') {
        // Only notify on skip if bot is live
        if (botEnabled) {
          await sendTelegram(TG_TOK, TG_CHAT,
            `⏭ <b>SKIP — 10-min Snapshot</b>\n\n` +
            `📸 Snapshot Decision: PASS (${conf}% conf — below threshold)\n` +
            `⏰ No trade placed at 10-min mark\n` +
            `💰 BTC @ $${Number(price).toLocaleString()} | Strike: $${Number(strike).toLocaleString()}`
          );
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, action: 'skipped' }) };
      }

      // Get balance → calculate 5% trade size
      const balance     = await kalshiGetBalance(KAL_KEY);
      const tradeDollars = Math.max(1, balance * 0.05);
      const tradeCents  = Math.round(tradeDollars * 100);

      // UP = buy YES (price will be ABOVE strike), DOWN = buy NO
      const side = signal === 'UP' ? 'yes' : 'no';
      const result = await kalshiPlaceTrade(KAL_KEY, buildKalshiTicker(), side, tradeCents);

      // Save trade to Dropbox log
      let tradeLog = [];
      try { tradeLog = (await dropboxLoad(DBX, DROPBOX_TRADES)) || []; } catch(e) {}
      tradeLog.unshift({
        time:     new Date().toISOString(),
        signal,
        conf,
        price,
        strike,
        side,
        market:   result.marketTicker,
        contracts: result.contracts,
        priceEach: result.price,
        costDollars: (result.contracts * result.price / 100).toFixed(2),
        balance:  balance.toFixed(2),
      });
      await dropboxSave(DBX, DROPBOX_TRADES, tradeLog.slice(0, 200));

      // Send Telegram alert — only when bot is live
      if (botEnabled) {
        const dir   = signal === 'UP' ? '🟢 UP' : '🔴 DOWN';
        const cost  = (result.contracts * result.price / 100).toFixed(2);
        await sendTelegram(TG_TOK, TG_CHAT,
          `${dir} <b>TRADE PLACED — 10-min Snapshot</b>\n\n` +
          `📸 <b>Snapshot Decision: ${signal}</b> (${conf}% conf)\n` +
          `⏰ Locked at 10-min mark — final 5 min won't change this\n\n` +
          `💰 BTC @ $${Number(price).toLocaleString()} | Strike: $${Number(strike).toLocaleString()}\n` +
          `🎲 Market: ${result.marketTicker}\n` +
          `📦 ${result.contracts} contracts @ ${result.price}¢ = $${cost}\n` +
          `💵 Balance: $${balance.toFixed(2)} | 5% = $${tradeDollars.toFixed(2)}`
        );
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, action: 'traded', result }) };
    } catch(e) {
      // Send error alert to Telegram
      try {
        await sendTelegram(TG_TOK, TG_CHAT, `⚠️ <b>Trade Error</b>\n${e.message}`);
      } catch(e2) {}
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── SETTLE TRADE (POST ?settle=1) ────────────────────────────────
  // Called at cycle end to report win/loss
  if (event.httpMethod === 'POST' && qs.settle) {
    try {
      const { signal, result, openPrice, closePrice, strike, conf } = JSON.parse(event.body);
      if (signal === 'PASS') return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };

      const won  = result === 'win';
      const icon = won ? '✅' : result === 'loss' ? '❌' : '⏭';
      const move = ((closePrice - openPrice) / openPrice * 100).toFixed(3);
      const finalDir = closePrice > strike ? 'UP' : closePrice < strike ? 'DOWN' : 'FLAT';
      const snapIcon = signal === 'UP' ? '🟢' : signal === 'DOWN' ? '🔴' : '⏭';
      const finalIcon = finalDir === 'UP' ? '🟢' : finalDir === 'DOWN' ? '🔴' : '↔';
      const matchIcon = signal === finalDir ? '✓ AGREED' : '✗ CHANGED';

      await sendTelegram(TG_TOK, TG_CHAT,
        `${icon} <b>Cycle Settled — ${result.toUpperCase()}</b>\n\n` +
        `${snapIcon} <b>10-min Snapshot:</b> ${signal} (${conf}% conf)\n` +
        `${finalIcon} <b>15-min Final:</b> ${finalDir} — ${matchIcon}\n\n` +
        `📈 BTC moved: ${move > 0 ? '+' : ''}${move}%\n` +
        `🔓 Open: $${Number(openPrice).toLocaleString()}\n` +
        `🔒 Close: $${Number(closePrice).toLocaleString()}\n` +
        `🎯 Strike: $${Number(strike).toLocaleString()}`
      );
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── KALSHI MARKET DATA ────────────────────────────────────────────
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

  // ── ANTHROPIC ─────────────────────────────────────────────────────
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
