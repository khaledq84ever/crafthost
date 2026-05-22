const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  // Only show visible plans. Hidden ones (deprecated tiers) are kept in DB so
  // existing servers don't break their JOIN, but they're not shown publicly.
  const plans = db.prepare('SELECT * FROM plans WHERE hidden = 0 ORDER BY price_cents ASC').all();
  res.json({ plans });
});

module.exports = router;
