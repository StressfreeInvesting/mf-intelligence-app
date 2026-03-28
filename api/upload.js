// /api/upload.js — Vercel Serverless Function
// Receives parsed F&O data from admin, pushes to GitHub
// Token is in Vercel Environment Variables (never exposed to browser)

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Environment variables (set in Vercel dashboard)
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER;
  const GITHUB_REPO = process.env.GITHUB_REPO || "mf-intelligence-data";
  const DATA_PATH = "data/fno_signals.json";

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Server not configured. Set environment variables in Vercel." });
  }

  try {
    const body = req.body;

    // Verify admin password
    if (body.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Wrong password" });
    }

    if (!body.signals || typeof body.signals !== "object") {
      return res.status(400).json({ error: "No signal data provided" });
    }

    // Prepare payload
    const payload = {
      signals: body.signals,
      meta: {
        updatedAt: new Date().toISOString(),
        files: body.files || [],
        stockCount: Object.keys(body.signals).length,
        latestDate: body.latestDate || "Unknown"
      }
    };

    const content = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");

    // Get existing file SHA (needed for GitHub update)
    let sha = null;
    try {
      const existing = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`,
        { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "MF-Intelligence" } }
      );
      if (existing.ok) {
        const ej = await existing.json();
        sha = ej.sha;
      }
    } catch (e) { /* file doesn't exist yet, that's fine */ }

    // Push to GitHub
    const ghBody = {
      message: `Update F&O signals — ${body.latestDate || "update"} (${Object.keys(body.signals).length} stocks)`,
      content: content
    };
    if (sha) ghBody.sha = sha;

    const ghResp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "MF-Intelligence"
        },
        body: JSON.stringify(ghBody)
      }
    );

    if (ghResp.ok) {
      return res.status(200).json({
        success: true,
        stockCount: Object.keys(body.signals).length,
        date: body.latestDate
      });
    } else {
      const err = await ghResp.json();
      return res.status(500).json({ error: "GitHub error: " + (err.message || ghResp.status) });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
