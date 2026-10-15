// frontend/js/dashboard.js
const expanded = new Set();
const tamperEditing = new Set();
let latestVerify = {}; // id -> last verify result, for showing a verdict inline
let currentProductId = new URLSearchParams(window.location.search).get("product");
let lastProductsSnapshot = "";
let lastTraceSnapshot = "";
let currentTraceability = null;
const OFFLINE_QUEUE_KEY = "farm2fork.offline-demo-queue";
const PRODUCT_CACHE_KEY = "farm2fork.offline-demo-products";
const DEMO_PRODUCT_ID = "MANGO-2026-001";
const DEMO_DEVICE_ID = "esp32-node-01";
const DEMO_BATCH_ID = "MANGO-BATCH-001";
const SIMULATOR_INTERVAL_MS = 10000;
const DEMO_SENSOR_EVENTS = [
  { device_id: DEMO_DEVICE_ID, product_id: DEMO_PRODUCT_ID, batch_id: DEMO_BATCH_ID, event_id: "MANGO-DEMO-E001", temp: 8.2, hum: 78, eth: 1.1 },
  { device_id: DEMO_DEVICE_ID, product_id: DEMO_PRODUCT_ID, batch_id: DEMO_BATCH_ID, event_id: "MANGO-DEMO-E002", temp: 8.5, hum: 79, eth: 1.2 },
  { device_id: DEMO_DEVICE_ID, product_id: DEMO_PRODUCT_ID, batch_id: DEMO_BATCH_ID, event_id: "MANGO-DEMO-E003", temp: 9.1, hum: 81, eth: 1.4 },
  { device_id: DEMO_DEVICE_ID, product_id: DEMO_PRODUCT_ID, batch_id: DEMO_BATCH_ID, event_id: "MANGO-DEMO-E004", temp: 9.4, hum: 82, eth: 1.6 },
];
let currentRole = sessionStorage.getItem("farm2fork.demo-role") || "Customer";
const roleSelect = document.getElementById("roleSelect");
if (roleSelect) roleSelect.value = currentRole;
let simulatorEnabled = false;
let networkOnline = true;
let simulatorTimer = null;
let simulatorEventIndex = 0;
let simulatorStatusMessage = "Device idle";
let latestReadings = [];
let latestChainVerification = null;
let lastSyncSummary = sessionStorage.getItem("farm2fork.last-sync-summary") || "Not run";

function getProductContext() {
  const product = (lastProductsSnapshot && lastProductsSnapshot !== "[]")
    ? JSON.parse(localStorage.getItem(PRODUCT_CACHE_KEY) || "[]").find((item) => item.product_id === currentProductId || item.product_id === DEMO_PRODUCT_ID)
    : null;
  return product || null;
}

function makeRoleSummary(product, fallbackProduct) {
  const item = product || fallbackProduct || {
    product_name: "Alphonso Mango",
    product_id: DEMO_PRODUCT_ID,
    batch_id: "MANGO-BATCH-001",
    farmer_name: "Ramesh Kumar",
    farm_name: "Green Valley Farm",
    farm_location: "Krishnagiri, Tamil Nadu",
    transporter_name: "Tamil Fresh Logistics",
    vehicle_id: "TN-38-AB-4521",
    device_id: DEMO_DEVICE_ID,
    current_stage: { label: "Harvested" },
  };
  return item;
}

async function ensureDemoProduct() {
  try {
    const products = await Api.getProducts();
    const existing = products.find((product) => product.product_id === DEMO_PRODUCT_ID);
    if (existing) {
      currentProductId = existing.product_id;
      if (currentProductId) history.replaceState(null, "", `/?product=${encodeURIComponent(currentProductId)}`);
      return existing;
    }

    const product = await Api.createProduct({
      product_id: DEMO_PRODUCT_ID,
      product_name: "Alphonso Mango",
      batch_id: "MANGO-BATCH-001",
      harvest_date: "2026-09-20",
      farmer_name: "Ramesh Kumar",
      farm_name: "Green Valley Farm",
      farm_location: "Krishnagiri, Tamil Nadu",
      device_id: DEMO_DEVICE_ID,
    });
    currentProductId = product.product_id;
    history.replaceState(null, "", `/?product=${encodeURIComponent(currentProductId)}`);
    return product;
  } catch (error) {
    console.error("Demo product bootstrap failed", error);
    return null;
  }
}

