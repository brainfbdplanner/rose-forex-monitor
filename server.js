const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/*
=========================================================
ROSE FOREX MONITOR — v1.0
=========================================================

PAIRS:
  EUR/USD
  GBP/USD
  USD/JPY

ENGINE:
  12H BIAS
     ↓
  1H CONFIRMATION
     ↓
  5M ENTRY
     ↓
  BUY / SELL → TELEGRAM

RULES:
  - 12H bias from COMPLETED candles only
  - Signal needs 4/5 score minimum
  - 12H + 1H must align before 5M entry fires
  - 4H cooldown per pair (no signal spam)
  - Extension protection per pair
  - 1:2 Risk/Reward always

=========================================================
*/

const TIMEFRAME = "5min";

const POLL_MS = Math.max(
  300000,
  Number(process.env.POLL_MS || 300000)
);

/*
=========================================================
PAIRS
=========================================================
*/

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY"
];

/*
=========================================================
PER-PAIR CONFIG
=========================================================
*/

const PAIR_CONFIG = {
  "EUR/USD": {
    decimals: 5,          // 1.10245
    atrMultiplier: 2.5,
    slAtrFactor: 1.2,
    label: "EUR/USD",
    emoji: "🇪🇺"
  },
  "GBP/USD": {
    decimals: 5,          // 1.27345
    atrMultiplier: 2.5,
    slAtrFactor: 1.2,
    label: "GBP/USD",
    emoji: "🇬🇧"
  },
  "USD/JPY": {
    decimals: 3,          // 149.234
    atrMultiplier: 2.5,
    slAtrFactor: 1.2,
    label: "USD/JPY",
    emoji: "🇯🇵"
  }
};

/*
=========================================================
SETTINGS
=========================================================
*/

const H1_REFRESH_MS = 60 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 4 * 60 * 60 * 1000;

let alertsEnabled = true;

/*
=========================================================
STATE
=========================================================
*/

const state = {
  online: true,
  lastScan: null,
  timeframe: TIMEFRAME,
  pairs: {},
  performance: {
    totalSignals: 0,
    buys: 0,
    sells: 0
  },
  api: {
    status: API_KEY ? "CONFIGURED" : "MISSING_API_KEY",
    totalRequests: 0,
    requestsThisScan: 0,
    lastError: null,
    cooldownUntil: null
  }
};

/*
=========================================================
SIGNAL COOLDOWN
=========================================================
*/

const lastSignalTime = {};

for (const pair of PAIRS) {
  lastSignalTime[pair] = null;
}

function isSignalOnCooldown(pair) {
  const last = lastSignalTime[pair];
  if (!last) return false;
  return Date.now() - last < SIGNAL_COOLDOWN_MS;
}

function markSignalSent(pair) {
  lastSignalTime[pair] = Date.now();
}

/*
=========================================================
1H CACHE
=========================================================
*/

const h1Cache = {};

for (const pair of PAIRS) {
  h1Cache[pair] = { candles: null, updated: null };
}

/*
=========================================================
INITIAL STATE PER PAIR
=========================================================
*/

for (const pair of PAIRS) {
  state.pairs[pair] = {
    symbol: pair,
    label: PAIR_CONFIG[pair].label,
    emoji: PAIR_CONFIG[pair].emoji,
    status: "WAIT",
    score: 0,
    message: "Waiting for first scan...",
    price: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    updated: null,
    timeframes: {
      h12: { trend: "UNKNOWN", rsi: null, previous: "UNKNOWN", current: "UNKNOWN", previousCandle: null },
      h1:  { trend: "UNKNOWN", rsi: null },
      m5:  { trend: "UNKNOWN", rsi: null }
    },
    analysis: {
      direction: "WAIT",
      h12SMC: "UNKNOWN",
      h1SMC:  "UNKNOWN",
      breakout: false,
      rejection: false,
      location: "—",
      extended: false,
      structure: "—",
      bos: "—",
      choch: "—",
      liquidity: "—"
    }
  };
}

/*
=========================================================
MARKET HOURS
=========================================================
*/

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 6) return false;                       // Saturday closed
  if (day === 0 && minutes < 22 * 60) return false;  // Sunday before 22:00
  if (day === 5 && minutes >= 22 * 60) return false; // Friday after 22:00

  return true;
}

