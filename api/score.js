// api/score.js  — default export (ESM)
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Expect JSON body:
 * {
 *   financedAmount, apr, termMonths,
 *   features: { ltv, dti },   // if you already compute in FE, send them too
 *   borrower: { monthlyIncome, housingCost, otherDebt }
 * }
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Method not allowed" }));
    }

    // Read JSON body
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");

    const {
      financedAmount = 0,
      apr = 0,
      termMonths = 60,
      features = {},
      borrower = {},
    } = body || {};

    // Derive (fallbacks if FE didn’t send)
    const ltv = Number(features.ltv ?? 0); // 0..2 typically
    const dti = Number(features.dti ?? 0); // 0..2 typically
    const income = Number(borrower.monthlyIncome ?? 0);

    // Simple engineered features
    const ltvPct = clamp(ltv, 0, 2);          // keep in sane range
    const dtiPct = clamp(dti, 0, 2);
    const term   = clamp(Number(termMonths || 60), 12, 96);
    const amount = clamp(Number(financedAmount || 0) / 1000, 0, 200);
    const rate   = clamp(Number(apr || 0), 0, 30);
    const incK   = clamp(income / 1000, 0, 50);

    // Logistic regression (made-up but realistic-ish coefficients)
    // logit(PD) = b0 + b1*ltv + b2*dti + b3*term + b4*amount + b5*rate + b6*incK
    const b0 = -3.2;
    const b1 =  2.1;   // LTV drives risk up
    const b2 =  2.4;   // DTI drives risk up
    const b3 =  0.01;  // longer term slightly riskier
    const b4 =  0.005; // larger loans slightly riskier
    const b5 =  0.06;  // higher APR correlates with higher risk
    const b6 = -0.03;  // higher income reduces risk

    const z = b0 + b1*ltvPct + b2*dtiPct + b3*term + b4*amount + b5*rate + b6*incK;
    const pd = clamp(sigmoid(z), 0.001, 0.999);

    // A very rough “confidence”: better when inputs aren’t missing and within ranges
    let conf = 0.85;
    if (!Number.isFinite(ltv) || !Number.isFinite(dti) || !income) conf -= 0.25;
    if (term < 12 || term > 96) conf -= 0.05;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pd, confidence: clamp(conf, 0, 1) }));
  } catch (err) {
    console.error("[score] error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}
