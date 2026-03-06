// ═══════════════════════════════════════════════════════════════════
//  SHADOW ENGINE — Server-side BTC Signal Engine (Phase 1: Shadow Mode)
//  Runs every 15 min via GitHub Actions. Does NOT place real trades.
//  Logs decisions to Dropbox shadow-log.json and sends 🔵 SHADOW
//  Telegram alerts so you can compare vs browser signals.
// ═══════════════════════════════════════════════════════════════════

const crypto = require('crypto');

// ── Constants (must match index.html exactly) ─────────────────────
const MIN_OBS_SECS          = 300;
const CONF_REALISTIC_FACTOR = 0.62;
const CONF_CURVE_STEEPNESS  = 1.6;
const CONF_SIGNAL_THRESHOLD = 0.25;
const MTF_STRONG_BOOST      = 1.30;
const MTF_MODERATE_BOOST    = 1.15;
const MTF_MILD_PENALTY      = 0.75;
const MTF_STRONG_PENALTY    = 0.50;
const MACRO_AGREE_BOOST     = 1.12;
const MACRO_OPPOSE_PENALTY  = 0.82;
const TREND_LOOKBACK        = 12;
const SMOOTH_WINDOW         = 8;
const LOCK_THRESHOLD        = 0.625;
const LOCK_DURATION         = 90;
const MIN_CONF_TRADE        = 62;
const CANDLE_SECS           = 60;
const DROPBOX_SHADOW_LOG    = '/btc-signal-desk/shadow-log.json';
const DROPBOX_GLOBAL        = '/btc-signal-desk/global-state.json';

// ── Sessions (must match index.html exactly) ──────────────────────
const SESSIONS = [
  { id:'asia',    pstStart:16, pstEnd:24 },
  { id:'london',  pstStart:0,  pstEnd:2  },
  { id:'eu',      pstStart:2,  pstEnd:5  },
  { id:'overlap', pstStart:5,  pstEnd:9  },
  { id:'ny',      pstStart:9,  pstEnd:13 },
  { id:'late',    pstStart:13, pstEnd:16 },
];

function pstOffset() {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
    const utcNow = new Date();
    const pstH   = parseInt(fmt.format(utcNow), 10) % 24;
    const utcH   = utcNow.getUTCHours();
    return ((pstH - utcH + 48) % 24) - 24;
  } catch(e) { return -8; }
}

function pstHour(date) {
  const d = date || new Date();
  const off = pstOffset();
  return ((d.getUTCHours() + off) + 24) % 24;
}

function getSession(date) {
  const h = pstHour(date);
  return SESSIONS.find(s => {
    if (s.pstStart < s.pstEnd) return h >= s.pstStart && h < s.pstEnd;
    return h >= s.pstStart || h < s.pstEnd;
  }) || SESSIONS[5];
}

