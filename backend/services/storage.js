// backend/services/storage.js
// Storage is behind a small adapter so the rest of the app never has to
// know whether records live in a local file or in the cloud.
//
// CLOUD_PROVIDER=local (default) -> backend/data/ledger.json
//   Works immediately, no account needed. Good for development and demos.
//
// CLOUD_PROVIDER=aws -> Amazon S3
//   Run: npm install aws-sdk
//   Fill AWS_* values in .env, then restart the server.
//   Every record is written as its own object (one JSON file per reading)
//   under the configured bucket, which keeps this close to how a real
//   append-only object-storage ledger behaves.

const fs = require("fs");
const { randomUUID } = require("crypto");
const path = require("path");

const PROVIDER = process.env.CLOUD_PROVIDER || "local";
const DATA_DIR = process.env.FARM2FORK_DATA_DIR || path.join(__dirname, "..", "data");
const LOCAL_FILE = path.join(DATA_DIR, "ledger.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
let writeQueue = Promise.resolve();

function serializeWrites(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function ensureLocalFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_FILE)) fs.writeFileSync(LOCAL_FILE, "[]");
}

function readLocal() {
  ensureLocalFile();
  return JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8"));
}

function writeLocal(records) {
  writeJsonFile(LOCAL_FILE, records);
}

function readProducts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, "[]");
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
}

function writeProducts(products) {
  writeJsonFile(PRODUCTS_FILE, products);
}

function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

// ---------------- AWS S3 adapter (only loaded if selected) ----------------
let s3Client = null;
function getS3() {
  if (s3Client) return s3Client;
  // Lazy require so the app still runs with CLOUD_PROVIDER=local even if
  // aws-sdk was never installed.
  const AWS = require("aws-sdk");
  AWS.config.update({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
  s3Client = new AWS.S3();
  return s3Client;
}

async function s3PutRecord(record) {
  const s3 = getS3();
  await s3
    .putObject({
      Bucket: process.env.AWS_BUCKET,
      Key: `readings/${record.id}.json`,
      Body: JSON.stringify(record),
      ContentType: "application/json",
    })
    .promise();
}

async function s3GetAllRecords() {
  const s3 = getS3();
  const list = await s3
    .listObjectsV2({ Bucket: process.env.AWS_BUCKET, Prefix: "readings/" })
    .promise();
  const objects = await Promise.all(
    (list.Contents || []).map((obj) =>
      s3
        .getObject({ Bucket: process.env.AWS_BUCKET, Key: obj.Key })
        .promise()
        .then((res) => JSON.parse(res.Body.toString("utf8")))
    )
  );
  return objects.sort((a, b) => a.id - b.id);
}

// ---------------------------- Public API ----------------------------
async function getAllRecords() {
  if (PROVIDER === "aws") return s3GetAllRecords();
  return readLocal();
}

async function appendRecord(record) {
  return serializeWrites(async () => {
    if (PROVIDER === "aws") {
      await s3PutRecord(record);
      return;
    }
    const records = readLocal();
    records.push(record);
    writeLocal(records);
  });
}

async function appendSensorEvent({ deviceId, eventId, payloadHash, genesis, createRecord }) {
  return serializeWrites(async () => {
    const records = await getAllRecords();
    const existing = records.find((record) =>
      (record.deviceId || record.device_id) === deviceId &&
      (record.eventId || record.event_id) === eventId
    );

    if (existing) {
      return {
        status: existing.payloadHash === payloadHash ? "duplicate" : "conflict",
        record: existing,
      };
    }

    const id = records.reduce((largest, record) => Math.max(largest, record.id), -1) + 1;
    const previous = records[records.length - 1];
    const record = createRecord({
      id,
      prevHash: previous ? previous.chainHash : genesis,
    });

    if (PROVIDER === "aws") await s3PutRecord(record);
    else {
      records.push(record);
      writeLocal(records);
    }
    return { status: "created", record };
  });
}

async function updateRecord(id, updater) {
  return serializeWrites(async () => {
    const records = await getAllRecords();
    const record = records.find((item) => item.id === id);
    if (!record) return null;
    updater(record);
    if (PROVIDER === "aws") await s3PutRecord(record);
    else writeLocal(records);
    return record;
  });
}

async function getRecordById(id) {
  const records = await getAllRecords();
  return records.find((r) => r.id === id) || null;
}

async function getAllProducts() {
  return readProducts();
}

async function getProductById(id) {
  return (await getAllProducts()).find((product) => product.product_id === id) || null;
}

async function createProduct(product) {
  return serializeWrites(() => {
    const products = readProducts();
    if (products.some((item) => item.product_id === product.product_id)) return null;
    products.push(product);
    writeProducts(products);
    return product;
  });
}

async function appendProductStage(productId, event) {
  return serializeWrites(() => {
    const products = readProducts();
    const product = products.find((item) => item.product_id === productId);
    if (!product) return { status: "not-found" };

    const existing = product.timeline.find((item) => item.event_id === event.event_id);
    if (existing) {
      return {
        status: JSON.stringify(existing) === JSON.stringify(event) ? "duplicate" : "conflict",
        product,
      };
    }

    product.timeline.push(event);
    writeProducts(products);
    return { status: "created", product };
  });
}

async function resetProductTimeline(productId, timeline) {
  return serializeWrites(() => {
    const products = readProducts();
    const product = products.find((item) => item.product_id === productId);
    if (!product) return null;

    const backupName = `products.backup.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.json`;
    const backupPath = path.join(DATA_DIR, backupName);
    fs.copyFileSync(PRODUCTS_FILE, backupPath, fs.constants.COPYFILE_EXCL);
    product.timeline = timeline;
    writeProducts(products);
    return { product, backupName };
  });
}

module.exports = {
  getAllRecords,
  appendRecord,
  appendSensorEvent,
  updateRecord,
  getRecordById,
  getAllProducts,
  getProductById,
  createProduct,
  appendProductStage,
  resetProductTimeline,
  PROVIDER,
};
