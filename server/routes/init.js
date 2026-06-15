const { Router } = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = Router();

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(PROJECT_DIR, 'logs');
const CONFIG_FILE = path.join(PROJECT_DIR, 'init-config.json');
const PROVIDER_CONFIG_FILE = path.join(PROJECT_DIR, 'provider-config.json');

function findSDKBin() {
  try {
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkDir = path.dirname(sdkEntry);
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    const bin = path.join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${arch}`, 'claude');
    return fs.existsSync(bin) ? bin : null;
  } catch { return null; }
}
const SDK_BIN = findSDKBin();

function logInit(msg, err) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(`${LOG_DIR}/init.log`, `${new Date().toISOString()} ${msg} ${err?.message || err || ''}\n`);
  } catch {}
}

function logProxy(msg, err) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(`${LOG_DIR}/proxy.log`, `${new Date().toISOString()} ${msg} ${err?.message || err || ''}\n`);
  } catch {}
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function readProviderConfig() {
  try {
    if (!fs.existsSync(PROVIDER_CONFIG_FILE)) return { apiKey: '', baseUrl: '', chatUrl: '', model: '', haikuModel: '', sonnetModel: '', opusModel: '' };
    return JSON.parse(fs.readFileSync(PROVIDER_CONFIG_FILE, 'utf8'));
  } catch { return { apiKey: '', baseUrl: '', chatUrl: '', model: '', haikuModel: '', sonnetModel: '', opusModel: '' }; }
}

function writeProviderConfig(cfg) {
  const dir = path.dirname(PROVIDER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROVIDER_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// Get current status of all components
router.get('/init/status', (_req, res) => {
  const config = readConfig();
  const claudeCodePath = checkClaudeCode();
  const claudeCodeVersion = claudeCodePath ? getClaudeCodeVersion() : null;
  const providerConfig = readProviderConfig();
  const configured = !!(providerConfig.apiKey && providerConfig.baseUrl);

  // Check if built-in proxy is running
  const proxyPort = config.proxyPort || 15721;
  const proxyUrl = config.proxyUrl || `http://127.0.0.1:${proxyPort}`;
  let proxyRunning = false;
  try {
    execSync(`ss -tlnp | grep -q ":${proxyPort}\\b"`, { encoding: 'utf8', timeout: 2000 });
    proxyRunning = true;
  } catch {}

  // Parse host from proxyUrl
  let proxyHost = '127.0.0.1';
  try { const u = new URL(proxyUrl); proxyHost = u.hostname; } catch {}

  res.json({
    sdkInstalled: fs.existsSync(SDK_BIN) && fs.statSync(SDK_BIN).size > 10000,
    sdkPath: SDK_BIN,
    sdkVersion: getSDKVersion(),
    claudeInstalled: !!claudeCodePath,
    claudePath: claudeCodePath || '未安装',
    claudeVersion: claudeCodeVersion,
    proxyRunning,
    proxyHost,
    proxyPort,
    claudeProxyUrl: proxyUrl,
    saved: !!fs.existsSync(CONFIG_FILE),
    providerConfigured: configured,
    providerModel: providerConfig.model || '',
    env: checkEnvironment(),
  });
});

function checkCommand(cmd) {
  try { execSync(`command -v ${cmd}`, { encoding: 'utf8', timeout: 2000 }); return true; }
  catch { return false; }
}

function checkVersion(cmd, args = '--version') {
  try { return execSync(`${cmd} ${args}`, { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0]; }
  catch { return null; }
}

function checkEnvironment() {
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: checkCommand('node'),
    nodeVersion: checkVersion('node', '-v'),
    npm: checkCommand('npm'),
    npmVersion: checkVersion('npm', '-v'),
    git: checkCommand('git'),
    gitVersion: checkVersion('git', '--version'),
    curl: checkCommand('curl'),
    buildTools: checkCommand('make') || checkCommand('gcc'),
    systemd: checkCommand('systemctl'),
    home: os.homedir(),
  };
}

function checkClaudeCode() {
  try { return require('child_process').execSync('command -v claude', { encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return null; }
}

function getClaudeCodeVersion() {
  try {
    const raw = require('child_process').execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim();
    // 提取纯版本号，例如 "2.1.148 (Claude Code)" → "v2.1.148"
    const match = raw.match(/^(\d+\.\d+\.\d+)/);
    return match ? 'v' + match[1] : raw;
  }
  catch { return null; }
}

function getSDKVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
    return pkg.version;
  } catch { return '?'; }
}

