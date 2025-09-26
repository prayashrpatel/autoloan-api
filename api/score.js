// api/score.js
const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 6000);

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
const num = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n) : d);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    }

    const body = await readBody(req);
    const cfg = body?.cfg || {};
    const borrower = body?.borrower || {};

    const price = num(cfg.price);
    const down = num(cfg.down);
    const feesUpfront = num(cfg?.fees?.upfront);
    const feesFinanced = num(cfg?.fees?.financed);
    const extrasUpfront = num(cfg?.extras?.upfront);
    const extrasFinanced = num(cfg?.extras?.financed);
    const tradeIn = num(cfg.tradeIn);
    const tradeInPayoff = num(cfg.tradeInPayoff);
    const apr = num(cfg.apr);
    const termMonths = num(cfg.termMonths);
    const taxRate = num(cfg.taxRate);
    const taxRule = cfg.taxRule === "price_full" ? "price_full" : "price_minus_tradein";

    const monthlyIncome = num(borrower.monthlyIncome);
    const housingCost = num(borrower.housingCost);
    const otherDebt = num(borrower.otherDebt);

    const taxableBase = taxRule === "price_full" ? price : Math.max(0, price - tradeIn);
    const salesTax = taxableBase * (taxRate / 100);

    const financedAmount = Math.max(
      0,
      price + feesUpfront + feesFinanced + extrasUpfront + extrasFinanced + salesTax
        - down - tradeIn + tradeInPayoff
    );

    const ltv = price > 0 ? financedAmount / price : 0;

    const r = apr > 0 ? (apr / 100) / 12 : 0;
    const pmt =
      r > 0 && termMonths > 0
        ? financedAmount * (r / (1 - Math.pow(1 + r, -termMonths)))
        : termMonths > 0
        ? financedAmount / termMonths
        : 0;

    const dti = monthlyIncome > 0 ? (housingCost + otherDebt + pmt) / monthlyIncome : 0;

    const violations = [];
    if (ltv > 1.0) violations.push({ code: "MAX_LTV", message: "LTV exceeds 100.0%" });
    if (dti > 0.5) violations.push({ code: "MAX_DTI", message: "DTI 50.0% limit exceeded" });

    const approved = violations.length === 0;

    let pd = 0.02 + 0.6 * clamp(ltv - 0.8, 0, 1) + 0.6 * clamp(dti - 0.3, 0, 1);
    pd = clamp(pd, 0.01, 0.95);
    const confidence = 0.7;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      data: {
        rules: { approved, violations },
        risk: { pd, confidence },
        features: { ltv, dti },
      },
    }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
