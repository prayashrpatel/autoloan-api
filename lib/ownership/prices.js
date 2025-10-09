const cache = new Map(); // zip -> { gasPrice, kWhPrice, when }

const round2 = (x) => Math.round(x * 100) / 100;

export async function getLocalPrices(zip) {
  const now = Date.now();
  const hit = cache.get(zip);
  if (hit && now - hit.when < 24 * 60 * 60 * 1000) return hit;

  const z3 = Number(String(zip || "").slice(0, 3));
  const gas = !isNaN(z3) ? 3.6 + ((z3 % 10) * 0.08) : 4.0;   // ~3.6–4.4
  const kwh = !isNaN(z3) ? 0.14 + ((z3 % 10) * 0.01) : 0.18; // ~0.14–0.23

  const obj = { gasPrice: round2(gas), kWhPrice: round2(kwh), when: now };
  cache.set(zip, obj);
  return obj;
}
