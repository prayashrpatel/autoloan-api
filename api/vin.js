// api/vin.js
// Decodes a VIN using NHTSA by default. Optionally enriches missing fields with AI,
// and (optionally) adds a short AI summary.
// GET /api/vin?vin=...   or   POST { vin: "..." }

const PROVIDER = process.env.VIN_DECODER_PROVIDER || 'nhtsa';
const AI_SUMMARY_ENABLED = String(process.env.AI_SUMMARY_ENABLED || 'false').toLowerCase() === 'true';
const AI_ENRICH_ENABLED = String(process.env.AI_ENRICH_ENABLED || 'true').toLowerCase() === 'true';

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 6000);
const aiCache = new Map(); // local cache of enrich results during dev

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
    msrp: undefined,
    source: 'nhtsa',
  };

  const parts = [mapped.year, mapped.make, mapped.model, mapped.trim].filter(Boolean);
  mapped.title = parts.join(' ');
  return mapped;
}

async function decodeWithCustom(vin) {
  const base = process.env.VIN_DECODER_URL;
  const key
