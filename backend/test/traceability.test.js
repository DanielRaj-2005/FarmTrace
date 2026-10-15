const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "farm2fork-test-"));
process.env.FARM2FORK_DATA_DIR = dataDir;
process.env.CLOUD_PROVIDER = "local";
process.env.DEVICE_API_KEY = "isolated-test-key";
process.env.DEMO_AUTH_SECRET = "test-only-demo-auth-secret-at-least-32-chars";
process.env.DEMO_ROLE_PASSWORD_FARMER = "test-farmer-passphrase";
process.env.DEMO_ROLE_PASSWORD_FARMER_SURESH = "test-suresh-passphrase";
process.env.DEMO_ROLE_PASSWORD_TRANSPORTER = "test-transporter-passphrase";
process.env.DEMO_ROLE_PASSWORD_WAREHOUSE = "test-warehouse-passphrase";
process.env.DEMO_ROLE_PASSWORD_RETAILER = "test-retailer-passphrase";
process.env.DEMO_ROLE_PASSWORD_ADMIN = "test-admin-passphrase";
process.env.DEMO_FARMER_NAME = "Demo Farmer";
process.env.DEMO_FARMER_SECONDARY_NAME = "Suresh Kumar";
process.env.DEMO_TRANSPORTER_NAME = "Demo Logistics";
process.env.DEMO_WAREHOUSE_NAME = "Cold Store";
process.env.DEMO_RETAILER_NAME = "Retailer";

let app;
let server;
let baseUrl;
const tokens = new Map();

function loadApp() {
  for (const file of [
    "../server",
    "../routes/readings",
    "../routes/products",
    "../routes/auth",
    "../services/storage",
    "../services/crypto",
    "../services/authorization",
  ]) {
    delete require.cache[require.resolve(file)];
  }
  app = require("../server");
}

function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => error ? reject(error) : resolve());
    server = null;
  });
}

async function roleToken(role) {
  if (tokens.has(role)) return tokens.get(role);
  const response = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, password: process.env[`DEMO_ROLE_PASSWORD_${role.toUpperCase()}`] }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  tokens.set(role, body.token);
  return body.token;
}

async function request(url, options = {}, role = "Admin") {
  const headers = { ...(options.headers || {}) };
  if (role && role !== "Customer") headers.authorization = `Bearer ${await roleToken(role)}`;
  const response = await fetch(`${baseUrl}${url}`, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, body };
}

