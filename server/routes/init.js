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
  const claudeCodePath = checkClaudeCode();
  const claudeCodeVersion = claudeCodePath ? getClaudeCodeVersion() : null;
  res.json({
    sdkInstalled: fs.existsSync(SDK_BIN) && fs.statSync(SDK_BIN).size > 10000,
    sdkPath: SDK_BIN,
    sdkVersion: getSDKVersion(),
    claudeInstalled: !!claudeCodePath,
    claudePath: claudeCodePath || '未安装',
    claudeVersion: claudeCodeVersion,
    ccSwitchInstalled: !!checkCCSwitch(),
    ccSwitchPath: checkCCSwitch(),
    proxyUrl: config.proxyUrl || 'http://127.0.0.1:15721',
    proxyPort: config.proxyPort || 15721,
    claudeProxyUrl: config.claudeProxyUrl || process.env.CLAUDE_PROXY || 'http://127.0.0.1:15721',
    sdkVersion: getSDKVersion(),
    saved: !!fs.existsSync(CONFIG_FILE),
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

function checkCCSwitch() {
  try { return execSync('command -v cc-switch', { encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return null; }
}

function checkClaudeCode() {
  try { return require('child_process').execSync('command -v claude', { encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return null; }
}

function getClaudeCodeVersion() {
  try { return require('child_process').execSync('claude --version', { encoding: 'utf8', timeout: 5000 }).trim(); }
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
    // Parse apt progress like "50%" or "Progress: 50" or "50% done"
    const pctMatch = text.match(/(\d{1,3})%/);
    if (pctMatch) {
      const pct = Math.min(parseInt(pctMatch[1]), 95);
      if (pct > lastPct) lastPct = pct;
    } else if (text.includes('Unpacking') || text.includes('Preparing')) {
      lastPct = Math.min(lastPct + 5, 50);
    } else if (text.includes('Setting up') || text.includes('Processing')) {
      lastPct = Math.min(lastPct + 3, 80);
    } else {
      lastPct = Math.min(lastPct + 1, 90);
    }
    send('progress', { pct: lastPct, text: text.trim().slice(0, 80) });
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    // Re-check if component is now available
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

// Install Claude Code CLI globally
router.post('/init/install-claude', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { pct: 10, text: '正在安装 Claude Code...' });

  const proc = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code'], { env: process.env });
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

  const proc = spawn('npm', ['rebuild', '@anthropic-ai/claude-agent-sdk'], { cwd: PROJECT_DIR, env: process.env });
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

// Get CC-Switch provider config from SQLite
router.get('/init/ccswitch-config', (req, res) => {
  try {
    const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (!fs.existsSync(dbPath)) return res.json({ providers: [], pricing: [] });

    const query = (sql) => {
      const out = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, { encoding: 'utf8', timeout: 5000 }).trim();
      return out ? JSON.parse(out) : [];
    };

    const providers = query("SELECT id, name, provider_type, config_json FROM providers");
    const pricing = query("SELECT model_id, model_name, input_price, output_price, cache_read_price, cache_write_price FROM model_pricing");

    res.json({
      providers: providers.map(p => ({
        id: p.id, name: p.name, type: p.provider_type,
        config: typeof p.config_json === 'string' ? JSON.parse(p.config_json || '{}') : (p.config_json || {}),
      })),
      pricing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update CC-Switch provider config
router.post('/init/ccswitch-config', (req, res) => {
  const { providerId, config_json, pricing } = req.body || {};
  try {
    const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'CC-Switch 数据库未找到' });

    const run = (sql) => execSync(`sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 5000 });

    if (providerId && config_json) {
      const json = JSON.stringify(config_json).replace(/'/g, "''");
      run(`UPDATE providers SET config_json = '${json}' WHERE id = '${providerId}'`);
    }

    if (pricing && Array.isArray(pricing)) {
      for (const p of pricing) {
        run(`INSERT OR REPLACE INTO model_pricing (model_id, model_name, input_price, output_price, cache_read_price, cache_write_price)
          VALUES ('${p.model_id}', '${p.model_name || p.model_id}', ${p.input_price || 0}, ${p.output_price || 0}, ${p.cache_read_price || 0}, ${p.cache_write_price || 0})`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
