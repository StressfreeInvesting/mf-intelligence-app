// /api/config.js — returns public GitHub raw URL (no secrets)
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    dataUrl: `https://raw.githubusercontent.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO || "mf-intelligence-data"}/main/data/fno_signals.json`
  });
}