/*
=========================================================
HELPERS
=========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function roundPrice(value, pair) {
  if (!Number.isFinite(value)) return null;
  const decimals = PAIR_CONFIG[pair]?.decimals ?? 5;
  return Number(value.toFixed(decimals));
}

/*
=========================================================
TWELVE DATA API
=========================================================
*/

async function twelveData(symbol, interval, outputsize = 200) {
  if (!API_KEY) throw new Error("TWELVE_DATA_API_KEY is missing");

  if (state.api.cooldownUntil && Date.now() < state.api.cooldownUntil) {
    throw new Error("API cooldown active — rate limit hit recently");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&timezone=UTC` +
    `&apikey=${encodeURIComponent(API_KEY)}`;

  state.api.totalRequests++;

  const response = await fetch(url);
  const data = await response.json().catch(() => null);

  if (response.status === 429) {
    state.api.cooldownUntil = Date.now() + 60000;
    throw new Error("Rate limit hit — cooling down 60s");
  }

  if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}`);
  if (data?.status === "error") throw new Error(data.message || "API error");
  if (!data || !Array.isArray(data.values)) throw new Error("No candle data returned");

  return data.values
    .map(c => ({
      datetime: new Date(c.datetime + " UTC"),
      open:  num(c.open),
      high:  num(c.high),
      low:   num(c.low),
      close: num(c.close),
      volume: num(c.volume)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/*
=========================================================
COMPLETED CANDLES FILTER
=========================================================
*/

function getClosedCandles(candles, minutes) {
  if (!candles?.length) return [];
  const now = Date.now();
  return candles.filter(c => c.datetime.getTime() + minutes * 60000 <= now);
}

/*
=========================================================
BUILD 12H CANDLES FROM 1H DATA
=========================================================
*/

function aggregate12HCandles(hourlyCandles) {
  if (!hourlyCandles || hourlyCandles.length < 24) return [];

  const closed1H = getClosedCandles(hourlyCandles, 60);
  const groups = new Map();

  for (const candle of closed1H) {
    const d = candle.datetime;
    const half = d.getUTCHours() < 12 ? 0 : 12;
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${half}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candle);
  }

  const result = [];

  for (const candles of groups.values()) {
    candles.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
    if (candles.length !== 12) continue;

    const first = candles[0];
    const last  = candles[candles.length - 1];

    result.push({
      datetime: first.datetime,
      open:   first.open,
      high:   Math.max(...candles.map(c => c.high)),
      low:    Math.min(...candles.map(c => c.low)),
      close:  last.close,
      volume: candles.reduce((s, c) => s + (c.volume || 0), 0)
    });
  }

  return result.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
}

/*
=========================================================
RSI
=========================================================
*/

function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/*
=========================================================
TREND
=========================================================
*/

function getTrend(candles) {
  if (!candles || candles.length < 20) return "UNKNOWN";

  const recent = candles.slice(-20);
  const fast   = average(recent.slice(-5).map(c => c.close));
  const slow   = average(recent.map(c => c.close));
  const first  = recent[0].close;
  const last   = recent[recent.length - 1].close;

  if (last > first && fast > slow) return "BULLISH";
  if (last < first && fast < slow) return "BEARISH";
  return "NEUTRAL";
}

/*
=========================================================
12H TREND — STRICTER CONFIRMATION
=========================================================
*/

function get12HTrend(candles) {
  if (!candles || candles.length < 20) return "UNKNOWN";

  const recent  = candles.slice(-20);
  const fast    = average(recent.slice(-5).map(c => c.close));
  const slow    = average(recent.map(c => c.close));
  const prev    = candles[candles.length - 2];
  const curr    = candles[candles.length - 1];

  const bullish = curr.close > prev.close && curr.high >= prev.high;
  const bearish = curr.close < prev.close && curr.low  <= prev.low;

  if (fast > slow && curr.close > fast && bullish) return "BULLISH";
  if (fast < slow && curr.close < fast && bearish) return "BEARISH";
  return "NEUTRAL";
}

/*
=========================================================
SWING HIGHS AND LOWS
=========================================================
*/

function isSwingHigh(candles, i) {
  if (i < 2 || i >= candles.length - 2) return false;
  return (
    candles[i].high > candles[i-1].high &&
    candles[i].high > candles[i-2].high &&
    candles[i].high > candles[i+1].high &&
    candles[i].high > candles[i+2].high
  );
}

function isSwingLow(candles, i) {
  if (i < 2 || i >= candles.length - 2) return false;
  return (
    candles[i].low < candles[i-1].low &&
    candles[i].low < candles[i-2].low &&
    candles[i].low < candles[i+1].low &&
    candles[i].low < candles[i+2].low
  );
}

/*
=========================================================
SMC STRUCTURE — BOS, CHoCH, LIQUIDITY
=========================================================
*/

function getStructure(candles) {
  if (!candles || candles.length < 15) {
    return { structure: "UNKNOWN", bos: "—", choch: "—", liquidity: "—" };
  }

  const highs = [];
  const lows  = [];

  for (let i = 2; i < candles.length - 2; i++) {
    if (isSwingHigh(candles, i)) highs.push(candles[i]);
    if (isSwingLow(candles, i))  lows.push(candles[i]);
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const prevHigh = highs.length ? highs[highs.length - 1].high : null;
  const prevLow  = lows.length  ? lows[lows.length - 1].low   : null;

  let structure = "RANGE";
  let bos       = "—";
  let choch     = "—";
  let liquidity = "—";

  // BOS
  if (prevHigh !== null && last.close > prevHigh) { structure = "BULLISH"; bos = "BULLISH"; }
  if (prevLow  !== null && last.close < prevLow)  { structure = "BEARISH"; bos = "BEARISH"; }

  // CHoCH — only on exact candle it happens
  if (prevHigh !== null && prev.close <= prevHigh && last.close > prevHigh) choch = "BULLISH";
  if (prevLow  !== null && prev.close >= prevLow  && last.close < prevLow)  choch = "BEARISH";

  // Liquidity sweep
  if (prevHigh !== null && last.high > prevHigh && last.close < prevHigh) liquidity = "BUY-SIDE SWEPT";
  if (prevLow  !== null && last.low  < prevLow  && last.close > prevLow)  liquidity = "SELL-SIDE SWEPT";

  return { structure, bos, choch, liquidity };
}

/*
=========================================================
REJECTION CANDLE (PIN BAR)
=========================================================
*/

function rejectionSignal(candle) {
  if (!candle) return { bullish: false, bearish: false };

  const body      = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const minimum   = Math.max(body * 1.5, 0.0000001);

  return {
    bullish: lowerWick > minimum && candle.close > candle.open,
    bearish: upperWick > minimum && candle.close < candle.open
  };
}

/*
=========================================================
BREAKOUT SIGNAL
=========================================================
*/

function breakoutSignal(candles) {
  if (!candles || candles.length < 10) return { bullish: false, bearish: false };

  const current  = candles[candles.length - 1];
  const previous = candles.slice(-6, -1);
  const highest  = Math.max(...previous.map(c => c.high));
  const lowest   = Math.min(...previous.map(c => c.low));

  return {
    bullish: current.close > highest,
    bearish: current.close < lowest
  };
}

/*
=========================================================
ATR
=========================================================
*/

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low  - p.close)
    ));
  }

  return average(trs.slice(-period));
}

