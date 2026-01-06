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
const getNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const first = (row, ...keys) => { for (const k of keys) { const v = row?.[k]; if (v != null && String(v).trim() !== "") return v; } return null; };

function decodeYearFromVin(vin) {
  if (!vin || vin.length < 10) return null;
  const code = vin[9].toUpperCase();
  const baseMap = {
    A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
    J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
    T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000, "1": 2001, "2": 2002, "3": 2003,
    "4": 2004, "5": 2005, "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  };
  if (!(code in baseMap)) return null;
  const base = baseMap[code];
  const currentYear = new Date().getFullYear();
  const maxYear = currentYear + 1;
  const candidates = [base, base + 30, base + 60].filter((y) => y >= 1980 && y <= 2069);
  let chosen = null; for (const y of candidates) if (y <= maxYear) chosen = y;
  return chosen ?? null;
}

/* ----------------------- Normalizers & helpers -------------------------- */
function normalizeBodyClass(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s.includes("hatchback")) return "Hatchback";
  if (s.includes("coupe")) return "Coupe";
  if (s.includes("convertible") || s.includes("cabriolet") || s.includes("roadster")) return "Convertible";
  if (s.includes("wagon") || s.includes("estate") || s.includes("avant")) return "Wagon";
  if (s.includes("pickup")) return "Pickup";
  if (s.includes("minivan") || s.includes("mini-van")) return "Minivan";
  if (s.includes("van")) return "Van";
  if (s.includes("sport utility vehicle") || s.includes("utility") || s.includes("suv")) return "SUV";
  if (s.includes("sedan") || s.includes("saloon") || s.includes("limousine")) return "Sedan";
  return null; // too vague
}
function normalizeDrive(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.toLowerCase();
  if (s.includes("rear")) return "RWD";
  if (s.includes("front")) return "FWD";
  if (s.includes("all") || s.includes("awd") || s.includes("4 wheel")) return "AWD";
  if (s.includes("4wd") || s.includes("four-wheel")) return "4WD";
  if (["rwd","fwd","awd","4wd"].includes(s)) return s.toUpperCase();
  return null;
}
const isConvertibleLike = (text) => /\b(convertible|cabrio|cabriolet|roadster|spyder)\b/i.test((text || "").toLowerCase());
function keywordBody(text) {
  const t = (text || "").toLowerCase();
  if (/\bhatch\b|\bhatchback\b/.test(t)) return "Hatchback";
  if (/\bcoup[eé]\b|\b2-?door\b/.test(t)) return "Coupe";
  if (/\bwagon|estate|avant\b/.test(t)) return "Wagon";
  if (/\bconvertible\b|\bcabrio\b|\bcabriolet\b|\broadster\b|\bspyder\b/.test(t)) return "Convertible";
  if (/\bsuv\b|\bcrossover\b/.test(t)) return "SUV";
  if (/\bsedan\b|\bsaloon\b|\blimousine\b/.test(t)) return "Sedan";
  if (/\bminivan\b/.test(t)) return "Minivan";
  if (/\bvan\b/.test(t)) return "Van";
  if (/\bpickup\b|\btruck\b/.test(t)) return "Pickup";
  return null;
}

/* ---------------------- Known-model dictionary (small) ------------------ */
const KNOWN_MODELS = [
  // style is optional (marketing); body is the physical class
  { rx: /mercedes.*\bcls\b/i, body: "Sedan", style: "4-Door Coupe" },
  { rx: /audi\s(a7|s7|rs7)\b/i, body: "Sedan", style: "Sportback" },
  { rx: /bmw.*\bgran coupe\b/i, body: "Sedan", style: "Gran Coupe" },
  { rx: /\barteon\b/i, body: "Sedan", style: "Fastback" },
  { rx: /\bstinger\b/i, body: "Sedan", style: "Fastback" },
  { rx: /\bsienna\b|odyssey\b/i, body: "Minivan" },
  { rx: /\boutback\b/i, body: "Wagon" },
  // E-Class Coupe (C238) & other coupes often mislabeled as sedan
  { rx: /mercedes.*\be(-|\s)?class\b.*\b(e|e450|amg)\b.*\b(coupe)\b/i, body: "Coupe" },
];

/* ----------------------- Universal body classifier ---------------------- */
function classifyBodyPyramid({ nhtsaBody, doors, make, model, trim }) {
  const votes = new Map(); // body -> score
  const add = (label, pts) => { if (!label) return; votes.set(label, (votes.get(label) || 0) + pts); };
  const name = [make, model, trim].filter(Boolean).join(" ");

  // 1) NHTSA precise
  const mapped = normalizeBodyClass(nhtsaBody);
  if (mapped) add(mapped, 3);

  // 2) hard cues
  if (isConvertibleLike(name)) add("Convertible", 3);
  if (Number(doors) === 2 && !isConvertibleLike(name)) add("Coupe", 3);

  // 3) keywords
  add(keywordBody(name), 2);

  // 4) dictionary
  for (const row of KNOWN_MODELS) { if (row.rx.test(name)) { add(row.body, 3); } }

  // winner
  let best = null, bestScore = -1;
  for (const [label, score] of votes.entries()) { if (score > bestScore) { best = label; bestScore = score; } }

  // guards
  if (Number(doors) === 2 && best !== "Convertible") best = "Coupe";
  if (isConvertibleLike(name)) best = "Convertible";

  // style via dictionary (optional, doesn’t affect body)
  let style = null;
  for (const row of KNOWN_MODELS) { if (row.rx.test(name) && row.style) { style = row.style; break; } }

  return { body: best || null, style };
}

