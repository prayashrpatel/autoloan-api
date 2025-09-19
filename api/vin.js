// api/vin.js
// Decodes a VIN using NHTSA by default. Optionally adds a short AI summary.
// GET  /api/vin?vin=...   or   POST { vin: "..." }

const PROVIDER = process.env.VIN_DECODER_PROVIDER || 'nhtsa';
const AI_SUMMARY_ENABLED = String(process.env.AI_SUMMARY_ENABLED || 'false').toLowerCase() === 'true';

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 6000);

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'request') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch {}
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] != null && obj[k] !== '') out[k] = obj[k];
  return out;
}

async function decodeWithNHTSA(vin) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
  const res = await withTimeout(fetch(url, { headers: { 'User-Agent': 'autoloan-api/1.0' } }), DEFAULT_TIMEOUT_MS, 'NHTSA');
  if (!res.ok) throw new Error(`NHTSA error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const row = data?.Results?.[0] || {};

  const mapped = {
    vin,
    year: row.ModelYear ? Number(row.ModelYear) : undefined,
    make: row.Make || undefined,
    model: row.Model || undefined,
    trim: row.Trim || row.Series || undefined,
    bodyClass: row.BodyClass || undefined,
    doors: row.Doors ? Number(row.Doors) : undefined,
    driveType: row.DriveType || row.DriveTypePrimary || undefined,
    transmission: row.TransmissionStyle || row.TransmissionDescriptor || undefined,
    fuelType: row.FuelTypePrimary || undefined,
    engineCylinders: row.EngineCylinders ? Number(row.EngineCylinders) : undefined,
    displacementL: row.DisplacementL ? Number(row.DisplacementL) : undefined,
    engineHP: row.EngineHP ? Number(row.EngineHP) : undefined,
    manufacturer: row.ManufacturerName || undefined,
    plantCountry: row.PlantCountry || undefined,
  };

  const parts = [mapped.year, mapped.make, mapped.model, mapped.trim].filter(Boolean);
  mapped.title = parts.join(' ');
  return mapped;
}

async function decodeWithCustom(vin) {
  const base = process.env.VIN_DECODER_URL;
  const key = process.env.VIN_DECODER_KEY;
  if (!base) throw new Error('VIN_DECODER_URL not set');
  const url = `${base.replace(/\/$/, '')}/decode?vin=${encodeURIComponent(vin)}`;
  const res = await withTimeout(fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} }), DEFAULT_TIMEOUT_MS, 'Custom decoder');
  if (!res.ok) throw new Error(`Custom decoder error: ${res.status} ${res.statusText}`);
  return await res.json();
}

async function aiSummary(vehicle) {
  if (!AI_SUMMARY_ENABLED) return null;
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  if (!apiKey) return null;

  const facts = pick(vehicle, [
    'year','make','model','trim','bodyClass','doors','driveType',
    'transmission','fuelType','engineCylinders','displacementL','engineHP'
  ]);

  const prompt = [
    'Write a concise, neutral 2–3 sentence summary of this vehicle.',
    'Highlight trim/engine/drivetrain/body style if available. Avoid marketing.',
    `Vehicle JSON: ${JSON.stringify(facts)}`
  ].join(' ');

  try {
    const res = await withTimeout(fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 120,
      }),
    }), DEFAULT_TIMEOUT_MS, 'AI summary');

    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    // If AI fails or times out, just return null; do not block VIN decode.
    return null;
  }
}

module.exports = async (req, res) => {
  try {
    const input = req.method === 'GET'
      ? (req.query || Object.fromEntries(new URL(req.url, 'http://local').searchParams))
      : await readBody(req);

    const vin = (input.vin || '').toString().trim().toUpperCase();
    if (!vin || vin.length !== 17) {
      return res.status(400).json({ ok: false, error: 'VIN must be 17 characters', vin });
    }

    const decoded = await (PROVIDER === 'nhtsa' ? decodeWithNHTSA(vin) : decodeWithCustom(vin));
    const summary = await aiSummary(decoded); // null if disabled/fails

    return res.status(200).json({ ok: true, data: { ...decoded, summary } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
