const express = require("express");
const { randomUUID } = require("crypto");
const QRCode = require("qrcode");
const router = express.Router();
const storage = require("../services/storage");
const { decryptRecord, verifyChain } = require("../services/crypto");
const {
  authenticateOptional,
  requireRoles,
  canAccessProduct,
  productsForRole,
  traceabilityForRole,
} = require("../services/authorization");

const STAGES = {
  harvested: "Harvested",
  dispatched: "Dispatched",
  in_transit: "In Transit",
  received_at_storage: "Received at Storage",
  delivered: "Delivered",
};
const NEXT_STAGE = {
  harvested: "dispatched",
  dispatched: "in_transit",
  in_transit: "received_at_storage",
  received_at_storage: "delivered",
};
const STAGE_ROLE = {
  harvested: "Farmer",
  dispatched: "Transporter",
  in_transit: "Transporter",
  received_at_storage: "Warehouse",
  delivered: "Retailer",
};
const OPERATIONAL_ROLES = ["Farmer", "Transporter", "Warehouse", "Retailer", "Admin"];

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function text(value, maxLength = 120) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function currentEvent(timeline) {
  return timeline.reduce((latest, event) =>
    !latest || event.happened_at >= latest.happened_at ? event : latest, null);
}

function traceUrl(req, productId) {
  return `${req.protocol}://${req.get("host")}/?product=${encodeURIComponent(productId)}`;
}

function roleProduct(product, req, role) {
  const timeline = (product.timeline || []).map((event) => ({ ...event, label: STAGES[event.stage] || "Unknown" }));
  const latest = currentEvent(timeline);
  const links = {
    traceability_url: traceUrl(req, product.product_id),
    qr_url: `/api/products/${encodeURIComponent(product.product_id)}/qr`,
  };
  if (role === "Admin") {
    return { ...product, current_stage: latest ? { stage: latest.stage, label: latest.label } : null, ...links };
  }
  return {
    product_id: product.product_id,
    product_name: product.product_name,
    batch_id: product.batch_id,
    harvest_date: product.harvest_date,
    farmer_name: product.farmer_name,
    farm_name: product.farm_name,
    farm_location: product.farm_location,
    transporter_name: product.transporter_name,
    vehicle_id: product.vehicle_id,
    dispatch_date: product.dispatch_date,
    current_stage: latest ? { stage: latest.stage, label: latest.label } : null,
    timeline: timeline.map(({ stage, happened_at, participant, location, label }) => ({ stage, happened_at, participant, location, label })),
    ...(["Farmer", "Transporter", "Warehouse"].includes(role) ? { device_id: product.device_id } : {}),
    ...links,
  };
}

router.get("/", requireRoles(...OPERATIONAL_ROLES), asyncRoute(async (req, res) => {
  const products = await storage.getAllProducts();
  res.json(productsForRole(req.auth, products).map((product) => roleProduct(product, req, req.auth.role)));
}));

router.get("/:id", requireRoles(...OPERATIONAL_ROLES), asyncRoute(async (req, res) => {
  const product = await storage.getProductById(req.params.id);
  if (!canAccessProduct(req.auth, product)) return res.status(404).json({ error: "product not found" });
  res.json(roleProduct(product, req, req.auth.role));
}));

router.post("/", requireRoles("Farmer", "Admin"), asyncRoute(async (req, res) => {
  const product = {
    product_id: text(req.body.product_id, 80),
    product_name: text(req.body.product_name),
    batch_id: text(req.body.batch_id, 80),
    harvest_date: text(req.body.harvest_date, 10),
    farmer_name: text(req.body.farmer_name),
    farm_name: text(req.body.farm_name),
    farm_location: text(req.body.farm_location),
    transporter_name: text(req.body.transporter_name) || process.env.DEMO_TRANSPORTER_NAME || "Transporter",
    vehicle_id: text(req.body.vehicle_id, 80) || null,
    dispatch_date: text(req.body.dispatch_date, 10) || null,
    device_id: text(req.body.device_id, 80),
    warehouse_name: process.env.DEMO_WAREHOUSE_NAME || "Cold Store",
    retailer_name: process.env.DEMO_RETAILER_NAME || "Retailer",
    created_at: new Date().toISOString(),
  };
  const required = ["product_id", "product_name", "batch_id", "harvest_date", "farmer_name", "farm_name", "farm_location", "device_id"];
  if (required.some((field) => !product[field])) {
    return res.status(400).json({ error: "product, farmer, logistics and device fields are required" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(product.harvest_date) || Number.isNaN(Date.parse(`${product.harvest_date}T00:00:00Z`))) {
    return res.status(400).json({ error: "harvest_date must use YYYY-MM-DD" });
  }
  if (product.dispatch_date && (!/^\d{4}-\d{2}-\d{2}$/.test(product.dispatch_date) || Number.isNaN(Date.parse(`${product.dispatch_date}T00:00:00Z`)))) {
    return res.status(400).json({ error: "dispatch_date must use YYYY-MM-DD" });
  }
  if (req.auth.role === "Farmer" && product.farmer_name !== req.auth.principal) {
    return res.status(403).json({ error: "Farmer may register products only under their authenticated identity" });
  }
  if (product.dispatch_date) {
    return res.status(403).json({ error: "Dispatch is recorded by the authenticated Transporter stage action" });
  }

  product.timeline = [{
    event_id: randomUUID(),
    stage: "harvested",
    happened_at: new Date(`${product.harvest_date}T00:00:00.000Z`).toISOString(),
    participant: product.farmer_name,
    location: product.farm_location,
  }];
  const saved = await storage.createProduct(product);
  if (!saved) return res.status(409).json({ error: "product_id already exists" });
  res.status(201).json(roleProduct(saved, req, req.auth.role));
}));

router.get("/:id/qr", asyncRoute(async (req, res) => {
  const product = await storage.getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "product not found" });
  const image = await QRCode.toBuffer(traceUrl(req, product.product_id), {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 240,
  });
  res.type("png").send(image);
}));