/* ---------------------------- NHTSA → VinInfo --------------------------- */
function fromNhtsa(row, vinValue) {
  const nhtsaBodyRaw = clean(first(row, "Body Class", "BodyClass"));
  const rawDrive = first(row, "Drive Type", "Drive Type - Primary", "DriveType", "DriveTypePrimary");
  const drive = normalizeDrive(rawDrive) || clean(rawDrive);

  const yearApi = getNum(first(row, "Model Year", "ModelYear"));
  const vinYear = decodeYearFromVin(vinValue || clean(row.VIN));
  const year = yearApi ?? vinYear ?? null;

  const make = clean(first(row, "Make"));
  const rawModel = clean(first(row, "Model"));
  const rawTrim = clean(first(row, "Trim"));
  const rawSeries = clean(first(row, "Series"));

  // ---- smart model/trim mapping ----
  let model = rawModel;
  let trim = rawTrim || rawSeries;

  // BMW: NHTSA often puts variant in Model and the family in Series.
  // We want: model="5-Series" trim="540i"  |  model="X3" trim="M40i"  | model="8-Series" trim="M8"
  if ((make || "").toLowerCase() === "bmw") {
    const rm = (rawModel || "").trim();
    const rs = (rawSeries || "").trim();

    // detect family like: "3-Series", "5-Series", "X3", "X5", "Z4", "i4"
    const looksLikeSeriesFamily = /(series|^x\d$|^z\d$|^i\d$)/i.test(rs);

    // detect BMW variant tokens:
    // - numeric: 540i, 330i, 840i, 750e, etc.
    // - M variants: M340i, M550i, M8, M2, M3, M4, etc.
    // - M-performance: M40i, M50i, M60i, M35i, etc.
    const looksLikeVariant =
      /^(\d{3}[a-z]{0,2}|\d{3}e|m\d{1,3}[a-z]{0,2}|m(35i|40i|50i|60i)|m\d{2})\b/i.test(rm);

    // Case 1: series family exists and model looks like variant -> swap
    // ex: Series="5-Series", Model="540i"
    if (looksLikeSeriesFamily && looksLikeVariant) {
      model = rs;
      trim = rm;
    }

    // Case 2: Model includes both family and variant -> split into model/trim
    // ex: Model="X3 M40i" (Series might be missing or just "X3")
    // We prefer model="X3", trim="M40i"
    const split = rm.match(/\b(x\d|z\d|i\d)\b\s*(m\d{1,3}[a-z]{0,2}|m(35i|40i|50i|60i)|\d{3}[a-z]{0,2}|\d{3}e)\b/i);
    if (split) {
      const family = split[1].toUpperCase(); // X3
      const variant = split[2].toUpperCase(); // M40I / 540I / etc.
      model = family;
      trim = variant.replace(/I$/, "i").replace(/D$/, "d"); // tiny casing cleanup
    }

    // Case 3: fallback: if Series exists but model is variant and we didn't swap above for some reason
    if (rs && looksLikeVariant && model === rm) {
      model = rs;
      trim = rm;
    }
  }

  return {
    vin: vinValue || clean(row.VIN),
    year,
    make,
    model,
    trim,

    // keep raw; final body/style decided later by classifier
    _nhtsaBody: nhtsaBodyRaw,
    body: normalizeBodyClass(nhtsaBodyRaw) || null,
    style: null,

    doors: getNum(first(row, "Doors", "DoorCount")),
    drive,
    transmission: clean(first(row, "Transmission Style", "TransmissionDescriptor", "Transmission")),
    fuel: clean(first(row, "Fuel Type - Primary", "Fuel Type Primary", "FuelTypePrimary")),
    cylinders: getNum(first(row, "Engine Number of Cylinders", "EngineNumberofCylinders", "Cylinders")),
    displacement: getNum(first(row, "Displacement (L)", "Engine Displacement (L)", "EngineDisplacementL", "DisplacementL")),
    engineHp: getNum(first(row, "Engine HP", "EngineHP")),

    msrp: null,
    summary: null,
    title: null,
  };
}

