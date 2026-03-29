// api/nifty.js — NSE India proxy
// Serves:
//   GET /api/nifty               → Nifty 50 + BankNifty index quotes
//   GET /api/nifty?symbols=RELIANCE,HDFCBANK,TCS
//                                → index quotes + per-stock price & OI data
//
// NSE blocks direct browser calls (CORS). This serverless function does a
// homepage pre-flight to obtain session cookies, then fans out all data
// requests in parallel under that single session.

const NSE_BASE = "https://www.nseindia.com";

const NSE_HEADERS = (cookies = "") => ({
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: `${NSE_BASE}/`,
  Connection: "keep-alive",
  ...(cookies ? { Cookie: cookies } : {}),
});

const INDEX_NAMES = {
  nifty: "NIFTY 50",
  banknifty: "NIFTY BANK",
};

// ── SESSION ────────────────────────────────────────────────────────────────
// NSE requires a real browser session cookie. We hit the homepage first,
// grab set-cookie, then reuse for all subsequent API calls.
async function getNSESession() {
  const res = await fetch(NSE_BASE, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
  });
  // Collect all Set-Cookie values into a single Cookie header string
  const raw = res.headers.get("set-cookie") || "";
  // Parse individual cookie name=value pairs (ignore attributes like path, expires)
  const cookies = raw
    .split(/,(?=[^ ])/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
  return cookies;
}

// ── INDEX QUOTES ───────────────────────────────────────────────────────────
let _indicesCache = null; // reuse within a single invocation (parallel calls)

async function fetchAllIndices(cookies) {
  if (_indicesCache) return _indicesCache;
  const res = await fetch(`${NSE_BASE}/api/allIndices`, {
    headers: NSE_HEADERS(cookies),
  });
  if (!res.ok) throw new Error(`allIndices: HTTP ${res.status}`);
  _indicesCache = await res.json();
  return _indicesCache;
}

async function fetchIndexQuote(key, cookies) {
  const name = INDEX_NAMES[key];
  const data = await fetchAllIndices(cookies);
  const rec = (data?.data || []).find((d) => d.index === name);
  if (!rec) throw new Error(`Index "${name}" not found`);
  return {
    name: rec.index,
    last: rec.last,
    change: rec.variation,
    changePct: rec.percentChange,
    open: rec.open,
    high: rec.high,
    low: rec.low,
    previousClose: rec.previousClose,
    yearHigh: rec["52wHigh"],
    yearLow: rec["52wLow"],
    timestamp: new Date().toISOString(),
  };
}

// ── PER-STOCK EQUITY QUOTE ─────────────────────────────────────────────────
// Returns CMP, 1D change%, open/high/low, 52-week range
async function fetchEquityQuote(symbol, cookies) {
  const url = `${NSE_BASE}/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: NSE_HEADERS(cookies) });
  if (!res.ok) {
    console.warn(`[quote-equity] ${symbol}: HTTP ${res.status}`);
    return null;
  }
  let json;
  try { json = await res.json(); } catch { return null; }

  // NSE response shape: { priceInfo: { lastPrice, change, pChange, open, intraDayHighLow, ... } }
  const p = json?.priceInfo;
  if (!p) return null;

  return {
    symbol,
    price:       p.lastPrice        ?? null,
    change:      p.change           ?? null,   // absolute ₹ change
    changePct:   p.pChange          ?? null,   // % change vs prev close
    open:        p.open             ?? null,
    high:        p.intraDayHighLow?.max ?? null,
    low:         p.intraDayHighLow?.min ?? null,
    prevClose:   p.previousClose    ?? null,
    yearHigh:    p["52WeekHigh"]    ?? null,
    yearLow:     p["52WeekLow"]     ?? null,
    timestamp:   new Date().toISOString(),
  };
}

// ── PER-STOCK F&O / OI DATA ────────────────────────────────────────────────
// Returns OI, OI change, PCR from the derivatives quote endpoint
async function fetchDerivativeQuote(symbol, cookies) {
  const url = `${NSE_BASE}/api/quote-derivative?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: NSE_HEADERS(cookies) });
  if (!res.ok) {
    console.warn(`[quote-derivative] ${symbol}: HTTP ${res.status}`);
    return null;
  }
  let json;
  try { json = await res.json(); } catch { return null; }

  const stocks = json?.stocks || [];

  // Aggregate OI across all contracts (futures + options)
  let totalOI = 0, totalOIChange = 0;
  let nearFutureOI = null, nearFutureOIChg = null;

  for (const s of stocks) {
    const md = s?.marketDeptOrderBook?.tradeInfo;
    if (!md) continue;
    const oi    = Number(md.openInterest       ?? 0);
    const oiChg = Number(md.changeinOpenInterest ?? 0);
    totalOI      += oi;
    totalOIChange += oiChg;
    // Near-month future for a clean single-contract view
    if (s?.metadata?.instrumentType === "Stock Futures" && nearFutureOI === null) {
      nearFutureOI    = oi;
      nearFutureOIChg = oiChg;
    }
  }

  const pcr = json?.putCallRatio?.ratio ?? null;

  return {
    symbol,
    totalOI,
    totalOIChange,
    totalOIChangePct: totalOI
      ? parseFloat(((totalOIChange / (totalOI - totalOIChange)) * 100).toFixed(2))
      : null,
    nearFutureOI,
    nearFutureOIChg,
    pcr,
    oiDirection: totalOIChange > 0 ? "adding" : totalOIChange < 0 ? "unwinding" : "flat",
    timestamp: new Date().toISOString(),
  };
}

