// api/market-stats.js (or similar) — ESM
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

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Extract listings safely across slight response variations
function getListings(data) {
  if (Array.isArray(data?.listings)) return data.listings;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.listings)) return data.data.listings;
  return [];
}

function computeStats(listings, subjectPrice) {
  const prices = listings.map((l) => toNumber(l?.price)).filter((n) => n != null);
  const miles  = listings.map((l) => toNumber(l?.miles)).filter((n) => n != null);

  const medPrice = median(prices);
  const medMiles = median(miles);
  const count = listings.length;

  let dealPercentile = null; // 0..1 (lower = better deal)
  if (subjectPrice != null && prices.length >= 8) {
    const sorted = [...prices].sort((a, b) => a - b);
    const below = sorted.filter((p) => p <= subjectPrice).length;
    dealPercentile = clamp01(below / sorted.length);
  }

  return { count, medianPrice: medPrice, medianMiles: medMiles, dealPercentile };
}

async function fetchMarketcheck({ base, key, year, make, model, trim, rows }) {
  const mcUrl =
    `${base}/search/car/active?` +
    `api_key=${encodeURIComponent(key)}` +
    `&year=${encodeURIComponent(year)}` +
    `&make=${encodeURIComponent(make)}` +
    `&model=${encodeURIComponent(model)}` +
    (trim ? `&trim=${encodeURIComponent(trim)}` : "") +
    `&rows=${rows}`;

  // IMPORTANT: do NOT log the full URL (it contains your api key)
  // console.log("[market-stats] request:", { year, make, model, trim, rows });

  const r = await fetch(mcUrl);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default async function marketStatsHandler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");

    const year = url.searchParams.get("year") || "";
    const make = url.searchParams.get("make") || "";
    const model = url.searchParams.get("model") || "";
    const trim = url.searchParams.get("trim") || "";

    const subjectPrice = toNumber(url.searchParams.get("subjectPrice"));

    if (!year || !make || !model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing year/make/model" }));
    }

    const key = process.env.MARKETCHECK_API_KEY || process.env.MARKETCHECK_KEY;
    if (!key) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error:
            "MARKETCHECK_API_KEY is missing. Add it to autoloan-api/.env and restart the API server.",
        })
      );
    }

    const base = process.env.MARKETCHECK_BASE_URL || "https://api.marketcheck.com/v2";
    const rows = Math.min(Math.max(Number(url.searchParams.get("rows") || 50), 10), 100);

    // 1) strict attempt (with trim)
    let attempt = await fetchMarketcheck({ base, key, year, make, model, trim, rows });
    if (!attempt.ok) {
      res.writeHead(attempt.status || 502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Marketcheck error", raw: attempt.data }));
    }

    let listings = getListings(attempt.data);

    // 2) fallback: if zero results and trim was used, retry without trim
    if (listings.length === 0 && trim) {
      const retry = await fetchMarketcheck({ base, key, year, make, model, trim: "", rows });
      if (retry.ok) listings = getListings(retry.data);
    }

    // 3) fallback: if still zero, try year-1 and year+1 (without trim)
    if (listings.length === 0) {
      const y = Number(year);
      if (Number.isFinite(y)) {
        const retry1 = await fetchMarketcheck({ base, key, year: String(y - 1), make, model, trim: "", rows });
        if (retry1.ok) listings = getListings(retry1.data);

        if (listings.length === 0) {
          const retry2 = await fetchMarketcheck({ base, key, year: String(y + 1), make, model, trim: "", rows });
          if (retry2.ok) listings = getListings(retry2.data);
        }
      }
    }

    // 4) Optional: if we had to broaden, try to loosely filter by trim locally
    // This helps when Marketcheck uses slightly different trim strings.
    if (trim && listings.length >= 10) {
      const t = norm(trim);
      const filtered = listings.filter((l) => {
        const a = norm(l?.build?.trim);
        const b = norm(l?.build?.trim_o);
        const c = norm(l?.build?.trim_r);
        return (a && a.includes(t)) || (b && b.includes(t)) || (c && c.includes(t));
      });

      // only use filtered if it still leaves enough comps
      if (filtered.length >= 8) listings = filtered;
    }

    const stats = computeStats(listings, subjectPrice);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(stats));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Server error", detail: String(e) }));
  }
}
