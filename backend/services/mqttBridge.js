const { Aedes } = require("aedes");
const net = require("net");
const ingestReading = require("./ingestReading");

const READING_TOPIC = "farm2fork/readings/+";
const ACK_TOPIC_PREFIX = "farm2fork/acks/";

function publishAck(broker, deviceId, result) {
  if (!deviceId) return;
  broker.publish({
    cmd: "publish",
    qos: 0,
    dup: false,
    retain: false,
    topic: `${ACK_TOPIC_PREFIX}${deviceId}`,
    payload: Buffer.from(JSON.stringify(result)),
  }, () => {});
}

async function startMqttBridge({ port = Number(process.env.MQTT_PORT || 1883), host = "0.0.0.0" } = {}) {
  const broker = new Aedes();
  await broker.listen();
  const server = net.createServer((socket) => broker.handle(socket));

  broker.on("publish", async (packet, client) => {
    if (!client || !packet.topic.startsWith("farm2fork/readings/")) return;
    const topicDeviceId = packet.topic.slice("farm2fork/readings/".length);
    let payload;
    try {
      payload = JSON.parse(packet.payload.toString("utf8"));
    } catch {
      publishAck(broker, topicDeviceId, { ok: false, error: "invalid JSON payload" });
      return;
    }

    try {
      const result = await ingestReading(payload, topicDeviceId);
      publishAck(broker, topicDeviceId, {
        ...result.body,
        event_id: result.body.event_id || payload.event_id,
        ok: result.status < 400 && result.body.ok !== false,
        status: result.status,
      });
    } catch (error) {
      console.error("MQTT reading ingestion failed:", error.message);
      publishAck(broker, topicDeviceId, {
        ok: false,
        status: 500,
        event_id: payload.event_id,
        error: "reading ingestion failed",
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    port: address.port,
    async close() {
      await new Promise((resolve) => broker.close(resolve));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startMqttBridge, READING_TOPIC, ACK_TOPIC_PREFIX };
