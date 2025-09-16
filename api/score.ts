// api/score.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

function readRaw(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // CORS (optional)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // 🚫 Do NOT touch req.body — only read the raw stream
    const rawBuf = await readRaw(req);
    const rawTxt = rawBuf.toString('utf8').replace(/^\uFEFF/, '').trim(); // strip BOM, trim

    let data: any;
    try {
      data = JSON.parse(rawTxt);
    } catch {
      return res.status(400).json({
        error: 'Invalid JSON',
        meta: {
          contentType: req.headers['content-type'],
          rawLength: rawBuf.length,
          snippet: rawTxt.slice(0, 160),
        },
      });
    }

    const { ltv, dti, apr, termMonths, income } = data ?? {};
    const fields = { ltv, dti, apr, termMonths, income };
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'number' || Number.isNaN(v)) {
        return res.status(400).json({ error: 'Missing or invalid fields', got: data });
      }
    }

    const pd = Math.min(0.95, Math.max(0, 0.2 + dti * 0.5 + ltv * 0.3));
    return res.status(200).json({ pd, confidence: 0.7, modelVersion: 'dummy-v1' });
  } catch (err: any) {
    console.error('score error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
