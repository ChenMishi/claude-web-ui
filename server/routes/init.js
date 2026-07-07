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

// ── Vision model detection ──
function checkVisionInstalled() {
  // Check venv exists
  const venvPython = path.join(PROJECT_DIR, 'venv', 'bin', 'python3');
  const venvPythonWin = path.join(PROJECT_DIR, 'venv', 'Scripts', 'python.exe');
  const pythonBin = fs.existsSync(venvPython) ? venvPython : (fs.existsSync(venvPythonWin) ? venvPythonWin : null);
  if (!pythonBin) return { installed: false, reason: 'venv-missing' };

  // Check vision_analyze.py exists
  if (!fs.existsSync(path.join(PROJECT_DIR, 'vision_analyze.py'))) {
    return { installed: false, reason: 'script-missing' };
  }

  // Check model downloaded (~1MB+ in .vision_cache means model is downloaded)
  const cacheDir = path.join(PROJECT_DIR, '.vision_cache');
  if (!fs.existsSync(cacheDir)) return { installed: false, reason: 'model-missing' };

  try {
    let totalSize = 0;
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(p);
        else totalSize += fs.statSync(p).size;
      }
    };
    walkDir(cacheDir);
    if (totalSize < 50 * 1024 * 1024) return { installed: false, reason: 'model-incomplete', size: totalSize };
  } catch { return { installed: false, reason: 'model-check-failed' }; }

  return { installed: true };
}

const VISION_STATUS = checkVisionInstalled();

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
    if (!fs.existsSync(PROVIDER_CONFIG_FILE)) return emptyProviderConfig();
    const cfg = JSON.parse(fs.readFileSync(PROVIDER_CONFIG_FILE, 'utf8'));
    // Migrate old single-object format → new array format
    if (!cfg.providers) {
      cfg.providers = [];
      if (cfg.apiKey || cfg.baseUrl) {
        cfg.providers.push({
          id: require('crypto').randomUUID(),
          name: '默认配置',
          apiKey: cfg.apiKey || '',
          baseUrl: cfg.baseUrl || '',
          chatUrl: cfg.chatUrl || '',
        });
      }
      cfg.providerModels = {};
      writeProviderConfig(cfg);
    }
    // Migrate old providerModels array format → {available, selected} format
    if (cfg.providerModels) {
      let migrated = false;
      for (const [id, val] of Object.entries(cfg.providerModels)) {
        if (Array.isArray(val)) {
          cfg.providerModels[id] = { available: val, selected: [] };
          migrated = true;
        }
      }
      // Clean orphaned entries (no corresponding provider)
      const validIds = new Set((cfg.providers || []).map(p => p.id));
      for (const id of Object.keys(cfg.providerModels)) {
        if (!validIds.has(id)) { delete cfg.providerModels[id]; migrated = true; }
      }
      if (migrated) writeProviderConfig(cfg);
    }
    return cfg;
  } catch { return emptyProviderConfig(); }
}

function emptyProviderConfig() {
  return { apiKey: '', baseUrl: '', chatUrl: '', model: '', haikuModel: '', sonnetModel: '', opusModel: '', providers: [], providerModels: {} };
}

function writeProviderConfig(cfg) {
  if (cfg.providers && cfg.providers.length > 0) {
    cfg.apiKey = cfg.providers[0].apiKey || '';
    cfg.baseUrl = cfg.providers[0].baseUrl || '';
    cfg.chatUrl = cfg.providers[0].chatUrl || '';
  } else {
    cfg.apiKey = '';
    cfg.baseUrl = '';
    cfg.chatUrl = '';
  }
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
  const configured = !!(providerConfig.providers && providerConfig.providers.length > 0 && providerConfig.apiKey);

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
    visionInstalled: checkVisionInstalled().installed,
    visionStatus: checkVisionInstalled(),
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
    tesseract: checkCommand('tesseract'),
    tesseractVersion: checkVersion('tesseract', '--version')?.replace(/\n.*/s, ''),
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
    tesseract: `apt install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-chi-tra 2>&1`,
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

// Get provider config (multi-provider with compatibility)
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
    providers: cfg.providers || [],
    providerModels: cfg.providerModels || {},
  });
});