function roleSummaryHtml(product, latestReading) {
  const resolvedProduct = makeRoleSummary(product, getProductContext());
  const stage = resolvedProduct.current_stage?.label || "Not recorded";
  const reading = latestReading;
  const queuedForProduct = readOfflineQueue().filter((item) => item.product_id === resolvedProduct.product_id).length;
  return `
    <div class="role-body">
      <div class="role-card">
        <h3>${currentRole === "Farmer" ? "My Farm" : currentRole === "Transporter" ? "Assigned Shipment" : currentRole === "Warehouse" ? "Incoming Shipment" : currentRole === "Retailer" ? "Incoming Product" : "Product"}</h3>
        <div class="role-grid">
          <div class="kv"><span class="k">Product</span><span class="v">${escapeHtml(resolvedProduct.product_name)}</span></div>
          <div class="kv"><span class="k">Product ID</span><span class="v mono">${escapeHtml(resolvedProduct.product_id)}</span></div>
          <div class="kv"><span class="k">Batch</span><span class="v mono">${escapeHtml(resolvedProduct.batch_id)}</span></div>
          <div class="kv"><span class="k">Current stage</span><span class="v">${escapeHtml(stage)}</span></div>
          <div class="kv"><span class="k">Farmer</span><span class="v">${escapeHtml(resolvedProduct.farmer_name)}</span></div>
          <div class="kv"><span class="k">Farm</span><span class="v">${escapeHtml(resolvedProduct.farm_name)}</span></div>
          <div class="kv"><span class="k">Location</span><span class="v">${escapeHtml(resolvedProduct.farm_location)}</span></div>
          <div class="kv"><span class="k">Transporter</span><span class="v">${escapeHtml(resolvedProduct.transporter_name)}</span></div>
          <div class="kv"><span class="k">Vehicle</span><span class="v mono">${escapeHtml(resolvedProduct.vehicle_id || "TN-38-AB-4521")}</span></div>
          <div class="kv"><span class="k">Device</span><span class="v mono">${escapeHtml(resolvedProduct.device_id || DEMO_DEVICE_ID)}</span></div>
        </div>
      </div>
      ${currentRole === "Farmer" ? `<div class="role-card"><h3>My Batch</h3><div class="role-grid"><div class="kv"><span class="k">Product</span><span class="v">${escapeHtml(resolvedProduct.product_name)}</span></div><div class="kv"><span class="k">Product ID</span><span class="v mono">${escapeHtml(resolvedProduct.product_id)}</span></div><div class="kv"><span class="k">Batch</span><span class="v mono">${escapeHtml(resolvedProduct.batch_id)}</span></div><div class="kv"><span class="k">Current stage</span><span class="v">${escapeHtml(stage)}</span></div></div></div>` : ""}
      <div class="role-card">
        <h3>Current conditions</h3>
        <div class="role-grid">
          <div class="kv"><span class="k">Temperature</span><span class="v">${reading ? `${escapeHtml(reading.temp)} °C` : "No sensor readings available for this batch."}</span></div>
          <div class="kv"><span class="k">Humidity</span><span class="v">${reading ? `${escapeHtml(reading.hum)} %` : "No sensor readings available for this batch."}</span></div>
          <div class="kv"><span class="k">Ethylene</span><span class="v">${reading ? `${escapeHtml(reading.eth)} ppm` : "No sensor readings available for this batch."}</span></div>
          <div class="kv"><span class="k">Device status</span><span class="v">${reading ? "Reporting" : "Waiting for batch readings"}</span></div>
          <div class="kv"><span class="k">Network</span><span class="v">${networkOnline ? "Online" : "Offline"}</span></div>
          <div class="kv"><span class="k">Synchronization</span><span class="v">${queuedForProduct} pending</span></div>
        </div>
      </div>
    </div>
  `;
}

function renderRoleSection(role, content) {
  const section = document.getElementById(`${role.toLowerCase()}View`);
  if (section) section.innerHTML = content;
}