/*
=========================================================
12H ANALYSIS
=========================================================
*/

function get12HAnalysis(candles) {
  if (!candles || candles.length < 20) {
    return { bias: "UNKNOWN", trend: "UNKNOWN", rsi: null,
             previous: "UNKNOWN", current: "UNKNOWN",
             previousCandle: null, currentCandle: null };
  }

  const current  = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const trend    = get12HTrend(candles);
  const rsi      = calculateRSI(candles);

  let bias = "NEUTRAL";

  if (trend === "BULLISH" && current.close > current.open && current.close > previous.close) {
    bias = "BULLISH";
  }
  if (trend === "BEARISH" && current.close < current.open && current.close < previous.close) {
    bias = "BEARISH";
  }

  return {
    bias,
    trend,
    rsi: rsi !== null ? Number(rsi.toFixed(1)) : null,
    previous: getTrend(candles.slice(0, -1)),
    current:  getTrend(candles),
    previousCandle: previous,
    currentCandle:  current
  };
}

/*
=========================================================
MAIN PAIR ANALYSIS ENGINE
=========================================================
*/

function analyzePair(pair, h12, h1, m5) {
  if (!h12.length || !h1.length || !m5.length) {
    throw new Error("Insufficient candle data");
  }

  const closedM5 = getClosedCandles(m5, 5);
  const closedH1 = getClosedCandles(h1, 60);

  if (closedM5.length < 30) throw new Error("Not enough completed 5M candles");
  if (closedH1.length < 30) throw new Error("Not enough completed 1H candles");

  const config = PAIR_CONFIG[pair];
  const latest = closedM5[closedM5.length - 1];
  const price  = latest.close;

  // ---- TIMEFRAME DATA ----
  const h12Analysis = get12HAnalysis(h12);
  const h1Trend      = getTrend(closedH1);
  const h1RSI        = calculateRSI(closedH1);
  const m5Trend      = getTrend(closedM5);
  const m5RSI        = calculateRSI(closedM5);

  // ---- SMC ----
  const h12Structure = getStructure(h12);
  const h1Structure  = getStructure(closedH1);
  const m5Structure  = getStructure(closedM5);
  const rejection    = rejectionSignal(latest);
  const breakout     = breakoutSignal(closedM5);

  // ---- SCORING ----
  let buyScore  = 0;
  let sellScore = 0;

  // 12H — worth 2 points (most important)
  if (h12Analysis.bias === "BULLISH") buyScore  += 2;
  if (h12Analysis.bias === "BEARISH") sellScore += 2;

  // 1H
  if (h1Trend === "BULLISH") buyScore++;
  if (h1Trend === "BEARISH") sellScore++;

  // 5M
  if (m5Trend === "BULLISH") buyScore++;
  if (m5Trend === "BEARISH") sellScore++;

  // RSI
  if (m5RSI !== null && m5RSI >= 50 && m5RSI <= 68) buyScore++;
  if (m5RSI !== null && m5RSI <= 50 && m5RSI >= 32) sellScore++;

  // SMC
  const bullishSMC =
    m5Structure.bos   === "BULLISH" ||
    m5Structure.choch === "BULLISH" ||
    breakout.bullish  ||
    rejection.bullish;

  const bearishSMC =
    m5Structure.bos   === "BEARISH" ||
    m5Structure.choch === "BEARISH" ||
    breakout.bearish  ||
    rejection.bearish;

  // CHoCH extra weight — strongest SMC signal
  if (m5Structure.choch === "BULLISH") buyScore++;
  if (m5Structure.choch === "BEARISH") sellScore++;

  if (bullishSMC) buyScore++;
  if (bearishSMC) sellScore++;

  // Cap at 5
  buyScore  = Math.min(5, buyScore);
  sellScore = Math.min(5, sellScore);

  let status = "WAIT";
  let score  = Math.max(buyScore, sellScore);

  // ---- BUY SIGNAL ----
  if (
    buyScore >= 4 &&
    h12Analysis.bias === "BULLISH" &&
    h1Trend === "BULLISH" &&
    (bullishSMC || m5Trend === "BULLISH")
  ) {
    status = "BUY";
  }

  // ---- SELL SIGNAL ----
  if (
    sellScore >= 4 &&
    h12Analysis.bias === "BEARISH" &&
    h1Trend === "BEARISH" &&
    (bearishSMC || m5Trend === "BEARISH")
  ) {
    status = "SELL";
  }

  // ---- EXTENSION PROTECTION ----
  const atr = calculateATR(closedM5);
  let extended = false;

  if (atr !== null) {
    const ref      = closedM5[Math.max(0, closedM5.length - 6)];
    const distance = Math.abs(price - ref.open);
    if (distance > atr * config.atrMultiplier) {
      extended = true;
      status   = "WAIT";
    }
  }

  // ---- ENTRY / SL / TP ----
  let entry     = null;
  let stopLoss  = null;
  let takeProfit = null;
  let riskReward = null;

  if (status === "BUY" && atr !== null) {
    entry    = price;
    stopLoss = Math.min(latest.low, price - atr * config.slAtrFactor);
    const risk = entry - stopLoss;
    if (risk > 0) { takeProfit = entry + risk * 2; riskReward = "1:2"; }
  }

  if (status === "SELL" && atr !== null) {
    entry    = price;
    stopLoss = Math.max(latest.high, price + atr * config.slAtrFactor);
    const risk = stopLoss - entry;
    if (risk > 0) { takeProfit = entry - risk * 2; riskReward = "1:2"; }
  }

  // ---- LOCATION LABEL ----
  let location = "NEUTRAL";

  if (status === "BUY") {
    if      (rejection.bullish)              location = "BULLISH REJECTION";
    else if (breakout.bullish)               location = "BULLISH BREAKOUT";
    else if (m5Structure.choch === "BULLISH") location = "CHoCH BULLISH";
    else if (m5Structure.bos   === "BULLISH") location = "BULLISH BOS";
    else                                      location = "BULLISH STRUCTURE";
  }

  if (status === "SELL") {
    if      (rejection.bearish)              location = "BEARISH REJECTION";
    else if (breakout.bearish)               location = "BEARISH BREAKOUT";
    else if (m5Structure.choch === "BEARISH") location = "CHoCH BEARISH";
    else if (m5Structure.bos   === "BEARISH") location = "BEARISH BOS";
    else                                      location = "BEARISH STRUCTURE";
  }

  // ---- MESSAGE ----
  let message =
    `12H ${h12Analysis.bias} | 1H ${h1Trend} | 5M ${m5Trend} | ` +
    `RSI ${m5RSI !== null ? m5RSI.toFixed(1) : "—"}`;

  if (status === "BUY")  message += " | ✅ BUY CONFIRMATION";
  if (status === "SELL") message += " | ✅ SELL CONFIRMATION";
  if (extended)          message  = "Move extended — waiting for pullback";

  return {
    symbol: pair,
    label:  config.label,
    emoji:  config.emoji,
    status,
    score,
    message,
    price:      roundPrice(price, pair),
    entry:      roundPrice(entry, pair),
    stopLoss:   roundPrice(stopLoss, pair),
    takeProfit: roundPrice(takeProfit, pair),
    riskReward,
    updated: new Date().toISOString(),
    timeframes: {
      h12: {
        trend:    h12Analysis.bias,
        rsi:      h12Analysis.rsi,
        previous: h12Analysis.previous,
        current:  h12Analysis.current,
        previousCandle: h12Analysis.previousCandle
          ? { open: h12Analysis.previousCandle.open,
              high: h12Analysis.previousCandle.high,
              low:  h12Analysis.previousCandle.low,
              close: h12Analysis.previousCandle.close }
          : null
      },
      h1: { trend: h1Trend, rsi: h1RSI !== null ? Number(h1RSI.toFixed(1)) : null },
      m5: { trend: m5Trend, rsi: m5RSI !== null ? Number(m5RSI.toFixed(1)) : null }
    },
    analysis: {
      direction: status,
      h12SMC:    h12Structure.structure,
      h1SMC:     h1Structure.structure,
      breakout:  breakout.bullish  || breakout.bearish,
      rejection: rejection.bullish || rejection.bearish,
      location,
      extended,
      structure: m5Structure.structure,
      bos:       m5Structure.bos,
      choch:     m5Structure.choch,
      liquidity: m5Structure.liquidity
    }
  };
}

