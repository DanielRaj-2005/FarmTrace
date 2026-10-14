// backend/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const readingsRouter = require("./routes/readings");
const productsRouter = require("./routes/products");
const authRouter = require("./routes/auth");
const storage = require("./services/storage");
const { startMqttBridge } = require("./services/mqttBridge");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API
app.use("/api/auth", authRouter);
app.use("/api/readings", readingsRouter);
app.use("/api/products", productsRouter);

// Serve the dashboard (frontend/) as static files
app.use(express.static(path.join(__dirname, "..", "frontend")));

if (require.main === module) {
  const server = app.listen(PORT);

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the existing process on http://localhost:${PORT} or set PORT in .env to a free port.`);
      process.exit(1);
    }
    throw error;
  });

  server.on("listening", () => {
    console.log(`Farm-to-Fork server running on http://localhost:${PORT}`);
    console.log(`Storage provider: ${storage.PROVIDER}`);
    if (!process.env.DEVICE_API_KEY) {
      console.warn("WARNING: DEVICE_API_KEY is not set. Copy .env.example to .env and set one.");
    }
  });

  let mqttBridge;
  startMqttBridge()
    .then((bridge) => {
      mqttBridge = bridge;
      console.log(`MQTT broker listening on port ${bridge.port}`);
    })
    .catch((error) => {
      console.error(`MQTT broker failed to start: ${error.message}`);
    });

  const shutdown = async () => {
    if (mqttBridge) await mqttBridge.close();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = app;
