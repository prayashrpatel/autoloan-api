import "dotenv/config";
import http from "node:http";

import vinHandler from "./api/vin.js";
import scoreHandler from "./api/score.js";
import ownershipHandler from "./api/ownership.js";
import rebatesHandler from "./api/rebates.js";
import vehiclesHandler from "./api/vehicles.js";
import vehiclePhotoHandler from "./api/vehiclePhoto.js";
import marketStatsHandler from "./api/market-stats.js";

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // CORS (dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // console.log(req.method, url.pathname);
  // Market stats
  if (url.pathname === "/api/market-stats") {
    return marketStatsHandler(req, res);
  }

  // Vehicle photo (support BOTH spellings)
  if (url.pathname === "/api/vehicle-photo" || url.pathname === "/api/vehiclePhoto") {
    return vehiclePhotoHandler(req, res);
  }

  // health
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, port: PORT, ts: Date.now() }));
  }

  // canonical search endpoint
  if (url.pathname === "/api/vehicles") return vehiclesHandler(req, res);

  // other endpoints
  if (url.pathname === "/api/vin") return vinHandler(req, res);
  if (url.pathname === "/api/score") return scoreHandler(req, res);
  if (url.pathname === "/api/ownership") return ownershipHandler(req, res);
  if (url.pathname === "/api/rebates") return rebatesHandler(req, res);

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ error: "Not Found", path: url.pathname }));
});

server.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
