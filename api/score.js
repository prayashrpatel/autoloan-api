// api/score.js

async function readBody(req) {
  // If framework already parsed:
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }

  // Otherwise, read the stream:
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return {};
}

module.exports = async (req, res) => {
  try {
    // GET → use query; POST → parse body
    const input = req.method === 'GET'
      ? (req.query || Object.fromEntries(new URL(req.url, 'http://local').searchParams))
      : await readBody(req);

    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const ltv = num(input.ltv);
    const dti = num(input.dti);
    const apr = num(input.apr);
    const termMonths = num(input.termMonths);
    const income = num(input.income);

    const missing = [];
    if (!(ltv >= 0)) missing.push('ltv');
    if (!(dti >= 0)) missing.push('dti');
    if (!(apr >= 0)) missing.push('apr');
    if (!(termMonths > 0)) missing.push('termMonths');
    if (!(income > 0)) missing.push('income');

    if (missing.length) {
      return res.status(400).json({ error: `Missing/invalid: ${missing.join(', ')}`, received: input });
    }

    // Simple illustrative PD calc (tune as you like)
    const base =
      0.02 +
      Math.max(0, ltv - 0.80) * 0.25 +
      Math.max(0, dti - 0.35) * 0.30 +
      Math.max(0, apr - 0.06) * 4.0;

    const pd = Math.min(0.35, Math.max(0.005, +base.toFixed(4)));
    const confidence = 0.70;
    const decision = (ltv <= 1.10 && dti <= 0.45 && pd < 0.20) ? 'APPROVED' : 'DECLINED';

    return res.status(200).json({ decision, pd, confidence });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