// ── Indicator math (exact copies from index.html) ─────────────────
function emaArr(arr, n) {
  const k = 2 / (n + 1);
  const out = new Array(arr.length).fill(null);
  if (arr.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += arr[i];
  out[n - 1] = seed / n;
  for (let i = n; i < arr.length; i++) {
    out[i] = arr[i] * k + out[i-1] * (1 - k);
  }
  return out;
}

function calcRSI(closes, n = 14) {
  if (closes.length < n + 2) return 50;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= n; avgL /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (n - 1) + g) / n;
    avgL = (avgL * (n - 1) + l) / n;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcBB(closes, n = 20) {
  if (closes.length < n) return { upper: 0, mid: 0, lower: 0, std: 0, width: 0 };
  const sl = closes.slice(-n);
  const m  = sl.reduce((a,b) => a+b, 0) / n;
  const sd = Math.sqrt(sl.reduce((a,b) => a + (b-m)**2, 0) / n);
  return { upper: m + 2*sd, mid: m, lower: m - 2*sd, std: sd, width: sd > 0 ? 4*sd/m : 0 };
}

function calcStochRSI(closes, rsiLen, stochLen, smoothK, smoothD) {
  rsiLen=rsiLen||14; stochLen=stochLen||14; smoothK=smoothK||3; smoothD=smoothD||3;
  if (closes.length < rsiLen+stochLen+smoothK+smoothD+2) return null;
  const rA = []; let avgG=0, avgL=0;
  for (let i=1; i<=rsiLen; i++) { const d=closes[i]-closes[i-1]; avgG+=d>0?d:0; avgL+=d<0?-d:0; }
  avgG/=rsiLen; avgL/=rsiLen;
  rA.push(avgL===0?100:100-100/(1+avgG/avgL));
  for (let i=rsiLen+1; i<closes.length; i++) {
    const d=closes[i]-closes[i-1], g=d>0?d:0, l=d<0?-d:0;
    avgG=(avgG*(rsiLen-1)+g)/rsiLen; avgL=(avgL*(rsiLen-1)+l)/rsiLen;
    rA.push(avgL===0?100:100-100/(1+avgG/avgL));
  }
  const kR=[];
  for (let i=stochLen-1; i<rA.length; i++) {
    const sl=rA.slice(i-stochLen+1,i+1), lo=Math.min(...sl), hi=Math.max(...sl);
    kR.push(hi===lo?50:((rA[i]-lo)/(hi-lo))*100);
  }
  const kS=[];
  for (let i=smoothK-1; i<kR.length; i++)
    kS.push(kR.slice(i-smoothK+1,i+1).reduce((a,b)=>a+b,0)/smoothK);
  if (kS.length < smoothD) return null;
  return { k:kS[kS.length-1], d:kS.slice(-smoothD).reduce((a,b)=>a+b,0)/smoothD };
}

function calcATR(candles, n = 14) {
  if (candles.length < n + 2) return 0;
  let atr = 0;
  for (let i = 1; i <= n; i++) {
    const c=candles[i], p=candles[i-1];
    atr += Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c));
  }
  atr /= n;
  for (let i = n+1; i < candles.length; i++) {
    const c=candles[i], p=candles[i-1];
    const tr = Math.max(c.h-c.l, Math.abs(c.h-p.c), Math.abs(c.l-p.c));
    atr = (atr*(n-1)+tr)/n;
  }
  return atr;
}

function calcVWAP(candles) {
  if (!candles.length) return 0;
  const midUTC = new Date(); midUTC.setUTCHours(0,0,0,0);
  const midMs = midUTC.getTime();
  const todayC = candles.filter(c => c.t && c.t >= midMs);
  const win = todayC.length >= 10 ? todayC : candles.slice(-120);
  let tpv=0, vol=0;
  for (const c of win) { const tp=(c.h+c.l+c.c)/3; tpv+=tp*c.v; vol+=c.v; }
  return vol > 0 ? tpv/vol : candles[candles.length-1].c;
}

function calcMacroBias(ema21) {
  const n = TREND_LOOKBACK;
  const len = ema21.length;
  if (len < n+1) return 0;
  const old = ema21[len-1-n];
  const cur = ema21[len-1];
  if (old===null || cur===null) return 0;
  const slope = (cur-old)/old;
  if (slope >  0.0008) return  1;
  if (slope < -0.0008) return -1;
  return 0;
}

function aggregateCandles(candles1m, period) {
  const out = [];
  for (let i = 0; i + period <= candles1m.length; i += period) {
    const slice = candles1m.slice(i, i+period);
    out.push({
      t: slice[0].t,
      o: slice[0].o,
      h: Math.max(...slice.map(c => c.h)),
      l: Math.min(...slice.map(c => c.l)),
      c: slice[slice.length-1].c,
      v: slice.reduce((a,c) => a+c.v, 0),
    });
  }
  return out;
}