function renderRoleContent(role, product, traceability) {
  const productContext = makeRoleSummary(product, getProductContext());
  const allProducts = JSON.parse(localStorage.getItem(PRODUCT_CACHE_KEY) || "[]");
  const currentStage = productContext.current_stage?.stage || null;
  const latestReading = role === "Customer"
    ? traceability?.environmental_condition && {
      temp: traceability.environmental_condition.temperature,
      hum: traceability.environmental_condition.humidity,
      eth: traceability.environmental_condition.ethylene,
    }
    : traceability?.readings?.at(-1) || null;
  const traceStages = traceability?.timeline || [];
  const journey = traceStages.length ? traceStages.map((event) => `${event.label} (${event.status})`).join(" → ") : "No journey recorded.";
  const farmerAction = '<button type="button" disabled>Harvest recorded</button>';
  const transporterActions = currentStage === "harvested"
    ? '<button type="button" data-role-stage="dispatched">Mark Dispatched</button>'
    : currentStage === "dispatched"
      ? '<button type="button" data-role-stage="in_transit">Mark In Transit</button>'
      : "";
  const warehouseAction = currentStage === "in_transit"
    ? '<button type="button" data-role-stage="received_at_storage">Confirm Received</button>'
    : "";
  const retailerAction = currentStage === "received_at_storage"
    ? '<button type="button" data-role-stage="delivered">Confirm Delivery</button>'
    : "";

  const productFormMarkup = `
    <details class="register">
      <summary>Register Batch</summary>
      <form id="productForm" class="product-form">
        <label>Product ID<input name="product_id" required maxlength="80"></label>
        <label>Product name<input name="product_name" required maxlength="120"></label>
        <label>Batch ID<input name="batch_id" required maxlength="80"></label>
        <label>Harvest date<input name="harvest_date" type="date" required></label>
        <label>Farmer name<input name="farmer_name" required maxlength="120"></label>
        <label>Farm name<input name="farm_name" required maxlength="120"></label>
        <label>Farm location<input name="farm_location" required maxlength="120"></label>
        <label>Transporter (optional)<input name="transporter_name" maxlength="120"></label>
        <label>Vehicle ID (optional)<input name="vehicle_id" maxlength="80"></label>
        <label>Dispatch date (optional)<input name="dispatch_date" type="date"></label>
        <label>Device ID<input name="device_id" value="esp32-node-01" required maxlength="80"></label>
        <div class="form-actions"><button type="submit">Create product QR</button><span id="productMessage" role="status"></span></div>
      </form>
    </details>
  `;

  const productListMarkup = `
    <div class="panel" id="productList"><div class="empty">No products registered yet.</div></div>
  `;

  const traceabilityMarkup = `
    <div id="traceabilitySection" hidden>
      <h2 id="traceHeading">Traceability</h2>
      <div class="panel" id="tracePanel"></div>
    </div>
  `;

  const adminControlsMarkup = `
    <div class="role-body">
      <div class="role-card">
        <h3>System summary</h3>
        <div class="role-grid">
          <div class="kv"><span class="k">Registered products</span><span class="v">${Array.isArray(allProducts) ? allProducts.length : 0}</span></div>
          <div class="kv"><span class="k">IoT device</span><span class="v mono">${escapeHtml(DEMO_DEVICE_ID)}</span></div>
          <div class="kv"><span class="k">Device service</span><span class="v">${simulatorEnabled ? "Running" : "Idle"}</span></div>
          <div class="kv"><span class="k">Network</span><span class="v">${networkOnline ? "Online" : "Offline"}</span></div>
          <div class="kv"><span class="k">Queue</span><span class="v">${readOfflineQueue().length} pending</span></div>
          <div class="kv"><span class="k">Integrity</span><span class="v">${latestChainVerification ? (latestChainVerification.valid ? "VERIFIED" : "FAILED") : "Checking…"}</span></div>
        </div>
      </div>
      <div class="role-card">
        <h3>Device status</h3>
        <div class="role-grid">
          <div class="kv"><span class="k">Device</span><span class="v mono">${escapeHtml(DEMO_DEVICE_ID)}</span></div>
          <div class="kv"><span class="k">Mode</span><span class="v">Device service</span></div>
          <div class="kv"><span class="k">Status</span><span class="v">${simulatorEnabled ? "Reporting" : "Idle"}</span></div>
          <div class="kv"><span class="k">Network</span><span class="v">${networkOnline ? "Online" : "Offline"}</span></div>
          <div class="kv"><span class="k">Pending synchronization</span><span class="v">${readOfflineQueue().length}</span></div>
          <div class="kv"><span class="k">Last synchronization</span><span class="v">${escapeHtml(lastSyncSummary)}</span></div>
        </div>
      </div>
      <div class="role-card">
        <h3>Device controls</h3>
        <div class="simulator-status" id="simulatorStatus">Device idle</div>
        <div class="role-actions">
          <button type="button" id="startSimulatorBtn">Start Device</button>
          <button type="button" id="stopSimulatorBtn">Stop Device</button>
          <button type="button" id="simLossBtn">Simulate Network Loss</button>
          <button type="button" id="simReconnectBtn">Reconnect</button>
        </div>
      </div>
    </div>
    <div class="btnrow">
      <button class="danger" id="verifyChainBtn">Verify entire chain</button>
    </div>
    <div id="chainStatus"></div>
    <div class="role-card">
      <h3>Ledger integrity</h3>
      <div class="role-grid">
        <div class="kv"><span class="k">Ledger records</span><span class="v">${latestReadings.length}</span></div>
        <div class="kv"><span class="k">Encryption at rest</span><span class="v">AES-256-GCM</span></div>
        <div class="kv"><span class="k">Integrity algorithm</span><span class="v">Tamper-evident SHA-256 hash chain</span></div>
        <div class="kv"><span class="k">Chain status</span><span class="v">${latestChainVerification ? (latestChainVerification.valid ? "VERIFIED" : `FAILED at record #${latestChainVerification.brokenAt}`) : "Checking…"}</span></div>
      </div>
    </div>
    <div class="btnrow network-demo">
      <button id="queueOfflineBtn" type="button">Simulate Offline + Store Sample</button>
      <button id="syncOfflineBtn" type="button" disabled>Reconnect &amp; Sync Queue</button>
      <span id="offlineQueueStatus" role="status">No offline readings queued.</span>
    </div>
    <section id="offlineQueueSection" hidden>
      <h2>Offline queue — not yet synced</h2>
      <div class="panel" id="offlineQueuePanel"></div>
    </section>
    <section>
      <h2>Sensor ledger — encrypted readings</h2>
      <div class="panel" id="ledgerPanel"><div class="empty">Waiting for the first reading…</div></div>
    </section>
    <footer>SHA-256 hash-chained ledger · sensor readings are encrypted at rest with AES-256-GCM · click a row to inspect and verify</footer>
  `;

  if (role === "Farmer") {
    renderRoleSection(role, `
      <h2>Farmer dashboard</h2>
      ${roleSummaryHtml(productContext, latestReading)}
      ${productFormMarkup}
      ${productListMarkup}
      ${traceabilityMarkup}
      <div class="role-actions">${farmerAction}</div>
      <div class="role-snapshot">Product registration, batch status and QR traceability remain available here for the farmer workflow.</div>
    `);
  } else if (role === "Transporter") {
    renderRoleSection(role, `
      <h2>Transporter dashboard</h2>
      ${roleSummaryHtml(productContext, latestReading)}
      <div class="role-actions">${transporterActions}</div>
      <div class="role-snapshot">Assigned shipment: ${escapeHtml(productContext.product_id)} · vehicle ${escapeHtml(productContext.vehicle_id || "TN-38-AB-4521")}</div>
      ${productListMarkup}
      ${traceabilityMarkup}
    `);
  } else if (role === "Warehouse") {
    renderRoleSection(role, `
      <h2>Warehouse dashboard</h2>
      ${roleSummaryHtml(productContext, latestReading)}
      <div class="role-actions">${warehouseAction}</div>
      <div class="role-snapshot">Incoming shipment review, device connectivity and synchronization status are available for cold-chain receiving.</div>
      ${traceabilityMarkup}
    `);
  } else if (role === "Retailer") {
    renderRoleSection(role, `
      <h2>Retailer dashboard</h2>
      ${roleSummaryHtml(productContext, latestReading)}
      <div class="role-actions">${retailerAction}</div>
      <div class="role-snapshot">Journey history: ${escapeHtml(journey)}</div>
      ${traceabilityMarkup}
    `);
  } else if (role === "Admin") {
    renderRoleSection(role, `
      <h2>Admin system overview</h2>
      ${adminControlsMarkup}
      ${productListMarkup}
      ${traceabilityMarkup}
    `);
  } else if (role === "Customer") {
    const timeline = traceability?.timeline || [];
    const customerJourney = timeline.length ? timeline.map((event) => event.label).join(" → ") : "Harvested → Dispatched → In Transit → Received at Storage → Delivered";
    renderRoleSection(role, `
      <h2>Customer traceability</h2>
      <div class="role-body">
        <div class="role-card">
          <h3>${escapeHtml(productContext.product_name)}</h3>
          <div class="role-grid">
            <div class="kv"><span class="k">Product ID</span><span class="v mono">${escapeHtml(productContext.product_id)}</span></div>
            <div class="kv"><span class="k">Batch ID</span><span class="v mono">${escapeHtml(productContext.batch_id)}</span></div>
            <div class="kv"><span class="k">Farmer</span><span class="v">${escapeHtml(productContext.farmer_name)}</span></div>
            <div class="kv"><span class="k">Farm</span><span class="v">${escapeHtml(productContext.farm_name)}</span></div>
            <div class="kv"><span class="k">Location</span><span class="v">${escapeHtml(productContext.farm_location)}</span></div>
            <div class="kv"><span class="k">Transporter</span><span class="v">${escapeHtml(productContext.transporter_name)}</span></div>
            <div class="kv"><span class="k">Vehicle</span><span class="v mono">${escapeHtml(productContext.vehicle_id || "TN-38-AB-4521")}</span></div>
            <div class="kv"><span class="k">Latest condition</span><span class="v">${latestReading ? `${escapeHtml(latestReading.temp)} °C · ${escapeHtml(latestReading.hum)} % · ${escapeHtml(latestReading.eth)} ppm` : "No sensor readings available for this batch."}</span></div>
          </div>
        </div>
        <div class="role-card">
          <h3>Journey</h3>
          <div class="role-snapshot">${escapeHtml(customerJourney)}</div>
        </div>
        <div class="role-card">
          <h3>Traceability status</h3>
          <div class="role-snapshot">${traceability?.integrity?.valid === false ? "Traceability needs review" : "Traceability verified"} · Sensor data securely stored</div>
        </div>
      </div>
      ${traceabilityMarkup}
    `);
  }

  document.querySelectorAll("[data-role-stage]").forEach((button) => {
    button.addEventListener("click", async () => {
      const stage = button.dataset.roleStage;
      const product = await Api.getProducts().then((list) => list.find((item) => item.product_id === (currentProductId || DEMO_PRODUCT_ID)) || list[0]);
      if (!product) return;
      try {
        await Api.addStage(product.product_id, {
          stage,
          batch_id: product.batch_id,
          participant: currentRole === "Farmer" ? product.farmer_name : currentRole === "Transporter" ? product.transporter_name : currentRole === "Warehouse" ? "Warehouse Ops" : "Retail Ops",
          location: product.farm_location,
          happened_at: new Date().toISOString(),
          event_id: `${stage}-${Date.now()}`,
        });
        await loadTraceability(product.product_id);
        await loadProducts();
        renderRoleView();
      } catch (error) {
        console.error(error);
      }
    });
  });

  const startBtn = document.getElementById("startSimulatorBtn");
  if (startBtn) startBtn.onclick = startSimulator;
  const stopBtn = document.getElementById("stopSimulatorBtn");
  if (stopBtn) stopBtn.onclick = stopSimulator;
  const lossBtn = document.getElementById("simLossBtn");
  if (lossBtn) lossBtn.onclick = forceOfflineMode;
  const reconnectBtn = document.getElementById("simReconnectBtn");
  if (reconnectBtn) reconnectBtn.onclick = forceOnlineMode;
  const verifyBtn = document.getElementById("verifyChainBtn");
  if (verifyBtn) {
    verifyBtn.onclick = async () => {
      const statusEl = document.getElementById("chainStatus");
      if (statusEl) statusEl.innerHTML = '<div class="empty">Verifying…</div>';
      try {
        const result = await Api.verifyChain();
        if (statusEl) {
          statusEl.innerHTML = result.valid
            ? '<div class="banner ok">✔ Chain verified — every record matches its ledger hash.</div>'
            : `<div class="banner bad">✘ Tampering detected at record #${result.brokenAt} — its data no longer matches the ledger.</div>`;
        }
      } catch (error) {
        if (statusEl) statusEl.innerHTML = `<div class="banner bad">✘ ${escapeHtml(error.message)}</div>`;
      }
    };
  }

  const productForm = document.getElementById("productForm");
  if (productForm && !productForm.dataset.bound) {
    productForm.dataset.bound = "true";
    productForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const message = document.getElementById("productMessage");
      try {
        const product = await Api.createProduct(Object.fromEntries(new FormData(form)));
        currentProductId = product.product_id;
        history.replaceState(null, "", `/?product=${encodeURIComponent(currentProductId)}`);
        if (message) message.textContent = "Product registered.";
        form.reset();
        form.elements.device_id.value = "esp32-node-01";
        lastTraceSnapshot = "";
        await loadProducts();
        await loadTraceability(currentProductId);
      } catch (error) {
        if (message) message.textContent = error.message;
      }
    });
  }

  const queueOfflineBtn = document.getElementById("queueOfflineBtn");
  if (queueOfflineBtn && !queueOfflineBtn.dataset.bound) {
    queueOfflineBtn.dataset.bound = "true";
    queueOfflineBtn.addEventListener("click", async () => {
      const status = document.getElementById("offlineQueueStatus");
      try {
        let products = [];
        try {
          products = JSON.parse(localStorage.getItem(PRODUCT_CACHE_KEY) || "[]");
        } catch {
          products = [];
        }
        if (!Array.isArray(products) || products.length === 0) {
          products = await Api.getProducts();
          localStorage.setItem(PRODUCT_CACHE_KEY, JSON.stringify(products));
        }
        const product = products.find((item) => item.product_id === currentProductId) || products[0];
        if (!product) {
          if (status) status.textContent = "Register a product before queuing a sensor sample.";
          return;
        }

        const { queue } = queueOfflineReadings([{
          device_id: product.device_id,
          event_id: window.crypto?.randomUUID?.() || `${product.device_id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          product_id: product.product_id,
          batch_id: product.batch_id,
          queued_at: new Date().toISOString(),
          temp: Number((4 + Math.random() * 2).toFixed(1)),
          hum: Number((70 + Math.random() * 12).toFixed(1)),
          eth: Number((0.8 + Math.random() * 0.8).toFixed(2)),
        }]);
        updateOfflineQueueStatus(`Offline simulation: ${queue.length} sample${queue.length === 1 ? "" : "s"} waiting on this browser.`);
      } catch (error) {
        if (status) status.textContent = error.message;
      }
    });
  }

  const syncOfflineBtn = document.getElementById("syncOfflineBtn");
  if (syncOfflineBtn && !syncOfflineBtn.dataset.bound) {
    syncOfflineBtn.dataset.bound = "true";
    syncOfflineBtn.addEventListener("click", forceOnlineMode);
  }
}

function setRoleVisibility() {
  const roleNames = ["Farmer", "Transporter", "Warehouse", "Retailer", "Admin", "Customer"];
  roleNames.forEach((role) => {
    const section = document.getElementById(`${role.toLowerCase()}View`);
    if (!section) return;
    section.hidden = role !== currentRole;
    if (role !== currentRole) section.replaceChildren();
  });
}

function renderRoleView() {
  const role = currentRole;
  const roleStamp = document.getElementById("simulatorStatus");
  if (roleStamp) {
    roleStamp.textContent = `${role} view · ${networkOnline ? "Network online" : "Offline queue active"} · ${simulatorEnabled ? "Device running" : "Device idle"}`;
  }

  const product = currentTraceability?.product || getProductContext();
  const currentProduct = product || { product_id: currentProductId || DEMO_PRODUCT_ID, batch_id: "MANGO-BATCH-001" };
  const roleTrace = currentTraceability;
  renderRoleContent(role, product, roleTrace || { timeline: [], readings: [], integrity: { valid: true, status: "Verified" }, encryption_status: "Encrypted at rest" });
  const cachedProducts = JSON.parse(localStorage.getItem(PRODUCT_CACHE_KEY) || "[]");
  renderProducts(Array.isArray(cachedProducts) ? cachedProducts : []);
  setRoleVisibility();
  const activeRoleStamp = document.getElementById("simulatorStatus");
  if (activeRoleStamp) {
    activeRoleStamp.textContent = `${role} view · ${networkOnline ? "Network online" : "Offline queue active"} · ${simulatorStatusMessage}`;
  }
  if (roleTrace) renderTraceability(roleTrace);
  if (role === "Admin") {
    renderLedger(latestReadings);
    updateOfflineQueueStatus();
  }
}

function readOfflineQueue() {
  try {
    const queue = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

function queueOfflineReadings(readings) {
  const queue = readOfflineQueue();
  let added = 0;
  let conflicts = 0;
  const fields = ["device_id", "product_id", "batch_id", "event_id", "temp", "hum", "eth"];

  readings.forEach((reading) => {
    const existing = queue.find((item) => item.device_id === reading.device_id && item.event_id === reading.event_id);
    if (!existing) {
      queue.push(reading);
      added += 1;
      return;
    }
    if (fields.some((field) => existing[field] !== reading[field])) conflicts += 1;
  });

  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  return { queue, added, conflicts };
}

async function syncQueuedReadings(queued) {
  const results = [];
  for (let index = 0; index < queued.length; index += 20) {
    const response = await Api.syncDemoReadings(queued.slice(index, index + 20));
    if (!Array.isArray(response.results)) throw new Error("Offline sync returned an invalid response.");
    results.push(...response.results);
  }
  return results;
}

async function synchronizeOfflineQueue() {
  const queued = readOfflineQueue();
  if (!queued.length) {
    updateOfflineQueueStatus();
    return;
  }

  updateOfflineQueueStatus(`Reconnecting: syncing ${queued.length} queued sample${queued.length === 1 ? "" : "s"}…`);
  try {
    const results = await syncQueuedReadings(queued);
    const acceptedIds = new Set(results
      .filter((item) => item.status === 200 || item.status === 201)
      .map((item) => item.event_id));
    const remaining = queued.filter((item) => !acceptedIds.has(item.event_id));
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    const rejected = results.filter((item) => item.status >= 400);
    lastSyncSummary = `Last sync: ${acceptedIds.size} event${acceptedIds.size === 1 ? "" : "s"} synchronized at ${new Date().toLocaleTimeString()}`;
    sessionStorage.setItem("farm2fork.last-sync-summary", lastSyncSummary);
    updateOfflineQueueStatus(remaining.length
      ? `${acceptedIds.size} synced; ${remaining.length} remain queued.${rejected.length ? ` ${rejected[0].body?.error || "Some readings were rejected."}` : ""}`
      : `${acceptedIds.size} sample${acceptedIds.size === 1 ? "" : "s"} synced to the ledger.`);
    await poll();
  } catch (error) {
    lastSyncSummary = `Last sync failed: ${error.message}`;
    sessionStorage.setItem("farm2fork.last-sync-summary", lastSyncSummary);
    const reason = error.message === "Failed to fetch"
      ? "Server not reachable at this dashboard address; the browser queue is preserved."
      : error.message;
    updateOfflineQueueStatus(`Sync failed; samples remain stored offline. ${reason}`);
  }
}

function updateOfflineQueueStatus(message = "") {
  const queue = readOfflineQueue();
  const syncBtn = document.getElementById("syncOfflineBtn");
  if (syncBtn) syncBtn.disabled = queue.length === 0;
  renderOfflineQueue(queue);
  const statusEl = document.getElementById("offlineQueueStatus");
  if (statusEl) statusEl.textContent = message ||
    (queue.length ? `${queue.length} sample${queue.length === 1 ? "" : "s"} stored offline.` : "No offline readings queued.");
}

function renderOfflineQueue(queue) {
  const section = document.getElementById("offlineQueueSection");
  const panel = document.getElementById("offlineQueuePanel");
  if (!section || !panel) return;
  section.hidden = queue.length === 0;
  panel.innerHTML = queue.map((reading) => `
    <div class="offline-row">
      <div><span class="offline-id">${escapeHtml(reading.event_id)}</span><span class="offline-product">${escapeHtml(reading.product_id)} · ${escapeHtml(reading.device_id)}</span></div>
      <div class="offline-reading">${escapeHtml(reading.temp)} °C · ${escapeHtml(reading.hum)} % · ${escapeHtml(reading.eth)} ppm</div>
      <span class="tag bad">Offline · pending</span>
    </div>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function setConnected(ok) {
  document.getElementById("netDot").classList.toggle("on", ok);
  document.getElementById("netLabel").textContent = ok ? "Connected to server" : "Connecting to server…";
}

function updateTiles(readings) {
  if (readings.length === 0) return;
  const latest = readings[readings.length - 1].original;
  const tempEl = document.getElementById("tempV");
  const humEl = document.getElementById("humV");
  const ethEl = document.getElementById("ethV");
  if (tempEl) tempEl.innerHTML = latest.temp + "<span> °C</span>";
  if (humEl) humEl.innerHTML = latest.hum + "<span> %</span>";
  if (ethEl) ethEl.innerHTML = latest.eth + "<span> ppm</span>";
}

function detailHtml(item) {
  const orig = item.original;
  const claimed = item.claimed;
  const fields = [["temp", "Temperature", "°C"], ["hum", "Humidity", "%"], ["eth", "Ethylene", "ppm"]];
  const rows = fields
    .map(([k, label, unit]) => {
      const changed = String(orig[k]) !== String(claimed[k]);
      return `<div class="kv"><div class="k">${label}</div>
        <div class="v ${changed ? "diff" : ""}">${escapeHtml(claimed[k])} ${unit}${changed ? ` (was ${escapeHtml(orig[k])})` : ""}</div></div>`;
    })
    .join("");

  const verify = latestVerify[item.id];
  const verdict = verify
    ? verify.match
      ? `<div class="tag ok" style="margin-top:8px;display:inline-block">MATCH — data is original</div>`
      : `<div class="tag bad" style="margin-top:8px;display:inline-block">TAMPERED — hash does not match ledger</div>`
    : "";
  const tamperForm = tamperEditing.has(item.id)
    ? `<form class="tamper-form" data-id="${item.id}">
        <label>Field<select name="field"><option value="temp">Temperature</option><option value="hum">Humidity</option><option value="eth">Ethylene</option></select></label>
        <label>New value<input name="value" type="number" step="any" value="${escapeHtml(claimed.temp)}" required></label>
        <button type="submit">Apply edit</button>
        <span role="status"></span>
      </form>`
    : "";

  return `<div class="detail mono">
    <div class="kv"><div class="k">device</div><div class="v">${escapeHtml(orig.device_id)}</div></div>
    <div class="kv"><div class="k">timestamp</div><div class="v">${escapeHtml(orig.ts)}</div></div>
    ${rows}
    <div class="kv"><div class="k">product</div><div class="v">${escapeHtml(orig.product_id || "Unassigned")}</div></div>
    <div class="kv"><div class="k">batch</div><div class="v">${escapeHtml(orig.batch_id || "Unassigned")}</div></div>
    <div class="kv"><div class="k">previous hash</div><div class="v">${escapeHtml(item.prevHash || "Unavailable")}</div></div>
    <div class="kv"><div class="k">ledger hash</div><div class="v">${escapeHtml(item.chainHash)}</div></div>
    <div class="kv"><div class="k">encryption</div><div class="v">${escapeHtml(item.encryption_status || "AES-256-GCM")}</div></div>
    ${verdict}
    ${tamperForm}
    <div class="actions">
        <button data-action="tamper" data-id="${item.id}">${tamperEditing.has(item.id) ? "Cancel Simulate Tamper" : "Simulate Tamper"}</button>
      <button data-action="verify" data-id="${item.id}">Recompute &amp; verify</button>
      <button data-action="reset" data-id="${item.id}">Restore Sensor Data</button>
    </div>
  </div>`;
}

function renderLedger(readings) {
  const el = document.getElementById("ledgerPanel");
  if (!el) return;
  if (readings.length === 0) {
    el.innerHTML = '<div class="empty">Waiting for the first reading…</div>';
    return;
  }
  const items = [...readings].reverse();
  el.innerHTML = items
    .map((item) => {
      const row = `<div class="row" data-id="${item.id}">
        <div class="mono">#${item.id}</div>
        <div class="hash mono">${escapeHtml(item.chainHash)}</div>
        <div class="tag ok">stored</div>
      </div>`;
      return expanded.has(item.id) ? row + detailHtml(item) : row;
    })
    .join("");

  el.querySelectorAll(".row").forEach((rowEl) => {
    rowEl.addEventListener("click", () => {
      const id = Number(rowEl.dataset.id);
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      poll(); // re-render immediately with current data
    });
  });

  el.querySelectorAll("form.tamper-form").forEach((form) => {
    const item = readings.find((reading) => reading.id === Number(form.dataset.id));
    const fieldSelect = form.elements.field;
    fieldSelect.addEventListener("change", () => {
      form.elements.value.value = item.claimed[fieldSelect.value];
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = Number(form.elements.value.value);
      const status = form.querySelector('[role="status"]');
      if (!Number.isFinite(value)) {
        status.textContent = "Enter a valid number.";
        return;
      }
      try {
        await Api.claimTamper(item.id, { [fieldSelect.value]: value });
        delete latestVerify[item.id];
        tamperEditing.delete(item.id);
        await poll();
      } catch (error) {
        status.textContent = error.message;
      }
    });
  });

  el.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === "tamper") {
        tamperEditing.has(id) ? tamperEditing.delete(id) : tamperEditing.add(id);
        poll();
        return;
      } else if (btn.dataset.action === "verify") {
        latestVerify[id] = await Api.verifyRecord(id);
      } else if (btn.dataset.action === "reset") {
        const current = await Api.verifyRecord(id); // includes original values
        await Api.claimTamper(id, current.original);
        delete latestVerify[id];
      }
      poll();
    });
  });
}

function renderProducts(products) {
  const snapshot = JSON.stringify(products);
  lastProductsSnapshot = snapshot;
  const list = document.getElementById("productList");
  if (!list) return;
  if (products.length === 0) {
    list.innerHTML = '<div class="empty">No products registered yet.</div>';
    return;
  }
  const selectedProduct = products.find((product) => product.product_id === (currentProductId || DEMO_PRODUCT_ID));
  const roleFiltered = currentRole === "Farmer"
    ? products.filter((product) => product.farmer_name === selectedProduct?.farmer_name)
    : products;
  list.innerHTML = roleFiltered.map((product) => `
    <div class="product-row">
      <div class="product-summary">
        <strong>${escapeHtml(product.product_name)}</strong>
        <span class="mono">${escapeHtml(product.product_id)} · ${escapeHtml(product.batch_id)}</span>
        <span>${escapeHtml(product.current_stage?.label || "No stage recorded")}</span>
        <a href="${escapeHtml(product.traceability_url)}">Open traceability</a>
      </div>
      <img class="product-qr" src="${escapeHtml(product.qr_url)}" alt="QR code for ${escapeHtml(product.product_id)}">
    </div>`).join("");
}

function renderTraceability(data) {
  const { product } = data;
  const container = document.getElementById("tracePanel");
  const heading = document.getElementById("traceHeading");
  const section = document.getElementById("traceabilitySection");
  if (!container || !section) return;
  if (heading) heading.textContent = `Traceability · ${product.product_name}`;
  const timeline = data.timeline.length
    ? `<ol class="timeline">${data.timeline.map((event) => `
      <li class="timeline-item">
        <span class="timeline-mark ${event.status === "Current" ? "current" : ""}"></span>
        <div><strong>${escapeHtml(event.label)}</strong><span class="tag ${event.status === "Current" ? "ok" : ""}">${escapeHtml(event.status)}</span>
          <div class="timeline-meta">${escapeHtml(new Date(event.happened_at).toLocaleString())} · ${escapeHtml(event.participant)} · ${escapeHtml(event.location)}</div>
        </div>
      </li>`).join("")}</ol>`
    : '<div class="empty">No supply-chain stages recorded.</div>';
  const readings = currentRole === "Customer"
    ? data.environmental_condition
      ? `<div class="sensor-event"><div class="sensor-values">${escapeHtml(data.environmental_condition.temperature)} °C · ${escapeHtml(data.environmental_condition.humidity)} % · ${escapeHtml(data.environmental_condition.ethylene)} ppm</div><div class="sensor-event-foot">Integrity ${data.environmental_condition.integrity_verified ? "verified" : "needs review"}</div></div>`
      : '<div class="empty">No environmental summary available for this batch.</div>'
    : data.readings.length
      ? data.readings.map((reading) => `
      <div class="sensor-event">
        <div class="sensor-event-head"><strong>${escapeHtml(new Date(reading.timestamp).toLocaleString())}</strong><span>${escapeHtml(reading.device_id)}</span></div>
        <div class="sensor-values">${escapeHtml(reading.temp)} °C · ${escapeHtml(reading.hum)} % · ${escapeHtml(reading.eth)} ppm</div>
        <div class="sensor-event-foot">Encrypted at rest · Integrity ${reading.integrity_verified ? "verified" : "failed"}</div>
      </div>`).join("")
      : '<div class="empty">No sensor readings available for this batch.</div>';

  container.innerHTML = `
    <div class="trace-top">
      <div class="trace-facts">
        <div class="kv"><div class="k">Product</div><div class="v">${escapeHtml(product.product_name)} · ${escapeHtml(product.product_id)}</div></div>
        <div class="kv"><div class="k">Batch</div><div class="v">${escapeHtml(product.batch_id)}</div></div>
        <div class="kv"><div class="k">Farm</div><div class="v">${escapeHtml(product.farm_name)} · ${escapeHtml(product.farm_location)}</div></div>
        <div class="kv"><div class="k">Farmer</div><div class="v">${escapeHtml(product.farmer_name)}</div></div>
        <div class="kv"><div class="k">Logistics</div><div class="v">${escapeHtml(product.transporter_name)}${product.vehicle_id ? ` · ${escapeHtml(product.vehicle_id)}` : ""}</div></div>
        ${product.dispatch_date ? `<div class="kv"><div class="k">Dispatch date</div><div class="v">${escapeHtml(product.dispatch_date)}</div></div>` : ""}
        <div class="kv"><div class="k">Current stage</div><div class="v">${escapeHtml(data.current_stage?.label || "Not recorded")}</div></div>
      </div>
      <img class="product-qr trace-qr" src="${escapeHtml(product.qr_url)}" alt="QR code for ${escapeHtml(product.product_id)}">
    </div>
    <div class="trace-status">
      ${currentRole === "Customer" ? "" : '<span class="tag ok">Encrypted at rest: Yes</span>'}
      <span class="tag ${data.integrity.valid ? "ok" : "bad"}">Integrity: ${escapeHtml(data.integrity.status)}</span>
      <span class="encryption-note">${currentRole === "Customer" ? (data.integrity.valid ? "Traceability verified" : "Traceability needs review") : escapeHtml(data.encryption_status)}</span>
    </div>
    <div class="trace-columns">
      <div><h3>Journey</h3>${timeline}</div>
      <div><h3>${currentRole === "Customer" ? "Environmental summary" : "Sensor readings"}</h3>${readings}</div>
    </div>`;
  section.hidden = false;
}

async function loadProducts() {
  try {
    const products = await Api.getProducts();
    if (!products.some((product) => product.product_id === currentProductId)) {
      currentProductId = products[0]?.product_id || null;
      if (currentProductId) history.replaceState(null, "", `/?product=${encodeURIComponent(currentProductId)}`);
    }
    localStorage.setItem(PRODUCT_CACHE_KEY, JSON.stringify(products));
    renderProducts(products);
  } catch (error) {
    console.error(error);
  }
}

async function loadTraceability(productId) {
  try {
    const data = await Api.getTraceability(productId);
    currentTraceability = data;
    const snapshot = JSON.stringify(data);
    if (snapshot !== lastTraceSnapshot) {
      lastTraceSnapshot = snapshot;
      renderTraceability(data);
    }
  } catch (error) {
    currentTraceability = null;
    const section = document.getElementById("traceabilitySection");
    const panel = document.getElementById("tracePanel");
    if (!section || !panel) return;
    section.hidden = false;
    panel.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function poll() {
  try {
    const readings = currentRole === "Admin" ? await Api.getReadings() : [];
    if (currentRole === "Admin") latestChainVerification = await Api.verifyChain();
    latestReadings = readings;
    setConnected(true);
    if (currentRole === "Admin") renderLedger(readings);
    if (currentRole !== "Customer") await loadProducts();
    if (currentProductId) {
      await loadTraceability(currentProductId);
    }
    renderRoleView();
  } catch (err) {
    setConnected(false);
    console.error(err);
  }
}

async function emitNextDemoReading() {
  if (!simulatorEnabled) return;
  const payload = DEMO_SENSOR_EVENTS[simulatorEventIndex++];
  if (!payload) {
    stopSimulator();
    await poll();
    return;
  }

  if (!networkOnline) {
    const { queue, conflicts } = queueOfflineReadings([payload]);
    simulatorStatusMessage = conflicts
      ? `${payload.event_id} conflicts with a queued payload; the original is retained.`
      : `${payload.event_id} saved offline (${queue.length} queued).`;
  } else {
    try {
      const response = await Api.syncDemoReadings([payload]);
      const result = response.results?.[0];
      if (!result || (result.status !== 200 && result.status !== 201)) {
        simulatorStatusMessage = `${payload.event_id} rejected: ${result?.body?.error || "No ingestion result returned."}`;
      } else {
        simulatorStatusMessage = result.body?.duplicate
          ? `${payload.event_id} already exists; duplicate safely ignored.`
          : `${payload.event_id} ingested and secured.`;
      }
    } catch (error) {
      const { queue } = queueOfflineReadings([payload]);
      simulatorStatusMessage = `${payload.event_id} queued after connection failure (${queue.length} queued). ${error.message}`;
    }
  }

  await poll();
  if (!simulatorEnabled) return;
  if (simulatorEventIndex >= DEMO_SENSOR_EVENTS.length) {
    simulatorEnabled = false;
    simulatorTimer = null;
    simulatorStatusMessage = "Reading sequence complete; replay is idempotent.";
    renderRoleView();
    return;
  }
  simulatorTimer = setTimeout(emitNextDemoReading, SIMULATOR_INTERVAL_MS);
  renderRoleView();
}

function startSimulator() {
  if (simulatorTimer) clearTimeout(simulatorTimer);
  simulatorEventIndex = 0;
  simulatorEnabled = true;
  simulatorStatusMessage = "Device reporting configured Mango readings.";
  renderRoleView();
  void emitNextDemoReading();
}

function stopSimulator() {
  simulatorEnabled = false;
  if (simulatorTimer) clearTimeout(simulatorTimer);
  simulatorTimer = null;
  simulatorStatusMessage = "Device stopped.";
  renderRoleView();
}

function forceOfflineMode() {
  networkOnline = false;
  simulatorStatusMessage = simulatorEnabled ? "Network offline; new readings will be queued." : "Network offline.";
  renderRoleView();
}

function forceOnlineMode() {
  networkOnline = true;
  simulatorStatusMessage = "Network online; synchronizing queued readings.";
  renderRoleView();
  void synchronizeOfflineQueue();
}

function clearRoleScopedCache() {
  localStorage.removeItem(PRODUCT_CACHE_KEY);
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("farm2fork.trace.")) localStorage.removeItem(key);
  }
  lastProductsSnapshot = "";
  lastTraceSnapshot = "";
  currentTraceability = null;
  latestReadings = [];
}

const roleAuthControls = document.getElementById("roleAuthControls");
const rolePassword = document.getElementById("rolePassword");
const roleLoginBtn = document.getElementById("roleLoginBtn");
const roleAuthStatus = document.getElementById("roleAuthStatus");
let pendingRole = null;

roleSelect.addEventListener("change", async (event) => {
  const requestedRole = event.target.value;
  if (requestedRole === "Customer") {
    pendingRole = null;
    roleAuthControls.hidden = true;
    rolePassword.value = "";
    roleAuthStatus.textContent = "";
    sessionStorage.removeItem("farm2fork.demo-session");
    sessionStorage.setItem("farm2fork.demo-role", "Customer");
    clearRoleScopedCache();
    currentRole = "Customer";
    renderRoleView();
    await poll();
    return;
  }

  if (requestedRole === currentRole) {
    pendingRole = null;
    roleAuthControls.hidden = true;
    return;
  }
  pendingRole = requestedRole;
  rolePassword.value = "";
  roleAuthStatus.textContent = "";
  roleAuthControls.hidden = false;
  rolePassword.focus();
});

async function authenticateSelectedRole() {
  if (!pendingRole || !rolePassword.value) {
    roleAuthStatus.textContent = "Enter the role passphrase.";
    return;
  }
  try {
    const session = await Api.login(pendingRole, rolePassword.value);
    sessionStorage.setItem("farm2fork.demo-session", session.token);
    sessionStorage.setItem("farm2fork.demo-role", pendingRole);
    clearRoleScopedCache();
    currentRole = pendingRole;
    roleSelect.value = currentRole;
    pendingRole = null;
    rolePassword.value = "";
    roleAuthStatus.textContent = "";
    roleAuthControls.hidden = true;
    renderRoleView();
    await poll();
  } catch (error) {
    rolePassword.value = "";
    roleAuthStatus.textContent = error.message;
  }
}

roleLoginBtn.addEventListener("click", authenticateSelectedRole);
rolePassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") authenticateSelectedRole();
});

poll();
updateOfflineQueueStatus();
renderRoleView();
setInterval(poll, 3000);
