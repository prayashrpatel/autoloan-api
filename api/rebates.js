// autoloan-api/api/rebates.js
// ✅ MarketCheck integration (Free plan): Fetch vehicle specs by VIN
// You can later expand this for market value, pricing, and incentives.

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export default async function rebatesHandler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const vin = (url.searchParams.get("vin") || "").trim();
    const apiKey = process.env.MARKETCHECK_API_KEY;

    if (!vin) return send(res, 400, { error: "Missing 'vin' query parameter" });
    if (!apiKey) return send(res, 500, { error: "MARKETCHECK_API_KEY is not set" });

    // ✅ MarketCheck base endpoint
    const base = "https://marketcheck-prod.apigee.net/v2";
    const endpoint = `${base}/specs?vin=${encodeURIComponent(vin)}&api_key=${encodeURIComponent(apiKey)}`;

    // ✅ Fetch with timeout (works natively in Node 18+)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return send(res, response.status, {
        ok: false,
        error: `MarketCheck API returned ${response.status}`,
      });
    }

    const specs = await response.json();

    // ✅ Unified payload shape (for your front-end)
    send(res, 200, {
      ok: true,
      vin,
      provider: "MarketCheck",
      source: "specs",
      data: specs,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err.name === "AbortError" ? "Request timed out" : err.message;
    send(res, 500, { ok: false, error: message });
  }
}
