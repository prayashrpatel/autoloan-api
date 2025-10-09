// ESM exports
export const FUEL_CLASS = {
  compact_ICE: { mpgMixed: 32 },
  midsize_sedan_ICE: { mpgMixed: 29 },
  suv_ICE: { mpgMixed: 24 },
  truck_ICE: { mpgMixed: 20 },
  compact_EV: { kwhPer100mi: 28 },
  midsize_sedan_EV: { kwhPer100mi: 30 },
  suv_EV: { kwhPer100mi: 35 },
  truck_EV: { kwhPer100mi: 44 },
};

export const MAINTENANCE = {
  ICE: {
    "0-3":  { compact: 350,  midsize: 450,  suv: 550,  truck: 600 },
    "4-7":  { compact: 650,  midsize: 750,  suv: 900,  truck: 1000 },
    "8-12": { compact: 1050, midsize: 1200, suv: 1400, truck: 1600 },
  },
  EV: {
    "0-3":  { compact: 260,  midsize: 340,  suv: 420,  truck: 480 },
    "4-7":  { compact: 500,  midsize: 600,  suv: 720,  truck: 800 },
    "8-12": { compact: 800,  midsize: 920,  suv: 1100, truck: 1200 },
  },
};

export const INSURANCE = {
  rural:    { economy: 95,  standard: 120, sport: 160, luxury: 190 },
  suburban: { economy: 110, standard: 140, sport: 185, luxury: 215 },
  urban:    { economy: 125, standard: 165, sport: 210, luxury: 250 },
};
