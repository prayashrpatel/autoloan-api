import fetch from "node-fetch";

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function marketStatsHandler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");

    const year = url.searchParams.get("year") || "";
    const make = url.searchParams.get("make") || "";
    const model = url.searchParams.get("model") || "";
    const trim = url.searchParams.get("trim") || "";

    // optional: use this to compute deal percentile
    const subjectPrice = toNumber(url.searchParams.get("subjectPrice"));

    if (!year || !make || !model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing year/make/model" }));
    }

    // IMPORTANT: match your .env name
    // In your screenshot you have MARKETCHECK_API_KEY
    const key = process.env.MARKETCHECK_API_KEY || process.env.MARKETCHECK_KEY;
    if (!key) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "MARKETCHECK_API_KEY not set" }));
    }

    const base = process.env.MARKETCHECK_BASE_URL || "https://api.marketcheck.com/v2";
    const rows = Math.min(Math.max(Number(url.searchParams.get("rows") || 50), 10), 100);

    // Marketcheck search endpoint (works for many plans)
    // If your plan requires different endpoint params, we’ll adjust after we see one real response shape.
    const mcUrl =
      `${base}/search/car/active?` +
      `api_key=${encodeURIComponent(key)}` +
      `&year=${encodeURIComponent(year)}` +
      `&make=${encodeURIComponent(make)}` +
      `&model=${encodeURIComponent(model)}` +
      (trim ? `&trim=${encodeURIComponent(trim)}` : "") +
      `&rows=${rows}`;

    const r = await fetch(mcUrl);
    const data = await r.json();

    if (!r.ok) {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: data?.message || "Marketcheck error",
          raw: data,
        })
      );
    }

    const listings = Array.isArray(data?.listings) ? data.listings : [];

    // Pull price & miles from common fields
    const prices = listings
      .map((l) => toNumber(l?.price))
      .filter((n) => n != null);

    const miles = listings
      .map((l) => toNumber(l?.miles))
      .filter((n) => n != null);

    const medPrice = median(prices);
    const medMiles = median(miles);
    const count = listings.length;

    // Deal percentile: % of comps priced <= subjectPrice
    let dealPercentile = null; // 0..1 (lower = better deal)
    if (subjectPrice != null && prices.length >= 8) {
      const sorted = [...prices].sort((a, b) => a - b);
      const below = sorted.filter((p) => p <= subjectPrice).length;
      dealPercentile = clamp01(below / sorted.length);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        count,
        medianPrice: medPrice,
        medianMiles: medMiles,
        dealPercentile,
      })
    );
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Server error", detail: String(e) }));
  }
}
