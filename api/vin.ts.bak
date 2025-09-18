import type { VercelRequest, VercelResponse } from '@vercel/node';

function cors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const vin = (req.query.vin as string || '').toUpperCase().trim();
  if (!vin) return res.status(400).json({ error: 'vin required' });

  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
  const r = await fetch(url);
  if (!r.ok) return res.status(502).json({ error: 'VIN provider error' });

  const data = await r.json();
  const row = data?.Results?.[0] ?? {};
  return res.json({
    year: Number(row.ModelYear) || undefined,
    make: row.Make || undefined,
    model: row.Model || undefined,
    trim: row.Trim || undefined,
    msrp: undefined // NHTSA usually doesn't return MSRP; you can replace with a paid provider later
  });
}
