// frontend/js/api.js
// All calls to the backend API live here, so dashboard.js never touches fetch() directly.

const Api = {
  authHeaders() {
    const token = sessionStorage.getItem("farm2fork.demo-session");
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  async login(role, password) {
    const res = await fetch("/api/auth/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Role login failed");
    return body;
  },

  async getReadings() {
    const res = await fetch("/api/readings", { headers: this.authHeaders() });
    if (!res.ok) throw new Error("Failed to load readings");
    return res.json();
  },

  async syncDemoReadings(readings) {
    const res = await fetch("/api/readings/demo-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ readings }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to sync offline readings");
    return body;
  },

  async getProducts() {
    const res = await fetch("/api/products", { headers: this.authHeaders() });
    if (!res.ok) throw new Error("Failed to load products");
    return res.json();
  },

  async createProduct(product) {
    const res = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(product),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to register product");
    return body;
  },

  async getTraceability(productId) {
    const res = await fetch(`/api/products/${encodeURIComponent(productId)}/traceability`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error("Failed to load product traceability");
    return res.json();
  },

  async addStage(productId, stage) {
    const res = await fetch(`/api/products/${encodeURIComponent(productId)}/stages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(stage),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Failed to record supply-chain stage");
    return body;
  },

  async verifyRecord(id) {
    const res = await fetch(`/api/readings/${id}/verify`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error("Failed to verify record");
    return res.json();
  },

  async verifyChain() {
    const res = await fetch("/api/readings/verify-chain/all", { headers: this.authHeaders() });
    if (!res.ok) throw new Error("Failed to verify chain");
    return res.json();
  },

  async claimTamper(id, fields) {
    const res = await fetch(`/api/readings/${id}/claim`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error("Failed to update record");
    return res.json();
  },
};