// Install system environment component
router.post('/init/install-env/:component', (req, res) => {
  const { component } = req.params;

  const installScripts = {
    node: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs 2>&1`,
    npm: `apt install -y npm 2>&1`,
    git: `apt install -y git 2>&1`,
    buildtools: `apt install -y build-essential python3 2>&1`,
    curl: `apt install -y curl 2>&1`,
  };

  const script = installScripts[component];
  if (!script) return res.status(400).json({ error: '未知组件' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { pct: 5, text: `正在安装 ${component}...` });

  const proc = spawn('bash', ['-c', script]);
  let lastPct = 5;

  const onData = (d) => {
    const text = d.toString();
    const pctMatch = text.match(/(\d{1,3})%/);
    if (pctMatch) {
      const pct = Math.min(parseInt(pctMatch[1]), 95);
      if (pct > lastPct) lastPct = pct;
    } else if (text.includes('Unpacking') || text.includes('Preparing')) {
      lastPct = Math.min(lastPct + 5, 50);
    } else if (text.includes('Setting up') || text.includes('Processing')) {
      lastPct = Math.min(lastPct + 3, 80);
    } else if (text.startsWith('Get:') || text.includes('Fetched')) {
      lastPct = Math.min(lastPct + 2, 95);
    } else {
      lastPct = Math.min(lastPct + 1, 92);
    }
    send('progress', { pct: lastPct, text: text.trim().slice(0, 80) });
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    const installed = component === 'buildtools'
      ? (checkCommand('make') || checkCommand('gcc'))
      : component === 'node'
        ? checkCommand('node')
        : checkCommand(component);
    send('done', { success: installed, pct: 100, text: installed ? `${component} 安装完成` : `${component} 安装失败` });
    res.end();
  });

  proc.on('error', (e) => {
    send('error', { message: e.message });
    res.end();
  });
});

// Save proxy config (port)
router.post('/init/config', (req, res) => {
  const { proxyUrl, proxyHost, proxyPort } = req.body || {};
  const config = readConfig();

  if (proxyUrl) {
    config.proxyUrl = proxyUrl;
    // Also extract host/port from URL
    try {
      const u = new URL(proxyUrl);
      config.proxyHost = u.hostname;
      config.proxyPort = parseInt(u.port) || 15721;
    } catch {}
  }
  if (proxyHost) config.proxyHost = proxyHost;
  if (proxyPort) config.proxyPort = parseInt(proxyPort) || 15721;

  // Rebuild proxyUrl if host/port changed without a full URL
  if (!proxyUrl && (proxyHost || proxyPort)) {
    const host = config.proxyHost || '127.0.0.1';
    const port = config.proxyPort || 15721;
    config.proxyUrl = `http://${host}:${port}`;
  }

  writeConfig(config);

  // Restart proxy on new address
  try {
    const { startProxy } = require('../proxy');
    const host = config.proxyHost || '127.0.0.1';
    const port = config.proxyPort || 15721;
    startProxy(host, port).then(() => {
      logProxy(`代理已重启 ${host}:${port}`);
    }).catch(() => {});
  } catch {}

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

// ── Provider config (replaces CC-Switch SQLite) ──

// Get provider config
router.get('/init/provider-config', (_req, res) => {
  const cfg = readProviderConfig();
  res.json({
    apiKey: cfg.apiKey || '',
    baseUrl: cfg.baseUrl || '',
    chatUrl: cfg.chatUrl || '',
    model: cfg.model || '',
    haikuModel: cfg.haikuModel || '',
    sonnetModel: cfg.sonnetModel || '',
    opusModel: cfg.opusModel || '',
    hasApiKey: !!(cfg.apiKey),
  });
});

// Save provider config
router.post('/init/provider-config', (req, res) => {
  const { apiKey, baseUrl, chatUrl, model, haikuModel, sonnetModel, opusModel } = req.body || {};
  const cfg = readProviderConfig();

  // Only update provided fields (allows partial updates)
  if (apiKey !== undefined) cfg.apiKey = apiKey;
  if (baseUrl !== undefined) cfg.baseUrl = baseUrl;
  if (chatUrl !== undefined) cfg.chatUrl = chatUrl;
  if (model !== undefined) cfg.model = model;
  if (haikuModel !== undefined) cfg.haikuModel = haikuModel;
  if (sonnetModel !== undefined) cfg.sonnetModel = sonnetModel;
  if (opusModel !== undefined) cfg.opusModel = opusModel;

  writeProviderConfig(cfg);

  // Bust models cache so /models returns fresh data
  modelsCache = null;

  logProxy('Provider config saved');
  res.json({ ok: true, model: cfg.model });
});

// Fetch available models from provider API
router.post('/init/fetch-models', async (req, res) => {
  const { baseUrl, token } = req.body || {};

  // Allow reading credentials from provider-config.json if not provided in body
  let apiKey = token;
  let apiBaseUrl = baseUrl;
  if (!apiKey || !apiBaseUrl) {
    const cfg = readProviderConfig();
    apiKey = apiKey || cfg.apiKey;
    apiBaseUrl = apiBaseUrl || cfg.baseUrl;
  }
  if (!apiBaseUrl || !apiKey) return res.status(400).json({ error: '缺少 baseUrl 或 apiKey' });

  try {
    const url = `${apiBaseUrl.replace(/\/$/, '')}/v1/models`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return res.status(resp.status).json({ error: `请求失败 (${resp.status}): ${errText}`.slice(0, 200) });
    }
    const data = await resp.json();
    const models = (data.data || []).map(m => m.id);
    res.json({ ok: true, models });
  } catch (err) {
    res.status(500).json({ error: `无法连接: ${err.message}` });
  }
});

// Install Claude Code CLI globally
router.post('/init/install-claude', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 先清理旧模块目录，避免 ENOTEMPTY 错误
  try {
    const npmRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    const modulePath = path.join(npmRoot, '@anthropic-ai', 'claude-code');
    if (fs.existsSync(modulePath)) {
      send('progress', { pct: 5, text: '清理旧版本...' });
      fs.rmSync(modulePath, { recursive: true, force: true });
    }
  } catch {}

  send('progress', { pct: 10, text: '正在安装 Claude Code...' });

  const proc = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code', '--registry', 'https://registry.npmmirror.com'], { env: process.env });
  let lastPct = 10;

  proc.stdout.on('data', (d) => {
    lastPct = Math.min(lastPct + 15, 90);
    send('progress', { pct: lastPct, text: d.toString().trim().slice(0, 80) });
  });
  proc.stderr.on('data', (d) => {
    lastPct = Math.min(lastPct + 10, 85);
    send('progress', { pct: lastPct, text: d.toString().trim().slice(0, 80) });
  });

  proc.on('close', (code) => {
    const installed = checkClaudeCode() ? true : false;
    send('done', { success: installed, pct: 100, text: installed ? 'Claude Code 安装完成' : '安装失败' });
    res.end();
  });
  proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
});