router.get("/:id/traceability", authenticateOptional, asyncRoute(async (req, res) => {
  const product = await storage.getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "product not found" });
  if (req.auth.role !== "Customer" && !canAccessProduct(req.auth, product)) {
    return res.status(404).json({ error: "product not found" });
  }

  const records = await storage.getAllRecords();
  const chain = verifyChain(records);
  const readings = records
    .filter((record) => record.productId === product.product_id && record.batchId === product.batch_id && record.deviceId === product.device_id)
    .map((record) => {
      const reading = decryptRecord(record.enc);
      return {
        record_id: record.id,
        event_id: reading.event_id,
        device_id: reading.device_id,
        timestamp: reading.ts,
        temp: reading.temp,
        hum: reading.hum,
        eth: reading.eth,
        encrypted_at_rest: true,
        integrity_verified: chain.valid,
      };
    });
  const timeline = [...(product.timeline || [])]
    .sort((left, right) => left.happened_at.localeCompare(right.happened_at))
    .map((event) => ({
      ...event,
      label: STAGES[event.stage],
    }));
  res.json(traceabilityForRole(req.auth, product, req, timeline, readings, chain));
}));

router.post("/:id/demo-reset", requireRoles("Admin"), asyncRoute(async (req, res) => {
  if (req.params.id !== "MANGO-2026-001" || req.body.confirm !== "MANGO-2026-001") {
    return res.status(400).json({ error: "Explicit confirmation for the canonical Mango product is required" });
  }
  const product = await storage.getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: "product not found" });

  const orderedStages = ["harvested", "dispatched", "in_transit", "received_at_storage", "delivered"];
  const sourceTimeline = [...(product.timeline || [])].sort((left, right) => left.happened_at.localeCompare(right.happened_at));
  const canonicalTimeline = [];
  let nextStageIndex = 0;
  for (const event of sourceTimeline) {
    if (event.stage !== orderedStages[nextStageIndex]) continue;
    canonicalTimeline.push(event);
    nextStageIndex += 1;
  }
  if (nextStageIndex !== orderedStages.length) {
    return res.status(409).json({ error: "Cannot normalize demo history: a required canonical stage is missing" });
  }

  const result = await storage.resetProductTimeline(product.product_id, canonicalTimeline);
  res.json({
    ok: true,
    backup: result.backupName,
    stages: canonicalTimeline.map((event) => event.stage),
  });
}));

router.post("/:id/stages", requireRoles(...OPERATIONAL_ROLES), asyncRoute(async (req, res) => {
  const stage = text(req.body.stage, 40).toLowerCase().replace(/[ -]+/g, "_");
  if (!Object.hasOwn(STAGES, stage)) {
    return res.status(400).json({ error: "stage must be harvested, dispatched, in_transit, received_at_storage or delivered" });
  }
  const product = await storage.getProductById(req.params.id);
  if (!canAccessProduct(req.auth, product)) return res.status(404).json({ error: "product not found" });
  if (STAGE_ROLE[stage] !== req.auth.role) {
    return res.status(403).json({ error: "Role is not authorized to record this stage" });
  }
  if (req.body.batch_id && req.body.batch_id !== product.batch_id) {
    return res.status(409).json({ error: "batch_id does not match the product" });
  }

  const happenedAt = req.body.happened_at ? new Date(req.body.happened_at) : new Date();
  if (Number.isNaN(happenedAt.getTime()) || happenedAt.getTime() > Date.now() + 300000) {
    return res.status(400).json({ error: "happened_at must be a valid timestamp no more than five minutes in the future" });
  }
  const event = {
    event_id: text(req.body.event_id, 128) || randomUUID(),
    stage,
    happened_at: happenedAt.toISOString(),
    participant: req.auth.principal,
    location: text(req.body.location) || product.farm_location,
  };
  const existingEvent = product.timeline.find((item) => item.event_id === event.event_id);
  if (existingEvent) {
    const sameEvent = ["stage", "happened_at", "participant", "location"].every((field) => existingEvent[field] === event[field]);
    if (!sameEvent) return res.status(409).json({ error: "stage event ID already exists with different data" });
    return res.json({ ok: true, duplicate: true, product: roleProduct(product, req, req.auth.role) });
  }
  if (stage === "harvested" && product.timeline.some((item) => item.stage === "harvested")) {
    return res.status(409).json({ error: "Harvest has already been recorded for this batch" });
  }

  const latest = currentEvent(product.timeline);
  const expectedStage = latest ? NEXT_STAGE[latest.stage] : "harvested";
  if (stage !== expectedStage) {
    return res.status(409).json({ error: `Invalid stage transition: expected ${expectedStage || "no further stage"}` });
  }
  if (latest && happenedAt.getTime() <= new Date(latest.happened_at).getTime()) {
    return res.status(409).json({ error: "Stage timestamp must be later than the current stage" });
  }

  const result = await storage.appendProductStage(product.product_id, event);
  if (result.status === "conflict") return res.status(409).json({ error: "stage event ID already exists with different data" });
  res.status(result.status === "duplicate" ? 200 : 201).json({
    ok: true,
    duplicate: result.status === "duplicate",
    product: roleProduct(result.product, req, req.auth.role),
  });
}));

module.exports = router;
