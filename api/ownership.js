import { calcFuelMonthly, calcMaintenanceMonthly, estimateInsuranceMonthly } from "../lib/ownership/compute.js";
import { getLocalPrices } from "../lib/ownership/prices.js";
import { resolveVehicleFromVIN } from "../lib/vehicle/resolve.js";
import OpenAI from "openai";

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const client = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

function ageFromYear(year) {
  const now = new Date().getFullYear();
  return Math.max(0, now - Number(year || now));
}
function zipToTier(zip) {
  if (!zip) return "suburban";
  const z = Number(String(zip).slice(0,3));
  if (z % 7 === 0) return "urban";
  if (z % 3 === 0) return "rural";
  return "suburban";
}
function computeConfidence({ veh, prices }) {
  let score = 3;
  if (!veh.mpgMixed && !veh.kwhPer100mi) score--;
  if (!prices || (!prices.gasPrice && !prices.kWhPrice)) score--;
  return score === 3 ? "high" : score === 2 ? "medium" : "low";
}
function buildWarnings({ veh, prices }) {
  const w = [];
  if (!veh.mpgMixed && !veh.kwhPer100mi) w.push("Used class average efficiency");
  if (!prices || (!prices.gasPrice && !prices.kWhPrice)) w.push("Used national average energy prices");
  return w;
}
async function aiExplainOwnership(payload, veh) {
  if (!client) return { summary: undefined, suggestions: undefined, confidence: payload.confidence };
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are an automotive finance assistant. Be concise and practical." },
      {
        role: "user",
        content:
          "Explain the ownership estimate in 2–3 sentences. Do not invent numbers; use those provided. " +
          "Add 2 short money-saving suggestions.\n\n" + JSON.stringify({ veh, payload })
      }
    ],
  });
  const text = resp.choices?.[0]?.message?.content ?? "";
  const suggestions = text.split("\n").filter(l => l.trim().startsWith("-")).slice(0, 2).map(s => s.replace(/^-\s*/, ""));
  return {
    summary: text.split("\n")[0]?.trim() || text.trim(),
    suggestions: suggestions.length ? suggestions : undefined,
    confidence: payload.confidence,
  };
}

export default async function ownershipHandler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const vin = url.searchParams.get("vin") || "";
    const zip = url.searchParams.get("zip") || "";
    const annualMiles = Number(url.searchParams.get("annualMiles") || 12000);

    const veh = await resolveVehicleFromVIN(vin);
    const prices = await getLocalPrices(zip);

    const ageYears = ageFromYear(veh.year);
    const vehClassGroup = (veh.class || "midsize_sedan_ICE").includes("truck")
      ? "truck"
      : (veh.class || "").includes("suv")
      ? "suv"
      : (veh.class || "").includes("compact")
      ? "compact"
      : "midsize";
    const powertrain = veh.powertrain ?? (veh.class?.includes("_EV") ? "EV" : "ICE");
    const zipTier = zipToTier(zip);

    const fuelMonthly = calcFuelMonthly({ veh, prices, annualMiles });
    const maintenanceMonthly = calcMaintenanceMonthly({ vehClassGroup, powertrain, ageYears });
    const insuranceMonthly = estimateInsuranceMonthly({
      zipTier,
      vehicleRiskClass: ["luxury","sport"].some(k => (veh.class || "").includes(k)) ? "luxury" : "standard",
    });

    const totalMonthly = fuelMonthly + maintenanceMonthly + insuranceMonthly;

    const payload = {
      totalMonthly: Number(totalMonthly.toFixed(2)),
      breakdown: {
        fuelOrCharging: {
          monthly: Number(fuelMonthly.toFixed(2)),
          basis: powertrain === "EV"
            ? `~${veh.kwhPer100mi ?? "class avg"} kWh/100mi @ $${(prices.kWhPrice ?? 0.18).toFixed(2)}/kWh`
            : `~${veh.mpgMixed ?? "class avg"} mpg @ $${(prices.gasPrice ?? 4.0).toFixed(2)}/gal`,
        },
        insurance: {
          monthly: Number(insuranceMonthly.toFixed(2)),
          basis: `${zipTier} ZIP tier, ${vehClassGroup} class`,
        },
        maintenance: {
          monthly: Number(maintenanceMonthly.toFixed(2)),
          basis: `${powertrain} ${vehClassGroup}, age ${ageYears}y`,
        },
      },
      assumptions: {
        annualMiles,
        zip: zip || null,
        fuelPricePerGal: prices.gasPrice ?? null,
        kWhPrice: prices.kWhPrice ?? null,
        vehicleClass: veh.class ?? "unknown",
        vehicleAgeYears: ageYears,
      },
      confidence: computeConfidence({ veh, prices }),
      provenance: {
        fuelModel: "rules:v1",
        insuranceModel: "zip-tier:v0.3",
        maintenanceModel: "age-class:v0.2",
        aiModel: client ? "gpt-4o-mini" : null,
      },
      warnings: buildWarnings({ veh, prices }),
    };

    const ai = await aiExplainOwnership(payload, veh);
    payload.aiSummary = ai.summary;
    payload.suggestions = ai.suggestions;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (e) {
    console.error("ownership error", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ownership computation failed" }));
  }
}
