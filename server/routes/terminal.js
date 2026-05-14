const { Router } = require('express');
const os = require('os');

const router = Router();

// This route is a marker — the actual WebSocket upgrade happens in server/index.js
// We expose the route so it appears in the API docs
router.get('/terminal', (_req, res) => {
  res.json({ message: 'WebSocket endpoint — connect with ws:// upgrade' });
});

module.exports = router;
