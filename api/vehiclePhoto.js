import fetch from "node-fetch";

export default async function vehiclePhotoHandler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const vin = url.searchParams.get("vin");

    if (!vin || vin.trim().length !== 17) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing/invalid vin" }));
    }

    // ✅ Accept either env var name
    const key = process.env.MARKETCHECK_KEY || process.env.MARKETCHECK_API_KEY;
    if (!key) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "MARKETCHECK_KEY not set" }));
    }

    const mcUrl =
      `https://api.marketcheck.com/v2/search/car/active?` +
      `api_key=${encodeURIComponent(key)}&vin=${encodeURIComponent(vin)}&rows=1`;

    const r = await fetch(mcUrl);
    const data = await r.json();

    if (!r.ok) {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: data?.message || "Marketcheck error", raw: data }));
    }

    const first = data?.listings?.[0];

    const photoUrl =
      first?.media?.photo_links?.[0] ||
      first?.media?.photoLink?.[0] ||
      first?.media?.photos?.[0] ||
      null;

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ photoUrl, listingId: first?.id || null }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Server error", detail: String(e) }));
  }
}
