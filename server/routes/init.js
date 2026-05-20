const { Router } = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = Router();

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const SDK_BIN = path.join(PROJECT_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');
const CONFIG_FILE = path.join(os.homedir(), '.claude-web-ui', 'init-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// Get current status of all components
router.get('/init/status', (_req, res) => {
  const config = readConfig();
  res.json({
    claudeInstalled: fs.existsSync(SDK_BIN),
    claudePath: SDK_BIN,
    ccSwitchInstalled: !!checkCCSwitch(),
    ccSwitchPath: checkCCSwitch(),
    proxyUrl: config.proxyUrl || 'http://127.0.0.1:15721',
    proxyPort: config.proxyPort || 15721,
    claudeProxyUrl: config.claudeProxyUrl || process.env.CLAUDE_PROXY || 'http://127.0.0.1:15721',
    sdkVersion: getSDKVersion(),
    saved: !!fs.existsSync(CONFIG_FILE),
  });
});

function checkCCSwitch() {
  try { return execSync('which cc-switch', { encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return null; }
}

function getSDKVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
    return pkg.version;
  } catch { return '?'; }
}

// Install CC-Switch
router.post('/init/install-ccswitch', (req, res) => {
  const { version } = req.body || {};
  const ver = version || '3.14.1';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('log', { text: `正在下载 CC-Switch v${ver}...\n` });

  const debUrl = `https://github.com/cc-switch/cc-switch/releases/download/v${ver}/CC-Switch-v${ver}-Linux-x86_64.deb`;
  const debFile = `/tmp/cc-switch-${ver}.deb`;

  const proc = spawn('bash', ['-c', `
    curl -L -o "${debFile}" "${debUrl}" 2>&1 && echo "DOWNLOAD_DONE" &&
    dpkg -i "${debFile}" 2>&1 && echo "INSTALL_DONE" &&
    rm -f "${debFile}"
  `]);

  proc.stdout.on('data', (d) => send('log', { text: d.toString() }));
  proc.stderr.on('data', (d) => send('log', { text: d.toString() }));
  proc.on('close', (code) => {
    send('done', { success: code === 0, installed: checkCCSwitch() ? true : false });
    res.end();
  });
  proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
});

// Save proxy configuration
router.post('/init/config', (req, res) => {
  const { proxyUrl, proxyPort } = req.body || {};
  const config = readConfig();
  if (proxyUrl) config.proxyUrl = proxyUrl;
  if (proxyPort) config.proxyPort = parseInt(proxyPort) || 15721;
  writeConfig(config);
  res.json({ ok: true, config });
});

// Test proxy connection
router.post('/init/test-proxy', async (req, res) => {
  const { url } = req.body || {};
  const proxyUrl = url || readConfig().proxyUrl || 'http://127.0.0.1:15721';
  try {
    const net = require('net');
    const u = new URL(proxyUrl);
    const ok = await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(parseInt(u.port) || 80, u.hostname);
    });
    res.json({ ok, url: proxyUrl });
  } catch { res.json({ ok: false, url: proxyUrl }); }
});

module.exports = router;
