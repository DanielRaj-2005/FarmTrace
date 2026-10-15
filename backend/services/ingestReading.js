const { randomUUID } = require("crypto");
const storage = require("./storage");
const {
  GENESIS,
  computeChainHash,
  sha256Hex,
  encryptRecord,
} = require("./crypto");

async function ingestReading(body, topicDeviceId = null, suppliedApiKey = body.api_key) {
  const key = suppliedApiKey;
  if (!key || key !== process.env.DEVICE_API_KEY) {
    return { status: 401, body: { error: "invalid or missing api key" } };
  }

  const { temp, hum, eth } = body;
  if ([temp, hum, eth].some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return { status: 400, body: { error: "temp, hum and eth must be numbers" } };
  }

  const deviceId = typeof body.device_id === "string" && body.device_id.trim()
    ? body.device_id.trim()
    : "unknown-device";
  if (topicDeviceId && topicDeviceId !== deviceId) {
    return { status: 409, body: { error: "MQTT topic device does not match payload device_id" } };
  }

  const productId = typeof body.product_id === "string" && body.product_id.trim()
    ? body.product_id.trim()
    : null;
  const eventId = typeof body.event_id === "string" && body.event_id.trim()
    ? body.event_id.trim()
    : randomUUID();
  if (eventId.length > 128) return { status: 400, body: { error: "event_id is too long" } };

  let batchId = typeof body.batch_id === "string" && body.batch_id.trim()
    ? body.batch_id.trim()
    : null;
  if (productId) {
    const product = await storage.getProductById(productId);
    if (!product) return { status: 404, body: { error: "product not found" } };
    if (product.device_id !== deviceId) {
      return { status: 409, body: { error: "device is not associated with this product" } };
    }
    if (batchId && batchId !== product.batch_id) {
      return { status: 409, body: { error: "batch_id does not match the product" } };
    }
    batchId = product.batch_id;
  }

  const payloadHash = sha256Hex(JSON.stringify({ temp, hum, eth, product_id: productId, batch_id: batchId }));
  const result = await storage.appendSensorEvent({
    deviceId,
    eventId,
    payloadHash,
    genesis: GENESIS,
    createRecord: ({ id, prevHash }) => {
      const reading = {
        id,
        device_id: deviceId,
        event_id: eventId,
        ...(productId ? { product_id: productId, batch_id: batchId } : {}),
        ts: new Date().toISOString(),
        temp,
        hum,
        eth,
      };
      const chainHash = computeChainHash(reading, prevHash);
      return {
        id,
        deviceId,
        eventId,
        payloadHash,
        ...(productId ? { productId, batchId } : {}),
        prevHash,
        chainHash,
        enc: encryptRecord(reading),
        claimedEnc: encryptRecord({ temp, hum, eth }),
      };
    },
  });

  if (result.status === "conflict") {
    return { status: 409, body: { error: "event_id already exists with a different payload" } };
  }
  if (result.status === "duplicate") {
    return { status: 200, body: { ok: true, duplicate: true, id: result.record.id, event_id: eventId } };
  }
  return {
    status: 201,
    body: { ok: true, duplicate: false, id: result.record.id, event_id: eventId, chainHash: result.record.chainHash },
  };
}

module.exports = ingestReading;
