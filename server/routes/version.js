const { Router } = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = Router();

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(PROJECT_DIR, 'VERSION');

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
    // Get new commits since current HEAD
    const log = execSync('git log HEAD..origin/master --oneline --no-merges', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim();
    const newVersion = execSync('git show origin/master:VERSION', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim().replace(/\n/g, '');

    if (log) {
      const commits = log.split('\n').map(line => {
        const [hash, ...msg] = line.split(' ');
        return { hash, message: msg.join(' ') };
      });
      res.json({ hasUpdate: true, currentVersion: getCurrentVersion(), newVersion, commits });
    } else {
      res.json({ hasUpdate: false, currentVersion: getCurrentVersion() });
    }
  } catch (err) {
    res.status(500).json({ error: `检测失败: ${err.message}` });
  }
});

// Run upgrade
router.post('/version/upgrade', (req, res) => {
  const { remote } = req.body || {};

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const upgradeScript = path.join(PROJECT_DIR, 'upgrade.sh');
  if (!fs.existsSync(upgradeScript)) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'upgrade.sh 脚本不存在' })}\n\n`);
    return res.end();
  }

  // Update remote if provided
  if (remote) {
    try {
      execSync(`git remote set-url origin "${remote}"`, { cwd: PROJECT_DIR, timeout: 5000 });
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: `设置远程地址失败: ${err.message}` })}\n\n`);
      return res.end();
    }
  }

  let keepalive = setInterval(() => {
    try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
  }, 15000);

  const proc = spawn('bash', [upgradeScript], { cwd: PROJECT_DIR, env: { ...process.env, PORT: process.env.PORT || '3000' } });

  proc.stdout.on('data', (data) => {
    if (!res.writableEnded) {
      res.write(`event: log\ndata: ${JSON.stringify({ text: data.toString() })}\n\n`);
    }
  });

  proc.stderr.on('data', (data) => {
    if (!res.writableEnded) {
      res.write(`event: log\ndata: ${JSON.stringify({ text: data.toString() })}\n\n`);
    }
  });

  proc.on('close', (code) => {
    clearInterval(keepalive);
    if (!res.writableEnded) {
      res.write(`event: done\ndata: ${JSON.stringify({ exitCode: code, success: code === 0 })}\n\n`);
      res.end();
    }
  });

  proc.on('error', (err) => {
    clearInterval(keepalive);
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      res.end();
    }
  });

  res.on('close', () => {
    clearInterval(keepalive);
    proc.kill();
  });
});

module.exports = router;