// ── MERGE EQUITY + OI → FINAL QUOTE OBJECT ────────────────────────────────
// OI signal classification:
//   Long Buildup   — OI ↑ + Price ↑  (bulls accumulating)
//   Short Buildup  — OI ↑ + Price ↓  (bears accumulating)
//   Long Unwinding — OI ↓ + Price ↓  (bulls exiting)
//   Short Covering — OI ↓ + Price ↑  (bears covering)
function mergeQuote(equity, derivative) {
  if (!equity) return null;

  const priceUp = equity.changePct !== null ? equity.changePct >= 0 : null;
  let oiSignal = "Neutral";

  if (derivative && priceUp !== null) {
    const adding    = derivative.oiDirection === "adding";
    const unwinding = derivative.oiDirection === "unwinding";
    if (adding    &&  priceUp)  oiSignal = "Long Buildup";
    if (adding    && !priceUp)  oiSignal = "Short Buildup";
    if (unwinding && !priceUp)  oiSignal = "Long Unwinding";
    if (unwinding &&  priceUp)  oiSignal = "Short Covering";
  }

  return {
    symbol:          equity.symbol,
    // ── Price ──────────────────────────────────────────────
    price:           equity.price,
    change:          equity.change,
    changePct:       equity.changePct,
    open:            equity.open,
    high:            equity.high,
    low:             equity.low,
    prevClose:       equity.prevClose,
    yearHigh:        equity.yearHigh,
    yearLow:         equity.yearLow,
    // ── OI ─────────────────────────────────────────────────
    oi:              derivative?.totalOI           ?? null,
    oiChange:        derivative?.totalOIChange     ?? null,
    oiChangePct:     derivative?.totalOIChangePct  ?? null,
    nearFutureOI:    derivative?.nearFutureOI      ?? null,
    nearFutureOIChg: derivative?.nearFutureOIChg   ?? null,
    pcr:             derivative?.pcr               ?? null,
    oiSignal,
    timestamp:       equity.timestamp,
  };
}

// ── HANDLER ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET")     { res.status(405).json({ error: "Method not allowed" }); return; }

  // Parse ?symbols=RELIANCE,HDFCBANK,... — uppercase, deduplicated, max 20
  const symbolsParam = req.query?.symbols || "";
  const symbols = symbolsParam
    ? [...new Set(symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))]
    : [];
  const safeSymbols = symbols.slice(0, 20);

  try {
    // 1. Single session cookie for everything
    const cookies = await getNSESession();

    // 2. Small polite delay
    await new Promise((r) => setTimeout(r, 250));

    // 3. Fetch indices + all stocks in one parallel fan-out
    const [nifty, banknifty, ...stockResults] = await Promise.all([
      fetchIndexQuote("nifty",     cookies).catch(() => null),
      fetchIndexQuote("banknifty", cookies).catch(() => null),
      ...safeSymbols.map(async (sym) => {
        const [eq, deriv] = await Promise.all([
          fetchEquityQuote(sym,     cookies).catch(() => null),
          fetchDerivativeQuote(sym, cookies).catch(() => null),
        ]);
        return { symbol: sym, quote: mergeQuote(eq, deriv) };
      }),
    ]);

    // 4. Build quotes map { "SYMBOL": quoteObject }
    const quotes = {};
    for (const sr of stockResults) {
      quotes[sr.symbol] = sr.quote;   // null if both fetches failed
    }

    // 5. Respond — shorter cache when stock quotes present (prices move fast)
    const cacheTTL = safeSymbols.length > 0 ? 30 : 60;
    res.setHeader("Cache-Control", `s-maxage=${cacheTTL}, stale-while-revalidate=15`);

    res.status(200).json({
      success: true,
      data: {
        indices: { nifty, banknifty },
        quotes,
        symbolsRequested: safeSymbols,
        symbolsFetched:   Object.keys(quotes).filter((k) => quotes[k] !== null),
      },
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[nifty.js]", err.message);
    res.status(502).json({
      success: false,
      error: err.message,
      data: { indices: { nifty: null, banknifty: null }, quotes: {} },
      fetchedAt: new Date().toISOString(),
    });
  }
}
