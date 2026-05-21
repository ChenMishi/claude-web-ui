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
    gtk3: checkLib('libgtk-3.so.0') || checkLib('libgdk-3.so.0'),
    webkit: checkLib('libwebkit2gtk-4.1.so.0') || checkLib('libwebkit2gtk-4.0.so.18'),
    home: os.homedir(),
  };
}

function checkLib(name) {
  try {
    execSync(`ldconfig -p | grep -q "${name}"`, { encoding: 'utf8', timeout: 2000 });
    return true;
  } catch { return false; }
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

  send('log', { text: `正在准备安装 CC-Switch v${ver}...\n` });

  // Find deb file: check project packages dir first, then home dir
  const candidates = [
    path.join(PROJECT_DIR, 'packages', `CC-Switch-v${ver}-Linux-x86_64.deb`),
    path.join(os.homedir(), `CC-Switch-v${ver}-Linux-x86_64.deb`),
  ];

  let debFile = candidates.find(f => fs.existsSync(f));

  if (!debFile) {
    // Try download from GitHub (may 404 if release doesn't exist)
    const debUrl = `https://github.com/cc-switch/cc-switch/releases/download/v${ver}/CC-Switch-v${ver}-Linux-x86_64.deb`;
    debFile = `/tmp/cc-switch-${ver}.deb`;
    send('log', { text: `本地未找到 deb 包，尝试下载...\n` });

    const proc = spawn('bash', ['-c',
      `curl -L -o "${debFile}" "${debUrl}" 2>&1 && echo "DOWNLOAD_DONE"`]);
    proc.stdout.on('data', (d) => send('log', { text: d.toString() }));
    proc.stderr.on('data', (d) => send('log', { text: d.toString() }));

    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(debFile) || fs.statSync(debFile).size < 1000) {
        send('error', { message: '下载失败：请将 CC-Switch deb 包放到项目根目录或 /root 下' });
        res.end();
        return;
      }
      installDeb(debFile, send, res);
    });
    proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
    return;
  }

  send('log', { text: `找到本地安装包: ${debFile}\n` });
  installDeb(debFile, send, res);
});

