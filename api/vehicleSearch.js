// api/vehicleSearch.js
import 'dotenv/config';
import fetch from 'node-fetch';

/**
 * Expected client query:
 *   /api/vehicle-search?q=camry%20under%2032k&priceMax=32000
 *
 * Response shape:
 *   { listings: VehicleOption[], stats: { min, max, mean, median } }
 */
export default async function vehicleSearchHandler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost'); // parse query from Node http
    const q = (url.searchParams.get('q') || '').trim();
    const priceMaxParam = url.searchParams.get('priceMax');

    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing q' }));
    }

    // ---- Build provider request (MarketCheck style) ----
    // Tweak the params below to your subscription/endpoint.
    const API_KEY = process.env.MARKETCHECK_API_KEY;
    const MC_BASE = process.env.MARKETCHECK_BASE_URL || 'https://marketcheck-prod.apigee.net/v2';

    // A reasonable default city/state if your plan requires geography
    const defaultGeo = { latitude: 37.3688, longitude: -122.0363, radius: 200 }; // Sunnyvale-ish, 200 miles

    const mcUrl = new URL(`${MC_BASE}/search/car/active`);
    mcUrl.searchParams.set('api_key', API_KEY);
    mcUrl.searchParams.set('rows', '25');
    mcUrl.searchParams.set('start', '0');
    mcUrl.searchParams.set('stats', 'price');
    mcUrl.searchParams.set('timestamp', String(Date.now())); // bust caches

    // You can map your free-text q to make/model/body keywords.
    // For a quick pass, send it as a `terms`/`car_type` style search:
    mcUrl.searchParams.set('title', q); // try "camry", "bmw coupe", etc.

    // Price filter if provided
    if (priceMaxParam && Number(priceMaxParam) > 0) {
      mcUrl.searchParams.set('price_to', String(Number(priceMaxParam)));
    }

    // Geo (if your plan requires)
    mcUrl.searchParams.set('lat', String(defaultGeo.latitude));
    mcUrl.searchParams.set('lon', String(defaultGeo.longitude));
    mcUrl.searchParams.set('radius', String(defaultGeo.radius));

    const upstream = await fetch(mcUrl.toString(), { timeout: 15000 });
    if (!upstream.ok) {
      const text = await upstream.text();
      throw new Error(`Provider ${upstream.status} – ${text?.slice(0, 200)}`);
    }
    const data = await upstream.json();

    // ---- Normalize into your UI shape ----
    const raw = Array.isArray(data.listings) ? data.listings : [];

    const listings = raw.map((r) => {
      const price = Number(r.price || r.list_price || r.sale_price || 0) || 0;
      const miles = Number(r.miles || r.mileage || 0) || 0;

      return {
        id: String(r.id ?? r.vin ?? Math.random().toString(36).slice(2)),
        name:
          r.build?.year && r.build?.make && r.build?.model
            ? `${r.build.year} ${r.build.make} ${r.build.model}`.trim()
            : r.heading || r.title || 'Vehicle',
        price,
        miles,
        fuel: r.build?.fuel_type || 'Gas',
        body: r.build?.body_type || r.body_type || '—',
        transmission: r.build?.transmission || r.transmission || '—',
        city: r.dealer?.city || r.location?.city || undefined,
        state: r.dealer?.state || r.location?.state || undefined,
        // Optional APR inference if you want:
        apr: undefined,
      };
    });

    // ---- Compute stats (min/max/mean/median over prices) ----
    const prices = listings.map((x) => x.price).filter((n) => Number.isFinite(n) && n > 0);
    const stats = computeStats(prices);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ listings, stats }));
  } catch (err) {
    console.error('vehicleSearch error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Vehicle search failed', detail: String(err?.message || err) }));
  }
}

function computeStats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((s, n) => s + n, 0) / sorted.length;
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) >> 1]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { min, max, mean: Math.round(mean), median };
}