/*
=========================================================
TELEGRAM ALERT
=========================================================
*/

async function sendTelegramSignal(signal) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !alertsEnabled) return;
  if (signal.status !== "BUY" && signal.status !== "SELL") return;

  const dirEmoji = signal.status === "BUY" ? "🟢" : "🔴";
  const arrow    = signal.status === "BUY" ? "⬆️"  : "⬇️";

  const text =
`${dirEmoji} ${signal.status} SIGNAL — ${signal.emoji} ${signal.label}
${arrow} ${signal.status} @ ${signal.entry}

━━━━━━━━━━━━━━━━
📍 Entry:       ${signal.entry}
🛑 Stop Loss:   ${signal.stopLoss}
🎯 Take Profit: ${signal.takeProfit}
💰 Risk/Reward: ${signal.riskReward ?? "1:2"}
━━━━━━━━━━━━━━━━

⭐ Signal Score: ${signal.score}/5

📊 TIMEFRAME ALIGNMENT
   12H → ${signal.timeframes.h12.trend}
   1H  → ${signal.timeframes.h1.trend}
   5M  → ${signal.timeframes.m5.trend}

📈 SMC ANALYSIS
   Structure : ${signal.analysis.structure}
   BOS       : ${signal.analysis.bos}
   CHoCH     : ${signal.analysis.choch}
   Liquidity : ${signal.analysis.liquidity}
   Location  : ${signal.analysis.location}

🔢 RSI (5M): ${signal.timeframes.m5.rsi ?? "—"}

━━━━━━━━━━━━━━━━
⚠️ ALERT ONLY — NOT A TRADE ORDER
Always verify your full checklist
on the chart before entering.
━━━━━━━━━━━━━━━━`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
      }
    );

    if (!response.ok) console.error("Telegram HTTP error:", response.status);
    else console.log(`[TELEGRAM] Signal sent — ${signal.symbol} ${signal.status}`);
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

