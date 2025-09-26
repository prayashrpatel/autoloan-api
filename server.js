import http from "http";
import vinHandler from "./api/vin.js";
import scoreHandler from "./api/score.js";

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/vin")) return vinHandler(req, res);
  if (req.url.startsWith("/api/score")) return scoreHandler(req, res);

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(3000, () => {
  console.log("API server running on http://localhost:3000");
});
