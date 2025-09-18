// api/vin.js
// GET /api/vin?vin=1HGCM82633A004352  (or POST with { vin })

module.exports = async (req, res) => {
  try {
    const vin =
      (req.method === 'GET' ? req.query?.vin : req.body?.vin) || '';
    const clean = String(vin).trim().toUpperCase();

    if (!clean || clean.length < 11) {
      return res.status(400).json({ error: 'VIN must be at least 11 characters' });
    }

    // 1) Deterministic decode via NHTSA vPIC
    const vpicUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${encodeURIComponent(clean)}?format=json`;
    const resp = await fetch(vpicUrl);
    if (!resp.ok) return res.status(502).json({ error: `vPIC error ${resp.status}` });

    const json = await resp.json();
    const row = json?.Results?.[0] || {};

    // 2) Normalize a compact profile for your app
    const profile = {
      vin: clean,
      year: row.ModelYear ? Number(row.ModelYear) : null,
      make: row.Make || null,
      model: row.Model || null,
      trim: row.Trim || row.Series || null,
      bodyClass: row.BodyClass || null,
      driveType: row.DriveType || null,
      fuelType: row.FuelTypePrimary || null,
      engine: [
        row.EngineConfiguration,
        row.EngineCylinders && `${row.EngineCylinders} cyl`,
        row.DisplacementL && `${row.DisplacementL}L`,
      ]
        .filter(Boolean)
        .join(' / ') || null,
    };

    // 3) OPTIONAL: AI assist for summary / inferred fields
    //    Only runs if env vars are present (see .env section below).
    let ai = null;
    if (process.env.VIN_AI_PROVIDER === 'openai' && process.env.OPENAI_API_KEY) {
      try {
        const prompt = `You are assisting with VIN decoding. 
Return a JSON object with:
- "summary": a <= 120 char human-friendly description (year make model, trim if known, drive, engine).
- "inferred": array of optional suggestions when data is missing, each: { "field": string, "value": string, "confidence": 0..1, "reason": string }.
Only infer if not provided in the normalized data.

Normalized: ${JSON.stringify(profile)}
vPIC Row (raw): ${JSON.stringify(row)}`;

        const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.VIN_AI_MODEL || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              { role: 'system', content: 'Be concise, cautious, and never overstate certainty.' },
              { role: 'user', content: prompt },
            ],
          }),
        });

        const aiJson = await aiResp.json();
        const content = aiJson?.choices?.[0]?.message?.content;
        ai = content ? JSON.parse(content) : { error: 'No AI content' };
      } catch (e) {
        ai = { error: 'AI unavailable', detail: String(e?.message || e) };
      }
    }

    return res.status(200).json({ ok: true, data: profile, ai, raw: row });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