/*
=========================================================
MARKET CLOSED STATE
=========================================================
*/

function setMarketClosed(pair) {
  const r = state.pairs[pair];
  r.status = "WAIT";
  r.score  = 0;
  r.message = "Market closed — resumes Sunday 22:00 UTC";
  r.price = r.entry = r.stopLoss = r.takeProfit = null;
  r.updated = new Date().toISOString();
  r.timeframes = {
    h12: { trend: "MARKET CLOSED", rsi: null, previous: "UNKNOWN", current: "UNKNOWN", previousCandle: null },
    h1:  { trend: "MARKET CLOSED", rsi: null },
    m5:  { trend: "MARKET CLOSED", rsi: null }
  };
  r.analysis = {
    direction: "WAIT", h12SMC: "MARKET CLOSED", h1SMC: "MARKET CLOSED",
    breakout: false, rejection: false, location: "MARKET CLOSED",
    extended: false, structure: "—", bos: "—", choch: "—", liquidity: "—"
  };
}

/*
=========================================================
GET 1H DATA WITH CACHE
=========================================================
*/

async function getHourlyData(pair) {
  const cached = h1Cache[pair];
  const now    = Date.now();

  if (cached.candles && cached.updated && now - cached.updated < H1_REFRESH_MS) {
    console.log(`[${pair}] Using cached 1H data`);
    return cached.candles;
  }

  console.log(`[${pair}] Fetching fresh 1H data`);
  const hourly = await twelveData(pair, "1h", 300);
  state.api.requestsThisScan++;
  cached.candles = hourly;
  cached.updated = now;
  return hourly;
}