// Install Agent SDK binary (rebuild native module)
router.post('/init/install-sdk', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { pct: 5, text: '正在安装 SDK 原生模块...' });

  const proc = spawn('npm', ['rebuild', '@anthropic-ai/claude-agent-sdk', '--registry', 'https://registry.npmmirror.com'], { cwd: PROJECT_DIR, env: process.env });
  let lastPct = 5;

  const onData = (d) => {
    const text = d.toString();
    if (text.includes('rebuilt') || text.includes('success')) lastPct = 90;
    else lastPct = Math.min(lastPct + 8, 85);
    send('progress', { pct: lastPct, text: text.trim().slice(0, 80) });
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    const ok = fs.existsSync(SDK_BIN) && fs.statSync(SDK_BIN).size > 10000;
    send('done', { success: ok, pct: 100, text: ok ? 'SDK 安装完成' : '安装失败，请检查日志' });
    res.end();
  });
  proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
});

// Check Claude Code update
router.post('/init/check-claude-update', (req, res) => {
  try {
    const raw = getClaudeCodeVersion() || '';
    const current = raw.replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1');
    // 用官方 registry 获取版本号（镜像的 latest tag 可能未同步）
    const latest = execSync('npm view @anthropic-ai/claude-code version', { encoding: 'utf8', timeout: 15000 }).trim();
    res.json({ current, latest, hasUpdate: current && latest && current !== latest });
  } catch (err) {
    logInit('Error in init route', err);
    res.status(500).json({ error: err.message });
  }
});

// Upgrade Claude Code
router.post('/init/upgrade-claude', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const REGISTRY = 'https://registry.npmmirror.com';

  // 用 fs.rmSync 清模块目录（npm 自己处理不了 ENOTEMPTY）
  try {
    const npmRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    const modulePath = path.join(npmRoot, '@anthropic-ai', 'claude-code');
    if (fs.existsSync(modulePath)) {
      send('progress', { pct: 5, text: '清理旧版本...' });
      fs.rmSync(modulePath, { recursive: true, force: true });
    }
    // 同时删除可能的残留二进制
    const binPath = '/usr/local/bin/claude';
    if (fs.existsSync(binPath)) {
      try { fs.unlinkSync(binPath); } catch {}
    }
  } catch {}

  send('progress', { pct: 15, text: `正在从镜像安装 Claude Code@latest...` });

  // --prefer-online: 强制查 registry 而非用缓存
  // --force: 即使本地有也重装
  const proc = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code@latest',
    '--prefer-online', '--force', '--registry', REGISTRY], { env: process.env });

  let lastPct = 15;
  proc.stdout.on('data', (d) => {
    lastPct = Math.min(lastPct + 15, 90);
    send('progress', { pct: lastPct, text: d.toString().trim().slice(0, 80) });
  });
  proc.stderr.on('data', (d) => {
    lastPct = Math.min(lastPct + 10, 85);
    send('progress', { pct: lastPct, text: d.toString().trim().slice(0, 80) });
  });
  proc.on('close', (code) => {
    const newVer = getClaudeCodeVersion() || '?';
    send('done', { success: code === 0, pct: 100, text: code === 0 ? `升级完成 v${newVer}` : '升级失败' });
    res.end();
  });
  proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
});