async function requestWithCredentials(url, options, role, password) {
  const response = await fetch(`${baseUrl}/api/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  const headers = { ...(options.headers || {}), authorization: `Bearer ${body.token}` };
  const result = await fetch(`${baseUrl}${url}`, { ...options, headers });
  const contentType = result.headers.get("content-type") || "";
  const resultBody = contentType.includes("application/json") ? await result.json() : Buffer.from(await result.arrayBuffer());
  return { response: result, body: resultBody };
}

const json = (method, body, authenticated = false) => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(authenticated ? { "x-api-key": process.env.DEVICE_API_KEY } : {}),
  },
  body: JSON.stringify(body),
});

before(async () => {
  loadApp();
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("product traceability and retry-safe sensor events", async () => {
  const harvestDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const productInput = {
    product_id: "TEST-APPLE-01",
    product_name: "Demo Apples",
    batch_id: "BATCH-TEST-01",
    harvest_date: harvestDate,
    farmer_name: "Demo Farmer",
    farm_name: "North Field",
    farm_location: "Test Valley",
    transporter_name: "Demo Logistics",
    vehicle_id: "VAN-01",
    device_id: "device-test-01",
  };
  let result = await request("/api/products", json("POST", productInput));
  assert.equal(result.response.status, 201);
  assert.equal(result.body.current_stage.stage, "harvested");
  result = await request("/api/products/TEST-APPLE-01");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.farmer_name, "Demo Farmer");
  result = await request("/api/products", json("POST", productInput));
  assert.equal(result.response.status, 409);

  result = await request("/api/products/TEST-APPLE-01/qr");
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("content-type"), /image\/png/);
  assert.deepEqual(result.body.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const stageTime = new Date().toISOString();
  result = await request("/api/products/TEST-APPLE-01/stages", json("POST", {
    event_id: "stage-dispatch-01",
    stage: "dispatched",
    happened_at: stageTime,
    participant: "Demo Logistics",
    location: "Farm gate",
    batch_id: "BATCH-TEST-01",
  }), "Farmer");
  assert.equal(result.response.status, 403);
  result = await request("/api/products/TEST-APPLE-01/stages", json("POST", {
    event_id: "stage-dispatch-01",
    stage: "dispatched",
    happened_at: stageTime,
    location: "Farm gate",
    batch_id: "BATCH-TEST-01",
  }), "Transporter");
  assert.equal(result.response.status, 201);
  result = await request("/api/products/TEST-APPLE-01/stages", json("POST", {
    event_id: "stage-dispatch-01",
    stage: "dispatched",
    happened_at: stageTime,
    participant: "Demo Logistics",
    location: "Farm gate",
    batch_id: "BATCH-TEST-01",
  }), "Transporter");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.duplicate, true);
  result = await request("/api/products/TEST-APPLE-01/stages", json("POST", {
    event_id: "stage-dispatch-01",
    stage: "in_transit",
    happened_at: stageTime,
    participant: "Demo Logistics",
    location: "Farm gate",
    batch_id: "BATCH-TEST-01",
  }), "Transporter");
  assert.equal(result.response.status, 409);
  result = await request("/api/products/TEST-APPLE-01/stages", json("POST", {
    event_id: "transit-before-dispatch",
    stage: "in_transit",
    happened_at: `${harvestDate}T00:00:00.000Z`,
    batch_id: "BATCH-TEST-01",
  }), "Transporter");
  assert.equal(result.response.status, 409);

  for (const [eventId, stage, location, role] of [
    ["stage-transit-01", "in_transit", "Highway 14", "Transporter"],
    ["stage-storage-01", "received_at_storage", "Cold Store A", "Warehouse"],
    ["stage-delivered-01", "delivered", "Retail depot", "Retailer"],
  ]) {
    result = await request("/api/products/TEST-APPLE-01/stages", json("POST", {
      event_id: eventId,
      stage,
      participant: "Demo Logistics",
      location,
      batch_id: "BATCH-TEST-01",
    }), role);
    assert.equal(result.response.status, 201);
  }

  const sensorEvent = {
    device_id: "device-test-01",
    event_id: "sensor-event-001",
    product_id: "TEST-APPLE-01",
    batch_id: "BATCH-TEST-01",
    temp: 4.2,
    hum: 71,
    eth: 1.3,
  };
  const simultaneous = await Promise.all([
    request("/api/readings", json("POST", sensorEvent, true)),
    request("/api/readings", json("POST", sensorEvent, true)),
  ]);
  assert.deepEqual(simultaneous.map((item) => item.response.status).sort(), [200, 201]);
  assert.equal(simultaneous.filter((item) => item.body.duplicate).length, 1);
  result = await request("/api/readings", json("POST", { ...sensorEvent, batch_id: "WRONG-BATCH" }, true));
  assert.equal(result.response.status, 409);
  result = await request("/api/readings", json("POST", { ...sensorEvent, device_id: "wrong-device" }, true));
  assert.equal(result.response.status, 409);
  result = await request("/api/readings", json("POST", {
    device_id: "other-device",
    event_id: sensorEvent.event_id,
    temp: 3.8,
    hum: 69,
    eth: 1.1,
  }, true));
  assert.equal(result.response.status, 201);

  result = await request("/api/readings", json("POST", { ...sensorEvent, temp: 4.4 }, true));
  assert.equal(result.response.status, 409);
  let readings = await request("/api/readings");
  assert.equal(readings.body.length, 2);
  assert.equal(readings.body[0].encryption_status, "AES-256-GCM");
  assert.equal(typeof readings.body[0].prevHash, "string");
  assert.equal(readings.body[0].original.product_id, "TEST-APPLE-01");
  assert.equal(readings.body[0].claimed.temp, 4.2);

  const storedLedger = fs.readFileSync(path.join(dataDir, "ledger.json"), "utf8");
  assert.doesNotMatch(storedLedger, /"temp": 4\.2/);
  assert.match(storedLedger, /"claimedEnc"/);
  assert.match(storedLedger, /"ciphertext"/);

  result = await request("/api/products/TEST-APPLE-01/traceability");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.current_stage.stage, "delivered");
  assert.deepEqual(result.body.timeline.map((event) => event.stage), ["harvested", "dispatched", "in_transit", "received_at_storage", "delivered"]);
  assert.equal(result.body.readings[0].temp, 4.2);
  assert.equal(result.body.readings[0].encrypted_at_rest, true);
  assert.equal(result.body.integrity.status, "Verified");

  const customerTrace = await request("/api/products/TEST-APPLE-01/traceability", {}, "Customer");
  assert.equal(customerTrace.response.status, 200);
  assert.equal(Object.hasOwn(customerTrace.body, "readings"), false);
  assert.equal(Object.hasOwn(customerTrace.body.product, "device_id"), false);
  assert.equal(Object.hasOwn(customerTrace.body.product, "created_at"), false);
  assert.equal(customerTrace.body.timeline.some((event) => Object.hasOwn(event, "event_id")), false);
  assert.deepEqual(customerTrace.body.environmental_condition, {
    temperature: 4.2,
    humidity: 71,
    ethylene: 1.3,
    integrity_verified: true,
  });
  for (const forbidden of ["record_id", "event_id", "device_id", "chainHash", "ciphertext"]) {
    assert.equal(JSON.stringify(customerTrace.body).includes(forbidden), false);
  }

  const farmerTrace = await request("/api/products/TEST-APPLE-01/traceability", {}, "Farmer");
  assert.equal(farmerTrace.response.status, 200);
  assert.equal(farmerTrace.body.readings.length, 1);
  assert.equal(farmerTrace.body.product.device_id, "device-test-01");
  result = await request("/api/readings", {}, "Farmer");
  assert.equal(result.response.status, 403);
  result = await request("/api/readings", { headers: { "x-demo-role": "Admin" } }, "Customer");
  assert.equal(result.response.status, 401);
  for (const role of ["Farmer", "Transporter", "Warehouse", "Retailer"]) {
    result = await request("/api/readings/verify-chain/all", {}, role);
    assert.equal(result.response.status, 403);
    result = await request("/api/readings/demo-sync", json("POST", { readings: [] }), role);
    assert.equal(result.response.status, 403);
  }
  result = await request("/api/readings/verify-chain/all", {}, "Customer");
  assert.equal(result.response.status, 401);

  const otherProduct = {
    ...productInput,
    product_id: "TEST-OTHER-FARM-01",
    batch_id: "BATCH-OTHER-01",
    farmer_name: "Other Farmer",
    farm_name: "Other Farm",
  };
  result = await request("/api/products", json("POST", otherProduct));
  assert.equal(result.response.status, 201);
  result = await request("/api/products/TEST-OTHER-FARM-01", {}, "Farmer");
  assert.equal(result.response.status, 404);
  result = await request("/api/products", {}, "Farmer");
  assert.equal(result.body.some((product) => product.product_id === "TEST-OTHER-FARM-01"), false);
  for (const role of ["Transporter", "Warehouse", "Retailer"]) {
    result = await request("/api/products/TEST-APPLE-01/traceability", {}, role);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.readings[0].temp, 4.2);
  }

  await stopServer();
  loadApp();
  await startServer();
  result = await request("/api/readings", json("POST", sensorEvent, true));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.duplicate, true);
  readings = await request("/api/readings");
  assert.equal(readings.body.length, 2);

  result = await request("/api/readings/0/verify");
  assert.equal(result.body.match, true);
  result = await request("/api/readings/0/claim", json("PATCH", { temp: 9.9 }));
  assert.equal(result.response.status, 200);
  result = await request("/api/readings/verify-chain/all");
  assert.equal(result.body.valid, false);
  result = await request("/api/readings/0/verify");
  await request("/api/readings/0/claim", json("PATCH", result.body.original));
  result = await request("/api/readings/verify-chain/all");
  assert.equal(result.body.valid, true);

  const storage = require("../services/storage");
  const secondRecord = await storage.getRecordById(1);
  const validPreviousHash = secondRecord.prevHash;
  await storage.updateRecord(1, (record) => { record.prevHash = "BROKEN-PREVIOUS-HASH"; });
  result = await request("/api/readings/verify-chain/all");
  assert.equal(result.body.valid, false);
  await storage.updateRecord(1, (record) => { record.prevHash = validPreviousHash; });
  result = await request("/api/readings/verify-chain/all");
  assert.equal(result.body.valid, true);
});

test("Farmer registration owns harvest and does not require transporter fields", async () => {
  const product = {
    product_id: "TEST-FARMER-01",
    product_name: "Farmer Batch",
    batch_id: "FARMER-BATCH-01",
    harvest_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    farmer_name: "Demo Farmer",
    farm_name: "North Field",
    farm_location: "Test Valley",
    device_id: "farmer-device-01",
  };
  let result = await request("/api/products", json("POST", product), "Farmer");
  assert.equal(result.response.status, 201);
  assert.equal(result.body.transporter_name, "Demo Logistics");
  assert.deepEqual(result.body.timeline.map((event) => event.stage), ["harvested"]);
  const adminProduct = await request(`/api/products/${product.product_id}`, {}, "Admin");
  const initialHarvest = adminProduct.body.timeline[0];

  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "harvested",
    event_id: "duplicate-harvest",
    happened_at: new Date().toISOString(),
  }), "Farmer");
  assert.equal(result.response.status, 409);

  const duplicate = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "harvested",
    event_id: initialHarvest.event_id,
    happened_at: initialHarvest.happened_at,
    location: initialHarvest.location,
  }), "Farmer");
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.duplicate, true);

  const trace = await request(`/api/products/${product.product_id}/traceability`, {}, "Farmer");
  assert.deepEqual(trace.body.timeline.map((event) => event.stage), ["harvested"]);
});

test("Tomato demo product is isolated to Suresh and uses the shared trace pipeline", async () => {
  const product = {
    product_id: "TOMATO-TEST-01",
    product_name: "Tomato",
    batch_id: "TOMATO-TEST-BATCH-01",
    harvest_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    farmer_name: "Suresh Kumar",
    farm_name: "Red Valley Farm",
    farm_location: "Krishnagiri, Tamil Nadu",
    transporter_name: "Demo Logistics",
    vehicle_id: "TN-38-CD-6789",
    device_id: "tomato-test-device",
  };
  let result = await requestWithCredentials("/api/products", json("POST", product), "Farmer", "test-suresh-passphrase");
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.body.timeline.map((event) => event.stage), ["harvested"]);

  const sureshProducts = await requestWithCredentials("/api/products", {}, "Farmer", "test-suresh-passphrase");
  assert.deepEqual(sureshProducts.body.map((item) => item.product_id), [product.product_id]);
  const rameshProducts = await request("/api/products", {}, "Farmer");
  assert.equal(rameshProducts.body.some((item) => item.product_id === product.product_id), false);
  result = await request(`/api/products/${product.product_id}`, {}, "Farmer");
  assert.equal(result.response.status, 404);

  for (const [eventId, stage, role] of [
    ["tomato-test-dispatch", "dispatched", "Transporter"],
    ["tomato-test-transit", "in_transit", "Transporter"],
    ["tomato-test-storage", "received_at_storage", "Warehouse"],
    ["tomato-test-delivered", "delivered", "Retailer"],
  ]) {
    result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
      event_id: eventId,
      stage,
      batch_id: product.batch_id,
    }), role);
    assert.equal(result.response.status, 201);
  }

  const readings = [
    ["TOMATO-DEMO-E001", 10.2, 84, 1.0],
    ["TOMATO-DEMO-E002", 10.5, 85, 1.1],
    ["TOMATO-DEMO-E003", 10.8, 86, 1.3],
    ["TOMATO-DEMO-E004", 11.0, 87, 1.4],
  ].map(([event_id, temp, hum, eth]) => ({
    device_id: product.device_id,
    event_id,
    product_id: product.product_id,
    batch_id: product.batch_id,
    temp,
    hum,
    eth,
  }));
  for (const reading of readings) {
    result = await request("/api/readings", json("POST", reading, true));
    assert.equal(result.response.status, 201);
  }
  result = await request("/api/readings", json("POST", readings[0], true));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.duplicate, true);
  result = await request("/api/readings", json("POST", { ...readings[0], temp: 12.5 }, true));
  assert.equal(result.response.status, 409);

  const trace = await requestWithCredentials(`/api/products/${product.product_id}/traceability`, {}, "Farmer", "test-suresh-passphrase");
  assert.equal(trace.response.status, 200);
  assert.deepEqual(trace.body.timeline.map((event) => event.stage), ["harvested", "dispatched", "in_transit", "received_at_storage", "delivered"]);
  assert.equal(trace.body.current_stage.stage, "delivered");
  assert.equal(trace.body.readings.length, 4);
  assert.equal(trace.body.integrity.status, "Verified");

  const customerTrace = await request(`/api/products/${product.product_id}/traceability`, {}, "Customer");
  assert.equal(customerTrace.response.status, 200);
  for (const forbidden of ["readings", "device_id", "event_id", "record_id", "chainHash", "ciphertext", "encryption_status"]) {
    assert.equal(JSON.stringify(customerTrace.body).includes(forbidden), false);
  }
  assert.equal(customerTrace.body.environmental_condition.temperature, 11.0);
  const qr = await request(`/api/products/${product.product_id}/qr`);
  assert.equal(qr.response.status, 200);
  assert.match(qr.response.headers.get("content-type"), /image\/png/);
});

test("Transporter can advance assigned shipments only through transit", async () => {
  const product = {
    product_id: "TEST-TRANSPORTER-01",
    product_name: "Transport Demo",
    batch_id: "TRANSPORT-BATCH-01",
    harvest_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    farmer_name: "Demo Farmer",
    farm_name: "North Field",
    farm_location: "Test Valley",
    transporter_name: "Demo Logistics",
    vehicle_id: "VAN-01",
    device_id: "transport-demo-device",
  };
  let result = await request("/api/products", json("POST", product));
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.body.timeline.map((event) => event.stage), ["harvested"]);

  const dispatchTime = new Date().toISOString();
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "dispatched",
    event_id: "transport-dispatch-01",
    happened_at: dispatchTime,
    batch_id: product.batch_id,
  }), "Transporter");
  assert.equal(result.response.status, 201);
  assert.equal(result.body.product.current_stage.stage, "dispatched");

  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "dispatched",
    event_id: "transport-dispatch-01",
    happened_at: dispatchTime,
    batch_id: product.batch_id,
  }), "Transporter");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.duplicate, true);

  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "in_transit",
    event_id: "transport-transit-01",
    batch_id: product.batch_id,
  }), "Transporter");
  assert.equal(result.response.status, 201);
  assert.equal(result.body.product.current_stage.stage, "in_transit");

  for (const stage of ["received_at_storage", "delivered"]) {
    result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
      stage,
      event_id: `transport-invalid-${stage}`,
      batch_id: product.batch_id,
    }), "Transporter");
    assert.equal(result.response.status, 403);
  }

  const unassigned = {
    ...product,
    product_id: "TEST-UNASSIGNED-SHIPMENT-01",
    batch_id: "UNASSIGNED-BATCH-01",
    transporter_name: "Other Logistics",
  };
  result = await request("/api/products", json("POST", unassigned));
  assert.equal(result.response.status, 201);
  result = await request(`/api/products/${unassigned.product_id}/stages`, json("POST", {
    stage: "dispatched",
    event_id: "unassigned-dispatch-01",
    batch_id: unassigned.batch_id,
  }), "Transporter");
  assert.equal(result.response.status, 404);
});

test("Warehouse and Retailer own the final Tomato stages", async () => {
  const product = {
    product_id: "TEST-FINAL-STAGES-01",
    product_name: "Final Stage Demo",
    batch_id: "FINAL-STAGES-BATCH-01",
    harvest_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    farmer_name: "Demo Farmer",
    farm_name: "North Field",
    farm_location: "Test Valley",
    transporter_name: "Demo Logistics",
    vehicle_id: "VAN-02",
    device_id: "final-stage-device",
  };
  let result = await request("/api/products", json("POST", product));
  assert.equal(result.response.status, 201);

  const dispatchTime = new Date().toISOString();
  const transitTime = new Date(Date.now() + 1000).toISOString();
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "dispatched",
    event_id: "final-stage-dispatch-01",
    happened_at: dispatchTime,
    batch_id: product.batch_id,
  }), "Transporter");
  assert.equal(result.response.status, 201);
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "in_transit",
    event_id: "final-stage-transit-01",
    happened_at: transitTime,
    batch_id: product.batch_id,
  }), "Transporter");
  assert.equal(result.response.status, 201);

  const receiveTime = new Date(Date.now() + 1000).toISOString();
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "received_at_storage",
    event_id: "final-stage-receive-01",
    happened_at: receiveTime,
    batch_id: product.batch_id,
  }), "Warehouse");
  assert.equal(result.response.status, 201);
  assert.equal(result.body.product.current_stage.stage, "received_at_storage");
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "received_at_storage",
    event_id: "final-stage-receive-01",
    happened_at: receiveTime,
    batch_id: product.batch_id,
  }), "Warehouse");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.duplicate, true);
  for (const stage of ["dispatched", "in_transit", "delivered"]) {
    result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
      stage,
      event_id: `warehouse-invalid-${stage}`,
      batch_id: product.batch_id,
    }), "Warehouse");
    assert.equal(result.response.status, 403);
  }

  const deliveryTime = new Date(Date.now() + 2000).toISOString();
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "delivered",
    event_id: "final-stage-delivery-01",
    happened_at: deliveryTime,
    batch_id: product.batch_id,
  }), "Retailer");
  assert.equal(result.response.status, 201);
  assert.equal(result.body.product.current_stage.stage, "delivered");
  result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
    stage: "delivered",
    event_id: "final-stage-delivery-01",
    happened_at: deliveryTime,
    batch_id: product.batch_id,
  }), "Retailer");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.duplicate, true);
  for (const stage of ["dispatched", "in_transit", "received_at_storage"]) {
    result = await request(`/api/products/${product.product_id}/stages`, json("POST", {
      stage,
      event_id: `retailer-invalid-${stage}`,
      batch_id: product.batch_id,
    }), "Retailer");
    assert.equal(result.response.status, 403);
  }

  const storage = require("../services/storage");
  const unassigned = {
    ...product,
    product_id: "TEST-UNASSIGNED-FINAL-01",
    batch_id: "UNASSIGNED-FINAL-BATCH-01",
    warehouse_name: "Other Warehouse",
    retailer_name: "Other Retailer",
    timeline: [
      { event_id: "unassigned-harvest", stage: "harvested", happened_at: new Date(Date.now() - 3000).toISOString(), participant: "Demo Farmer", location: "Test Valley" },
      { event_id: "unassigned-dispatch", stage: "dispatched", happened_at: new Date(Date.now() - 2000).toISOString(), participant: "Demo Logistics", location: "Farm gate" },
      { event_id: "unassigned-transit", stage: "in_transit", happened_at: new Date(Date.now() - 1000).toISOString(), participant: "Demo Logistics", location: "Highway 7" },
    ],
  };
  await storage.createProduct(unassigned);
  result = await request(`/api/products/${unassigned.product_id}/stages`, json("POST", {
    stage: "received_at_storage",
    event_id: "unassigned-receive-01",
    batch_id: unassigned.batch_id,
  }), "Warehouse");
  assert.equal(result.response.status, 404);
  result = await request(`/api/products/${unassigned.product_id}/stages`, json("POST", {
    stage: "delivered",
    event_id: "unassigned-delivery-01",
    batch_id: unassigned.batch_id,
  }), "Retailer");
  assert.equal(result.response.status, 404);
});

test("legacy records remain compatible in the extended hash chain", async () => {
  const crypto = require("../services/crypto");
  const storage = require("../services/storage");
  const records = await storage.getAllRecords();
  const previous = records[records.length - 1];
  const reading = {
    id: records.length,
    device_id: "legacy-device",
    ts: new Date().toISOString(),
    temp: 5.2,
    hum: 72,
    eth: 1.1,
  };
  const prevHash = previous.chainHash;
  await storage.appendRecord({
    id: reading.id,
    prevHash,
    chainHash: crypto.computeChainHash(reading, prevHash),
    enc: crypto.encryptRecord(reading),
    claimed: { temp: 5.2, hum: 72, eth: 1.1 },
  });
  const result = await request("/api/readings/verify-chain/all");
  assert.equal(result.body.valid, true);
});

test("product creation cannot bypass authenticated stage transitions", async () => {
  const harvestDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const product = {
    product_id: "TEST-PEAR-02",
    product_name: "Demo Pears",
    batch_id: "BATCH-TEST-02",
    harvest_date: harvestDate,
    farmer_name: "Demo Farmer",
    farm_name: "East Orchard",
    farm_location: "Test Valley",
    transporter_name: "Demo Logistics",
    device_id: "device-test-02",
  };
  const result = await request("/api/products", json("POST", product));
  assert.equal(result.response.status, 201);
  assert.equal(result.body.current_stage.stage, "harvested");
  const dateBypass = await request("/api/products", json("POST", {
    ...product,
    product_id: "TEST-PEAR-03",
    dispatch_date: harvestDate,
  }));
  assert.equal(dateBypass.response.status, 403);
  const invalidDate = await request("/api/products", json("POST", {
    ...product,
    product_id: "TEST-PEAR-04",
    harvest_date: "invalid",
  }));
  assert.equal(invalidDate.response.status, 400);
  const invalidOrder = await request("/api/products/TEST-PEAR-02/stages", json("POST", {
    stage: "in_transit",
    event_id: "transit-before-dispatch",
  }), "Transporter");
  assert.equal(invalidOrder.response.status, 409);
  const dispatch = await request("/api/products/TEST-PEAR-02/stages", json("POST", {
    stage: "dispatched",
    event_id: "pear-dispatch-01",
  }), "Transporter");
  assert.equal(dispatch.response.status, 201);
  assert.equal(dispatch.body.product.current_stage.stage, "dispatched");
});

test("Admin demo reset backs up and normalizes invalid Mango history", async () => {
  const harvestDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const product = {
    product_id: "MANGO-2026-001",
    product_name: "Alphonso Mango",
    batch_id: "MANGO-BATCH-001",
    harvest_date: harvestDate,
    farmer_name: "Demo Farmer",
    farm_name: "Green Valley Farm",
    farm_location: "Test Valley",
    transporter_name: "Demo Logistics",
    device_id: "demo-mango-device",
  };
  const registration = await request("/api/products", json("POST", product));
  assert.equal(registration.response.status, 201);

  const storage = require("../services/storage");
  const baseTime = Date.now() - 120 * 60 * 1000;
  const history = [
    ["duplicate-harvest", "harvested", 0, "Demo Farmer"],
    ["canonical-dispatch", "dispatched", 1, "Demo Logistics"],
    ["canonical-transit", "in_transit", 2, "Demo Logistics"],
    ["canonical-storage", "received_at_storage", 3, "Cold Store"],
    ["canonical-delivery", "delivered", 4, "Retailer"],
    ["post-delivery-storage", "received_at_storage", 5, "Cold Store"],
  ];
  for (const [event_id, stage, offset, participant] of history) {
    await storage.appendProductStage(product.product_id, {
      event_id,
      stage,
      happened_at: new Date(baseTime + offset * 60000).toISOString(),
      participant,
      location: "Demo location",
    });
  }

  let reset = await request(`/api/products/${product.product_id}/demo-reset`, json("POST", {}));
  assert.equal(reset.response.status, 400);
  reset = await request(`/api/products/${product.product_id}/demo-reset`, json("POST", { confirm: product.product_id }));
  assert.equal(reset.response.status, 200);
  assert.deepEqual(reset.body.stages, ["harvested", "dispatched", "in_transit", "received_at_storage", "delivered"]);
  const backup = JSON.parse(fs.readFileSync(path.join(dataDir, reset.body.backup), "utf8"));
  const backedUpProduct = backup.find((item) => item.product_id === product.product_id);
  assert.equal(backedUpProduct.timeline.length, 7);
  const current = await request(`/api/products/${product.product_id}/traceability`);
  assert.deepEqual(current.body.timeline.map((event) => event.stage), reset.body.stages);
});

test("failed local replacements leave valid catalog and ledger files intact", async () => {
  const storage = require("../services/storage");
  const ledgerPath = path.join(dataDir, "ledger.json");
  const productsPath = path.join(dataDir, "products.json");
  const ledgerBefore = fs.readFileSync(ledgerPath, "utf8");
  const productsBefore = fs.readFileSync(productsPath, "utf8");
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("simulated replacement failure"); };

  try {
    await assert.rejects(storage.createProduct({ product_id: "FAILED-WRITE" }), /simulated replacement failure/);
    await assert.rejects(storage.appendSensorEvent({
      deviceId: "device-test",
      eventId: "failed-write-event",
      payloadHash: "payload-hash",
      genesis: "FARM2FORK-GENESIS-BLOCK",
      createRecord: ({ id, prevHash }) => ({ id, prevHash, chainHash: "unused" }),
    }), /simulated replacement failure/);
  } finally {
    fs.renameSync = rename;
  }

  assert.equal(fs.readFileSync(ledgerPath, "utf8"), ledgerBefore);
  assert.equal(fs.readFileSync(productsPath, "utf8"), productsBefore);
  assert.equal(fs.readdirSync(dataDir).some((name) => name.endsWith(".tmp")), false);
});

test("MQTT readings enter the same ledger and receive backend acknowledgments", async () => {
  const mqtt = require("mqtt");
  const { startMqttBridge } = require("../services/mqttBridge");
  const bridge = await startMqttBridge({ port: 0, host: "127.0.0.1" });
  const client = mqtt.connect(`mqtt://127.0.0.1:${bridge.port}`, { connectTimeout: 3000 });
  const product = {
    product_id: "MQTT-PRODUCT-01",
    product_name: "MQTT Test Product",
    batch_id: "MQTT-BATCH-01",
    harvest_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    farmer_name: "Test Farmer",
    farm_name: "Test Farm",
    farm_location: "Test Valley",
    transporter_name: "Test Transport",
    device_id: "mqtt-test-device",
  };

  try {
    const registration = await request("/api/products", json("POST", product));
    assert.equal(registration.response.status, 201);
    await new Promise((resolve, reject) => {
      client.once("error", reject);
      client.once("connect", resolve);
    });
    await new Promise((resolve, reject) => {
      client.subscribe("farm2fork/acks/mqtt-test-device", (error) => error ? reject(error) : resolve());
    });

    const event = {
      api_key: process.env.DEVICE_API_KEY,
      device_id: "mqtt-test-device",
      event_id: "mqtt-reading-001",
      product_id: product.product_id,
      batch_id: product.batch_id,
      temp: 6.4,
      hum: 73,
      eth: 1.2,
    };
    const before = await request("/api/readings");
    const beforeCount = before.body.length;
    const sendAndWaitForAck = (message = event) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("MQTT application acknowledgment timed out")), 3000);
      const onMessage = (topic, payload) => {
        if (topic !== "farm2fork/acks/mqtt-test-device") return;
        clearTimeout(timeout);
        client.removeListener("message", onMessage);
        resolve(JSON.parse(payload.toString("utf8")));
      };
      client.on("message", onMessage);
      client.publish("farm2fork/readings/mqtt-test-device", JSON.stringify(message), { qos: 1 }, (error) => {
        if (error) {
          clearTimeout(timeout);
          client.removeListener("message", onMessage);
          reject(error);
        }
      });
    });

    const firstAck = await sendAndWaitForAck();
    assert.equal(firstAck.status, 201);
    assert.equal(firstAck.ok, true);
    const duplicateAck = await sendAndWaitForAck();
    assert.equal(duplicateAck.status, 200);
    assert.equal(duplicateAck.duplicate, true);
    const conflictAck = await sendAndWaitForAck({ ...event, temp: 15.7 });
    assert.equal(conflictAck.status, 409);
    assert.equal(conflictAck.event_id, event.event_id);

    const readings = await request("/api/readings");
    assert.equal(readings.body.length, beforeCount + 1);
    const storedEvent = readings.body.find((reading) => reading.original.event_id === event.event_id);
    assert.ok(storedEvent);
    assert.equal(storedEvent.original.temp, event.temp);
    const trace = await request(`/api/products/${product.product_id}/traceability`);
    assert.equal(trace.body.readings.length, 1);
    assert.equal(trace.body.readings[0].event_id, event.event_id);
  } finally {
    await new Promise((resolve) => client.end(false, {}, resolve));
    await bridge.close();
  }
});

