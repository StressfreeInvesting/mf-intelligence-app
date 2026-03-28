// /api/upload.js — Vercel Serverless Function (Phase 1 — History Management)

const GITHUB_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "MF-Intelligence"
});

// ── GitHub helpers ──────────────────────────────────────────────────────────

async function ghGet(owner, repo, path, token) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers: GITHUB_HEADERS(token) }
  );
  return res;
}

async function ghPut(owner, repo, path, token, message, contentB64, sha = null) {
  const body = { message, content: contentB64 };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { method: "PUT", headers: GITHUB_HEADERS(token), body: JSON.stringify(body) }
  );
  return res;
}

async function ghDelete(owner, repo, path, token, sha, message) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "DELETE",
      headers: GITHUB_HEADERS(token),
      body: JSON.stringify({ message, sha })
    }
  );
  return res;
}

// Get SHA of existing file (null if not found)
async function getSha(owner, repo, path, token) {
  try {
    const res = await ghGet(owner, repo, path, token);
    if (res.ok) {
      const j = await res.json();
      return j.sha;
    }
  } catch (e) {}
  return null;
}

// Save any JSON file to GitHub (create or update)
async function saveJson(owner, repo, path, token, data, commitMsg) {
  const sha = await getSha(owner, repo, path, token);
  const contentB64 = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const res = await ghPut(owner, repo, path, token, commitMsg, contentB64, sha);
  return res.ok;
}