function installDeb(debFile, send, res) {
  const proc = spawn('bash', ['-c',
    `dpkg -i "${debFile}" 2>&1 && echo "INSTALL_DONE"`]);
  proc.stdout.on('data', (d) => send('log', { text: d.toString() }));
  proc.stderr.on('data', (d) => send('log', { text: d.toString() }));
  proc.on('close', (code) => {
    send('done', { success: code === 0, installed: checkCCSwitch() ? true : false });
    res.end();
  });
  proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
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
    gtk3: `apt install -y libgtk-3-0t64 2>&1 || apt install -y libgtk-3-0 2>&1`,
    webkit: `apt install -y libwebkit2gtk-4.1-0 2>&1 || apt install -y libwebkit2gtk-4.0-37 2>&1`,
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

// Check CC-Switch running status
router.get('/init/ccswitch-status', (req, res) => {
  try {
    const pid = execSync('pgrep -x cc-switch', { encoding: 'utf8', timeout: 3000 }).trim();
    res.json({ running: true, pid });
  } catch {
    res.json({ running: false, pid: null });
  }
});

// Start or restart CC-Switch
router.post('/init/ccswitch-restart', (req, res) => {
  try {
    // Kill existing
    try { execSync('pkill -x cc-switch', { timeout: 3000 }); } catch {}
    // Start in background and capture output
    const logFile = path.join(PROJECT_DIR, 'logs', 'ccswitch.log');
    const outFd = fs.openSync(logFile, 'a');
    const child = spawn('nohup', ['cc-switch'], { detached: true, stdio: ['ignore', outFd, outFd] });
    child.unref();
    setTimeout(() => {
      try {
        execSync('pgrep -x cc-switch', { timeout: 2000 });
        fs.appendFileSync(path.join(PROJECT_DIR, 'logs', 'init.log'), `${new Date().toISOString()} CC-Switch 启动成功\n`);
        res.json({ ok: true });
      } catch {
        const errLog = fs.readFileSync(logFile, 'utf8').slice(-500);
        fs.appendFileSync(path.join(PROJECT_DIR, 'logs', 'init.log'), `${new Date().toISOString()} CC-Switch 启动失败\n${errLog}\n`);
        res.json({ ok: false, error: `启动失败，查看日志: ${logFile}` });
      }
    }, 2000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const providers = query("SELECT id, name, provider_type, settings_config FROM providers");
    const pricing = query("SELECT model_id, display_name, input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing");

    res.json({
      providers: providers.map(p => ({
        id: p.id, name: p.name, type: p.provider_type,
        config: typeof p.settings_config === 'string' ? JSON.parse(p.settings_config || '{}') : (p.settings_config || {}),
      })),
      pricing: pricing.map(p => ({
        model_id: p.model_id, model_name: p.display_name,
        input_price: p.input_cost_per_million, output_price: p.output_cost_per_million,
        cache_read_price: p.cache_read_cost_per_million, cache_write_price: p.cache_creation_cost_per_million,
      })),
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
      run(`UPDATE providers SET settings_config = '${json}' WHERE id = '${providerId}'`);
    }

    if (pricing && Array.isArray(pricing)) {
      for (const p of pricing) {
        run(`INSERT OR REPLACE INTO model_pricing (model_id, display_name, input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million)
          VALUES ('${p.model_id}', '${p.model_name || p.model_id}', ${p.input_price || 0}, ${p.output_price || 0}, ${p.cache_read_price || 0}, ${p.cache_write_price || 0})`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check Claude Code update
router.post('/init/check-claude-update', (req, res) => {
  try {
    const current = getClaudeCodeVersion() || '';
    const latest = execSync('npm view @anthropic-ai/claude-code version', { encoding: 'utf8', timeout: 10000 }).trim();
    res.json({ current, latest, hasUpdate: current && latest && current !== latest });
  } catch (err) {
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

  send('progress', { pct: 10, text: '正在升级 Claude Code...' });

  const proc = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code@latest'], { env: process.env });
  let lastPct = 10;
  const onData = (d) => {
    const text = d.toString();
    if (text.includes('added') || text.includes('changed')) lastPct = 90;
    else lastPct = Math.min(lastPct + 8, 85);
    send('progress', { pct: lastPct, text: text.trim().slice(0, 80) });
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    const newVer = getClaudeCodeVersion() || '?';
    send('done', { success: code === 0, pct: 100, text: code === 0 ? `升级完成 v${newVer}` : '升级失败' });
    res.end();
  });
  proc.on('error', (e) => { send('error', { message: e.message }); res.end(); });
});

// Initialize default provider in CC-Switch DB
router.post('/init/ccswitch-init-provider', (req, res) => {
  try {
    const dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'CC-Switch 数据库未找到' });

    const defaultConfig = JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-your-api-key',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6-20260217',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6-20260217',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7-20250514',
      },
    });

    // Check if default provider already exists
    const existing = execSync(`sqlite3 -json "${dbPath}" "SELECT id FROM providers WHERE id='default'"`, { encoding: 'utf8', timeout: 3000 }).trim();
    if (existing && JSON.parse(existing).length > 0) {
      return res.json({ ok: false, message: 'Provider 已存在' });
    }

    // Use temp file to avoid shell escaping issues with JSON
    const tmpFile = '/tmp/cc-switch-init.sql';
    const escapedConfig = defaultConfig.replace(/'/g, "''");
    const sql = `INSERT INTO providers (id, app_type, name, settings_config, website_url, provider_type, is_current, sort_index, meta, cost_multiplier)
      VALUES ('default', 'claude', 'Default Provider', '${escapedConfig}', '', 'custom', 1, 0, '{}', '1.0');`;
    fs.writeFileSync(tmpFile, sql);
    execSync(`sqlite3 "${dbPath}" < "${tmpFile}"`, { encoding: 'utf8', timeout: 5000 });

    res.json({ ok: true, message: '默认 Provider 已创建，请编辑配置后重启 CC-Switch' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Get all error logs (frontend + backend + init + ccswitch)
router.get('/init/log-errors', (req, res) => {
  try {
    const readLog = (name) => {
      const p = path.join(PROJECT_DIR, 'logs', name);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-30) : [];
    };
    res.json({
      server: readLog('server-error.log'),
      frontend: readLog('frontend-error.log'),
      init: readLog('init.log'),
      ccswitch: readLog('ccswitch.log'),
    });
  } catch { res.json({ frontend: [], server: [], init: [], ccswitch: [] }); }
});

module.exports = router;
