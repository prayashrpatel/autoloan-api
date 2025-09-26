// api/vin.js  — ESM default export

import OpenAI from "openai";

/* --------------------------- Config & globals --------------------------- */

const ENRICH = String(process.env.AI_ENRICH_ENABLED || "false").toLowerCase() === "true";
const DO_SUM = String(process.env.AI_SUMMARY_ENABLED || "false").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const AI_TEMPERATURE = Number(process.env.AI_TEMPERATURE ?? 0.2);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 120);

const VIN_CACHE_TTL_MS = Number(
  process.env.VIN_CACHE_TTL_MS || 24 * 60 * 60 * 1000 /* 24h */
);
const vinCache = new Map(); // Map<VIN, { when:number, payload:any }>

const client = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* ------------------------------- Utilities ------------------------------ */

const clean = (s) => (s && typeof s === "string" ? s.trim() || null : null);
const getNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** Decode model year from VIN's 10th character, choosing the most plausible year. */
function decodeYearFromVin(vin) {
  if (!vin || vin.length < 10) return null;
  const code = vin[9].toUpperCase();

  // Mapping base cycle (1980–2009)
  const baseMap = {
    A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
    J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
    T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
    "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
    "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  };

  if (!(code in baseMap)) return null;

  const base = baseMap[code];

  // Codes repeat every 30 years: 1980/2010/2040...
  const now = new Date();
  const currentYear = now.getFullYear();
  const maxYear = currentYear + 1; // allow early next-model-year releases

  // Generate plausible candidates up to ~2069 to be safe
  const candidates = [base, base + 30, base + 60].filter((y) => y >= 1980 && y <= 2069);

  // Pick the most recent candidate that is not in the future beyond maxYear
  let chosen = null;
  for (const y of candidates) {
    if (y <= maxYear) chosen = y;
  }
  return chosen ?? null;
}

/** Map NHTSA "Body Class" to a short, user-friendly style label. */
function normalizeBodyClass(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase();

  // Specific first
  if (s.includes("hatchback")) return "Hatchback";
  if (s.includes("coupe")) return "Coupe";
  if (s.includes("convertible") || s.includes("cabriolet") || s.includes("roadster"))
    return "Convertible";
  if (s.includes("wagon")) return "Wagon";
  if (s.includes("pickup")) return "Pickup";
  if (s.includes("minivan") || s.includes("mini-van")) return "Minivan";
  if (s.includes("van")) return "Van";

  // Broad buckets
  if (s.includes("sport utility vehicle") || s.includes("utility") || s.includes("suv"))
    return "SUV";
  if (s.includes("sedan") || s.includes("saloon") || s.includes("limousine"))
    return "Sedan";

  // Too vague -> let heuristics/AI decide
  return null;
}

/** Heuristic fallback: infer style from model/trim text if possible. */
function guessBodyFromNames({ model, trim }) {
  const text = [model, trim].filter(Boolean).join(" ").toLowerCase();
  if (!text) return null;

  if (/\bhatch\b|\bhatchback\b/.test(text)) return "Hatchback";
  if (/\bcoupe\b/.test(text)) return "Coupe";
  if (/\bwagon\b/.test(text)) return "Wagon";
  if (/\bconvertible\b|\bcabrio\b|\bcabriolet\b|\broadster\b/.test(text)) return "Convertible";
  if (/\bsuv\b|\bcrossover\b/.test(text)) return "SUV";
  if (/\bsedan\b/.test(text)) return "Sedan";
  if (/\bminivan\b/.test(text)) return "Minivan";
  if (/\bvan\b/.test(text)) return "Van";
  if (/\bpickup\b|\btruck\b/.test(text)) return "Pickup";

  return null;
}

/** Shallow-fill only where base has null/undefined. */
function fillMissing(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    if (out[k] == null && patch[k] != null) out[k] = patch[k];
  }
  return out;
}

/* --------------------------- NHTSA -> VinInfo --------------------------- */

function fromNhtsa(row, vinValue) {
  const rawBodyClass = clean(row["Body Class"]);
  const normalizedBody = normalizeBodyClass(rawBodyClass);

  // Prefer NHTSA year; if missing, decode from VIN 10th char
  const nhtsaYear = getNum(row["Model Year"]);
  const vinYear = decodeYearFromVin(vinValue || clean(row.VIN));
  const year = nhtsaYear ?? vinYear ?? null;

  return {
    vin: vinValue || clean(row.VIN),

    year,
    make: clean(row.Make),
    model: clean(row.Model),
    trim: clean(row["Trim"] || row["Series"]),

    body: normalizedBody || null,
    doors: getNum(row["Doors"]),

    drive: clean(row["Drive Type"]),
    transmission: clean(row["Transmission Style"] || row["TransmissionDescriptor"]),
    fuel: clean(row["Fuel Type - Primary"]),
    cylinders: getNum(row["Engine Number of Cylinders"]),
    displacement: getNum(row["Displacement (L)"]),
    engineHp: getNum(row["Engine HP"]),

    msrp: null,
    summary: null,
    title: null,
  };
}

/* ----------------------------- AI enrichment ---------------------------- */

async function enrichWithAI(base) {
  if (!ENRICH || !client) {
    console.log("[VIN] Skipping AI enrichment (disabled or no key).");
    return null;
  }

  const prompt = [
    "You are enriching decoded VIN data.",
    "Return ONLY a compact JSON object with missing fields you can confidently infer.",
    "Allowed keys: body, drive, transmission, fuel, cylinders, displacement, engineHp, msrp, summary (<=40 words).",
    "Do not invent specs that conflict with provided data. If unsure, omit the key.",
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
      temperature: AI_TEMPERATURE,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
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
      "body",
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

/* -------------------------------- Handler ------------------------------- */

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

    // Cache first
    const cached = vinCache.get(vinParam);
    if (cached && Date.now() - cached.when < VIN_CACHE_TTL_MS) {
      console.log(`[VIN] Cache hit for ${vinParam}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(cached.payload));
    }

    // NHTSA decode
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

    // Map to our shape + year fallback + body normalization
    let data = fromNhtsa(row, vinParam);

    // Fallback title
    if (!data.title) {
      const parts = [data.year, data.make, data.model, data.trim].filter(Boolean);
      data.title = parts.join(" ").trim() || null;
    }

    // Heuristic: infer body from model/trim if still unknown
    if (!data.body) {
      const guess = guessBodyFromNames({ model: data.model, trim: data.trim });
      if (guess) data.body = guess;
    }

    // AI enrichment if still missing key fields
    const meta = { ai: { enabled: ENRICH, attempted: false, ok: false, model: MODEL } };
    const missing =
      !data.body ||
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

    const payload = { data, meta };

    // Save to cache (best-effort)
    try {
      vinCache.set(vinParam, { when: Date.now(), payload });
    } catch {}

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (err) {
    console.error("vin handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}

export default handler;