// Save a single provider
router.post('/init/provider-config', (req, res) => {
  const { id, name, apiKey, baseUrl, chatUrl, model, haikuModel, sonnetModel, opusModel } = req.body || {};
  const cfg = readProviderConfig();

  // Model fields (compatibility)
  if (model !== undefined) cfg.model = model;
  if (haikuModel !== undefined) cfg.haikuModel = haikuModel;
  if (sonnetModel !== undefined) cfg.sonnetModel = sonnetModel;
  if (opusModel !== undefined) cfg.opusModel = opusModel;

  if (!cfg.providers) cfg.providers = [];
  let provider;
  if (id) {
    provider = cfg.providers.find(p => p.id === id);
  }
  if (!provider) {
    provider = { id: require('crypto').randomUUID(), name: '', apiKey: '', baseUrl: '', chatUrl: '' };
    cfg.providers.push(provider);
  }
  if (name !== undefined) provider.name = name;
  if (apiKey !== undefined) provider.apiKey = apiKey;
  if (baseUrl !== undefined) provider.baseUrl = baseUrl;
  if (chatUrl !== undefined) provider.chatUrl = chatUrl;

  // Clean orphaned providerModels entries
  const validIds = new Set((cfg.providers || []).map(p => p.id));
  if (cfg.providerModels) {
    for (const id of Object.keys(cfg.providerModels)) {
      if (!validIds.has(id)) { delete cfg.providerModels[id]; }
    }
  }

  writeProviderConfig(cfg);
  modelsCache = null;
  res.json({ ok: true, provider });
});

// Delete a provider
router.delete('/init/provider-config/:id', (req, res) => {
  const cfg = readProviderConfig();
  const idx = (cfg.providers || []).findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Provider not found' });
  const deletedName = cfg.providers[idx]?.name;
  cfg.providers.splice(idx, 1);
  // Clean up orphaned model data
  if (cfg.providerModels) delete cfg.providerModels[req.params.id];
  // Clear current model if it was from the deleted provider
  if (cfg.model && deletedName && cfg.model.startsWith(deletedName + '/')) {
    cfg.model = '';
  }
  writeProviderConfig(cfg);
  modelsCache = null;
  res.json({ ok: true });
});

