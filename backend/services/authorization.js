const { createHmac, timingSafeEqual } = require("crypto");

const ROLES = ["Farmer", "Transporter", "Warehouse", "Retailer", "Admin"];
const PASSWORD_ENV = {
  Farmer: "DEMO_ROLE_PASSWORD_FARMER",
  Transporter: "DEMO_ROLE_PASSWORD_TRANSPORTER",
  Warehouse: "DEMO_ROLE_PASSWORD_WAREHOUSE",
  Retailer: "DEMO_ROLE_PASSWORD_RETAILER",
  Admin: "DEMO_ROLE_PASSWORD_ADMIN",
};
const PRINCIPAL_ENV = {
  Farmer: "DEMO_FARMER_NAME",
  Transporter: "DEMO_TRANSPORTER_NAME",
  Warehouse: "DEMO_WAREHOUSE_NAME",
  Retailer: "DEMO_RETAILER_NAME",
};
const DEFAULT_PRINCIPAL = {
  Farmer: "Ramesh Kumar",
  Transporter: "Tamil Fresh Logistics",
  Warehouse: "Cold Store",
  Retailer: "Retailer",
  Admin: "Admin",
};
const SECONDARY_FARMER_PASSWORD_ENV = "DEMO_ROLE_PASSWORD_FARMER_SURESH";
const SECONDARY_FARMER_NAME_ENV = "DEMO_FARMER_SECONDARY_NAME";
const TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

function signingSecret() {
  const secret = process.env.DEMO_AUTH_SECRET || "";
  return secret.length >= 32 ? secret : null;
}

function sign(value) {
  return createHmac("sha256", signingSecret()).update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function principalFor(role) {
  const envName = PRINCIPAL_ENV[role];
  return envName ? process.env[envName] || DEFAULT_PRINCIPAL[role] : DEFAULT_PRINCIPAL[role];
}

function credentialsFor(role) {
  const credentials = [{
    password: PASSWORD_ENV[role] ? process.env[PASSWORD_ENV[role]] : null,
    principal: principalFor(role),
  }];
  if (role === "Farmer") {
    credentials.push({
      password: process.env[SECONDARY_FARMER_PASSWORD_ENV],
      principal: process.env[SECONDARY_FARMER_NAME_ENV] || "Suresh Kumar",
    });
  }
  return credentials.filter((credential) => credential.password);
}

function login(role, password) {
  const credentials = credentialsFor(role);
  if (!signingSecret() || !credentials.length) {
    return { status: 503, body: { error: "Demo role authentication is not configured on this server" } };
  }
  const credential = typeof password === "string"
    ? credentials.find((item) => safeEqual(password, item.password))
    : null;
  if (!credential) {
    return { status: 401, body: { error: "Invalid role credentials" } };
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    role,
    principal: credential.principal,
    issuedAt,
    expiresAt: issuedAt + TOKEN_LIFETIME_SECONDS,
  })).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  return { status: 200, body: { token, role, expires_in: TOKEN_LIFETIME_SECONDS } };
}

function readBearerToken(req) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function authenticateOptional(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    req.auth = { role: "Customer", principal: null, authenticated: false };
    return next();
  }

  const separator = token.lastIndexOf(".");
  if (separator < 1 || !signingSecret()) {
    return res.status(401).json({ error: "Invalid or expired demo session" });
  }
  const payload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!safeEqual(sign(payload), providedSignature)) {
    return res.status(401).json({ error: "Invalid or expired demo session" });
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return res.status(401).json({ error: "Invalid or expired demo session" });
  }
  if (!ROLES.includes(claims.role) || typeof claims.principal !== "string" || claims.expiresAt <= Date.now() / 1000) {
    return res.status(401).json({ error: "Invalid or expired demo session" });
  }
  req.auth = { role: claims.role, principal: claims.principal, authenticated: true };
  next();
}

