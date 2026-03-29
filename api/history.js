// /api/history.js — Serve historical F&O data for trend analysis
// Returns: index of dates, specific day data, or multi-day trend summary

const GITHUB_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "MF-Intelligence"
});

async function readJson(owner, repo, path, token) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: GITHUB_HEADERS(token) }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const text = Buffer.from(j.content, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// Compute consistency score for each stock across N days
function computeTrends(dailyDataArr) {
  const stockMap = {};

  dailyDataArr.forEach(({ date, signals }) => {
    if (!signals) return;
    Object.keys(signals).forEach(sym => {
      if (!stockMap[sym]) stockMap[sym] = [];
      stockMap[sym].push({ date, score: signals[sym].score, label: signals[sym].label });
    });
  });

  const trends = {};
  Object.keys(stockMap).forEach(sym => {
    const days = stockMap[sym].sort((a, b) => a.date.localeCompare(b.date));
    const scores = days.map(d => d.score);
    const n = scores.length;

    const avgScore = Math.round((scores.reduce((a, b) => a + b, 0) / n) * 100) / 100;
    const bullishDays = scores.filter(s => s > 0.3).length;
    const bearishDays = scores.filter(s => s < -0.3).length;
    const consistencyPct = Math.round((bullishDays / n) * 100);

    const firstHalf = scores.slice(0, Math.floor(n / 2));
    const secondHalf = scores.slice(Math.floor(n / 2));
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const momentum = secondAvg - firstAvg > 0.2 ? "improving"
      : secondAvg - firstAvg < -0.2 ? "declining"
      : "stable";

    const positionalStrength = consistencyPct >= 70 && momentum === "improving" ? "Strong"
      : consistencyPct >= 60 ? "Moderate"
      : consistencyPct >= 40 ? "Weak"
      : "Avoid";

    trends[sym] = {
      daysTracked: n,
      avgScore,
      consistencyPct,
      bullishDays,
      bearishDays,
      momentum,
      positionalStrength,
      scores,
      latestScore: scores[n - 1],
      latestLabel: days[n - 1].label
    };
  });

  return trends;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER;
  const GITHUB_REPO  = process.env.GITHUB_REPO || "mf-intelligence-data";

  if (!GITHUB_TOKEN || !GITHUB_OWNER) {
    return res.status(500).json({ error: "Server not configured." });
  }

  const { type, date, days } = req.query;

  try {

    // ── 0. GET LATEST — returns fno_signals.json + history count ──
    // Called by V8 index.html as: fetch('/api/history?latest=1')
    if (req.query.latest === '1' || req.query.latest === 'true') {
      const [latest, index] = await Promise.all([
        readJson(GITHUB_OWNER, GITHUB_REPO, "data/fno_signals.json", GITHUB_TOKEN),
        readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN)
      ]);
      if (!latest) {
        return res.status(404).json({ error: "No F&O data yet. Upload via admin." });
      }
      const historyCount = (index?.dates?.length) || 0;
      return res.status(200).json({
        ...latest,
        historyCount,
        date: latest.meta?.date || null,
        uploadDate: latest.meta?.date || null
      });
    }

    // ── 1. GET INDEX — list of all available dates ──
    if (type === "index" || !type) {
      const index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN);
      if (!index) return res.status(404).json({ error: "No history yet. Upload data first." });
      return res.status(200).json(index);
    }

    // ── 2. GET SPECIFIC DAY ──
    if (type === "day") {
      if (!date) return res.status(400).json({ error: "date param required (YYYY-MM-DD)" });
      const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/history/${date}.json`, GITHUB_TOKEN);
      if (!data) return res.status(404).json({ error: `No data for ${date}` });
      return res.status(200).json(data);
    }

    // ── 3. GET TRENDS — multi-day consistency scores ──
    if (type === "trends") {
      const nDays = Math.min(30, Math.max(2, parseInt(days) || 5));

      const index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN);
      if (!index || !index.dates || index.dates.length < 2) {
        return res.status(200).json({
          trends: {},
          daysRequested: nDays,
          daysAvailable: 0,
          message: "Not enough history yet. Keep uploading daily."
        });
      }

      const recentDates = index.dates.slice(-nDays);

      const dailyDataArr = await Promise.all(
        recentDates.map(async d => {
          const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/history/${d}.json`, GITHUB_TOKEN);
          return { date: d, signals: data ? data.signals : null };
        })
      );

      const validDays = dailyDataArr.filter(d => d.signals !== null);
      const trends = computeTrends(validDays);

      const top10Bullish = Object.entries(trends)
        .filter(([, t]) => t.latestScore > 0.3 && t.daysTracked >= 2)
        .sort(([, a], [, b]) => {
          const aRank = a.consistencyPct * 0.6 + a.latestScore * 8;
          const bRank = b.consistencyPct * 0.6 + b.latestScore * 8;
          return bRank - aRank;
        })
        .slice(0, 10)
        .map(([sym, t]) => ({ sym, ...t }));

      const top5Bearish = Object.entries(trends)
        .filter(([, t]) => t.latestScore < -0.3 && t.daysTracked >= 2)
        .sort(([, a], [, b]) => a.latestScore - b.latestScore)
        .slice(0, 5)
        .map(([sym, t]) => ({ sym, ...t }));

      return res.status(200).json({
        trends,
        top10Bullish,
        top5Bearish,
        daysRequested: nDays,
        daysAvailable: validDays.length,
        dates: recentDates,
        generatedAt: new Date().toISOString()
      });
    }

    // ── 4. GET WEEKLY ──
    if (type === "weekly") {
      const weekLabel = date;
      if (!weekLabel) return res.status(400).json({ error: "date param required (YYYY-WNN)" });
      const data = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/weekly/${weekLabel}.json`, GITHUB_TOKEN);
      if (!data) return res.status(404).json({ error: `No weekly data for ${weekLabel}` });
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: "Invalid type. Use: index, day, trends, weekly" });

  } catch (e) {
    console.error("HISTORY ERROR:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