// Frontend error logging
router.post('/init/log-error', (req, res) => {
  try {
    const { message, stack, url } = req.body || {};
    const logDir = path.join(PROJECT_DIR, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const line = `${new Date().toISOString()} [${url || 'unknown'}] ${message}\n${stack || ''}\n`;
    fs.appendFileSync(path.join(logDir, 'frontend-error.log'), line);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// Get all error logs (frontend + backend + init + proxy + syslog)
router.get('/init/log-errors', async (req, res) => {
  try {
    const fsPromises = require('fs').promises;
    const { exec } = require('child_process');

    const readLog = async (name) => {
      try {
        const p = path.join(PROJECT_DIR, 'logs', name);
        const data = await fsPromises.readFile(p, 'utf8');
        return data.split('\n').filter(Boolean).slice(-30);
      } catch { return []; }
    };

    const syslog = () => new Promise((resolve) => {
      const p = '/var/log/syslog';
      try {
        if (!require('fs').existsSync(p)) return resolve([]);
        exec(`tail -30 "${p}"`, { encoding: 'utf8', timeout: 3000 }, (err, stdout) => {
          if (err) return resolve([]);
          resolve(stdout.split('\n').filter(Boolean));
        });
      } catch { resolve([]); }
    });

    const [server, frontend, init, proxy, sys] = await Promise.all([
      readLog('server-error.log'),
      readLog('frontend-error.log'),
      readLog('init.log'),
      readLog('proxy.log'),
      syslog(),
    ]);

    res.json({ server, frontend, init, proxy, syslog: sys });
  } catch { res.json({ frontend: [], server: [], init: [], proxy: [], syslog: [] }); }
});

// ── Model listing & switching (from provider-config.json) ──

// In-memory model cache (2 min TTL)
let modelsCache = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 2 * 60 * 1000;

router.get('/models', async (req, res) => {
  try {
    // Return cached models if fresh
    if (modelsCache && (Date.now() - modelsCacheTime) < MODELS_CACHE_TTL) {
      return res.json(modelsCache);
    }

    const cfg = readProviderConfig();
    const { apiKey, baseUrl, model } = cfg;

    if (!baseUrl || !apiKey) return res.json({ models: [], current: model || '' });

    // Fetch model list from provider's /v1/models
    let models = [];
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'x-api-key': apiKey,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        models = (data.data || []).map(m => m.id);
      }
    } catch {
      // Fallback: use current model only
      if (model) models = [model];
    }

    modelsCache = { models, current: model };
    modelsCacheTime = Date.now();
    res.json(modelsCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/models/switch', async (req, res) => {
  try {
    const { model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model is required' });

    const cfg = readProviderConfig();
    if (!cfg.baseUrl) return res.status(404).json({ error: 'Provider 未配置' });

    // Update all model fields
    cfg.model = model;
    cfg.haikuModel = model;
    cfg.sonnetModel = model;
    cfg.opusModel = model;
    writeProviderConfig(cfg);

    // Bust cache
    modelsCache = null;

    logProxy(`Model switched to: ${model}`);
    res.json({ ok: true, model });
  } catch (err) {
    logProxy('Error in model switch', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Custom token pricing ──

const PRICING_FILE = path.join(PROJECT_DIR, 'pricing-config.json');

function readPricing() {
  try {
    if (fs.existsSync(PRICING_FILE)) {
      return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
    }
  } catch {}
  return { models: {} };
}

function writePricing(data) {
  fs.writeFileSync(PRICING_FILE, JSON.stringify(data, null, 2));
}

router.get('/init/pricing', (_req, res) => {
  res.json(readPricing());
});

router.post('/init/pricing', (req, res) => {
  const { models } = req.body || {};
  if (!models || typeof models !== 'object') {
    return res.status(400).json({ error: 'models is required' });
  }
  writePricing({ models });
  logProxy('Pricing config saved');
  res.json({ ok: true });
});

module.exports = router;
