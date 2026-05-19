const { Router } = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = Router();

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(PROJECT_DIR, 'VERSION');
const UPGRADE_STATUS_FILE = '/tmp/claude-web-ui-upgrade.status';

// Upgrade state: { status: 'running'|'done'|'error', progress: 0-100, message: '', newVersion: '' }
let upgradeState = null;

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

  if (upgradeState && upgradeState.status === 'running') {
    return res.status(409).json({ error: '升级已在执行中' });
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
  upgradeState = { status: 'running', progress: 0, message: '启动升级...', newVersion: '' };

  // Run upgrade in background via nohup, write output to temp file
  const logFile = '/tmp/claude-web-ui-upgrade.log';
  const pidFile = '/tmp/claude-web-ui-upgrade.pid';

  const child = spawn('nohup', ['bash', upgradeScript], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: process.env.PORT || '3000' },
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  // Update progress based on log file (poll in background)
  const totalSteps = 4; // git pull, npm install server, npm install client, build
  let lastCheck = 0;

  const progressInterval = setInterval(() => {
    if (!upgradeState || upgradeState.status !== 'running') {
      clearInterval(progressInterval);
      return;
    }
    try {
      const log = fs.readFileSync(logFile, 'utf8');
      // Count progress markers from upgrade.sh stages
      const steps = [
        '拉取最新代码', '服务端依赖', '前端依赖', '重新构建前端',
        '启动服务', '升级完成'
      ];
      let matched = 0;
      for (const step of steps) {
        if (log.includes(step)) matched++;
      }
      const progress = Math.min(Math.round((matched / steps.length) * 100), 95);
      upgradeState.progress = progress;
      if (matched >= 3) upgradeState.message = '构建前端...';
      if (matched >= 4) upgradeState.message = '重启服务...';
    } catch {}
  }, 500);

  // Check if process is done
  const doneInterval = setInterval(() => {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      try { process.kill(pid, 0); } catch {
        // Process exited
        clearInterval(progressInterval);
        clearInterval(doneInterval);
        const log = fs.readFileSync(logFile, 'utf8');
        const success = log.includes('升级完成') || log.includes('启动成功');
        // Get new version
        let newVersion = '?';
        try { newVersion = fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch {}

        upgradeState = {
          status: success ? 'done' : 'error',
          progress: 100,
          message: success ? '升级完成，请刷新页面' : '升级失败，查看日志',
          newVersion,
        };
        // Cleanup
        fs.unlinkSync(pidFile);
      }
    } catch {}
  }, 1000);

  res.json({ ok: true, message: '升级已启动' });
});

// Poll upgrade status
router.get('/version/upgrade/status', (_req, res) => {
  if (!upgradeState) return res.json({ status: 'idle', progress: 0 });
  res.json(upgradeState);
});

module.exports = router;
