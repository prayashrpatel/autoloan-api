import { URL } from "node:url";

const MC_KEY = process.env.MARKETCHECK_API_KEY || "";
const MC_BASE = process.env.MARKETCHECK_BASE_URL || "https://api.marketcheck.com/v2";
const MAX_RAD = Number(process.env.MC_MAX_RADIUS || 100);
const MAX_ROWS = Number(process.env.MC_MAX_ROWS || 24);
const DEF_ROWS = 12;

const KNOWN_MAKES = new Set([
  "toyota","honda","ford","chevrolet","gmc","bmw","audi","mercedes","mercedes-benz","lexus","acura",
  "nissan","hyundai","kia","mazda","subaru","volkswagen","volvo","porsche","tesla","jeep","ram",
]);

function normalizeMake(m) {
  const x = (m || "").toLowerCase();
  if (x === "mercedes") return "mercedes-benz";
  return x;
}

/**
 * Parse input into either:
 * - make/model (structured)
 * - model-only (single token)
 * - search (free text)
 */
function parseVehicleQuery(qRaw) {
  const raw = (qRaw || "").trim();
  if (!raw) return { raw: "", make: "", model: "", search: "" };

  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    // model-only: "camry"
    return { raw, make: "", model: tokens[0], search: "" };
  }

  if (tokens.length >= 2 && KNOWN_MAKES.has(tokens[0])) {
    // "toyota camry ..."
    const make = normalizeMake(tokens[0]);
    const model = tokens.slice(1).join(" ");
    return { raw, make, model, search: "" };
  }

  // fallback: free-text search
  return { raw, make: "", model: "", search: raw };
}

export default async function vehiclesHandler(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const url = new URL(req.url, "http://localhost");

    const qRaw = (url.searchParams.get("q") || "").trim();
    const priceMax = Number(url.searchParams.get("priceMax") || 0);
    const zip = url.searchParams.get("zip") || "94087";
    const radiusIn = Number(url.searchParams.get("radius") || 100);
    const rowsIn = Number(url.searchParams.get("rows") || DEF_ROWS);
    const pageIn = Number(url.searchParams.get("page") || 1);

    const radius = Math.min(Math.max(radiusIn, 1), MAX_RAD);
    const rows = Math.min(Math.max(rowsIn, 1), MAX_ROWS);
    const page = Math.max(pageIn, 1);
    const start = (page - 1) * rows;

    if (!MC_KEY) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        source: "stub",
        q: qRaw,
        priceMax,
        listings: [],
        stats: null,
        paging: { total: 0, page, rows, hasMore: false },
      }));
    }

    const parsed = parseVehicleQuery(qRaw);

    const mcUrl = new URL(`${MC_BASE}/search/car/active`);
    mcUrl.searchParams.set("api_key", MC_KEY);
    mcUrl.searchParams.set("rows", String(rows));
    mcUrl.searchParams.set("start", String(start));
    mcUrl.searchParams.set("car_type", "used");
    mcUrl.searchParams.set("stats", "true");
    mcUrl.searchParams.set("zip", zip);
    mcUrl.searchParams.set("radius", String(radius));
    mcUrl.searchParams.set("sort_by", "price");
    mcUrl.searchParams.set("sort_order", "asc");

    // ✅ Structured filters when possible
    if (parsed.make) mcUrl.searchParams.set("make", parsed.make);
    if (parsed.model) mcUrl.searchParams.set("model", parsed.model);

    // ✅ Correct free-text keyword param for this endpoint
    // (Not "q")
    if (parsed.search) mcUrl.searchParams.set("search", parsed.search);

    if (priceMax) mcUrl.searchParams.set("price_range", `0-${priceMax}`);

    console.log("[vehicles] qRaw:", qRaw, "parsed:", parsed);
    console.log("[vehicles] ->", mcUrl.toString());

    const upstream = await fetch(mcUrl.toString(), { headers: { Accept: "application/json" } });
    if (!upstream.ok) {
      const text = await upstream.text();
      console.error("[vehicles] Marketcheck error:", upstream.status, text?.slice(0, 400));
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: "marketcheck_error",
        status: upstream.status,
        message: text?.slice(0, 400),
      }));
    }

    const data = await upstream.json();

    const listings = (data.listings || []).map((item) => {
      const build = item.build || {};
      const dealer = item.dealer || {};
      const title =
        item.heading ||
        [build.year, build.make, build.model, build.trim || build.short_trim]
          .filter(Boolean)
          .join(" ");

      return {
        id: item.id || item.vin,
        name: title,
        price: item.price || 0,
        miles: item.miles || 0,
        fuel: build.fuel_type || "—",
        body: build.body_type || build.vehicle_type || "—",
        transmission: build.transmission || "—",
        city: dealer.city || "",
        state: dealer.state || "",
        url: item.vdp_url || "",
        photo: item.media?.photo_links?.[0] || null,
      };
    });

    const total = data.num_found ?? data.total ?? null;
    const hasMore = total != null ? start + listings.length < total : listings.length === rows;

    const priceStats = data.stats?.price || null;

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      source: "marketcheck",
      q: qRaw,
      parsed,
      priceMax,
      listings,
      stats: priceStats
        ? { min: priceStats.min, max: priceStats.max, mean: priceStats.mean, median: priceStats.median }
        : null,
      paging: { total, page, rows, hasMore },
    }));
  } catch (err) {
    console.error("[vehicles] Handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Internal error" }));
  }
}