/* ------------------------------- AI enrich ------------------------------ */
async function enrichWithAI(base) {
  if (!ENRICH || !client) return null;

  const prompt = [
    "You are enriching decoded VIN data.",
    "Return ONLY a valid JSON object (no prose) with missing fields you can confidently infer.",
    "Allowed keys: body, drive, transmission, fuel, cylinders, displacement, engineHp, msrp, summary (<=40 words).",
    "Body must be one of: [\"sedan\",\"coupe\",\"convertible\",\"hatchback\",\"wagon\",\"suv\",\"minivan\",\"pickup\",\"van\"].",
    "Never contradict the provided data. If unsure, omit the key.",
    "",
    "Known data:",
    JSON.stringify({
      year: base.year, make: base.make, model: base.model, trim: base.trim,
      body: base.body, doors: base.doors
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
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const patch = JSON.parse(match[0]);
    if (!DO_SUM && "summary" in patch) delete patch.summary;

    const allowed = ["body","drive","transmission","fuel","cylinders","displacement","engineHp","msrp","summary"];
    const out = {};
    for (const k of allowed) if (patch[k] != null) out[k] = patch[k];
    return out;
  } catch (err) {
    console.error("[VIN] AI enrichment error:", err);
    return null;
  }
}

/* ----------------------------- Fetch w/ timeout ------------------------- */
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(t); }
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

    // cache unless fresh=1
    if (!forceFresh) {
      const cached = vinCache.get(vinParam);
      if (cached && Date.now() - cached.when < VIN_CACHE_TTL_MS) {
        console.log(`[VIN] Cache hit for ${vinParam}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(cached.payload));
      }
    }

    // NHTSA
    const r = await fetchWithTimeout(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vinParam}?format=json`,
      HTTP_TIMEOUT_MS
    );
    if (!r.ok) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: `NHTSA error ${r.status}` }));
    }

    const j = await r.json();
    const row = Array.isArray(j?.Results) && (j.Results.find(x => x.Make || x.Model || x["Model Year"]) || j.Results[0]);
    if (!row) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "VIN not found" }));
    }

    let data = fromNhtsa(row, vinParam);

    // title
    if (!data.title) {
      const parts = [data.year, data.make, data.model, data.trim].filter(Boolean);
      data.title = parts.join(" ").trim() || null;
    }

    // ---------- BODY: universal classifier (NHTSA + heuristics + dict) ----------
    const cls = classifyBodyPyramid({
      nhtsaBody: data._nhtsaBody, doors: data.doors,
      make: data.make, model: data.model, trim: data.trim
    });
    if (cls.body) data.body = cls.body;
    if (cls.style) data.style = cls.style;

    // ---------- AI enrichment (only if key gaps) ----------
    const meta = { ai: { enabled: ENRICH, attempted: false, ok: false, model: MODEL } };
    const missing =
      !data.body || !data.drive || !data.transmission || !data.fuel ||
      !data.cylinders || !data.displacement || !data.engineHp ||
      data.msrp == null || (DO_SUM && !data.summary);

    let aiPatch = null;
    if (ENRICH && missing) {
      meta.ai.attempted = true;
      aiPatch = await enrichWithAI(data);
      if (aiPatch) {
        // fill non-body/drive first; body/drive get final say below
        const { body, drive, ...rest } = aiPatch;
        for (const k of Object.keys(rest)) if (data[k] == null && rest[k] != null) data[k] = rest[k];
        meta.ai.ok = true;
      }
    }

    // ---------- DRIVE finalize ----------
    // 1) explicit model keywords
    const nameStr = `${data.make || ""} ${data.model || ""} ${data.trim || ""}`.toLowerCase();
    const hasAwdKeyword = /\b(4matic|quattro|xdrive|4motion|awd|all[\s-]?wheel|4wd)\b/i.test(nameStr);
    if (!data.drive && hasAwdKeyword) data.drive = "AWD";

    // 2) brand/body defaults: coupes default RWD unless AWD keyword
    if ((data.body || "").toLowerCase() === "coupe" && !hasAwdKeyword) {
      if (/mercedes/.test(nameStr) || /bmw/.test(nameStr)) data.drive = "RWD";
    }

    // 3) AI override last (if provided)
    if (aiPatch?.drive) data.drive = String(aiPatch.drive).toUpperCase();
    if (data.drive) {
      const d = data.drive.toUpperCase();
      if (["AWD", "RWD", "FWD", "4WD"].includes(d)) data.drive = d;
    }

    // ---------- Cylinders sanity / correction ----------
    // If AI provided, allow fix when base missing or implausible vs displacement & model
    if (aiPatch?.cylinders != null) {
      const aiCyl = Number(aiPatch.cylinders);
      const baseCyl = Number(data.cylinders ?? 0);
      const disp = Number(data.displacement ?? 0);

      const likelyE450I6 =
        /mercedes/.test(nameStr) && /\be[-\s]?450\b/i.test(nameStr) && disp >= 2.9 && disp <= 3.1;

      // more general rule: 2.8–3.2L turbo sixes (BMW B58, Mercedes M256, etc.)
      const looksLikeModernThreeLiter = disp >= 2.8 && disp <= 3.2 && aiCyl === 6;

      if (!baseCyl || baseCyl === 4 || likelyE450I6 || looksLikeModernThreeLiter) {
        data.cylinders = aiCyl;
      }
    }

    // --------- Cache & respond ----------
    const payload = { data, meta };
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
