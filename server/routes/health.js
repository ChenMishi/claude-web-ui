const { Router } = require('express');

const PROXY_URL = 'http://127.0.0.1:15721';

const router = Router();

router.get('/health', async (_req, res) => {
  // Lightweight check: try to connect to the proxy's TCP port (no API call)
  let proxyOk = false;
  try {
    const url = new URL(PROXY_URL);
    const net = require('net');
    proxyOk = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(2000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(parseInt(url.port) || 80, url.hostname);
    });
  } catch {
    proxyOk = false;
  }
  res.json({ healthy: proxyOk, version: '1.1.9', proxy: PROXY_URL });
});

module.exports = router;
