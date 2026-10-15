// backend/services/crypto.js
// Chained SHA-256 hashing (tamper-evidence) + AES-256-GCM encryption (confidentiality).
// This is the server-side equivalent of the secure-element logic that would
// ideally run on the ESP32 itself in a production device.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const GENESIS = "FARM2FORK-GENESIS-BLOCK";
const DATA_DIR = process.env.FARM2FORK_DATA_DIR || path.join(__dirname, "..", "data");
const KEY_FILE = path.join(DATA_DIR, "device.key");

// The AES key is generated once and persisted to disk so records stay
// decryptable across server restarts. In production this key should live in
// a proper secrets manager (AWS KMS, HashiCorp Vault, etc.), not a flat file.
function loadOrCreateKey() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) {
    return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
  }
  const key = crypto.randomBytes(32); // 256-bit key
  fs.writeFileSync(KEY_FILE, key.toString("hex"));
  return key;
}

const AES_KEY = loadOrCreateKey();

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

// hash_n = SHA256(reading_n as JSON + hash_(n-1))
function computeChainHash(reading, prevHash) {
  return sha256Hex(JSON.stringify(reading) + prevHash);
}

function encryptRecord(payloadObj) {
  const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", AES_KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function decryptRecord(enc) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    AES_KEY,
    Buffer.from(enc.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(enc.authTag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, "hex")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

// Recomputes the whole chain from a list of records (using each record's
// "claimed" reading, which may have been edited to simulate tampering) and
// reports the first record whose hash no longer matches the ledger.
function verifyChain(records) {
  let prev = GENESIS;
  for (const rec of records) {
    const original = decryptRecord(rec.enc);
    const claimed = rec.claimedEnc ? decryptRecord(rec.claimedEnc) : rec.claimed;
    const claimedReading = { ...original, ...claimed, id: rec.id };
    const recomputed = computeChainHash(claimedReading, prev);
    if (rec.prevHash !== prev || recomputed !== rec.chainHash) {
      return { valid: false, brokenAt: rec.id, expected: rec.chainHash, recomputed };
    }
    prev = rec.chainHash;
  }
  return { valid: true };
}

module.exports = {
  GENESIS,
  sha256Hex,
  computeChainHash,
  encryptRecord,
  decryptRecord,
  verifyChain,
};
