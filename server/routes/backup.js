const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const multer = require('multer');

const router = Router();
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const BACKUP_CONFIG_FILE = path.join(os.homedir(), '.claude-web-ui', 'backup-config.json');

// Default config
function readBackupConfig() {
  try {
    if (fs.existsSync(BACKUP_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(BACKUP_CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return { path: '', frequency: 'manual', maxBackups: 3 };
}

function writeBackupConfig(cfg) {
  const dir = path.dirname(BACKUP_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BACKUP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getBackupDir() {
  const cfg = readBackupConfig();
  return cfg.path || path.join(os.homedir(), '.claude-web-ui', 'backups');
}

// Files/dirs to include in backup (relative to homedir or PROJECT_DIR)
const BACKUP_ITEMS = [
  // Project-level configs
  { src: path.join(PROJECT_DIR, 'provider-config.json'), dest: 'provider-config.json' },
  { src: path.join(PROJECT_DIR, 'init-config.json'), dest: 'init-config.json' },
  { src: path.join(PROJECT_DIR, 'pricing-config.json'), dest: 'pricing-config.json' },
  // User data
  { src: path.join(os.homedir(), '.claude-web-ui', 'users.json'), dest: 'users.json' },
  { src: path.join(os.homedir(), '.claude-web-ui', '.jwt-secret'), dest: '.jwt-secret' },
  // Stats
  { src: path.join(os.homedir(), '.claude-web-ui', 'stats'), dest: 'stats', isDir: true },
  // Skills
  { src: path.join(PROJECT_DIR, 'skills'), dest: 'skills', isDir: true },
  { src: path.join(PROJECT_DIR, 'server', 'builtin-skills'), dest: 'builtin-skills', isDir: true },
  // Session data
  { src: path.join(os.homedir(), '.claude', 'projects'), dest: 'projects', isDir: true },
  { src: path.join(os.homedir(), '.claude', 'sessions'), dest: 'sessions', isDir: true },
];

function createBackup() {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `backup-${ts}.tar.gz`;
  const tmpDir = path.join(os.tmpdir(), `claude-backup-${ts}`);

  try {
    // Collect all files into temp directory
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    for (const item of BACKUP_ITEMS) {
      if (!fs.existsSync(item.src)) continue;
      const dst = path.join(tmpDir, item.dest);
      if (item.isDir) {
        // Copy directory recursively
        fs.cpSync(item.src, dst, { recursive: true });
      } else {
        fs.copyFileSync(item.src, dst);
      }
    }

    // Create tar.gz
    const outPath = path.join(backupDir, name);
    execSync(`tar -czf "${outPath}" -C "${tmpDir}" .`, { timeout: 60000 });

    // Cleanup tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Enforce max backups
    enforceMaxBackups(backupDir);

    return { ok: true, name, size: fs.statSync(outPath).size };
  } catch (err) {
    // Cleanup tmp on error
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function enforceMaxBackups(backupDir) {
  const cfg = readBackupConfig();
  const max = cfg.maxBackups || 3;
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
    .sort();
  while (files.length > max) {
    fs.unlinkSync(path.join(backupDir, files.shift()));
  }
}

// GET /api/backup/list
router.get('/backup/list', (_req, res) => {
  try {
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) return res.json({ backups: [] });
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
      .sort()
      .reverse()
      .map(f => ({ name: f, size: fs.statSync(path.join(backupDir, f)).size }));
    res.json({ backups: files, path: backupDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backup/create
router.post('/backup/create', (_req, res) => {
  try {
    const result = createBackup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/backup/download/:filename
router.get('/backup/download/:filename', (req, res) => {
  const backupDir = getBackupDir();
  const filePath = path.join(backupDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  res.download(filePath);
});

// DELETE /api/backup/:filename
router.delete('/backup/:filename', (req, res) => {
  try {
    const backupDir = getBackupDir();
    const filePath = path.join(backupDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/backup/restore — multipart upload
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
router.post('/backup/restore', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传备份文件' });

  const tmpDir = path.join(os.tmpdir(), `claude-restore-${Date.now()}`);
  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // Extract tar.gz
    execSync(`tar -xzf "${req.file.path}" -C "${tmpDir}"`, { timeout: 60000 });

    // Copy files to their destinations
    const restoreMap = [
      { src: 'provider-config.json', dst: path.join(PROJECT_DIR, 'provider-config.json') },
      { src: 'init-config.json', dst: path.join(PROJECT_DIR, 'init-config.json') },
      { src: 'pricing-config.json', dst: path.join(PROJECT_DIR, 'pricing-config.json') },
      { src: 'users.json', dst: path.join(os.homedir(), '.claude-web-ui', 'users.json') },
      { src: '.jwt-secret', dst: path.join(os.homedir(), '.claude-web-ui', '.jwt-secret') },
    ];

    const dirRestoreMap = [
      { src: 'stats', dst: path.join(os.homedir(), '.claude-web-ui', 'stats') },
      { src: 'skills', dst: path.join(PROJECT_DIR, 'skills') },
      { src: 'builtin-skills', dst: path.join(PROJECT_DIR, 'server', 'builtin-skills') },
      { src: 'projects', dst: path.join(os.homedir(), '.claude', 'projects') },
      { src: 'sessions', dst: path.join(os.homedir(), '.claude', 'sessions') },
    ];

    for (const { src, dst } of restoreMap) {
      const s = path.join(tmpDir, src);
      if (fs.existsSync(s)) {
        const d = path.dirname(dst);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(s, dst);
      }
    }

    for (const { src, dst } of dirRestoreMap) {
      const s = path.join(tmpDir, src);
      if (fs.existsSync(s)) {
        const d = path.dirname(dst);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(s, dst, { recursive: true });
      }
    }

    res.json({ ok: true, message: '备份已还原，请重启服务使配置生效' });
  } catch (err) {
    res.status(500).json({ error: `还原失败: ${err.message}` });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// GET /api/backup/config
router.get('/backup/config', (_req, res) => {
  res.json(readBackupConfig());
});

// POST /api/backup/config
router.post('/backup/config', (req, res) => {
  const { path: cfgPath, frequency, maxBackups } = req.body || {};
  const cfg = readBackupConfig();
  if (cfgPath !== undefined) cfg.path = cfgPath;
  if (frequency !== undefined) cfg.frequency = frequency;
  if (maxBackups !== undefined) cfg.maxBackups = maxBackups;
  writeBackupConfig(cfg);
  res.json({ ok: true });
});

// Export createBackup for auto-backup scheduler
router.createBackup = createBackup;
router.getBackupDir = getBackupDir;
router.enforceMaxBackups = enforceMaxBackups;
router.readBackupConfig = readBackupConfig;

module.exports = router;