function computeMTFSnapshot(candles) {
  if (candles.length < 10) return { trend:0, rsi:50, macdSlope:0, emaGap:0, bb:{} };
  const closes = candles.map(c => c.c);
  const n = closes.length;
  const ema9  = emaArr(closes, 9);
  const ema21 = emaArr(closes, 21);
  const rsi   = calcRSI(closes, Math.min(14, n-1));
  const ema12a = emaArr(closes, 12);
  const ema26a = emaArr(closes, 26);
  const macdL  = ema12a.map((v,i) => (v!==null && ema26a[i]!==null) ? v-ema26a[i] : null);
  const macdV  = macdL.filter(v=>v!==null);
  const macdSlope = macdV.length >= 2 ? macdV[macdV.length-1] - macdV[macdV.length-2] : 0;
  const trend = (ema9[n-1]!==null && ema21[n-1]!==null) ? (ema9[n-1]>ema21[n-1]?1:-1) : 0;
  const emaGap = (ema9[n-1]!==null && ema21[n-1]!==null) ? (ema9[n-1]-ema21[n-1]) : 0;
  const bb = calcBB(closes, Math.min(20, n));
  return { trend, rsi, macdSlope, emaGap, bb };
}

function getMTFConfluence(candles1m, signDir) {
  if (signDir === 0) return 0;
  const candles5m  = aggregateCandles(candles1m, 5);
  const candles15m = aggregateCandles(candles1m, 15);
  const tf5  = computeMTFSnapshot(candles5m);
  const tf15 = computeMTFSnapshot(candles15m);
  let score = 0, count = 0;
  [tf5, tf15].forEach(tf => {
    if (tf.trend !== 0) { score += (tf.trend === signDir ? 1 : -1); count++; }
    const rsiDir = tf.rsi > 55 ? 1 : tf.rsi < 45 ? -1 : 0;
    if (rsiDir !== 0)  { score += (rsiDir === signDir ? 0.5 : -0.5); count += 0.5; }
    if (tf.macdSlope !== 0) {
      const ms = tf.macdSlope > 0 ? 1 : -1;
      score += (ms === signDir ? 0.5 : -0.5); count += 0.5;
    }
  });
  return count > 0 ? Math.max(-1, Math.min(1, score/count)) : 0;
}