/*
=========================================================
SCAN ONE PAIR
=========================================================
*/

async function scanPair(pair) {
  const result = state.pairs[pair];
  result.updated = new Date().toISOString();

  if (!isMarketOpen()) {
    setMarketClosed(pair);
    return;
  }

  try {
    const hourly = await getHourlyData(pair);
    const h12    = aggregate12HCandles(hourly);
    const h1     = getClosedCandles(hourly, 60).slice(-150);
    const m5     = await twelveData(pair, "5min", 150);
    state.api.requestsThisScan++;

    if (h12.length < 20) throw new Error(`Not enough 12H candles: ${h12.length}`);
    if (h1.length  < 30) throw new Error(`Not enough 1H candles: ${h1.length}`);
    if (m5.length  < 30) throw new Error("Not enough 5M candles");

    const signal    = analyzePair(pair, h12, h1, m5);
    const oldStatus = result.status;

    const isNewBuy  = signal.status === "BUY"  && oldStatus !== "BUY";
    const isNewSell = signal.status === "SELL" && oldStatus !== "SELL";

    if ((isNewBuy || isNewSell) && !isSignalOnCooldown(pair)) {
      if (isNewBuy)  { state.performance.totalSignals++; state.performance.buys++;  }
      if (isNewSell) { state.performance.totalSignals++; state.performance.sells++; }
      await sendTelegramSignal(signal);
      markSignalSent(pair);
    }

    state.pairs[pair] = signal;
    console.log(`[${pair}] ${signal.status} | Score ${signal.score}/5 | ${signal.message}`);

  } catch (err) {
    console.error(`[${pair}] ERROR:`, err.message);
    result.status  = "OFFLINE";
    result.score   = 0;
    result.message = err.message;
    result.updated = new Date().toISOString();
    result.price   = result.entry = result.stopLoss = result.takeProfit = null;
    state.api.lastError = `${pair}: ${err.message}`;
  }
}

