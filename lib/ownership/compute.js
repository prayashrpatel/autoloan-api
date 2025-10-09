import { FUEL_CLASS, MAINTENANCE, INSURANCE } from "./tables.js";

export function bandByAge(ageYears) {
  if (ageYears <= 3) return "0-3";
  if (ageYears <= 7) return "4-7";
  return "8-12";
}

export function calcFuelMonthly({ veh, prices, annualMiles }) {
  if (veh.powertrain === "EV") {
    const kwh100 = veh.kwhPer100mi ?? FUEL_CLASS[veh.class]?.kwhPer100mi ?? 32;
    const annualKwh = (annualMiles / 100) * kwh100;
    const annualCost = (prices.kWhPrice ?? 0.18) * annualKwh;
    return annualCost / 12;
  }
  const mpg = veh.mpgMixed ?? FUEL_CLASS[veh.class]?.mpgMixed ?? 26;
  const gallons = annualMiles / Math.max(mpg, 1);
  const annualCost = (prices.gasPrice ?? 4.0) * gallons;
  return annualCost / 12;
}

export function calcMaintenanceMonthly({ vehClassGroup, powertrain, ageYears }) {
  const band = bandByAge(ageYears);
  const table = MAINTENANCE[powertrain === "EV" ? "EV" : "ICE"][band];
  const annual = table[vehClassGroup] ?? 800;
  return annual / 12;
}

export function estimateInsuranceMonthly({ zipTier, vehicleRiskClass }) {
  const base = INSURANCE[zipTier ?? "suburban"] ?? INSURANCE.suburban;
  return base[vehicleRiskClass ?? "standard"] ?? 140;
}
