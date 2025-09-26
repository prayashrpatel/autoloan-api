// api/vin.js (ESM, default export)

import OpenAI from "openai";

const ENRICH = String(process.env.AI_ENRICH_ENABLED || "false").toLowerCase() === "true";
const DO_SUM = String(process.env.AI_SUMMARY_ENABLED || "false").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const client = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

function fromNhtsa(row, vinValue) {
  const getNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const clean = (s) => (s && typeof s === "string" ? s.trim() || null : null);

 return {
    vin: vinValue || clean(row.VIN),

    year: getNum(row["Model Year"]),
    make: clean(row.Make),
    model: clean(row.Model),
    trim: clean(row["Trim"] || row["Series"]),
    body: clean(row["Body Class"]),
    doors: getNum(row["Doors"]),

    drive: clean(row["Drive Type"]),
    transmission: clean(row["Transmission Style"] || row["TransmissionDescriptor"]),
    fuel: clean(row["Fuel Type - Primary"]),
    cylinders: getNum(row["Engine Number of Cylinders"]),
    displacement: getNum(row["Displacement (L)"]),
    engineHp: getNum(row["Engine HP"]),

    msrp: null,
    summary: null,
    title: null
  };
  }

function fillMissing(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    if (out[k] == null && patch[k] != null) out[k] = patch[k];
  }
  return out;
}

async function enrichWithAI(base) {
  if (!ENRICH || !client) {
    console.log("[VIN] Skipping AI enrichment (disabled or no key).");
    return null;
  }

  const prompt = [
    "You are enriching decoded VIN data.",
    "Return a compact JSON with only missing fields you can confidently infer.",
    "Allowed keys: drive, transmission, fuel, cylinders, displacement, engineHp, msrp, summary (<=40 words).",
    "Do not invent specs that conflict with provided data. If unsure, omit.",
    "",
    "Known data:",
    JSON.stringify({
      year: base.year,
      make: base.make,
      model: base.model,
      trim: base.trim,
      body: base.body,
    }),
  ].join("\n");

  try {
    console.log("[VIN] Calling OpenAI for enrichment…");

    const r = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const text = r.choices?.[0]?.message?.content || "";
    console.log("[VIN] Raw OpenAI response:", text);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn("[VIN] No JSON found in AI response.");
      return null;
    }

    const patch = JSON.parse(match[0]);

    if (!DO_SUM && "summary" in patch) delete patch.summary;

    const allowed = [
      "drive",
      "transmission",
      "fuel",
      "cylinders",
      "displacement",
      "engineHp",
      "msrp",
      "summary",
    ];
    const filtered = {};
    for (const k of allowed) if (patch[k] != null) filtered[k] = patch[k];

    console.log("[VIN] Parsed enrichment patch:", filtered);
    return filtered;
  } catch (err) {
    console.error("[VIN] AI enrichment error:", err);
    return null;
  }
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }

    const vinParam = String(url.searchParams.get("vin") || "").trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vinParam)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "VIN must be 17 characters (no I/O/Q)." }));
    }

    const nhtsaUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vinParam}?format=json`;
    const r = await fetch(nhtsaUrl);
    if (!r.ok) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: `NHTSA error ${r.status}` }));
    }

    const j = await r.json();
    const row =
      Array.isArray(j?.Results) &&
      (j.Results.find((x) => x.Make || x.Model || x["Model Year"]) || j.Results[0]);

    if (!row) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "VIN not found" }));
    }

    let data = fromNhtsa(row, vinParam);

    if (!data.title) {
      const parts = [data.year, data.make, data.model, data.trim].filter(Boolean);
      data.title = parts.join(" ").trim() || null;
    }

    const meta = { ai: { enabled: ENRICH, attempted: false, ok: false, model: MODEL } };
    const missing =
      !data.drive ||
      !data.transmission ||
      !data.fuel ||
      !data.cylinders ||
      !data.displacement ||
      !data.engineHp ||
      data.msrp == null ||
      (DO_SUM && !data.summary);

    if (ENRICH && missing) {
      meta.ai.attempted = true;
      const patch = await enrichWithAI(data);
      if (patch) {
        data = fillMissing(data, patch);
        meta.ai.ok = true;
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data, meta }));
  } catch (err) {
    console.error("vin handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}

export default handler;