// Read JSON file from GitHub (null if not found)
async function readJson(owner, repo, path, token) {
  try {
    const res = await ghGet(owner, repo, path, token);
    if (!res.ok) return null;
    const j = await res.json();
    const text = Buffer.from(j.content, "base64").toString("utf8");
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ── Date helpers ────────────────────────────────────────────────────────────

// Parse "DD-Mon-YYYY" → Date object
function parseLabelDate(label) {
  try {
    const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    const [dd, mon, yyyy] = label.split("-");
    return new Date(parseInt(yyyy), months[mon], parseInt(dd));
  } catch (e) {
    return null;
  }
}

// Returns "YYYY-MM-DD" from a Date object
function toISO(date) {
  return date.toISOString().split("T")[0];
}

// Returns ISO date string for N days ago
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISO(d);
}

// Is the given date a Friday?
function isFriday(date) {
  return date.getDay() === 5;
}

// Get ISO week string "YYYY-WNN"
function getWeekLabel(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// ── Data validation ─────────────────────────────────────────────────────────

function validateSignals(signals) {
  const errors = [];
  const symbols = Object.keys(signals);

  if (symbols.length < 100) errors.push(`Only ${symbols.length} stocks — expected 150+. Wrong file?`);
  if (symbols.length > 600) errors.push(`${symbols.length} stocks seems too high. Check file.`);

  let zeroPrice = 0, nanScore = 0;
  symbols.forEach(sym => {
    const s = signals[sym];
    if (!s.cl || s.cl === 0) zeroPrice++;
    if (isNaN(s.score)) nanScore++;
  });

  if (zeroPrice > 10) errors.push(`${zeroPrice} stocks have zero close price — data quality issue.`);
  if (nanScore > 10) errors.push(`${nanScore} stocks have invalid scores — check CSV columns.`);

  return errors;
}

// ── Weekly summary generator ────────────────────────────────────────────────

function generateWeeklySummary(dailyFiles) {
  // dailyFiles: array of { date, signals }
  if (!dailyFiles.length) return null;

  const allSymbols = new Set();
  dailyFiles.forEach(f => Object.keys(f.signals).forEach(s => allSymbols.add(s)));

  const weekly = {};
  allSymbols.forEach(sym => {
    const days = dailyFiles.filter(f => f.signals[sym]);
    if (!days.length) return;

    const scores = days.map(f => f.signals[sym].score);
    const avgScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
    const latestDay = days[days.length - 1].signals[sym];
    const firstDay = days[0].signals[sym];

    const trend = avgScore >= 2 ? "Strong Bullish"
      : avgScore >= 1 ? "Bullish"
      : avgScore >= 0.3 ? "Mild Bullish"
      : avgScore <= -2 ? "Strong Bearish"
      : avgScore <= -1 ? "Bearish"
      : avgScore <= -0.3 ? "Mild Bearish"
      : "Neutral";

    const consistentDays = scores.filter(s => s > 0.3).length;
    const consistencyPct = Math.round((consistentDays / scores.length) * 100);

    weekly[sym] = {
      avgScore,
      trend,
      consistencyPct,
      daysTracked: days.length,
      weekChange: latestDay.cl && firstDay.pr
        ? Math.round(((latestDay.cl - firstDay.pr) / firstDay.pr) * 10000) / 100
        : 0,
      latestScore: latestDay.score,
      latestLabel: latestDay.label,
      cl: latestDay.cl
    };
  });

  return weekly;
}

// ── 90-day cleanup ──────────────────────────────────────────────────────────

async function cleanupOldFiles(owner, repo, token, index) {
  const cutoff = daysAgo(90);
  const toDelete = (index.dates || []).filter(d => d < cutoff);

  for (const dateStr of toDelete) {
    const path = `data/history/${dateStr}.json`;
    const sha = await getSha(owner, repo, path, token);
    if (sha) {
      await ghDelete(owner, repo, path, token, sha, `Auto-cleanup: remove ${dateStr} (>90 days)`);
      console.log("Deleted old file:", dateStr);
    }
  }

  // Return updated index without deleted dates
  return {
    ...index,
    dates: (index.dates || []).filter(d => d >= cutoff)
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER   = process.env.GITHUB_OWNER;
  const GITHUB_REPO    = process.env.GITHUB_REPO || "mf-intelligence-data";

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Server not configured. Set environment variables in Vercel." });
  }

  try {
    const body = req.body;

    // ── Auth ──
    if (body.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Wrong password" });
    }

    // ── DELETE action ──
    if (body.action === "delete") {
      const dateToDelete = body.deleteDate;
      if (!dateToDelete || !dateToDelete.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
      }
      const histPath = `data/history/${dateToDelete}.json`;
      const sha = await getSha(GITHUB_OWNER, GITHUB_REPO, histPath, GITHUB_TOKEN);
      if (!sha) {
        return res.status(404).json({ error: `No data found for ${dateToDelete}` });
      }
      await ghDelete(GITHUB_OWNER, GITHUB_REPO, histPath, GITHUB_TOKEN, sha, `Delete history: ${dateToDelete}`);
      // Update index
      let index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN) || { dates: [] };
      index.dates = (index.dates || []).filter(d => d !== dateToDelete);
      index.lastUpdated = new Date().toISOString();
      await saveJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN, index, `Remove ${dateToDelete} from index`);
      return res.status(200).json({ success: true, deleted: dateToDelete });
    }

    if (!body.signals || typeof body.signals !== "object") {
      return res.status(400).json({ error: "No signal data provided" });
    }

    // ── Validate signals ──
    const validationErrors = validateSignals(body.signals);
    if (validationErrors.length) {
      return res.status(400).json({ error: "Data validation failed", details: validationErrors });
    }

    // ── Determine upload date ──
    const uploadDate = parseLabelDate(body.latestDate);
    if (!uploadDate) {
      return res.status(400).json({ error: "Could not parse date from filename. Expected DD-Mon-YYYY format." });
    }
    const isoDate = toISO(uploadDate);

    // ── Load index.json ──
    let index = await readJson(GITHUB_OWNER, GITHUB_REPO, "data/index.json", GITHUB_TOKEN) || {
      dates: [],
      lastUpdated: null,
      totalUploads: 0
    };

    // ── Duplicate date check ──
    if (index.dates && index.dates.includes(isoDate)) {
      return res.status(409).json({
        error: `Data for ${isoDate} already uploaded. Delete it first if you want to re-upload.`,
        duplicate: true,
        date: isoDate
      });
    }

    const stockCount = Object.keys(body.signals).length;

    // ── Build payload ──
    const payload = {
      signals: body.signals,
      meta: {
        date: isoDate,
        updatedAt: new Date().toISOString(),
        files: body.files || [],
        stockCount,
        latestDate: body.latestDate
      }
    };

    // ── 1. Save latest (fno_signals.json) ──
    const savedLatest = await saveJson(
      GITHUB_OWNER, GITHUB_REPO,
      "data/fno_signals.json",
      GITHUB_TOKEN, payload,
      `Update latest signals — ${body.latestDate} (${stockCount} stocks)`
    );

    // ── 2. Save daily history file ──
    const savedHistory = await saveJson(
      GITHUB_OWNER, GITHUB_REPO,
      `data/history/${isoDate}.json`,
      GITHUB_TOKEN, payload,
      `History: ${isoDate} (${stockCount} stocks)`
    );

    // ── 3. Update index.json ──
    index.dates = [...(index.dates || []), isoDate].sort();
    index.lastUpdated = new Date().toISOString();
    index.totalUploads = (index.totalUploads || 0) + 1;
    index.latestDate = isoDate;
    index.latestStockCount = stockCount;

    // Run cleanup — remove files older than 90 days
    index = await cleanupOldFiles(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, index);

    await saveJson(
      GITHUB_OWNER, GITHUB_REPO,
      "data/index.json",
      GITHUB_TOKEN, index,
      `Update index — ${isoDate}`
    );

    // ── 4. Weekly summary (generate on Fridays) ──
    let weeklySaved = false;
    if (isFriday(uploadDate)) {
      const weekLabel = getWeekLabel(uploadDate);
      console.log("Friday detected — generating weekly summary:", weekLabel);

      // Load this week's daily files
      const weekDates = index.dates.filter(d => {
        const dt = new Date(d);
        return getWeekLabel(dt) === weekLabel;
      });

      const weeklyFiles = [];
      for (const d of weekDates) {
        const dayData = await readJson(GITHUB_OWNER, GITHUB_REPO, `data/history/${d}.json`, GITHUB_TOKEN);
        if (dayData) weeklyFiles.push({ date: d, signals: dayData.signals });
      }

      if (weeklyFiles.length >= 3) {
        const weeklySummary = generateWeeklySummary(weeklyFiles);
        await saveJson(
          GITHUB_OWNER, GITHUB_REPO,
          `data/weekly/${weekLabel}.json`,
          GITHUB_TOKEN,
          {
            week: weekLabel,
            generatedAt: new Date().toISOString(),
            daysIncluded: weekDates,
            stockCount: Object.keys(weeklySummary).length,
            signals: weeklySummary
          },
          `Weekly summary: ${weekLabel} (${weekDates.length} days)`
        );
        weeklySaved = true;
        console.log("Weekly summary saved:", weekLabel);
      }
    }

    // ── Response ──
    return res.status(200).json({
      success: true,
      stockCount,
      date: body.latestDate,
      isoDate,
      savedLatest,
      savedHistory,
      weeklySaved,
      totalDaysInHistory: index.dates.length,
      message: weeklySaved
        ? `✅ Uploaded + weekly summary generated (${getWeekLabel(uploadDate)})`
        : `✅ Uploaded successfully — ${index.dates.length} days in history`
    });

  } catch (e) {
    console.error("UPLOAD ERROR:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
