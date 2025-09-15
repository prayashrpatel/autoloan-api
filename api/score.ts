// api/score.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const features = req.body as {
    ltv: number;
    dti: number;
    apr: number;
    termMonths: number;
    income: number;
  };

  if (!features || typeof features !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // === Dummy scoring model ===
  const pd = Math.min(0.95, 0.2 + features.dti * 0.5 + features.ltv * 0.3);
  const confidence = 0.7; // placeholder

  return res.status(200).json({
    pd,
    confidence,
    modelVersion: "dummy-v1",
  });
}
