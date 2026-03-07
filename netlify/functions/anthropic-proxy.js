const DROPBOX_FILE     = '/btc-signal-desk/global-state.json';
const DROPBOX_TRADES   = '/btc-signal-desk/trade-log.json';

// ── Dropbox helpers ───────────────────────────────────────────────
async function getDropboxAccessToken() {
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id:     process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
    })
  });
  if (!res.ok) throw new Error('Dropbox token refresh HTTP ' + res.status);
  const data = await res.json();
  return data.access_token;
}

async function dropboxSave(unusedToken, path, data) {
  const token = await getDropboxAccessToken();
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

async function dropboxLoad(unusedToken, path) {
  const token = await getDropboxAccessToken();
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

// ── Kalshi RSA signing ────────────────────────────────────────────
const crypto = require('crypto');

function kalshiSign(method, path, keyId, privateKeyPem) {
  const ts = Date.now();
  const msg = ts + method.toUpperCase() + path;
  const sign = crypto.createSign('SHA256');
  sign.update(msg);
  sign.end();
  // Support both PKCS8 (BEGIN PRIVATE KEY) and PKCS1 (BEGIN RSA PRIVATE KEY)
  const keyObj = privateKeyPem.includes('BEGIN RSA PRIVATE KEY')
    ? { key: privateKeyPem, format: 'pem', type: 'pkcs1' }
    : { key: privateKeyPem, format: 'pem', type: 'pkcs8' };
  const sig = sign.sign({
    ...keyObj,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }, 'base64');
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': String(ts) };
}

function kalshiHeaders(method, path) {
  const keyId  = process.env.KALSHI_API_KEY;
  const pemRaw = process.env.KALSHI_PRIVATE_KEY || '';
  // Netlify collapses line breaks to spaces — reconstruct proper PEM format
  const pem = pemRaw
    .replace(/\\n/g, '\n')          // literal \n -> newline
    .replace(/-----\s+/g, '-----\n') // fix header/footer spacing
    .replace(/\s+-----/g, '\n-----') // fix header/footer spacing
    .replace(/ ([A-Za-z0-9+/=]{10})/g, '\n$1'); // space-separated chunks -> newlines
  const sig    = kalshiSign(method, path, keyId, pem);
  return { ...sig, 'Accept': 'application/json', 'Content-Type': 'application/json' };
}

async function kalshiGetBalance() {
  const path = '/trade-api/v2/portfolio/balance';
  const res = await fetch('https://api.elections.kalshi.com' + path, {
    headers: kalshiHeaders('GET', path)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Kalshi balance HTTP ' + res.status + ': ' + err);
  }
  const data = await res.json();
  // balance = cash only, portfolio_value = open positions — add both for true total
  return ((data.balance || 0) + (data.portfolio_value || 0)) / 100;
}

async function kalshiPlaceTrade(ticker, side, amountCents) {
  // Get active markets
  const mktPath = '/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5';
  const mktRes = await fetch('https://api.elections.kalshi.com' + mktPath, {
    headers: kalshiHeaders('GET', '/trade-api/v2/markets')
  });
  const mktData = await mktRes.json();
  const markets = mktData.markets || [];
  const now = Date.now() / 1000;
  const mkt = markets.find(m => m.close_time > now) || markets[0];
  if (!mkt) throw new Error('No active Kalshi market found');

  const marketTicker = mkt.ticker;
  // Prices must be whole integers 1-99 (cents) — used for contract count calculation only
  const rawYes = mkt.yes_ask || mkt.yes_bid || mkt.yes_price || 50;
  const rawNo  = mkt.no_ask  || mkt.no_bid  || mkt.no_price  || 50;
  const yesPrice = Math.min(99, Math.max(1, Math.round(rawYes)));
  const noPrice  = Math.min(99, Math.max(1, Math.round(rawNo)));
  const price    = side === 'yes' ? yesPrice : noPrice;
  const contracts = Math.max(1, Math.floor(amountCents / price));

  const orderPath = '/trade-api/v2/portfolio/orders';
  // ── Use aggressive limit price (+5 cents above ask) to guarantee immediate fill ──
  const aggressiveYes = Math.min(99, yesPrice + 10);
  const aggressiveNo  = Math.min(99, noPrice  + 10);
  const orderBody = JSON.stringify({
    action: 'buy', side, ticker: marketTicker, count: contracts, type: 'limit',
    yes_price: side === 'yes' ? aggressiveYes : undefined,
    no_price:  side === 'no'  ? aggressiveNo  : undefined,
  });

  const orderRes = await fetch('https://api.elections.kalshi.com' + orderPath, {
    method: 'POST',
    headers: kalshiHeaders('POST', orderPath),
    body: orderBody
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
    // ── Timeout watchdog — Netlify free tier limit is 10s ──────────
    const _tradeTimeout = setTimeout(async () => {
      try {
        await sendTelegram(TG_TOK, TG_CHAT,
          `⏱ <b>Trade Timeout Warning</b>\n\n` +
          `The proxy function hit Netlify's 10s limit and may not have placed the trade.\n\n` +
          `If this keeps happening, upgrade to Netlify paid tier (26s timeout).`
        );
      } catch(e) {}
    }, 9000); // fire at 9s before Netlify kills at 10s

    try {
      const { signal, conf, price, strike, botEnabled, tradePercent, passOverride, overridePct, overrideMin, overrideSec } = JSON.parse(event.body);
      const tradePct = Math.min(20, Math.max(1, Number(tradePercent) || 5)) / 100;

      if (signal === 'PASS') {
        // Only notify on skip if bot is live
        if (botEnabled) {
          await sendTelegram(TG_TOK, TG_CHAT,
            `⏭ <b>SKIP — 10-min Snapshot</b>\n\n` +
            `📸 Snapshot Decision: PASS (${conf}% conf — below threshold)\n` +
            `⏰ No trade placed at 10-min mark\n` +
            `🎯 Beginning Cycle Strike: $${Number(strike).toLocaleString()} | BTC @ 10min: $${Number(price).toLocaleString()}`
          );
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, action: 'skipped' }) };
      }

      // Get balance → calculate trade size
      const balance     = await kalshiGetBalance();
      const tradeDollars = Math.max(1, balance * tradePct);
      const tradeCents  = Math.round(tradeDollars * 100);

      // UP = buy YES (price will be ABOVE strike), DOWN = buy NO
      const side = signal === 'UP' ? 'yes' : 'no';
      const result = await kalshiPlaceTrade(buildKalshiTicker(), side, tradeCents);

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
          `${dir} <b>TRADE PLACED — ${passOverride ? "⚡ Late Entry Override" : "10-min Snapshot"}</b>\n\n` +
          `📸 <b>Snapshot Decision: ${signal}</b> (${conf}% conf)\n` +
          `⏰ ${passOverride ? "⚡ LATE ENTRY — PASS Override at " + overrideMin + ":" + String(overrideSec).padStart(2,"0") + " (" + overridePct + "% move triggered)" : "Locked at 10-min mark"}\n\n` +
          `🎯 Beginning Cycle Strike: $${Number(strike).toLocaleString()}\n` +
          `💰 BTC @ 10min: $${Number(price).toLocaleString()}\n` +
          `🎲 Market: ${result.marketTicker}\n` +
          `📦 ${result.contracts} contracts @ ${result.price}¢ = $${cost}\n` +
          `💵 ${Math.round(tradePct*100)}% of Balance Trading: $${tradeDollars.toFixed(2)} | Balance: $${balance.toFixed(2)}`
        );
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, action: 'traded', result }) };
    } catch(e) {
      // Send error alert to Telegram
      try {
        await sendTelegram(TG_TOK, TG_CHAT, `⚠️ <b>Trade Error</b>\n${e.message}`);
      } catch(e2) {}
      clearTimeout(_tradeTimeout);
      await sendTelegram(TG_TOK, TG_CHAT,
        `⚠️ <b>Trade Error</b>\n\nKalshi order failed: ${JSON.stringify(e.message)}`
      ).catch(()=>{});
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
    } finally {
      clearTimeout(_tradeTimeout);
    }
  }

  // ── SETTLE TRADE (POST ?settle=1) ────────────────────────────────
  // Called at cycle end to report win/loss
  if (event.httpMethod === 'POST' && qs.settle) {
    try {
      const { signal, result, openPrice, closePrice, strike, conf, contracts, tradePrice } = JSON.parse(event.body);
      if (signal === 'PASS') return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };

      const won  = result === 'win';
      const icon = won ? '✅' : result === 'loss' ? '❌' : '⏭';
      const move = ((closePrice - openPrice) / openPrice * 100).toFixed(3);
      const finalDir = closePrice > strike ? 'UP' : closePrice < strike ? 'DOWN' : 'FLAT';
      const snapIcon = signal === 'UP' ? '🟢' : signal === 'DOWN' ? '🔴' : '⏭';
      const finalIcon = finalDir === 'UP' ? '🟢' : finalDir === 'DOWN' ? '🔴' : '↔';
      const matchIcon = signal === finalDir ? '✓ AGREED' : '✗ CHANGED';

      // Calculate net proceeds for WIN
      let balanceLine = '';
      let netLine = '';
      if (result === 'win' && contracts > 0 && tradePrice > 0) {
        try {
          // Wait 20 seconds for Kalshi to settle and credit the balance
          await new Promise(r => setTimeout(r, 20000));
          console.log('[SETTLE] contracts=' + contracts + ' tradePrice=' + tradePrice + 'c');
          const balanceAfter = await kalshiGetBalance();
          // tradePrice is in cents (1-99), contracts is count
          // Each contract pays $1.00 (100 cents) on win
          const grossWin   = contracts * 100;          // cents — each contract pays $1.00
          const costBasis  = contracts * tradePrice;   // cents — fees already included in price
          const netCents   = grossWin - costBasis;     // simple: payout minus what you paid
          const netDollars = (netCents / 100).toFixed(2);
          balanceLine = `\n💵 Kalshi Balance After Win: $${balanceAfter.toFixed(2)}`;
          const netLabel = parseFloat(netDollars) >= 0 ? '💰 Net Profit After Fees' : '⚠️ Net Loss After Fees';
          netLine = `\n${netLabel}: $${netDollars}`;
        } catch(e) { /* skip if balance fetch fails */ }
      }

      await sendTelegram(TG_TOK, TG_CHAT,
        `${icon} <b>Cycle Settled — ${result.toUpperCase()}</b>\n\n` +
        `${snapIcon} <b>10-min Snapshot:</b> ${signal} (${conf}% conf)\n` +
        `${finalIcon} <b>15-min Final:</b> ${finalDir} — ${matchIcon}\n\n` +
        `📈 BTC moved: ${move > 0 ? '+' : ''}${move}%\n` +
        `🎯 Beginning Cycle Strike: $${Number(strike).toLocaleString()}\n` +
        `🔒 BTC Close @ 15min: $${Number(closePrice).toLocaleString()}` +
        netLine + balanceLine
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
