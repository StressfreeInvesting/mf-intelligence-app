// api/nifty.js — NSE India proxy for Nifty 50 & BankNifty live quotes
// Vercel serverless function. No API key required — NSE is publicly accessible.
// NSE requires browser-like headers + a session cookie obtained via a pre-flight.

const NSE_BASE = "https://www.nseindia.com";

const INDICES = {
  nifty: "NIFTY 50",
  banknifty: "NIFTY BANK",
};

async function getNSESession() {
  const res = await fetch(NSE_BASE, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
  });
  const cookies = res.headers.get("set-cookie") || "";
  return cookies;
}

async function fetchIndexQuote(indexName, cookies) {
  const url = `${NSE_BASE}/api/allIndices`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: `${NSE_BASE}/`,
      Cookie: cookies,
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) throw new Error(`NSE responded ${res.status}`);
  const data = await res.json();

  const indices = data?.data || [];
  const record = indices.find((d) => d.index === indexName);
  if (!record) throw new Error(`Index "${indexName}" not found in NSE response`);

  return {
    name: record.index,
    last: record.last,
    change: record.variation,
    changePct: record.percentChange,
    open: record.open,
    high: record.high,
    low: record.low,
    previousClose: record.previousClose,
    yearHigh: record["52wHigh"],
    yearLow: record["52wLow"],
    timestamp: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  // CORS — allow the app origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // Step 1: get session cookies from NSE homepage
    const cookies = await getNSESession();

    // Step 2: small delay to mimic browser behaviour
    await new Promise((r) => setTimeout(r, 300));

    // Step 3: fetch both indices in parallel
    const [nifty, banknifty] = await Promise.all([
      fetchIndexQuote(INDICES.nifty, cookies),
      fetchIndexQuote(INDICES.banknifty, cookies),
    ]);

    // Cache for 60 seconds on Vercel edge
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    res.status(200).json({
      success: true,
      data: { nifty, banknifty },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[nifty.js]", err.message);

    // Fallback — return a structured error so the UI can show stale/unavailable
    res.status(502).json({
      success: false,
      error: err.message,
      data: {
        nifty: null,
        banknifty: null,
      },
      fetchedAt: new Date().toISOString(),
    });
  }
}
