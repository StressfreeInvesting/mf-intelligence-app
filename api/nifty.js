// /api/nifty.js — Index tiles + per-stock quote proxy
// Reads from fno_signals.json (already uploaded daily by admin)
// No external API needed — all data is in your own GitHub repo
//
// GET /api/nifty
// GET /api/nifty?symbols=RELIANCE,HDFCBANK,TCS   (subset of quotes)
// Returns: { indices: { nifty, banknifty, sensex }, quotes: { SYM: {...} }, fetchedAt }

const GH_HEADERS = token => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "MF-Intelligence"
});

async function readJson(owner, repo, path, token) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: GH_HEADERS(token) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
}

// Classify OI signal from premium + score
function classifyOI(signal) {
  const prem  = parseFloat(signal.prem) || 0;
  const score = signal.score || 0;
  const d1    = parseFloat(signal.d1)   || 0;

  // Long buildup: futures premium positive + bullish score + price rising
  if (prem > 0.05 && score > 1 && d1 > 0)  return "Long Buildup";
  // Short buildup: futures at discount + bearish score + price rising (shorts covering or new shorts)
  if (prem < -0.05 && score < -1)           return "Short Buildup";
  // Long unwinding: was long but score falling
  if (prem > 0.05 && score < -0.5)          return "Long Unwinding";
  // Short covering: was short, now recovering
  if (prem < -0.05 && score > 0.5 && d1 > 0) return "Short Covering";
  return "Neutral";
}

// Format an index entry (NIFTY, BANKNIFTY, SENSEX) from signal data
function formatIndex(sym, signal) {
  if (!signal) return null;
  const last      = signal.cl   || 0;
  const prev      = signal.pr   || last;
  const change    = +(last - prev).toFixed(2);
  const changePct = prev ? +((change / prev) * 100).toFixed(2) : 0;

  return {
    symbol:    sym,
    last,
    prev,
    change,
    changePct,
    // FOVOLT doesn't carry intraday H/L — derive ±vol estimate as placeholder
    high: +(last * (1 + Math.abs(parseFloat(signal.vol) || 20) / 10000)).toFixed(2),
    low:  +(last * (1 - Math.abs(parseFloat(signal.vol) || 20) / 10000)).toFixed(2),
    score:  signal.score,
    label:  signal.label,
    prem:   signal.prem,
    vol:    signal.vol,
  };
}

// Format a regular stock quote
function formatQuote(sym, signal) {
  if (!signal) return null;
  const price     = signal.cl || 0;
  const prev      = signal.pr || price;
  const changePct = prev ? +((price - prev) / prev * 100).toFixed(2) : 0;
  const oiSignal  = classifyOI(signal);

  return {
    price,
    prev,
    changePct,
    high:         +(price * (1 + Math.abs(parseFloat(signal.vol) || 25) / 10000)).toFixed(2),
    low:          +(price * (1 - Math.abs(parseFloat(signal.vol) || 25) / 10000)).toFixed(2),
    score:        signal.score,
    label:        signal.label,
    prem:         parseFloat(signal.prem) || 0,
    vol:          parseFloat(signal.vol)  || 0,
    d1:           parseFloat(signal.d1)   || 0,
    d2:           parseFloat(signal.d2)   || 0,
    oiSignal,
    // OI change % approximated from premium × vol (no raw OI in FOVOLT)
    oiChangePct:  +(parseFloat(signal.prem) * parseFloat(signal.vol) || 0).toFixed(2),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache for 60s at CDN level — data only changes once daily
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "GET only" });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER;
  const GITHUB_REPO  = process.env.GITHUB_REPO || "mf-intelligence-data";

  if (!GITHUB_TOKEN || !GITHUB_OWNER) {
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    // Load latest signals (already fetched & cached in GitHub by admin upload)
    const latest = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/fno_signals.json", GITHUB_TOKEN);

    if (!latest || !latest.signals) {
      return res.status(404).json({
        error: "No F&O data available yet. Admin must upload FOVOLT data first.",
        dataAvailable: false
      });
    }

    const signals    = latest.signals;
    const fetchedAt  = new Date().toISOString();
    const dataDate   = latest.meta?.date || null;
    const dataAge    = dataDate
      ? Math.round((Date.now() - new Date(dataDate).getTime()) / 3600000)
      : null;

    // ── Index tiles ─────────────────────────────────────────
    const indices = {
      nifty:     formatIndex("NIFTY",     signals["NIFTY"]),
      banknifty: formatIndex("BANKNIFTY", signals["BANKNIFTY"]),
      sensex:    formatIndex("SENSEX",    signals["SENSEX"]),
      finnifty:  formatIndex("FINNIFTY",  signals["FINNIFTY"]),
    };

    // ── Per-stock quotes ─────────────────────────────────────
    // If ?symbols= param given, return only those; else return all
    const requested = req.query.symbols
      ? req.query.symbols.split(",").map(s => s.trim().toUpperCase())
      : Object.keys(signals);

    const INDEX_SYMS = new Set(["NIFTY","BANKNIFTY","SENSEX","FINNIFTY","NIFTYNXT50","MIDCPNIFTY","BANKEX","SX40","SENSEX50"]);

    const quotes = {};
    requested.forEach(sym => {
      if (INDEX_SYMS.has(sym)) return; // indices handled separately
      if (!signals[sym]) return;
      quotes[sym] = formatQuote(sym, signals[sym]);
    });

    // ── Bullish / bearish leaderboard ────────────────────────
    const ranked = Object.entries(signals)
      .filter(([sym]) => !INDEX_SYMS.has(sym))
      .map(([sym, s]) => ({ sym, score: s.score, label: s.label, cl: s.cl, d1: parseFloat(s.d1) }))
      .sort((a, b) => b.score - a.score);

    const top10Bullish = ranked.filter(s => s.score > 0).slice(0, 10);
    const top10Bearish = ranked.filter(s => s.score < 0).reverse().slice(0, 10);

    // ── Market mood ──────────────────────────────────────────
    const total   = ranked.length;
    const bullish = ranked.filter(s => s.score > 0.3).length;
    const bearish = ranked.filter(s => s.score < -0.3).length;
    const neutral = total - bullish - bearish;
    const mood    = bullish / total > 0.6 ? "Bullish"
                  : bearish / total > 0.6 ? "Bearish"
                  : "Mixed";

    return res.status(200).json({
      dataAvailable: true,
      dataDate,
      dataAge,        // hours since upload
      stockCount: latest.meta?.stockCount || total,
      fetchedAt,
      indices,
      quotes,
      market: { total, bullish, bearish, neutral, mood },
      top10Bullish,
      top10Bearish,
    });

  } catch (e) {
    console.error("NIFTY API ERROR:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
