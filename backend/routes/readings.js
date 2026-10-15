// backend/routes/readings.js
const express = require("express");
const router = express.Router();
const storage = require("../services/storage");
const ingestReading = require("../services/ingestReading");
const { requireRoles } = require("../services/authorization");
const {
  computeChainHash,
  encryptRecord,
  decryptRecord,
  verifyChain,
} = require("../services/crypto");

function requireApiKey(req, res, next) {
  const key = req.header("x-api-key") || req.body.api_key;
  if (!key || key !== process.env.DEVICE_API_KEY) {
    return res.status(401).json({ error: "invalid or missing api key" });
  }
  next();
}

// POST /api/readings  — called by the ESP32 (or the "Run demo" button)
router.post("/", requireApiKey, async (req, res, next) => {
  try {
    const result = await ingestReading(req.body, null, req.header("x-api-key") || req.body.api_key);
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

router.post("/demo-sync", requireRoles("Admin"), async (req, res, next) => {
  if (storage.PROVIDER !== "local") {
    return res.status(403).json({ error: "offline demo sync is available only with local storage" });
  }
  const queued = req.body.readings;
  if (!Array.isArray(queued) || queued.length === 0 || queued.length > 20) {
    return res.status(400).json({ error: "readings must contain between 1 and 20 queued items" });
  }

  try {
    const results = [];
    for (const reading of queued) {
      const result = await ingestReading(reading, null, process.env.DEVICE_API_KEY);
      results.push({ event_id: reading.event_id || null, ...result });
    }
    res.json({ ok: results.every((result) => result.status < 400), results });
  } catch (error) {
    next(error);
  }
});

// GET /api/readings — dashboard polls this
router.get("/", requireRoles("Admin"), async (req, res) => {
  const records = await storage.getAllRecords();
  const decorated = records.map((r) => ({
    id: r.id,
    prevHash: r.prevHash,
    chainHash: r.chainHash,
    encryption_status: "AES-256-GCM",
    original: decryptRecord(r.enc),
    claimed: r.claimedEnc ? decryptRecord(r.claimedEnc) : r.claimed,
  }));
  res.json(decorated);
});

// GET /api/readings/:id/verify — recompute this record's hash from its
// (possibly tampered) claimed data and compare to the immutable ledger hash
router.get("/:id/verify", requireRoles("Admin"), async (req, res) => {
  const id = Number(req.params.id);
  const record = await storage.getRecordById(id);
  if (!record) return res.status(404).json({ error: "not found" });

  const original = decryptRecord(record.enc);
  const claimed = record.claimedEnc ? decryptRecord(record.claimedEnc) : record.claimed;
  const claimedReading = { ...original, ...claimed, id: record.id };
  const recomputed = computeChainHash(claimedReading, record.prevHash);

  res.json({
    id,
    match: recomputed === record.chainHash,
    ledgerHash: record.chainHash,
    recomputedHash: recomputed,
    original,
    claimed,
  });
});

// PATCH /api/readings/:id/claim — simulate someone editing a record's
// reported data (for demonstrating tamper detection; does not touch the
// immutable encrypted original or its ledger hash)
router.patch("/:id/claim", requireRoles("Admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { temp, hum, eth } = req.body;
  const record = await storage.updateRecord(id, (r) => {
    const claimed = r.claimedEnc ? decryptRecord(r.claimedEnc) : { ...r.claimed };
    if (temp !== undefined) claimed.temp = temp;
    if (hum !== undefined) claimed.hum = hum;
    if (eth !== undefined) claimed.eth = eth;
    if (r.claimedEnc) r.claimedEnc = encryptRecord(claimed);
    else r.claimed = claimed;
  });
  if (!record) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, claimed: record.claimedEnc ? decryptRecord(record.claimedEnc) : record.claimed });
});

// GET /api/readings/verify-chain — walk the whole ledger and find the first broken link
router.get("/verify-chain/all", requireRoles("Admin"), async (req, res) => {
  const records = await storage.getAllRecords();
  const result = verifyChain(records);
  res.json(result);
});

module.exports = router;
