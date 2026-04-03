// /api/news.js — RSS news proxy
// Fetches Moneycontrol + ET Markets RSS server-side (bypasses browser CORS)
// Parses XML, detects stock mentions, returns clean JSON
// GET /api/news           → latest 20 news items with stock tags
// GET /api/news?limit=10  → limit items per source

const RSS_SOURCES = [
  {
    name: 'Moneycontrol',
    url: 'https://www.moneycontrol.com/rss/marketreports.xml',
    color: '#1a73e8',
  },
  {
    name: 'ET Markets',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    color: '#ff6b00',
  },
];

// Stock name → NSE symbol map for mention detection
// Covers full names, short names, and common aliases used in news headlines
const STOCK_MENTIONS = {
  // Banks
  'HDFC Bank':'HDFCBANK','HDFC':'HDFCBANK','ICICI Bank':'ICICIBANK','ICICI':'ICICIBANK',
  'SBI':'SBIN','State Bank':'SBIN','Axis Bank':'AXISBANK','Kotak':'KOTAKBANK',
  'Kotak Bank':'KOTAKBANK','IndusInd':'INDUSINDBK','Yes Bank':'YESBANK',
  'Bandhan':'BANDHANBNK','AU Small Finance':'AUBANK','PNB':'PNB','Canara Bank':'CANBK',
  'Bank of Baroda':'BANKBARODA','Federal Bank':'FEDERALBNK',
  // IT
  'Infosys':'INFY','TCS':'TCS','Tata Consultancy':'TCS','HCL Tech':'HCLTECH',
  'Wipro':'WIPRO','Tech Mahindra':'TECHM','Persistent':'PERSISTENT',
  'Coforge':'COFORGE','Mphasis':'MPHASIS','LTIMindtree':'LTM',
  // Pharma
  'Sun Pharma':'SUNPHARMA','Cipla':'CIPLA','Dr Reddy':'DRREDDY',"Divi's":"DIVISLAB",
  'Lupin':'LUPIN','Aurobindo':'AUROPHARMA','Zydus':'ZYDUSLIFE','Alkem':'ALKEM',
  'Biocon':'BIOCON','Laurus':'LAURUSLABS',
  // Auto
  'Maruti':'MARUTI','Tata Motors':'TATAMOTORS','Mahindra':'M&M','M&M':'M&M',
  'Hero MotoCorp':'HEROMOTOCO','Bajaj Auto':'BAJAJ-AUTO','Eicher':'EICHERMOT',
  'TVS Motor':'TVSMOTOR','Ashok Leyland':'ASHOKLEY',
  // FMCG
  'HUL':'HINDUNILVR','Hindustan Unilever':'HINDUNILVR','ITC':'ITC',
  'Nestle':'NESTLEIND','Britannia':'BRITANNIA','Dabur':'DABUR','Marico':'MARICO',
  'Godrej Consumer':'GODREJCP','Colgate':'COLPAL','Tata Consumer':'TATACONSUM',
  'Varun Beverages':'VBL','Jubilant Food':'JUBLFOOD','Zomato':'ETERNAL','Swiggy':'SWIGGY',
  // Energy
  'Reliance':'RELIANCE','RIL':'RELIANCE','ONGC':'ONGC','BPCL':'BPCL','IOC':'IOC',
  'HPCL':'HINDPETRO','GAIL':'GAIL','Oil India':'OIL',
  // Metals
  'Tata Steel':'TATASTEEL','JSW Steel':'JSWSTEEL','Hindalco':'HINDALCO',
  'Vedanta':'VEDL','Coal India':'COALINDIA','NMDC':'NMDC','SAIL':'SAIL',
  'Jindal Steel':'JINDALSTEL','Hindustan Zinc':'HINDZINC',
  // Infra / Capital Goods
  'Larsen':'LT','L&T':'LT','BHEL':'BHEL','Siemens':'SIEMENS','ABB':'ABB',
  'CG Power':'CGPOWER','Cummins':'CUMMINSIND','HAL':'HAL','BEL':'BEL',
  'Mazagon':'MAZDOCK',
  // Power
  'Power Grid':'POWERGRID','NTPC':'NTPC','Tata Power':'TATAPOWER',
  'Adani Power':'ADANIPOWER','Adani Green':'ADANIGREEN','Torrent Power':'TORNTPOWER',
  'Suzlon':'SUZLON','Waaree':'WAAREEENER',
  // Telecom
  'Airtel':'BHARTIARTL','Bharti Airtel':'BHARTIARTL','Vodafone':'IDEA',
  'Indus Towers':'INDUSTOWER',
  // Real Estate / Cement
  'DLF':'DLF','Godrej Properties':'GODREJPROP','Oberoi Realty':'OBEROIRLTY',
  'Prestige':'PRESTIGE','UltraTech':'ULTRACEMCO','Ambuja':'AMBUJACEM',
  'Shree Cement':'SHREECEM',
  // Conglomerates / Others
  'Adani':'ADANIENT','Adani Ports':'ADANIPORTS','Jio Financial':'JIOFIN',
  'Bajaj Finance':'BAJFINANCE','LIC':'LICI','Titan':'TITAN','Dixon':'DIXON',
  'Nykaa':'NYKAA','Paytm':'PAYTM','Info Edge':'NAUKRI',
};