// ── Main signal computation (mirrors evalRawSignal + computeIndicators) ──
function computeSignal(candles, learnedWeights, sessionStats, dowStats, dirStats,
                       lossStreak, cbThresholdBoost, fgScore, kalshiYesPrice,
                       signalRunLen, lastRawSignal, history) {

  if (candles.length < 28) return { signal:'PASS', conf:0, reason:'not enough candles' };

  const closes = candles.map(c => c.c);
  const vols   = candles.map(c => c.v);
  const n      = candles.length;
  const price  = candles[n-1].c;

  const ema9arr  = emaArr(closes, 9);
  const ema21arr = emaArr(closes, 21);
  const ema12    = emaArr(closes, 12);
  const ema26    = emaArr(closes, 26);
  const macdLine = ema12.map((v,i) => (v!==null && ema26[i]!==null) ? v-ema26[i] : null);
  const macdValid = macdLine.filter(v=>v!==null);
  const macdSig9  = emaArr(macdValid, 9);
  const macdSignal = new Array(macdLine.length).fill(null);
  let vi=0;
  for (let i=0; i<macdLine.length; i++) {
    if (macdLine[i]!==null) { macdSignal[i] = macdSig9[vi++] ?? null; }
  }
  const histogram = macdLine.map((v,i) => v!==null && macdSignal[i]!==null ? v-macdSignal[i] : null);

  const rsi      = calcRSI(closes, 14);
  const stochRSI = calcStochRSI(closes, 14, 14, 3, 3);
  const bb       = calcBB(closes, 20);
  const atr      = calcATR(candles, 14);
  const vwap     = calcVWAP(candles);
  const lv       = vols.slice(-20);
  const avgVol   = lv.length ? lv.reduce((a,b)=>a+b,0)/lv.length : 1;
  const ema21full = emaArr(closes, 21);
  const macroBias = calcMacroBias(ema21full);

  const e9=ema9arr[n-1], pe9=ema9arr[n-2];
  const e21=ema21arr[n-1], pe21=ema21arr[n-2];
  const mL=macdLine[n-1], mSig=macdSignal[n-1];
  const mH=histogram[n-1], pmH=histogram[n-2], ppmH=histogram[n-3];
  const atrPct = atr > 0 ? atr/price : 0;

  if (e9===null || e21===null || mL===null || mSig===null) return { signal:'PASS', conf:0, reason:'indicators null' };

  const curVol = candles[n-1].v;
  const vr     = avgVol > 0 ? curVol/avgVol : 1;

  const s = {};
  const W = learnedWeights;

  // Signal 1: Momentum
  {
    const c5 = candles.slice(n-6, n).map(c => c.c);
    const roc5 = (c5[5]-c5[0])/c5[0];
    const roc2 = (c5[5]-c5[3])/c5[3];
    const atrNorm = atr > 0 ? atr/price : 0.001;
    const normRoc5 = roc5/(atrNorm*3);
    const normRoc2 = roc2/(atrNorm*1.5);
    s.mom = Math.max(-2, Math.min(2, normRoc5*1.2+normRoc2*0.8));
  }

  // Signal 2: EMA + VWAP
  {
    const freshCross = pe9!==null && pe21!==null &&
      ((pe9<pe21 && e9>=e21)||(pe9>pe21 && e9<=e21));
    let ema;
    if (freshCross && e9>e21) ema=2;
    else if (freshCross && e9<e21) ema=-2;
    else ema=Math.max(-1.5, Math.min(1.5, (e9-e21)/atr));
    const aboveVWAP = vwap>0 && price>vwap;
    if (ema>0 && aboveVWAP)  ema=Math.min(2, ema+0.4);
    if (ema<0 && !aboveVWAP) ema=Math.max(-2, ema-0.4);
    if (ema>0 && !aboveVWAP) ema*=0.7;
    if (ema<0 && aboveVWAP)  ema*=0.7;
    s.ema=ema; s.aboveVWAP=aboveVWAP;
  }

  // Signal 3: RSI + StochRSI
  {
    let rsiComp;
    if (rsi>=72)      rsiComp=macroBias>0?1.0:-1.5;
    else if (rsi<=28) rsiComp=macroBias<0?-1.0:1.5;
    else if (rsi>=62) rsiComp=1.8;
    else if (rsi>=55) rsiComp=1.0;
    else if (rsi>=50) rsiComp=0.3;
    else if (rsi>=45) rsiComp=-0.3;
    else if (rsi>=38) rsiComp=-1.0;
    else              rsiComp=-1.8;
    let stochComp=0;
    if (stochRSI) {
      const kd=stochRSI.k-stochRSI.d;
      if (stochRSI.k>=85)      stochComp=macroBias>0?1.0:-1.2;
      else if (stochRSI.k<=15) stochComp=macroBias<0?-1.0:1.2;
      else if (stochRSI.k>=60) stochComp=1.5+(kd>0?0.3:-0.3);
      else if (stochRSI.k>=50) stochComp=0.5+(kd>0?0.3:-0.2);
      else if (stochRSI.k>=40) stochComp=-0.5+(kd<0?-0.3:0.2);
      else                     stochComp=-1.5+(kd<0?-0.3:0.3);
      stochComp=Math.max(-2, Math.min(2, stochComp));
    }
    s.rsi = stochRSI ? rsiComp*0.5+stochComp*0.5 : rsiComp;
  }

  // Signal 4: MACD histogram slope
  {
    let macdSig=0;
    if (mH!==null && pmH!==null) {
      const slope1=mH-pmH;
      const slope2=ppmH!==null?pmH-ppmH:slope1;
      const slopeAccel=slope1-slope2;
      const norm=atr>0?slope1/(atr*0.1):slope1;
      const normAccel=atr>0?slopeAccel/(atr*0.05):slopeAccel;
      macdSig=Math.max(-2, Math.min(2, norm*1.2+normAccel*0.5));
      if (mL>0 && macdSig>0) macdSig=Math.min(2, macdSig*1.1);
      if (mL<0 && macdSig<0) macdSig=Math.max(-2, macdSig*1.1);
    }
    s.macd=macdSig;
  }

  // Signal 5: Volume
  {
    const volArr=candles.slice(n-4,n).map(c=>c.v);
    const volTrend=(volArr[3]-volArr[0])/(volArr[0]||1);
    const priceDir=candles[n-1].c>candles[n-4].c?1:-1;
    if (vr>=2.0)       s.vol=priceDir*2.0;
    else if (vr>=1.5)  s.vol=priceDir*1.2;
    else if (vr>=0.85) s.vol=priceDir*(volTrend>0.1?0.6:0.2);
    else               s.vol=priceDir*-0.4;
    s.vr=vr;
  }

  // Signal 6: Candle structure
  {
    const cs=candles.slice(n-4,n);
    let bullStreak=0, bearStreak=0, bodyQuality=0;
    for (const c of cs) {
      const body=Math.abs(c.c-c.o), range=c.h-c.l||1;
      const br=body/range;
      if (c.c>c.o) { bullStreak++; bodyQuality+=br; }
      else if (c.c<c.o) { bearStreak++; bodyQuality-=br; }
    }
    const streak=bullStreak>bearStreak?bullStreak:-bearStreak;
    s.candle=Math.max(-2, Math.min(2, (streak*0.5)+(bodyQuality*0.35)));
  }

  // Signal 7: Bollinger Bands
  {
    const bbPos=(bb.upper>bb.lower && bb.std>0)?(price-bb.lower)/(bb.upper-bb.lower):0.5;
    s.isSqueeze=(bb.width||0)<0.012; s.bbPos=bbPos;
    let bbSig;
    if (s.isSqueeze) { bbSig=s.mom>0?0.5:s.mom<0?-0.5:0; }
    else {
      const zScore=bb.std>0?(price-bb.mid)/bb.std:0;
      bbSig=Math.max(-2, Math.min(2, zScore*0.9));
    }
    s.bb=bbSig;
  }

  // ATR gate
  const atrOk=atrPct>0.0003, atrHigh=atrPct>0.004;
  s.atrOk=atrOk; s.atrPct=atrPct;

  // Composite score
  let score = s.mom*W.mom + s.ema*W.ema + s.rsi*W.rsi + s.macd*W.macd +
              s.vol*W.vol + s.candle*W.candle + s.bb*W.bb;

  if (!atrOk)  score*=0.55;
  if (atrHigh) score*=0.80;

  const signDir=score>0?1:score<0?-1:0;
  if (macroBias!==0 && macroBias===signDir)              score*=MACRO_AGREE_BOOST;
  if (macroBias!==0 && macroBias!==signDir && signDir!==0) score*=MACRO_OPPOSE_PENALTY;

  const mtfC=getMTFConfluence(candles, signDir);
  s.mtfConfluence=mtfC;
  if (mtfC>=0.5)       score*=MTF_STRONG_BOOST;
  else if (mtfC>=0.2)  score*=MTF_MODERATE_BOOST;
  else if (mtfC>=-0.1) score*=1.00;
  else if (mtfC>=-0.4) score*=MTF_MILD_PENALTY;
  else                  score*=MTF_STRONG_PENALTY;

  // Indicator conflict penalty
  const bull=[s.ema>0,s.rsi>0,s.macd>0,s.bb>0].filter(Boolean).length;
  const bear=[s.ema<0,s.rsi<0,s.macd<0,s.bb<0].filter(Boolean).length;
  if (bull>=2 && bear>=2) {
    const highConflict=(s.mom>0.5 && s.macd<-0.5)||(s.mom<-0.5 && s.macd>0.5)||
                       (s.ema>0.5 && s.rsi<-0.3)||(s.ema<-0.5 && s.rsi>0.3);
    score*=highConflict?0.50:0.65;
  }

  const theoreticalMax=(W.mom*2+W.ema*2+W.rsi*1.8+W.macd*2+W.vol*2+W.candle*2+W.bb*2)*1.15;
  const realisticMax=theoreticalMax*CONF_REALISTIC_FACTOR;
  const _normPre=score/realisticMax;

  // Cycle progress momentum exhaustion — server doesn't know cycleOpen so we skip this
  // F&G nudge
  if (fgScore!==null) {
    const fg=fgScore;
    if      (fg<=15 && _normPre>0) score*=1.04;
    else if (fg<=15 && _normPre<0) score*=0.96;
    else if (fg<=25 && _normPre>0) score*=1.02;
    else if (fg>=85 && _normPre<0) score*=1.04;
    else if (fg>=85 && _normPre>0) score*=0.96;
    else if (fg>=75 && _normPre<0) score*=1.02;
  }

  const norm=score/realisticMax;
  const absNorm=Math.abs(norm);
  let baseConf=Math.round(100*(1-Math.exp(-CONF_CURVE_STEEPNESS*absNorm)));
  baseConf=Math.max(0, Math.min(99, baseConf));

  // Session adj
  const sessId=getSession().id;
  const sessS=sessionStats[sessId];
  let sessAdj=1.0;
  if (sessS && sessS.traded>=5) {
    sessAdj=Math.max(0.92, Math.min(1.08, 0.92+(sessS.wins/sessS.traded)*0.16));
  }

  // DOW adj
  let dowAdj=1.0;
  const todayDOW=new Date().getDay();
  const dowS=dowStats[todayDOW];
  if (dowS && dowS.traded>=5) {
    dowAdj=Math.max(0.94, Math.min(1.06, 0.94+(dowS.wins/dowS.traded)*0.12));
  }

  // Dir adj
  let dirAdj=1.0;
  const dirS=dirStats&&dirStats[sessId];
  if (dirS && norm>=CONF_SIGNAL_THRESHOLD && dirS.upTrades>=5) {
    dirAdj=Math.max(0.95, Math.min(1.05, 0.95+(dirS.upWins/dirS.upTrades)*0.10));
  } else if (dirS && norm<=-0.25 && dirS.dnTrades>=5) {
    dirAdj=Math.max(0.95, Math.min(1.05, 0.95+(dirS.dnWins/dirS.dnTrades)*0.10));
  }

  // Regime
  let regimeAdj=1.0;
  if (candles.length>=20) {
    const rc=candles.slice(-20);
    const totalMove=rc.reduce((sum,c,i)=>sum+(i>0?Math.abs(c.c-rc[i-1].c):0),0);
    const netMove=Math.abs(rc[rc.length-1].c-rc[0].c);
    const eff=totalMove>0?netMove/totalMove:0.5;
    if (eff>=0.55) regimeAdj=1.08;
    else if (eff<=0.25) regimeAdj=0.82;
  }

  // Signal stability
  let curRunLen=signalRunLen||0;
  const curRawDir=norm>0?'UP':norm<0?'DOWN':'PASS';
  if (curRawDir!=='PASS') {
    if (curRawDir===lastRawSignal) curRunLen++;
    else curRunLen=1;
  } else { curRunLen=0; }
  const stabilityAdj=Math.min(1.08, 1.0+Math.min(curRunLen,10)*0.008);

  // Circuit breaker
  const cbAdj=cbThresholdBoost>0?Math.max(0.82,1.0-cbThresholdBoost*0.015):1.0;

  // Kalshi crowd
  let crowdAdj=1.0, crowdVeto=false;
  if (kalshiYesPrice!==null) {
    const aiAbove=norm>0, crowdAbove=kalshiYesPrice>50;
    const neutral=kalshiYesPrice>=45&&kalshiYesPrice<=55;
    const agrees=aiAbove===crowdAbove;
    const strength=Math.abs(kalshiYesPrice-50)/50;
    if (!neutral) crowdAdj=agrees?(1.0+strength*0.12):(1.0-strength*0.18);
    if (!agrees && (kalshiYesPrice>88||kalshiYesPrice<12)) crowdVeto=true;
  }

  const rawConf=Math.max(0,Math.min(99,Math.round(baseConf*sessAdj*dowAdj*dirAdj*regimeAdj*stabilityAdj*cbAdj*crowdAdj)));

  let rec;
  if (!atrOk && absNorm<0.4) rec='PASS';
  else if (norm>=CONF_SIGNAL_THRESHOLD) rec='UP';
  else if (norm<=-CONF_SIGNAL_THRESHOLD) rec='DOWN';
  else rec='PASS';
  if (crowdVeto && rec!=='PASS') rec='PASS';

  return {
    signal: rec,
    conf:   rawConf,
    price,
    sigs:   { mom:s.mom, ema:s.ema, rsi:s.rsi, macd:s.macd, vol:s.vol, candle:s.candle, bb:s.bb, atrOk:atrOk?1:0, mtfC },
    bull, bear,
    atr, rsi, macroBias,
  };
}