test("offline demo queue sync stores a reading and safely acknowledges replay", async () => {
  const product = {
    product_id: "OFFLINE-DEMO-01",
    product_name: "Offline Demo Produce",
    batch_id: "OFFLINE-BATCH-01",
    harvest_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    farmer_name: "Offline Test Farmer",
    farm_name: "Offline Test Farm",
    farm_location: "Test Valley",
    transporter_name: "Test Logistics",
    device_id: "offline-demo-device",
  };
  const registration = await request("/api/products", json("POST", product));
  assert.equal(registration.response.status, 201);

  const reading = {
    device_id: product.device_id,
    event_id: "offline-browser-event-01",
    product_id: product.product_id,
    batch_id: product.batch_id,
    temp: 5.1,
    hum: 76,
    eth: 1.1,
  };
  const before = await request("/api/readings");
  let result = await request("/api/readings/demo-sync", json("POST", { readings: [reading] }));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.results[0].status, 201);

  result = await request("/api/readings/demo-sync", json("POST", { readings: [reading] }));
  assert.equal(result.body.results[0].status, 200);
  assert.equal(result.body.results[0].body.duplicate, true);

  const after = await request("/api/readings");
  assert.equal(after.body.length, before.body.length + 1);
  const trace = await request(`/api/products/${product.product_id}/traceability`);
  assert.equal(trace.body.readings.length, 1);
  assert.equal(trace.body.readings[0].event_id, reading.event_id);
});
