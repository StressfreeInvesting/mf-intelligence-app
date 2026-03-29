// /api/history.js — Historical F&O data + decay-weighted trend analysis
// Endpoints:
//   GET ?latest=1                          → latest fno_signals.json + history count
//   GET ?type=index                        → list of available dates
//   GET ?type=day&date=YYYY-MM-DD          → specific day's data
//   GET ?type=trends[&days=N]              → decay-weighted multi-day trend summary
//   GET ?type=weekly&date=YYYY-WNN         → weekly summary file
//   GET ?type=pricehistory&symbols=A,B,C   → per-stock close prices across N days (for true multi-day returns)

// ── Config ──────────────────────────────────────────────────────────────────
// Decay factor for exponential weighting of trend scores.
// 0.2 = mild recency bias (smoother). Higher = more recent days dominate.
const DECAY = 0.2;

const GH_HEADERS = token => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "MF-Intelligence"
});

// ── GitHub helper ────────────────────────────────────────────────────────────
async function readJson(owner, repo, path, token) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: GH_HEADERS(token) }
    );
    if (!res.ok) return null;
    const j    = await res.json();
    const text = Buffer.from(j.content, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ── Exponential decay weights ────────────────────────────────────────────────
// Oldest day (i=0) gets weight e^(0) = 1.
// Newest day (i=N-1) gets weight e^(DECAY*(N-1)) — larger = more recent bias.
// All weights are normalised so they sum to 1.
function decayWeights(n, decay = DECAY) {
  const raw = Array.from({ length: n }, (_, i) => Math.exp(decay * i));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(w => w / sum);
}

// ── Decay-weighted trend computation ────────────────────────────────────────
function computeTrends(dailyDataArr, decay = DECAY) {
  // dailyDataArr: [{ date, signals }] sorted oldest→newest
  const stockMap = {};

  dailyDataArr.forEach(({ date, signals }) => {
    if (!signals) return;
    Object.keys(signals).forEach(sym => {
      if (!stockMap[sym]) stockMap[sym] = [];
      stockMap[sym].push({
        date,
        score: signals[sym].score,
        label: signals[sym].label,
        cl:    signals[sym].cl,   // close price — used for true price history
        pr:    signals[sym].pr,   // previous close
      });
    });
  });

  const trends = {};

  Object.keys(stockMap).forEach(sym => {
    const days   = stockMap[sym].sort((a, b) => a.date.localeCompare(b.date));
    const n      = days.length;
    const scores = days.map(d => d.score);
    const w      = decayWeights(n, decay);

    // ── Weighted average score ──
    const weightedAvg = scores.reduce((acc, s, i) => acc + s * w[i], 0);
    const avgScore    = Math.round(weightedAvg * 100) / 100;

    // ── Simple metrics ──
    const bullishDays    = scores.filter(s => s > 0.3).length;
    const bearishDays    = scores.filter(s => s < -0.3).length;

    // ── Weighted consistency: days weighted by recency, bullish wins ──
    const weightedBullishPct = scores.reduce((acc, s, i) => acc + (s > 0.3 ? w[i] : 0), 0);
    const consistencyPct     = Math.round(weightedBullishPct * 100);

    // ── Momentum: compare weighted avg of first half vs second half ──
    const mid        = Math.floor(n / 2);
    const firstHalf  = scores.slice(0, mid || 1);
    const secondHalf = scores.slice(mid);
    const firstAvg   = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg  = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const momentum   = secondAvg - firstAvg >  0.2 ? "improving"
                     : secondAvg - firstAvg < -0.2 ? "declining"
                     : "stable";

    // ── Positional strength: uses weighted consistency for grading ──
    const positionalStrength = consistencyPct >= 70 && momentum !== "declining" ? "Strong"
                             : consistencyPct >= 55                              ? "Moderate"
                             : consistencyPct >= 35                              ? "Weak"
                             : "Avoid";

    // ── True price return across tracked period ──
    const first       = days[0];
    const last        = days[n - 1];
    const periodReturn = first.pr && last.cl
      ? Math.round(((last.cl - first.pr) / first.pr) * 10000) / 100
      : null;

    // ── Scores array with date labels for sparkline ──
    const scoreSeries = days.map(d => ({ date: d.date, score: d.score, cl: d.cl }));

    trends[sym] = {
      daysTracked:      n,
      avgScore,                    // decay-weighted
      consistencyPct,              // decay-weighted bullish %
      bullishDays,
      bearishDays,
      momentum,
      positionalStrength,
      scores,                      // raw score array (oldest → newest)
      scoreSeries,                 // with dates + close prices
      latestScore: scores[n - 1],
      latestLabel: days[n - 1].label,
      latestCl:    last.cl,
      periodReturn,                // true % return over tracked period
      decayFactor:  decay,
    };
  });

  return trends;
}

// ── Price history builder ────────────────────────────────────────────────────
// Returns per-stock close prices indexed by date — for client-side true multi-day return calc.
function buildPriceHistory(dailyDataArr, symbols) {
  const symSet = symbols ? new Set(symbols.map(s => s.toUpperCase())) : null;
  const result = {};

  dailyDataArr.forEach(({ date, signals }) => {
    if (!signals) return;
    Object.keys(signals).forEach(sym => {
      if (symSet && !symSet.has(sym)) return;
      if (!result[sym]) result[sym] = [];
      result[sym].push({
        date,
        cl: signals[sym].cl,
        pr: signals[sym].pr,
        score: signals[sym].score,
      });
    });
  });

  // Sort each stock's history oldest → newest and compute true daily returns
  Object.keys(result).forEach(sym => {
    result[sym].sort((a, b) => a.date.localeCompare(b.date));

    // Compute true 1D return for each day using consecutive cl values
    for (let i = 1; i < result[sym].length; i++) {
      const prev = result[sym][i - 1].cl;
      const curr = result[sym][i].cl;
      result[sym][i].true1D = prev ? +((curr - prev) / prev * 100).toFixed(2) : null;
    }
    result[sym][0].true1D = null; // no previous day for first entry

    // Compute true N-day return from first day's pr
    const first = result[sym][0];
    result[sym].forEach(d => {
      d.trueND = first.pr && d.cl
        ? +((d.cl - first.pr) / first.pr * 100).toFixed(2)
        : null;
    });
  });

  return result;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "GET only" });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER;
  const GITHUB_REPO  = process.env.GITHUB_REPO || "mf-intelligence-data";

  if (!GITHUB_TOKEN || !GITHUB_OWNER) {
    return res.status(500).json({ error: "Server not configured." });
  }

  const { type, date, days, symbols } = req.query;

  try {

    // ── 0. LATEST — fno_signals.json + history count ───────────────────────
    if (req.query.latest === "1" || req.query.latest === "true") {
      const [latest, index] = await Promise.all([
        readJson(GITHUB_OWNER, GITHUB_REPO, "data/fno_signals.json", GITHUB_TOKEN),
        readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json",       GITHUB_TOKEN),
      ]);
      if (!latest) {
        return res.status(404).json({
          error: "No F&O data yet. Upload via admin.",
          dataAvailable: false
        });
      }
      const historyCount = index?.dates?.length || 0;
      const dataDate     = latest.meta?.date || null;
      const dataAge      = dataDate
        ? Math.round((Date.now() - new Date(dataDate).getTime()) / 3600000)
        : null;

      return res.status(200).json({
        ...latest,
        historyCount,
        date:        dataDate,
        uploadDate:  dataDate,
        dataAge,
        availableDates: index?.dates || [],
        dataAvailable: true,
      });
    }

    // ── 1. INDEX — list of all available dates ─────────────────────────────
    if (type === "index" || !type) {
      const index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN);
      if (!index) return res.status(404).json({ error: "No history yet. Upload data first." });
      return res.status(200).json(index);
    }

    // ── 2. SPECIFIC DAY ────────────────────────────────────────────────────
    if (type === "day") {
      if (!date) return res.status(400).json({ error: "date param required (YYYY-MM-DD)" });
      const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/history/${date}.json`, GITHUB_TOKEN);
      if (!data) return res.status(404).json({ error: `No data for ${date}` });
      return res.status(200).json(data);
    }

    // ── 3. TRENDS — decay-weighted multi-day consistency ──────────────────
    if (type === "trends") {
      const nDays   = Math.min(30, Math.max(2, parseInt(days) || 5));
      const decay   = parseFloat(req.query.decay) || DECAY;

      const index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN);
      if (!index?.dates?.length || index.dates.length < 2) {
        return res.status(200).json({
          trends:       {},
          daysRequested: nDays,
          daysAvailable: 0,
          decayFactor:   decay,
          message:      "Not enough history yet. Keep uploading daily."
        });
      }

      const recentDates   = index.dates.slice(-nDays);
      const dailyDataArr  = await Promise.all(
        recentDates.map(async d => {
          const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/history/${d}.json`, GITHUB_TOKEN);
          return { date: d, signals: data?.signals || null };
        })
      );

      const validDays = dailyDataArr.filter(d => d.signals !== null);
      const trends    = computeTrends(validDays, decay);

      // ── Leaderboards ──
      const strong = Object.entries(trends)
        .filter(([, t]) => t.positionalStrength === "Strong" && t.daysTracked >= 3)
        .sort(([, a], [, b]) => b.consistencyPct - a.consistencyPct || b.avgScore - a.avgScore)
        .slice(0, 15)
        .map(([sym, t]) => ({ sym, ...t }));

      const top10Bullish = Object.entries(trends)
        .filter(([, t]) => t.latestScore > 0.3 && t.daysTracked >= 2)
        .sort(([, a], [, b]) => {
          const aR = a.consistencyPct * 0.5 + a.avgScore * 10;
          const bR = b.consistencyPct * 0.5 + b.avgScore * 10;
          return bR - aR;
        })
        .slice(0, 10)
        .map(([sym, t]) => ({ sym, ...t }));

      const top5Bearish = Object.entries(trends)
        .filter(([, t]) => t.latestScore < -0.3 && t.daysTracked >= 2)
        .sort(([, a], [, b]) => a.avgScore - b.avgScore)
        .slice(0, 5)
        .map(([sym, t]) => ({ sym, ...t }));

      return res.status(200).json({
        trends,
        strong,
        top10Bullish,
        top5Bearish,
        daysRequested:  nDays,
        daysAvailable:  validDays.length,
        dates:          recentDates,
        decayFactor:    decay,
        generatedAt:    new Date().toISOString(),
      });
    }

    // ── 4. PRICE HISTORY — true multi-day returns per stock ───────────────
    if (type === "pricehistory") {
      const nDays  = Math.min(30, Math.max(2, parseInt(days) || 10));
      const syms   = symbols ? symbols.split(",").map(s => s.trim().toUpperCase()) : null;

      const index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN);
      if (!index?.dates?.length) {
        return res.status(200).json({ priceHistory: {}, daysAvailable: 0 });
      }

      const recentDates  = index.dates.slice(-nDays);
      const dailyDataArr = await Promise.all(
        recentDates.map(async d => {
          const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/history/${d}.json`, GITHUB_TOKEN);
          return { date: d, signals: data?.signals || null };
        })
      );

      const validDays    = dailyDataArr.filter(d => d.signals !== null);
      const priceHistory = buildPriceHistory(validDays, syms);

      return res.status(200).json({
        priceHistory,
        daysAvailable: validDays.length,
        dates:         validDays.map(d => d.date),
        generatedAt:   new Date().toISOString(),
      });
    }

    // ── 5. WEEKLY ──────────────────────────────────────────────────────────
    if (type === "weekly") {
      if (!date) return res.status(400).json({ error: "date param required (YYYY-WNN)" });
      const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/weekly/${date}.json`, GITHUB_TOKEN);
      if (!data)  return res.status(404).json({ error: `No weekly data for ${date}` });
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: "Invalid type. Use: index | day | trends | pricehistory | weekly" });

  } catch (e) {
    console.error("HISTORY ERROR:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