// ── Dropbox helpers ───────────────────────────────────────────────
async function getDropboxToken() {
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id:     process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
    })
  });
  if (!res.ok) throw new Error('Dropbox token HTTP ' + res.status);
  return (await res.json()).access_token;
}

async function dropboxLoad(token, path) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  if (res.status===409) return null;
  if (!res.ok) throw new Error('Dropbox load HTTP ' + res.status);
  return JSON.parse(await res.text());
}

async function dropboxSave(token, path, data) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path, mode:'overwrite', autorename:false, mute:true }),
      'Content-Type': 'application/octet-stream'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Dropbox save HTTP ' + res.status);
}

// ── Telegram ──────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── BTC price fetch (multi-source with fallback) ──────────────────
async function fetchBTCCandles() {
  // Fetch 1-minute OHLCV from Binance — last 200 candles
  const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=200', {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('Binance candles HTTP ' + res.status);
  const rows = await res.json();
  return rows.map(r => ({ t:+r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4], v:+r[5] }));
}

async function fetchBTCPrice() {
  const sources = [
    { url:'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', parse: d => parseFloat(d.price) },
    { url:'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',        parse: d => parseFloat(d.result&&d.result.XXBTZUSD&&d.result.XXBTZUSD.c&&d.result.XXBTZUSD.c[0]) },
    { url:'https://api.coinbase.com/v2/prices/BTC-USD/spot',            parse: d => parseFloat(d.data&&d.data.amount) },
  ];
  for (const src of sources) {
    try {
      const r = await fetch(src.url);
      if (!r.ok) continue;
      const d = await r.json();
      const p = src.parse(d);
      if (p && p > 1000) return p;
    } catch(e) {}
  }
  throw new Error('All BTC price sources failed');
}