// Simple XML tag extractor — no DOM needed in Node
function extractTags(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1]
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim()
    );
  }
  return results;
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function parseRSS(xml, sourceName) {
  const items = [];
  // Split into <item> blocks
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTags(block, 'title')[0] || '';
    const link  = extractTags(block, 'link')[0]
               || block.match(/<link[^>]*>(.*?)<\/link>/i)?.[1]
               || '';
    const pubDate = extractTags(block, 'pubDate')[0] || '';
    const desc  = extractTags(block, 'description')[0] || '';

    if (!title) continue;

    // Parse timestamp
    let ts = 0;
    try { ts = pubDate ? new Date(pubDate).getTime() : Date.now(); } catch(e) {}

    // Detect stock mentions in title + description
    const text = (title + ' ' + desc).toUpperCase();
    const mentioned = new Set();
    Object.entries(STOCK_MENTIONS).forEach(([name, sym]) => {
      if (text.includes(name.toUpperCase())) mentioned.add(sym);
    });

    items.push({
      title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"),
      link:  link.trim(),
      ts,
      age:   pubDate,
      source: sourceName,
      stocks: [...mentioned],
    });
  }
  return items;
}

function ageLabel(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600'); // 5min cache
  if (req.method === 'OPTIONS') return res.status(200).end();

  const limit = Math.min(20, Math.max(3, parseInt(req.query.limit) || 10));

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; MFIntelligence/1.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  };

  try {
    // Fetch both RSS feeds in parallel
    const results = await Promise.allSettled(
      RSS_SOURCES.map(async src => {
        const r = await fetch(src.url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${src.name}`);
        const xml = await r.text();
        const items = parseRSS(xml, src.name);
        return { source: src.name, color: src.color, items };
      })
    );

    // Merge, sort by timestamp, deduplicate similar headlines
    let allItems = [];
    const errors = [];

    results.forEach(r => {
      if (r.status === 'fulfilled') allItems.push(...r.value.items);
      else errors.push(r.reason?.message || 'Feed error');
    });

    // Sort newest first
    allItems.sort((a, b) => b.ts - a.ts);

    // Add age labels
    allItems = allItems.map(i => ({ ...i, ageLabel: ageLabel(i.ts) }));

    // Deduplicate very similar headlines (edit distance shortcut: shared 6+ word prefix)
    const seen = new Set();
    allItems = allItems.filter(i => {
      const key = i.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 6).join(' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Slice to limit per source
    const bySource = {};
    RSS_SOURCES.forEach(s => { bySource[s.name] = 0; });
    allItems = allItems.filter(i => {
      if (bySource[i.source] >= limit) return false;
      bySource[i.source]++;
      return true;
    });

    // Stock-tagged items first within same-second items
    allItems.sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return b.stocks.length - a.stocks.length;
    });

    return res.status(200).json({
      items: allItems,
      fetchedAt: new Date().toISOString(),
      errors: errors.length ? errors : undefined,
      sources: RSS_SOURCES.map(s => s.name),
    });

  } catch (e) {
    console.error('NEWS ERROR:', e.message);
    return res.status(500).json({ error: e.message, items: [] });
  }
}
