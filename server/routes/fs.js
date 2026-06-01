const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const multer = require('multer');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
});

// List directory contents
router.get('/fs/list', requireAuth, (req, res) => {
  try {
    const dirPath = req.query.path || '/';
    const resolved = path.resolve(dirPath);

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: '目录不存在' });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: '路径不是目录' });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = [];
    const files = [];

    for (const entry of entries) {
      // Skip hidden files by default (can override with ?all=1)
      if (!req.query.all && entry.name.startsWith('.')) continue;
      const fullPath = path.join(resolved, entry.name);
      try {
        const s = fs.statSync(fullPath);
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, path: fullPath });
        } else {
          files.push({ name: entry.name, path: fullPath, size: s.size });
        }
      } catch {
        // skip entries we can't stat
      }
    }

    // Sort: dirs first alphabetically, then files
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ path: resolved, dirs, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload file — multipart form data (FormData + multer)
router.post('/fs/upload', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      return res.status(400).json({
        error: `上传处理失败: ${err.message}`,
        code: err.code,
        debug: { contentType: req.headers['content-type'], multerCode: err.code },
      });
    }
    next();
  });
}, (req, res) => {
  try {
    const { dir } = req.body;
    const file = req.file;
    if (!dir || !file) {
      return res.status(400).json({
        error: '缺少参数: dir, file',
        debug: { hasDir: !!dir, dirVal: dir, hasFile: !!file, contentType: req.headers['content-type'] },
      });
    }
    const targetDir = path.resolve(dir);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const targetPath = path.join(targetDir, file.originalname);
    fs.writeFileSync(targetPath, file.buffer);
    res.json({ ok: true, path: targetPath, size: file.buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download file
router.get('/fs/download', requireAuth, (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: '缺少参数: path' });
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: '文件不存在' });
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      // Download directory as tar.gz
      const tmpFile = path.join(os.tmpdir(), `fs-dl-${Date.now()}.tar.gz`);
      try {
        const dirName = path.basename(resolved) || 'download';
        execSync(`tar -czf "${tmpFile}" -C "${path.dirname(resolved)}" "${dirName}"`, { timeout: 120000 });
        res.download(tmpFile, `${dirName}.tar.gz`, () => {
          try { fs.unlinkSync(tmpFile); } catch {}
        });
      } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return res.status(500).json({ error: `打包失败: ${e.message}` });
      }
      return;
    }
    res.download(resolved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Server-side copy (for "local" → server transfer on same machine)
router.post('/fs/copy', requireAuth, (req, res) => {
  try {
    const { sourcePath, destDir } = req.body;
    if (!sourcePath || !destDir) {
      return res.status(400).json({ error: '缺少参数: sourcePath, destDir' });
    }
    const src = path.resolve(sourcePath);
    const dest = path.resolve(destDir);
    if (!fs.existsSync(src)) return res.status(404).json({ error: '源文件不存在' });

    const srcStat = fs.statSync(src);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    const destPath = path.join(dest, path.basename(src));

    if (srcStat.isDirectory()) {
      // Recursive copy for directories
      fs.cpSync(src, destPath, { recursive: true });
    } else {
      fs.copyFileSync(src, destPath);
    }
    res.json({ ok: true, path: destPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