// ── Kalshi YES price fetch ────────────────────────────────────────
async function fetchKalshiYesPrice() {
  try {
    const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5', {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const markets = data.markets || [];
    const now = Date.now()/1000;
    const mkt = markets.find(m => m.close_time > now) || markets[0];
    if (!mkt) return null;
    return mkt.yes_ask || mkt.yes_bid || mkt.yes_price || null;
  } catch(e) { return null; }
}

// ── Fear & Greed fetch ────────────────────────────────────────────
async function fetchFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1');
    if (!res.ok) return null;
    const data = await res.json();
    return data.data&&data.data[0] ? parseInt(data.data[0].value) : null;
  } catch(e) { return null; }
}

// ── Main handler ──────────────────────────────────────────────────
exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
  if (event.httpMethod==='OPTIONS') return { statusCode:200, headers:CORS, body:'' };

  try {
    console.log('[SHADOW] Starting shadow cycle run...');

    // 1. Load global state from Dropbox (learned weights, stats, history)
    const dbxToken = await getDropboxToken();
    let globalState = null;
    try { globalState = await dropboxLoad(dbxToken, DROPBOX_GLOBAL); } catch(e) {}

    const learnedWeights = (globalState&&globalState.learnedWeights) ||
      { mom:3.5, ema:2.5, rsi:2.0, macd:2.0, vol:1.5, candle:1.5, bb:1.0 };
    const sessionStats   = (globalState&&globalState.sessionStats)   || {};
    const dowStats       = (globalState&&globalState.dowStats)       || {};
    const dirStats       = (globalState&&globalState.dirStats)       || {};
    const lossStreak     = (globalState&&globalState.lossStreak)     || 0;
    const cbThresholdBoost = (globalState&&globalState.cbThresholdBoost) || 0;
    const history        = (globalState&&globalState.history)        || [];

    // 2. Fetch live data in parallel
    const [candles, fgScore, kalshiYesPrice] = await Promise.all([
      fetchBTCCandles(),
      fetchFearGreed(),
      fetchKalshiYesPrice(),
    ]);

    if (!candles || candles.length < 28) {
      throw new Error('Insufficient candle data: ' + (candles||[]).length);
    }

    // 3. Determine cycle position from wall clock
    const now       = new Date();
    const totalSec  = now.getMinutes()*60 + now.getSeconds();
    const cyclePos  = totalSec % 900;
    const cycleLeft = 900 - cyclePos;
    const isSnapshotWindow = cyclePos >= 600 && cyclePos < 660; // just crossed 10-min mark

    // 4. Run signal engine
    const result = computeSignal(
      candles, learnedWeights, sessionStats, dowStats, dirStats,
      lossStreak, cbThresholdBoost, fgScore, kalshiYesPrice,
      0, 'WAIT', history
    );

    const { signal, conf, price, sigs, bull, bear } = result;
    const cycleMin  = Math.floor(cyclePos/60);
    const cycleSec  = cyclePos%60;
    const leftMin   = Math.floor(cycleLeft/60);
    const leftSec   = cycleLeft%60;

    // 5. Save to shadow log
    let shadowLog = [];
    try { shadowLog = (await dropboxLoad(dbxToken, DROPBOX_SHADOW_LOG)) || []; } catch(e) {}
    shadowLog.unshift({
      time:         now.toISOString(),
      cyclePos,
      signal,
      conf,
      price:        Math.round(price),
      kalshiYP:     kalshiYesPrice,
      fgScore,
      sigs,
      bull, bear,
      isSnapshotWindow,
    });
    await dropboxSave(dbxToken, DROPBOX_SHADOW_LOG, shadowLog.slice(0, 500));

    // 6. Send Telegram shadow alert
    const dir   = signal==='UP'?'🟢':signal==='DOWN'?'🔴':'🟡';
    const phase = cyclePos<300?'⏳ FORMING':cyclePos<600?'⚡ PRIME':cyclePos<720?'✓ GOOD':'⚠ LATE';
    const snapTag = isSnapshotWindow ? '\n📸 <b>THIS IS THE 10-MIN SNAPSHOT WINDOW</b>' : '';

    await sendTelegram(
      `🔵 <b>SHADOW SIGNAL — Server Engine</b>\n\n` +
      `${dir} <b>Signal: ${signal}</b> (${conf}% conf)\n` +
      `⏱ Cycle: ${cycleMin}:${String(cycleSec).padStart(2,'0')} elapsed | ${leftMin}:${String(leftSec).padStart(2,'0')} left\n` +
      `${phase}${snapTag}\n\n` +
      `💰 BTC: $${Math.round(price).toLocaleString()}\n` +
      `🎯 Kalshi Crowd YES: ${kalshiYesPrice!==null?kalshiYesPrice+'¢':'N/A'}\n` +
      `😨 Fear & Greed: ${fgScore!==null?fgScore:'N/A'}\n\n` +
      `📊 Indicators — Bull:${bull} Bear:${bear}\n` +
      `  mom:${sigs.mom?.toFixed(2)} ema:${sigs.ema?.toFixed(2)} rsi:${sigs.rsi?.toFixed(2)}\n` +
      `  macd:${sigs.macd?.toFixed(2)} vol:${sigs.vol?.toFixed(2)} bb:${sigs.bb?.toFixed(2)}\n` +
      `  mtfC:${sigs.mtfC?.toFixed(2)}`
    );

    console.log('[SHADOW] Done. Signal:', signal, conf+'%', '@ $'+Math.round(price));

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok:true, signal, conf, price:Math.round(price) })
    };

  } catch(e) {
    console.error('[SHADOW] Error:', e.message);
    try {
      await sendTelegram(`⚠️ <b>Shadow Engine Error</b>\n${e.message}`);
    } catch(e2) {}
    return { statusCode:502, headers:CORS, body:JSON.stringify({ error:e.message }) };
  }
};

