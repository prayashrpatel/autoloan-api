// api/health.js
export default async function handler(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    hasKey: !!process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || null,
    provider: process.env.VIN_DECODER_PROVIDER || "nhtsa",
  }));
}
