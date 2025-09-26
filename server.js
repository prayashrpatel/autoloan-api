// server.js
import http from "node:http";
import vinHandler from "./api/vin.js";
import scoreHandler from "./api/score.js"; // <-- add this

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/vin") {
    return vinHandler(req, res);
  }
  if (url.pathname === "/api/score") {              // <-- add this
    return scoreHandler(req, res);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
