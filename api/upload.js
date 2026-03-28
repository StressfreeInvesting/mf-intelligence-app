// /api/upload.js — Vercel Serverless Function
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER;
  const GITHUB_REPO = process.env.GITHUB_REPO || "mf-intelligence-data";
  const DATA_PATH = "data/fno_signals.json";

  // DEBUG LOGS
  console.log("=== UPLOAD DEBUG ===");
  console.log("OWNER:", GITHUB_OWNER);
  console.log("REPO:", GITHUB_REPO);
  console.log("TOKEN prefix:", GITHUB_TOKEN?.substring(0, 15));
  console.log("PASSWORD set:", !!ADMIN_PASSWORD);

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Server not configured. Set environment variables in Vercel." });
  }

  try {
    const body = req.body;
    if (body.password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Wrong password" });
    }
    if (!body.signals || typeof body.signals !== "object") {
      return res.status(400).json({ error: "No signal data provided" });
    }

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

    // Get existing file SHA
    let sha = null;
    try {
      const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`;
      console.log("GET URL:", url);
      const existing = await fetch(url, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "User-Agent": "MF-Intelligence" }
      });
      console.log("GET status:", existing.status);
      if (existing.ok) {
        const ej = await existing.json();
        sha = ej.sha;
        console.log("Existing SHA found:", sha?.substring(0, 10));
      }
    } catch (e) {
      console.log("GET error (ok if first upload):", e.message);
    }

    // Push to GitHub
    const ghBody = {
      message: `Update F&O signals — ${body.latestDate || "update"} (${Object.keys(body.signals).length} stocks)`,
      content: content
    };
    if (sha) ghBody.sha = sha;

    const putUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`;
    console.log("PUT URL:", putUrl);
    const ghResp = await fetch(putUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "MF-Intelligence"
      },
      body: JSON.stringify(ghBody)
    });

    console.log("PUT status:", ghResp.status);

    if (ghResp.ok) {
      return res.status(200).json({
        success: true,
        stockCount: Object.keys(body.signals).length,
        date: body.latestDate
      });
    } else {
      const err = await ghResp.json();
      console.log("PUT error:", JSON.stringify(err));
      return res.status(500).json({ error: "GitHub error: " + (err.message || ghResp.status) });
    }
  } catch (e) {
    console.log("CATCH error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
