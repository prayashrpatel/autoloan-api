// checkKey.js
import "dotenv/config";

console.log("cwd:", process.cwd());
console.log("exists?", !!process.env.OPENAI_API_KEY);
console.log("first10:", (process.env.OPENAI_API_KEY || "").slice(0, 10));
