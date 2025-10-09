// server.js
import http from "node:http";
import vinHandler from "./api/vin.js";
import scoreHandler from "./api/score.js";
import ownershipHandler from "./api/ownership.js"; // ✅ added new route

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/vin") {
    return vinHandler(req, res);
  }

  if (url.pathname === "/api/score") {
    return scoreHandler(req, res);
  }

  if (url.pathname === "/api/ownership") { // ✅ Ownership endpoint
    return ownershipHandler(req, res);
  }

  // default 404 handler
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
