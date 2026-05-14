const { Router } = require('express');
const { PROXY_BASE } = require('../config');

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    const proxyRes = await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }], stream: false }),
    });
    res.json({ healthy: proxyRes.ok, version: '2.0.0', proxy: PROXY_BASE });
  } catch {
    res.status(502).json({ healthy: false, version: '2.0.0', proxy: PROXY_BASE });
  }
});

module.exports = router;
