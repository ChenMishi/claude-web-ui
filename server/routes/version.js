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
  const tmp = UPGRADE_STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, UPGRADE_STATUS_FILE);
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
    const gitDir = path.join(PROJECT_DIR, '.git');
    let isGitRepo = fs.existsSync(gitDir);

    // Tarball-deployed: no .git — init a bare repo to enable remote fetch
    if (!isGitRepo) {
      if (!remote) {
        return res.status(400).json({ error: '当前部署方式不支持自动检测升级，请提供 git 仓库地址' });
      }
      execSync('git init', { cwd: PROJECT_DIR, timeout: 5000 });
      execSync(`git remote add origin "${remote}"`, { cwd: PROJECT_DIR, timeout: 5000 });
      isGitRepo = true;
    }

    const currentRemote = remote || getGitRemote();
    if (currentRemote) {
      execSync(`git remote set-url origin "${currentRemote}"`, { cwd: PROJECT_DIR, timeout: 5000 });
    }

    // Fetch latest (full fetch — shallow breaks git log range detection)
    execSync('git fetch origin master --quiet', { cwd: PROJECT_DIR, timeout: 15000 });

    // Get remote version
    const newVersion = execSync('git show origin/master:VERSION', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim().replace(/\n/g, '');
    const curVer = getCurrentVersion();

    // Get remote HEAD hash for comparison
    const remoteHash = execSync('git rev-parse origin/master', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim().slice(0, 7);
    let localHash = '';
    try {
      localHash = execSync('git rev-parse HEAD', {
        cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
      }).trim().slice(0, 7);
    } catch {}

    // Detect update: version changed OR same version but new commit hash
    const hasUpdate = newVersion !== curVer || (localHash && localHash !== remoteHash);

    if (hasUpdate) {
      let commits = [];
      try {
        const logArgs = localHash
          ? `git log ${localHash}..origin/master --no-merges --format="%h||%s"`
          : `git log origin/master --no-merges --format="%h||%s" -n 20`;
        const log = execSync(logArgs, { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000 }).trim();
        commits = log ? log.split('\n').map(line => {
          const [hash, ...msg] = line.split('||');
          const message = msg.join('||');
          let category = '其他';
          if (message.startsWith('新增') || message.startsWith('功能')) category = '新增';
          else if (message.startsWith('修复') || message.startsWith('fix')) category = '修复';
          else if (message.startsWith('优化')) category = '优化';
          else if (message.startsWith('版本')) category = '版本';
          return { hash, message, category };
        }) : [{ hash: remoteHash, message: `${curVer} → ${newVersion === curVer ? `commit ${remoteHash}` : newVersion}`, category: '版本' }];
      } catch {
        commits = [{ hash: remoteHash, message: `${curVer} → ${newVersion === curVer ? `commit ${remoteHash}` : newVersion}`, category: '版本' }];
      }
      res.json({ hasUpdate: true, currentVersion: curVer, newVersion, commits });
    } else {
      res.json({ hasUpdate: false, currentVersion: curVer });
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

  // Init git repo if tarball-deployed (no .git directory)
  const gitDir = path.join(PROJECT_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    if (!remote) {
      return res.status(400).json({ error: '当前部署方式不支持自动升级，请提供 git 仓库地址' });
    }
    try {
      execSync('git init', { cwd: PROJECT_DIR, timeout: 5000 });
      execSync(`git remote add origin "${remote}"`, { cwd: PROJECT_DIR, timeout: 5000 });
    } catch (err) {
      return res.status(500).json({ error: `初始化 git 仓库失败: ${err.message}` });
    }
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

  // Run upgrade in background, write output to temp file
  const logFile = '/tmp/claude-web-ui-upgrade.log';
  const pidFile = '/tmp/claude-web-ui-upgrade.pid';

  // Truncate old log so stale [INFO] lines don't overwrite status messages
  fs.writeFileSync(logFile, '');

  // Use stdbuf -oL for line-buffered stdout so log appears in real-time
  const child = spawn('nohup', ['stdbuf', '-oL', 'bash', upgradeScript], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: process.env.PORT || '3000' },
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
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

// ── Recent version changelogs (last 3 tags) ──

router.get('/version/recent-changelogs', (req, res) => {
  try {
    try { execSync('git fetch --tags --quiet', { cwd: PROJECT_DIR, timeout: 10000 }); } catch {}

    const raw = execSync('git tag -l --sort=-creatordate', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim();

    if (!raw) return res.json({ changelogs: [] });

    const tags = raw.split('\n').filter(Boolean).slice(0, 4); // need 4 to get 3 intervals
    const changelogs = [];

    for (let i = 0; i < tags.length - 1 && changelogs.length < 3; i++) {
      const curTag = tags[i];
      const prevTag = tags[i + 1];
      try {
        const log = execSync(`git log ${prevTag}..${curTag} --no-merges --format="%h||%s"`, {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
        }).trim();

        let ver = curTag.replace(/^v/, '');
        try {
          ver = execSync(`git show "${curTag}:VERSION"`, {
            cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000
          }).trim().replace(/\n/g, '');
        } catch {}

        const commits = log ? log.split('\n').map(line => {
          const [hash, ...rest] = line.split('||');
          return { hash, message: rest.join('||') };
        }) : [];

        const date = execSync(`git log -1 --format=%ai "${curTag}"`, {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000
        }).trim().slice(0, 10);

        if (commits.length > 0) {
          changelogs.push({ tag: curTag, version: ver, date, commits });
        }
      } catch {}
    }

    res.json({ changelogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Version history (git tags) ──

router.get('/version/history', (req, res) => {
  try {
    // Ensure we have the latest tags
    try { execSync('git fetch --tags --quiet', { cwd: PROJECT_DIR, timeout: 10000 }); } catch {}

    // List tags sorted by creation date, newest first
    const raw = execSync('git tag -l --sort=-creatordate', {
      cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000
    }).trim();

    if (!raw) return res.json({ versions: [] });

    const versions = [];
    const tags = raw.split('\n').filter(Boolean);
    const currentVer = getCurrentVersion();

    for (const tag of tags.slice(0, 30)) { // max 30 entries
      try {
        const hash = execSync(`git rev-list -n 1 "${tag}"`, {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000
        }).trim().slice(0, 8);

        const date = execSync(`git log -1 --format=%ai "${tag}"`, {
          cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000
        }).trim().slice(0, 10);

        // Read VERSION from tag
        let ver = tag.replace(/^v/, '');
        try {
          const tagVer = execSync(`git show "${tag}:VERSION"`, {
            cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000
          }).trim().replace(/\n/g, '');
          if (tagVer) ver = tagVer;
        } catch {}

        versions.push({
          tag,
          version: ver,
          commit: hash,
          date,
          current: ver === currentVer || tag === `v${currentVer}`,
        });
      } catch {}
    }

    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Version rollback ──

router.post('/version/rollback', (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'tag is required' });

  const curState = readUpgradeState();
  if (curState && curState.status === 'running') {
    return res.status(409).json({ error: '升级/回滚已在执行中' });
  }

  const rollbackScript = path.join(PROJECT_DIR, 'rollback.sh');
  if (!fs.existsSync(rollbackScript)) {
    return res.status(500).json({ error: 'rollback.sh 脚本不存在' });
  }

  // Verify tag exists
  try {
    execSync(`git rev-parse "${tag}"`, { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000 });
  } catch {
    return res.status(400).json({ error: `版本 ${tag} 不存在` });
  }

  // Reset state
  const state = { status: 'running', progress: 0, message: `正在回滚到 ${tag}...` };
  writeUpgradeState(state);

  const logFile = '/tmp/claude-web-ui-upgrade.log';
  const pidFile = '/tmp/claude-web-ui-upgrade.pid';
  fs.writeFileSync(logFile, '');

  const child = spawn('nohup', ['stdbuf', '-oL', 'bash', rollbackScript, tag], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: process.env.PORT || '3000' },
    stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  res.json({ ok: true, message: `回滚到 ${tag} 已启动` });
});

module.exports = router;
