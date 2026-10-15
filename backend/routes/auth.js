const express = require("express");
const { ROLES, login } = require("../services/authorization");

const router = express.Router();

router.post("/demo-login", (req, res) => {
  const { role, password } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: "A valid operational role is required" });
  const result = login(role, password);
  res.status(result.status).json(result.body);
});

module.exports = router;