function requireRoles(...roles) {
  return (req, res, next) => authenticateOptional(req, res, (error) => {
    if (error) return next(error);
    if (!req.auth?.authenticated) return res.status(401).json({ error: "Authentication required" });
    if (!roles.includes(req.auth.role)) return res.status(403).json({ error: "Role is not authorized for this resource" });
    next();
  });
}

function canAccessProduct(auth, product) {
  if (!auth?.authenticated || !product) return false;
  if (auth.role === "Admin") return true;
  if (auth.role === "Farmer") return product.farmer_name === auth.principal;
  if (auth.role === "Transporter") return product.transporter_name === auth.principal;
  if (auth.role === "Warehouse") {
    return product.warehouse_name === auth.principal || product.timeline.some((event) =>
      event.stage === "received_at_storage" && event.participant === auth.principal);
  }
  if (auth.role === "Retailer") {
    return product.retailer_name === auth.principal || product.timeline.some((event) =>
      event.stage === "delivered" && event.participant === auth.principal);
  }
  return false;
}

function productsForRole(auth, products) {
  if (auth.role === "Admin") return products;
  return products.filter((product) => canAccessProduct(auth, product));
}

function customerProduct(product, req) {
  const latest = product.timeline.reduce((current, event) =>
    !current || event.happened_at >= current.happened_at ? event : current, null);
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
    current_stage: latest ? { stage: latest.stage, label: latest.label } : null,
    traceability_url: `${req.protocol}://${req.get("host")}/?product=${encodeURIComponent(product.product_id)}`,
    qr_url: `/api/products/${encodeURIComponent(product.product_id)}/qr`,
  };
}

function publicTimeline(timeline, latest) {
  return [...timeline]
    .sort((left, right) => left.happened_at.localeCompare(right.happened_at))
    .map((event) => ({
      stage: event.stage,
      happened_at: event.happened_at,
      participant: event.participant,
      location: event.location,
      label: event.label,
      status: latest && event.happened_at === latest.happened_at && event.stage === latest.stage ? "Current" : "Recorded",
    }));
}

function traceabilityForRole(auth, product, req, timeline, readings, integrity) {
  const latest = timeline.reduce((current, event) =>
    !current || event.happened_at >= current.happened_at ? event : current, null);
  const currentStage = latest ? { stage: latest.stage, label: latest.label } : null;
  const productView = auth.role === "Customer"
    ? customerProduct({ ...product, timeline }, req)
    : {
      ...product,
      current_stage: currentStage,
      traceability_url: `${req.protocol}://${req.get("host")}/?product=${encodeURIComponent(product.product_id)}`,
      qr_url: `/api/products/${encodeURIComponent(product.product_id)}/qr`,
      ...(["Farmer", "Transporter", "Warehouse", "Admin"].includes(auth.role) ? { device_id: product.device_id } : {}),
    };
  const response = {
    product: productView,
    current_stage: currentStage,
    timeline: publicTimeline(timeline, latest),
    integrity: auth.role === "Customer"
      ? { valid: integrity.valid, status: integrity.valid ? "Verified" : "Needs review" }
      : { valid: integrity.valid, status: integrity.valid ? "Verified" : "Failed", ...(auth.role === "Admin" ? { broken_at: integrity.brokenAt ?? null } : {}) },
  };

  if (auth.role === "Customer") {
    const latestReading = readings.at(-1);
    response.environmental_condition = latestReading ? {
      temperature: latestReading.temp,
      humidity: latestReading.hum,
      ethylene: latestReading.eth,
      integrity_verified: integrity.valid,
    } : null;
    return response;
  }

  response.readings = readings;
  response.encryption_status = "Encrypted at rest; readings are decrypted by the backend for this response.";
  return response;
}

module.exports = {
  ROLES,
  login,
  authenticateOptional,
  requireRoles,
  canAccessProduct,
  productsForRole,
  traceabilityForRole,
};
