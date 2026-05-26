const { Router } = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = Router();

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(PROJECT_DIR, 'VERSION');
const UPGRADE_STATUS_FILE = '/tmp/claude-web-ui-upgrade.status.json';

// Read upgrade state from disk (survives server restart)
function readUpgradeState() {
  try {
    if (fs.existsSync(UPGRADE_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(UPGRADE_STATUS_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function writeUpgradeState(state) {
  fs.writeFileSync(UPGRADE_STATUS_FILE, JSON.stringify(state), 'utf8');
}

function getGitRemote() {
  try {
    return execSync('git remote get-url origin', { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return ''; }
}

function getCurrentCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return ''; }
}

function getCurrentVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch { return '0.0.0'; }
}

// Get version info
router.get('/version/info', (_req, res) => {
  res.json({
    remote: getGitRemote(),
    commit: getCurrentCommit(),
    version: getCurrentVersion(),
  });
});

// Check for updates
router.post('/version/check', (req, res) => {
  const { remote } = req.body || {};
  try {
    const currentRemote = remote || getGitRemote();
    if (currentRemote) {
      execSync(`git remote set-url origin "${currentRemote}"`, { cwd: PROJECT_DIR, timeout: 5000 });
    }
    // Fetch latest
    execSync('git fetch origin master --quiet', { cwd: PROJECT_DIR, timeout: 15000 });
    // Get new commits with full messages
    const log = execSync('git log HEAD..origin/master --no-merges --format="%h||%s"', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim();
    const newVersion = execSync('git show origin/master:VERSION', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim().replace(/\n/g, '');

    if (log) {
      const commits = log.split('\n').map(line => {
        const [hash, ...msg] = line.split('||');
        const message = msg.join('||');
        // Categorize: 新增/修复/优化/版本
        let category = '其他';
        if (message.startsWith('新增') || message.startsWith('功能')) category = '新增';
        else if (message.startsWith('修复') || message.startsWith('fix')) category = '修复';
        else if (message.startsWith('优化')) category = '优化';
        else if (message.startsWith('版本')) category = '版本';
        return { hash, message, category };
      });
      res.json({ hasUpdate: true, currentVersion: getCurrentVersion(), newVersion, commits });
    } else {
      res.json({ hasUpdate: false, currentVersion: getCurrentVersion() });
    }
  } catch (err) {
    res.status(500).json({ error: `检测失败: ${err.message}` });
  }
});

// Start upgrade (background)
router.post('/version/upgrade', (req, res) => {
  const { remote } = req.body || {};

  const curState = readUpgradeState();
  if (curState && curState.status === 'running') {
    // Check if the upgrade process is actually still alive
    const pidFile = '/tmp/claude-web-ui-upgrade.pid';
    let stillRunning = false;
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      try { process.kill(pid, 0); stillRunning = true; } catch {}
    } catch {}
    if (stillRunning) {
      return res.status(409).json({ error: '升级已在执行中' });
    }
    // Stale state — clear it and proceed
    writeUpgradeState({ status: 'idle', progress: 0 });
  }

  const upgradeScript = path.join(PROJECT_DIR, 'upgrade.sh');
  if (!fs.existsSync(upgradeScript)) {
    return res.status(500).json({ error: 'upgrade.sh 脚本不存在' });
  }

  // Update remote if provided
  if (remote) {
    try {
      execSync(`git remote set-url origin "${remote}"`, { cwd: PROJECT_DIR, timeout: 5000 });
    } catch (err) {
      return res.status(500).json({ error: `设置远程地址失败: ${err.message}` });
    }
  }

  // Reset state
  const state = { status: 'running', progress: 0, message: '启动升级...', newVersion: '' };
  writeUpgradeState(state);

  // Run upgrade in background via nohup, write output to temp file
  const logFile = '/tmp/claude-web-ui-upgrade.log';
  const pidFile = '/tmp/claude-web-ui-upgrade.pid';

  const child = spawn('nohup', ['stdbuf', '-oL', 'bash', upgradeScript], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: process.env.PORT || '3000' },
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  res.json({ ok: true, message: '升级已启动' });
});

// Poll upgrade status
router.get('/version/upgrade/status', (_req, res) => {
  const state = readUpgradeState();
  if (!state) return res.json({ status: 'idle', progress: 0 });
  res.json(state);
});

// Get upgrade log
router.get('/version/upgrade/log', (_req, res) => {
  const logFile = '/tmp/claude-web-ui-upgrade.log';
  try {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      res.json({ log: content });
    } else {
      res.json({ log: '' });
    }
  } catch {
    res.json({ log: '' });
  }
});

module.exports = router;