// Fetch available models from ALL providers, or specified provider if baseUrl+token passed
router.post('/init/fetch-models', async (req, res) => {
  const { baseUrl, token } = req.body || {};

  // Explicit provider: fetch directly
  if (baseUrl && token) {
    try {
      const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'x-api-key': token },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.json({ ok: true, models: (data.data || []).map(m => m.id) });
      }
      return res.json({ ok: false, models: [], error: `请求失败 (${resp.status})` });
    } catch (err) {
      return res.status(500).json({ error: `无法连接: ${err.message}` });
    }
  }

  // All providers: read from config
  const cfg = readProviderConfig();

  const results = {};
  for (const p of providers) {
    if (!p.baseUrl || !p.apiKey) continue;
    try {
      const url = `${p.baseUrl.replace(/\/$/, '')}/v1/models`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${p.apiKey}`, 'x-api-key': p.apiKey },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const models = (data.data || []).map(m => m.id);
        // Preserve existing selected models, default to all if new
        const prev = cfg.providerModels?.[p.id];
        const prevSelected = prev?.selected || models;
        results[p.id] = { available: models, selected: prevSelected.filter(m => models.includes(m)) };
      } else {
        results[p.id] = { available: [], selected: [] };
      }
    } catch {
      results[p.id] = { available: [], selected: [] };
    }
  }

  // Save to providerModels
  cfg.providerModels = { ...cfg.providerModels, ...results };
  writeProviderConfig(cfg);
  modelsCache = null;

  res.json({ ok: true, providerModels: cfg.providerModels });
});

// Save selected models for a provider
router.post('/init/provider-models', (req, res) => {
  const { providerId, available, selected } = req.body || {};
  if (!providerId) return res.status(400).json({ error: 'providerId is required' });
  const cfg = readProviderConfig();
  if (!cfg.providerModels) cfg.providerModels = {};
  const entry = cfg.providerModels[providerId] || { available: [], selected: [] };
  if (available !== undefined) entry.available = available;
  if (selected !== undefined) entry.selected = selected;
  cfg.providerModels[providerId] = entry;
  writeProviderConfig(cfg);
  modelsCache = null;
  res.json({ ok: true });
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

// ── Vision model installation ──
router.post('/init/install-vision', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const venvDir = path.join(PROJECT_DIR, 'venv');
  const venvPython = path.join(venvDir, 'bin', 'python3');

  // Step 1: clean old venv and caches, then create fresh venv
  send('progress', { pct: 2, text: '清理旧环境...' });
  try {
    if (fs.existsSync(venvDir)) fs.rmSync(venvDir, { recursive: true, force: true });
    const hfCache = path.join(os.homedir(), '.cache', 'huggingface');
    if (fs.existsSync(hfCache)) fs.rmSync(hfCache, { recursive: true, force: true });
    const visionCache = path.join(PROJECT_DIR, '.vision_cache');
    if (fs.existsSync(visionCache)) fs.rmSync(visionCache, { recursive: true, force: true });
  } catch {}

  send('progress', { pct: 5, text: '创建 Python 虚拟环境...' });
  try {
    execSync(`python3 -m venv "${venvDir}"`, { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    // 常见原因：系统未安装 python3-venv
    if (e.message.includes('ensurepip') || e.message.includes('venv') || e.status !== 0) {
      send('progress', { pct: 5, text: '检测到 python3-venv 未安装，正在安装...' });
      try {
        // 尝试 apt (Debian/Ubuntu)
        execSync('apt-get update -qq && apt-get install -y -qq python3-venv', { encoding: 'utf8', timeout: 120000 });
        execSync(`python3 -m venv "${venvDir}"`, { encoding: 'utf8', timeout: 60000 });
      } catch (e2) {
        try {
          // 尝试 yum/dnf (RHEL/CentOS/Fedora)
          execSync('yum install -y python3-venv || dnf install -y python3-venv', { encoding: 'utf8', timeout: 120000 });
          execSync(`python3 -m venv "${venvDir}"`, { encoding: 'utf8', timeout: 60000 });
        } catch (e3) {
          send('done', { success: false, pct: 0, text: `创建虚拟环境失败。请手动安装 python3-venv: apt install python3-venv 或 yum install python3-venv` });
          return res.end();
        }
      }
    } else {
      send('done', { success: false, pct: 0, text: `创建虚拟环境失败: ${e.message}` });
      return res.end();
    }
  }

  const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python3';

  // Helper: run a command via spawn, streaming stdout/stderr as progress updates
  const runStep = ({ stepPct, stepText, cmd, args, env: stepEnv, timeout, onDone }) => {
    send('progress', { pct: stepPct, text: stepText });

    const proc = spawn(cmd, args, {
      env: stepEnv || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPct = stepPct;
    const maxPct = stepPct + 18; // each step spans ~18% of the progress bar

    const onData = (d) => {
      const text = d.toString().trim();
      if (!text) return;
      // Try to parse pip download progress percentage
      const pctMatch = text.match(/(\d{1,3})%/);
      if (pctMatch) {
        const p = parseInt(pctMatch[1]);
        lastPct = Math.round(stepPct + (p / 100) * (maxPct - stepPct));
      } else if (text.includes('Downloading') || text.includes('Collecting')) {
        lastPct = Math.min(lastPct + 2, maxPct - 5);
      } else if (text.includes('Installing') || text.includes('Building')) {
        lastPct = Math.min(lastPct + 1, maxPct - 3);
      } else if (text.includes('Successfully') || text.includes('Requirement already')) {
        lastPct = maxPct;
      }
      const short = text.length > 100 ? text.slice(0, 100) + '...' : text;
      send('progress', { pct: lastPct, text: short });
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const timer = timeout ? setTimeout(() => { try { proc.kill(); } catch {} }, timeout) : null;

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        send('progress', { pct: maxPct, text: `${stepText.split(' ')[0]} 完成` });
        onDone(null);
      } else {
        onDone(new Error(`exit code ${code}`));
      }
    });

    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      onDone(e);
    });
  };

  // Step 2: install PyTorch CPU
  runStep({
    stepPct: 10,
    stepText: '安装 PyTorch + TorchVision (CPU 版, ~300MB)...',
    cmd: pythonBin,
    args: ['-m', 'pip', 'install', 'torch>=2.4,<2.6', 'torchvision', '--index-url', 'https://download.pytorch.org/whl/cpu', '--no-cache-dir'],
    env: { ...process.env, PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
    timeout: 600000,
    onDone: (err) => {
      if (err) {
        send('done', { success: false, pct: 15, text: `PyTorch 安装失败: ${err.message.slice(0, 200)}` });
        return res.end();
      }
      // Step 3: install transformers + pillow + sentencepiece
      runStep({
        stepPct: 28,
        stepText: '安装 Transformers + Pillow (~100MB)...',
        cmd: pythonBin,
        args: ['-m', 'pip', 'install', 'transformers>=4.38,<5.0', 'pillow', 'sentencepiece', 'einops', 'timm', '--no-cache-dir'],
        env: { ...process.env, PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
        timeout: 600000,
        onDone: (err2) => {
          if (err2) {
            send('done', { success: false, pct: 30, text: `Transformers 安装失败: ${err2.message.slice(0, 200)}` });
            return res.end();
          }
          // Step 4: download Florence-2 model (~300MB)
          send('progress', { pct: 46, text: '下载 Florence-2 模型 (~300MB)...' });

          const modelProc = spawn(pythonBin, ['-c', `
import os
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
cache_dir = '${path.join(PROJECT_DIR, '.vision_cache').replace(/'/g, "'\\''")}'
os.makedirs(cache_dir, exist_ok=True)
print('FLORENCE_PROGRESS:0')
import torch
print('FLORENCE_PROGRESS:10')
from PIL import Image
print('FLORENCE_PROGRESS:15')
from transformers import AutoProcessor, AutoModelForCausalLM
print('FLORENCE_PROGRESS:20 正在下载模型文件（约 300MB，首次下载需 2-5 分钟）...')
model = AutoModelForCausalLM.from_pretrained(
    'microsoft/Florence-2-base', trust_remote_code=True, cache_dir=cache_dir,
    attn_implementation='eager'
).to('cpu').eval()
print('FLORENCE_PROGRESS:75')
processor = AutoProcessor.from_pretrained(
    'microsoft/Florence-2-base', trust_remote_code=True, cache_dir=cache_dir
)
print('FLORENCE_PROGRESS:85 正在验证...')
img = Image.new('RGB', (64, 64), color=(128, 128, 128))
inputs = processor(text='<DETAILED_CAPTION>', images=img, return_tensors='pt')
generated_ids = model.generate(input_ids=inputs['input_ids'], pixel_values=inputs['pixel_values'], max_new_tokens=32, do_sample=False, use_cache=False, num_beams=1)
caption = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
print('MODEL_OK:' + str(len(caption) > 0))
`], {
            env: { ...process.env, PYTHONUNBUFFERED: '1', HF_ENDPOINT: 'https://hf-mirror.com' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let modelPct = 46;

          const onModelData = (d) => {
            const text = d.toString().trim();
            if (!text) return;
            // Parse FLORENCE_PROGRESS:XX markers
            const progMatch = text.match(/FLORENCE_PROGRESS:(\d+)/);
            if (progMatch) {
              const p = parseInt(progMatch[1]);
              modelPct = Math.round(46 + (p / 100) * 44); // map 0-100 → 46-90
            }
            // Send the raw text as progress
            const cleanText = text.replace(/FLORENCE_PROGRESS:\d+\s*/, '').trim();
            const short = (cleanText || text).slice(0, 120);
            send('progress', { pct: modelPct, text: short || '下载中...' });
          };

          modelProc.stdout.on('data', onModelData);
          modelProc.stderr.on('data', onModelData);

          const modelTimer = setTimeout(() => { try { modelProc.kill(); } catch {} }, 600000);

          modelProc.on('close', (code) => {
            clearTimeout(modelTimer);
            if (code === 0) {
              send('progress', { pct: 90, text: '验证模型...' });
              const newStatus = checkVisionInstalled();
              const ok = newStatus.installed;
              send('done', {
                success: ok,
                pct: ok ? 100 : 80,
                text: ok ? 'Florence-2 图像识别模型安装完成' : `安装异常 (状态: ${newStatus.reason})，请查看日志`,
              });
            } else {
              send('done', { success: false, pct: modelPct, text: `模型下载/验证失败 (exit ${code})，请查看日志` });
            }
            res.end();
          });

          modelProc.on('error', (e) => {
            clearTimeout(modelTimer);
            send('done', { success: false, pct: modelPct, text: `模型步骤异常: ${e.message.slice(0, 200)}` });
            res.end();
          });
        }
      });
    }
  });
});

// Check Agent SDK update
router.post('/init/check-sdk-update', (req, res) => {
  try {
    const current = getSDKVersion();
    const latest = execSync('npm view @anthropic-ai/claude-agent-sdk version', { encoding: 'utf8', timeout: 15000 }).trim();
    let versions = [];
    try {
      const raw = execSync('npm view @anthropic-ai/claude-agent-sdk versions --json', { encoding: 'utf8', timeout: 15000 }).trim();
      versions = JSON.parse(raw).slice(-20).reverse(); // last 20, newest first
    } catch {}
    res.json({ current, latest, versions, hasUpdate: current && latest && current !== latest && current !== '?' });
  } catch (err) {
    logInit('Error checking SDK update', err);
    res.status(500).json({ error: err.message });
  }
});

// Upgrade / Rollback Agent SDK
router.post('/init/upgrade-sdk', (req, res) => {
  const targetVersion = req.body?.version || 'latest';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { pct: 5, text: `正在切换到 SDK v${targetVersion}...` });

  const proc = spawn('npm', ['install', `@anthropic-ai/claude-agent-sdk@${targetVersion}`,
    '--prefer-online', '--registry', 'https://registry.npmmirror.com'], { cwd: PROJECT_DIR, env: process.env });

  let lastPct = 5;
  proc.stdout.on('data', (d) => {
    lastPct = Math.min(lastPct + 15, 90);
    send('progress', { pct: lastPct, text: d.toString().trim().slice(0, 80) });
  });
  proc.stderr.on('data', (d) => {
    lastPct = Math.min(lastPct + 10, 85);
    send('progress', { pct: lastPct, text: d.toString().trim().slice(0, 80) });
  });
  proc.on('close', (code) => {
    if (code === 0) {
      send('progress', { pct: 95, text: 'SDK 包已更新，正在 rebuild 原生模块...' });
      const rebuild = spawn('npm', ['rebuild', '@anthropic-ai/claude-agent-sdk',
        '--registry', 'https://registry.npmmirror.com'], { cwd: PROJECT_DIR, env: process.env });
      rebuild.stdout.on('data', (d) => {
        send('progress', { pct: 98, text: d.toString().trim().slice(0, 80) });
      });
      rebuild.stderr.on('data', (d) => {
        send('progress', { pct: 98, text: d.toString().trim().slice(0, 80) });
      });
      rebuild.on('close', (rc) => {
        const newVer = getSDKVersion();
        send('done', { success: rc === 0, pct: 100, text: rc === 0 ? `SDK 升级完成 v${newVer}` : `rebuild 失败 (exit ${rc})` });
        res.end();
      });
      rebuild.on('error', (e) => {
        send('done', { success: false, pct: 95, text: `rebuild 异常: ${e.message}` });
        res.end();
      });
    } else {
      send('done', { success: false, pct: lastPct, text: `安装失败 (exit ${code})` });
      res.end();
    }
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
    if (modelsCache && (Date.now() - modelsCacheTime) < MODELS_CACHE_TTL) {
      return res.json(modelsCache);
    }

    const cfg = readProviderConfig();
    const models = [];
    const groups = {};
    const seen = new Set();

    // Collect selected models from all providers
    if (cfg.providerModels) {
      for (const [id, val] of Object.entries(cfg.providerModels)) {
        const list = val?.selected || val?.available || (Array.isArray(val) ? val : []);
        const provider = (cfg.providers || []).find(p => p.id === id);
        const pName = provider?.name || id.slice(0, 8);
        const pModels = [];
        for (const m of list) {
          if (!seen.has(m)) { seen.add(m); models.push(m); }
          pModels.push(m);
        }
        if (pModels.length > 0) groups[id] = { name: pName, models: pModels };
      }
    }

    // Fallback: if no selected models, return all available
    if (models.length === 0 && cfg.providerModels) {
      for (const [id, val] of Object.entries(cfg.providerModels)) {
        const list = val?.available || (Array.isArray(val) ? val : []);
        for (const m of list) {
          if (!seen.has(m)) { seen.add(m); models.push(m); }
        }
      }
    }

    // Legacy: single provider fallback
    if (models.length === 0 && cfg.baseUrl && cfg.apiKey) {
      try {
        const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/v1/models`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'x-api-key': cfg.apiKey },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const data = await resp.json();
          (data.data || []).forEach(m => { if (!seen.has(m.id)) { seen.add(m.id); models.push(m.id); } });
        }
      } catch {}
    }

    const current = cfg.model || models[0] || '';
    modelsCache = { models, groups, current };
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

// ── General settings (stored in init-config.json) ──

router.get('/init/settings', (_req, res) => {
  const config = readConfig();
  res.json({
    aiArtifactJudge: config.aiArtifactJudge !== undefined ? config.aiArtifactJudge : true,
  });
});

router.post('/init/settings', (req, res) => {
  const config = readConfig();
  const { aiArtifactJudge } = req.body || {};
  if (aiArtifactJudge !== undefined) {
    config.aiArtifactJudge = !!aiArtifactJudge;
  }
  writeConfig(config);
  res.json({ ok: true });
});

module.exports = router;
