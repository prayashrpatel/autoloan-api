// api/vin.js — ESM default export

import OpenAI from "openai";

/* --------------------------- Config & globals --------------------------- */
const ENRICH = String(process.env.AI_ENRICH_ENABLED || "false").toLowerCase() === "true";
const DO_SUM = String(process.env.AI_SUMMARY_ENABLED || "false").toLowerCase() === "true";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const AI_TEMPERATURE = Number(process.env.AI_TEMPERATURE ?? 0.2);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 120);

const VIN_CACHE_TTL_MS = Number(process.env.VIN_CACHE_TTL_MS || 24 * 60 * 60 * 1000); // 24h
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 6000);

const vinCache = new Map(); // Map<VIN, { when:number, payload:any }>
const client = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

/* ------------------------------- Utilities ------------------------------ */
const clean = (s) => (s && typeof s === "string" ? s.trim() || null : null);
const getNum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const first = (row, ...keys) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
};

/** Decode model year from VIN 10th character, using plausible cycle. */
function decodeYearFromVin(vin) {
  if (!vin || vin.length < 10) return null;
  const code = vin[9].toUpperCase();
  const baseMap = {
    A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
    J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
    T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
    "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
    "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  };
  if (!(code in baseMap)) return null;

  const base = baseMap[code];
  const currentYear = new Date().getFullYear();
  const maxYear = currentYear + 1; // early next-MY allowance
  const candidates = [base, base + 30, base + 60].filter((y) => y >= 1980 && y <= 2069);

  let chosen = null;
  for (const y of candidates) if (y <= maxYear) chosen = y;
  return chosen ?? null;
}

/** Normalize NHTSA "Body Class" to a simple label. */
function normalizeBodyClass(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s.includes("hatchback")) return "Hatchback";
  if (s.includes("coupe")) return "Coupe";
  if (s.includes("convertible") || s.includes("cabriolet") || s.includes("roadster")) return "Convertible";
  if (s.includes("wagon")) return "Wagon";
  if (s.includes("pickup")) return "Pickup";
  if (s.includes("minivan") || s.includes("mini-van")) return "Minivan";
  if (s.includes("van")) return "Van";
  if (s.includes("sport utility vehicle") || s.includes("utility") || s.includes("suv")) return "SUV";
  if (s.includes("sedan") || s.includes("saloon") || s.includes("limousine")) return "Sedan";
  return null; // too vague
}

/** Normalize drive strings to codes. */
function normalizeDrive(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s.includes("rear")) return "RWD";
  if (s.includes("front")) return "FWD";
  if (s.includes("all") || s.includes("awd") || s.includes("4 wheel")) return "AWD";
  if (s.includes("4wd") || s.includes("four-wheel")) return "4WD";
  if (["rwd", "fwd", "awd", "4wd"].includes(s)) return s.toUpperCase();
  return null;
}

/** Body guess from model/trim keywords. */
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
const isConvertibleLike = (text) =>
  /\b(convertible|cabrio|cabriolet|roadster|spyder)\b/i.test((text || "").toLowerCase());

/** Strong heuristic body fixer (runs before + after AI). */
function deriveBodyFromHeuristics(data) {
  if (data.body && !/sedan|unknown/i.test(data.body)) return data.body;
  const name = [data.model, data.trim].filter(Boolean).join(" ");
  const doors = data.doors ?? null;

  if (isConvertibleLike(name)) return "Convertible";
  if (doors === 2) return "Coupe";
  if (/\b(hatch|hatchback)\b/i.test(name)) return "Hatchback";
  if (/\bwagon\b/i.test(name)) return "Wagon";
  if (/\bminivan\b/i.test(name)) return "Minivan";
  if (/\bvan\b/i.test(name)) return "Van";
  if (/\b(pickup|truck)\b/i.test(name)) return "Pickup";
  if (/\b(suv|crossover)\b/i.test(name)) return "SUV";
  if (doors === 4 && (!data.body || /sedan/i.test(data.body))) return "Sedan";
  return data.body || null;
}

/** Brand/trim keywords for drive. */
function deriveDriveFromNames(data) {
  const s = [data.make, data.model, data.trim].filter(Boolean).join(" ").toLowerCase();
  if (/\b(4matic|quattro|xdrive|4motion|4wd|awd)\b/i.test(s)) return "AWD";
  if (/\bsdrive\b/i.test(s)) return "RWD";
  return data.drive || null;
}

/** Shallow-fill only missing keys. */
function fillMissing(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    if (out[k] == null && patch[k] != null) out[k] = patch[k];
  }
  return out;
}