/*
=========================================================
SCAN ALL PAIRS
=========================================================
*/

async function scanAll() {
  state.api.requestsThisScan = 0;
  state.api.lastError        = null;

  console.log("====================================");
  console.log(`[SCAN] ${new Date().toISOString()}`);
  console.log("[SCAN] EUR/USD + GBP/USD + USD/JPY");
  console.log(`[SCAN] Market: ${isMarketOpen() ? "OPEN" : "CLOSED"}`);

  if (!isMarketOpen()) {
    for (const pair of PAIRS) setMarketClosed(pair);
    state.lastScan = new Date().toISOString();
    return;
  }

  for (const pair of PAIRS) {
    await scanPair(pair);
    await sleep(2000); // 2s gap — avoids rate limit with 3 pairs
  }

  state.lastScan = new Date().toISOString();
  console.log(`[SCAN COMPLETE] API calls this scan: ${state.api.requestsThisScan}`);
  console.log(`[TOTAL API CALLS] ${state.api.totalRequests}`);
  console.log("====================================");
}

/*
=========================================================
API ROUTES
=========================================================
*/

app.get("/api/status", (req, res) => {
  res.json({
    online:       state.online,
    marketOpen:   isMarketOpen(),
    marketStatus: isMarketOpen() ? "OPEN" : "CLOSED",
    alerts:       alertsEnabled,
    lastScan:     state.lastScan,
    timeframe:    state.timeframe,
    pairs:        state.pairs,
    performance:  state.performance,
    api:          state.api
  });
});

app.get("/api/alerts", (req, res) => {
  res.json({ ok: true, enabled: alertsEnabled });
});

app.post("/api/alerts", (req, res) => {
  alertsEnabled = Boolean(req.body.enabled);
  res.json({ ok: true, enabled: alertsEnabled });
});

app.get("/health", (req, res) => {
  res.json({
    ok:           true,
    pairs:        PAIRS,
    marketOpen:   isMarketOpen(),
    marketStatus: isMarketOpen() ? "OPEN" : "CLOSED",
    time:         new Date().toISOString()
  });
});

app.get("/api", (req, res) => {
  res.json({
    name:        "Rose Forex Monitor",
    version:     "1.0",
    pairs:       PAIRS,
    engine:      "12H + 1H + 5M",
    riskReward:  "1:2",
    cooldown:    "4H per pair",
    marketOpen:  isMarketOpen(),
    message:     "EUR/USD + GBP/USD + USD/JPY signal engine running"
  });
});

/*
=========================================================
START SERVER
=========================================================
*/

app.listen(PORT, async () => {
  console.log("====================================");
  console.log("ROSE FOREX MONITOR v1.0");
  console.log("====================================");
  console.log(`Port     : ${PORT}`);
  console.log(`Market   : ${isMarketOpen() ? "OPEN" : "CLOSED"}`);
  console.log(`API Key  : ${API_KEY ? "CONFIGURED" : "MISSING ⚠️"}`);
  console.log(`Telegram : ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "CONFIGURED" : "NOT CONFIGURED"}`);
  console.log("====================================");
  console.log("PAIRS:");
  console.log("  - EUR/USD  | 5dp | ATR x2.5");
  console.log("  - GBP/USD  | 5dp | ATR x2.5");
  console.log("  - USD/JPY  | 3dp | ATR x2.5");
  console.log("====================================");
  console.log("ENGINE  : 12H + 1H + 5M");
  console.log("SMC     : BOS + CHoCH + LIQUIDITY");
  console.log("SCORE   : 4/5 minimum to fire");
  console.log("COOLDOWN: 4H per pair");
  console.log("R:R     : 1:2 always");
  console.log("====================================");

  try {
    await scanAll();
  } catch (err) {
    console.error("Initial scan error:", err.message);
  }

  setInterval(async () => {
    try {
      await scanAll();
    } catch (err) {
      console.error("Scan loop error:", err.message);
    }
  }, POLL_MS);
});