/** Merge base + AI with strong guards (2 doors ⇒ Coupe). */
function reconcileVehicleFields(baseData, aiPatch) {
  const out = { ...baseData };

  // BODY: heuristics first
  const heurBody = deriveBodyFromHeuristics(out);
  if (heurBody) out.body = heurBody;

  // AI may refine body
  if (aiPatch?.body) out.body = aiPatch.body;

  // FINAL guard: 2 doors ⇒ Coupe (unless convertible)
  if (Number(out.doors) === 2 && !isConvertibleLike(out.body)) {
    out.body = "Coupe";
  }

  // DRIVE: brand/trim inference
  const nameDrive = deriveDriveFromNames(out);
  if (nameDrive) out.drive = nameDrive;

  // AI may refine drive
  if (aiPatch?.drive) out.drive = aiPatch.drive;

  // Normalize drive code
  if (out.drive) {
    const d = String(out.drive).toUpperCase();
    if (["AWD", "RWD", "FWD", "4WD"].includes(d)) out.drive = d;
  }

  return out;
}

/* --------------------------- NHTSA -> VinInfo --------------------------- */
function fromNhtsa(row, vinValue) {
  const body = normalizeBodyClass(clean(first(row, "Body Class", "BodyClass"))) || null;

  const rawDrive = first(
    row,
    "Drive Type",
    "Drive Type - Primary",
    "DriveType",
    "DriveTypePrimary"
  );
  const drive = normalizeDrive(rawDrive) || clean(rawDrive);

  const yearApi = getNum(first(row, "Model Year", "ModelYear"));
  const vinYear = decodeYearFromVin(vinValue || clean(row.VIN));
  const year = yearApi ?? vinYear ?? null;

  return {
    vin: vinValue || clean(row.VIN),
    year,
    make: clean(first(row, "Make")),
    model: clean(first(row, "Model")),
    trim: clean(first(row, "Trim", "Series")),
    body,
    doors: getNum(first(row, "Doors", "DoorCount")),
    drive, // normalized value
    transmission: clean(first(row, "Transmission Style", "TransmissionDescriptor", "Transmission")),
    fuel: clean(first(row, "Fuel Type - Primary", "Fuel Type Primary", "FuelTypePrimary")),
    cylinders: getNum(first(row, "Engine Number of Cylinders", "EngineCylinders", "Cylinders")),
    displacement: getNum(first(row, "Displacement (L)", "Engine Displacement (L)", "EngineDisplacementL", "DisplacementL")),
    engineHp: getNum(first(row, "Engine HP", "EngineHP")),
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
    "Return ONLY a valid JSON object (no prose) with missing fields you can confidently infer.",
    "Allowed keys: body, drive, transmission, fuel, cylinders, displacement, engineHp, msrp, summary (<=40 words).",
    "Never contradict the provided data. If unsure, omit the key.",
    "",
    "Known data:",
    JSON.stringify({
      year: base.year,
      make: base.make,
      model: base.model,
      trim: base.trim,
      body: base.body,
      doors: base.doors,
    }),
  ].join("\n");

  try {
    const r = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: AI_TEMPERATURE,
      max_tokens: AI_MAX_OUTPUT_TOKENS,
    });

    const text = r.choices?.[0]?.message?.content || "";
    // Extract the first JSON object from any formatting
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

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
    return filtered;
  } catch (err) {
    console.error("[VIN] AI enrichment error:", err);
    return null;
  }
}

/* ----------------------------- Fetch with timeout ----------------------- */
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
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
    const forceFresh = url.searchParams.get("fresh") === "1";

    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vinParam)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "VIN must be 17 characters (no I/O/Q)." }));
    }

    // Cache (unless ?fresh=1)
    if (!forceFresh) {
      const cached = vinCache.get(vinParam);
      if (cached && Date.now() - cached.when < VIN_CACHE_TTL_MS) {
        console.log(`[VIN] Cache hit for ${vinParam}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(cached.payload));
      }
    }

    // NHTSA decode
    const nhtsaUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vinParam}?format=json`;
    const r = await fetchWithTimeout(nhtsaUrl, HTTP_TIMEOUT_MS);
    if (!r.ok) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: `NHTSA error ${r.status}` }));
    }

    const j = await r.json();
    const row = Array.isArray(j?.Results) &&
      (j.Results.find((x) => x.Make || x.Model || x["Model Year"]) || j.Results[0]);
    if (!row) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "VIN not found" }));
    }

    let data = fromNhtsa(row, vinParam);

    // Title fallback
    if (!data.title) {
      const parts = [data.year, data.make, data.model, data.trim].filter(Boolean);
      data.title = parts.join(" ").trim() || null;
    }

    // Extra heuristic if body still unknown
    if (!data.body) {
      const guess = guessBodyFromNames({ model: data.model, trim: data.trim });
      if (guess) data.body = guess;
    }

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

    let aiPatch = null;
    if (ENRICH && missing) {
      meta.ai.attempted = true;
      aiPatch = await enrichWithAI(data);
      if (aiPatch) {
        // Fill non-body/drive fields first
        const { body, drive, ...rest } = aiPatch;
        data = fillMissing(data, rest);
        meta.ai.ok = true;
      }
    }

    // Always reconcile to finalize body/drive
    data = reconcileVehicleFields(data, aiPatch);

    const payload = { data, meta };
    // Cache
    try { vinCache.set(vinParam, { when: Date.now(), payload }); } catch {}

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (err) {
    console.error("vin handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}

export default handler;
