const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');

// ── Office document text extraction (docx/xlsx/pptx are zip+XML) ──

function extractDocxText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) return null;
    const xml = docEntry.getData().toString('utf8');
    // Extract all text between <w:t> tags (skip XML namespace prefix)
    const parts = [];
    xml.replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, (_, text) => { parts.push(text); });
    return parts.join('');
  } catch { return null; }
}

function extractXlsxText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    // Shared strings table
    let sharedStrings = [];
    const ssEntry = zip.getEntry('xl/sharedStrings.xml');
    if (ssEntry) {
      const ssXml = ssEntry.getData().toString('utf8');
      ssXml.replace(/<t[^>]*>([^<]*)<\/t>/g, (_, text) => { sharedStrings.push(text); });
    }
    // Parse worksheets
    const sheetEntries = zip.getEntries().filter(e =>
      e.entryName.match(/^xl\/worksheets\/sheet\d*\.xml$/));
    const allRows = [];
    for (const sheet of sheetEntries) {
      const sheetXml = sheet.getData().toString('utf8');
      const rows = [];
      let currentRow = [];
      // Match each row element
      const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
        currentRow = [];
        const cellRegex = /<c[^>]*>[\s\S]*?<\/c>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
          let value = '';
          // t="s" means shared string index
          if (cellMatch[0].includes('t="s"')) {
            const idxMatch = cellMatch[0].match(/<v>(\d+)<\/v>/);
            if (idxMatch && sharedStrings[parseInt(idxMatch[1])]) {
              value = sharedStrings[parseInt(idxMatch[1])];
            }
          } else {
            const vMatch = cellMatch[0].match(/<v>([^<]*)<\/v>/);
            if (vMatch) value = vMatch[1];
          }
          currentRow.push(value);
        }
        if (currentRow.some(c => c !== '')) {
          rows.push(currentRow.join('\t'));
        }
      }
      if (rows.length > 0) {
        const sheetName = sheet.entryName.match(/sheets\/(sheet\d*)\.xml/)?.[1] || sheet.entryName;
        allRows.push(`[${sheetName}]\n${rows.join('\n')}`);
      }
    }
    return allRows.length > 0 ? allRows.join('\n\n') : null;
  } catch { return null; }
}

function extractPptxText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const slideEntries = zip.getEntries().filter(e =>
      e.entryName.match(/^ppt\/slides\/slide\d*\.xml$/));
    slideEntries.sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)\.xml/)?.[1] || '0');
      const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/)?.[1] || '0');
      return na - nb;
    });
    const slides = [];
    for (const entry of slideEntries) {
      const xml = entry.getData().toString('utf8');
      const parts = [];
      xml.replace(/<a:t[^>]*>([^<]*)<\/a:t>/g, (_, text) => { parts.push(text); });
      const text = parts.join('');
      if (text.trim()) {
        slides.push(`[Slide ${slides.length + 1}]\n${text.trim()}`);
      }
    }
    return slides.length > 0 ? slides.join('\n\n') : null;
  } catch { return null; }
}

function extractOfficeText(filePath, ext) {
  switch (ext.toLowerCase()) {
    case '.docx': return extractDocxText(filePath);
    case '.xlsx': return extractXlsxText(filePath);
    case '.pptx': return extractPptxText(filePath);
    default: return null;
  }
}

// ── Archive extraction ──

function walkDir(dir, maxDepth = 5, depth = 0) {
  if (depth > maxDepth) return [];
  const entries = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    // Directories first, then files
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const fp = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push({ type: 'dir', name: item.name, path: fp });
        entries.push(...walkDir(fp, maxDepth, depth + 1));
      } else {
        try {
          const s = fs.statSync(fp);
          entries.push({ type: 'file', name: item.name, path: fp, size: s.size });
        } catch { entries.push({ type: 'file', name: item.name, path: fp, size: 0 }); }
      }
    }
  } catch {}
  return entries;
}

function formatFileTree(entries, basePath) {
  const lines = [];
  for (const e of entries) {
    const indent = '  '.repeat(e.path.replace(basePath, '').split(path.sep).filter(Boolean).length - 1);
    if (e.type === 'dir') {
      lines.push(`${indent}📁 ${e.name}/`);
    } else {
      const sizeStr = e.size ? ` (${e.size < 1024 ? e.size + 'B' : e.size < 1048576 ? (e.size / 1024).toFixed(1) + 'KB' : (e.size / 1048576).toFixed(1) + 'MB'})` : '';
      lines.push(`${indent}📄 ${e.name}${sizeStr}`);
    }
  }
  return lines.join('\n');
}

function extractArchive(sourcePath, ext) {
  const extractDir = sourcePath + '_extracted';
  try {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir, { recursive: true });

    const lowerExt = ext.toLowerCase();
    if (lowerExt === '.zip') {
      const zip = new AdmZip(sourcePath);
      zip.extractAllTo(extractDir, true);
    } else if (['.tar', '.gz', '.tgz', '.tar.gz'].includes(lowerExt) ||
               (lowerExt === '.gz' && !sourcePath.endsWith('.tar.gz'))) {
      // Handle .tar.gz / .tgz / .tar / .gz
      execSync(`tar xf "${sourcePath}" -C "${extractDir}"`, { timeout: 30000 });
    } else if (lowerExt === '.7z') {
      execSync(`7z x "${sourcePath}" -o"${extractDir}" -y`, { timeout: 30000 });
    } else if (lowerExt === '.rar') {
      execSync(`unrar x -y "${sourcePath}" "${extractDir}/"`, { timeout: 30000 });
    } else {
      return null;
    }

    const entries = walkDir(extractDir);
    if (entries.length === 0) return null;

    return {
      extractDir,
      fileTree: formatFileTree(entries, extractDir),
      fileCount: entries.filter(e => e.type === 'file').length,
      dirCount: entries.filter(e => e.type === 'dir').length,
    };
  } catch (e) {
    // Clean up on failure
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}

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

// Chat attachment upload — multipart form data (500MB limit via multer)
router.post('/fs/chat-upload', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      return res.status(400).json({ error: `上传处理失败: ${err.message}`, code: err.code });
    }
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: '缺少文件' });
      }
      const targetDir = path.resolve(path.join(os.homedir(), '.claude-web-ui', 'uploads'));
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const fileName = file.originalname;
      const ext = path.extname(fileName);
      const baseName = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_\-一-鿿]/g, '_');
      const safeName = `chat_${Date.now()}_${baseName}${ext}`;
      const targetPath = path.join(targetDir, safeName);
      fs.writeFileSync(targetPath, file.buffer);

      // Determine MIME type
      const mimeTypes = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
        '.csv': 'text/csv', '.json': 'application/json', '.xml': 'text/xml',
        '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
        '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
      };
      const mimeType = mimeTypes[ext.toLowerCase()] || file.mimetype || 'application/octet-stream';

      // Extract text from Office documents (docx/xlsx/pptx are zip+XML)
      let extractedText = null;
      let extractedPath = null;
      const officeExts = ['.docx', '.xlsx', '.pptx'];
      const archiveExts = ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'];
      if (officeExts.includes(ext.toLowerCase())) {
        extractedText = extractOfficeText(targetPath, ext.toLowerCase());
      } else if (archiveExts.includes(ext.toLowerCase()) || fileName.toLowerCase().endsWith('.tar.gz')) {
        const effectiveExt = fileName.toLowerCase().endsWith('.tar.gz') ? '.tar.gz'
          : fileName.toLowerCase().endsWith('.tgz') ? '.tgz' : ext.toLowerCase();
        const result = extractArchive(targetPath, effectiveExt);
        if (result) {
          extractedText = `压缩包内容（${result.fileCount} 个文件，${result.dirCount} 个目录）：\n${result.fileTree}`;
          extractedPath = result.extractDir;
        }
      }

      res.json({
        ok: true,
        path: targetPath,
        fileName: safeName,
        originalName: fileName,
        size: file.buffer.length,
        mimeType,
        extractedText,
        extractedPath,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ── Periodic cleanup of old uploads (>24h) ──

const UPLOADS_DIR = path.join(os.homedir(), '.claude-web-ui', 'uploads');
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function cleanOldUploads() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
  let deletedCount = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith('chat_')) continue;
    const fullPath = path.join(UPLOADS_DIR, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.rmSync(fullPath, { recursive: true, force: true });
        deletedCount++;
      }
    } catch {}
  }
  if (deletedCount > 0) {
    console.log(`[uploads] 清理了 ${deletedCount} 个过期文件（>24h）`);
  }
}

// Run cleanup on startup and every hour
cleanOldUploads();
const cleanupInterval = setInterval(cleanOldUploads, 60 * 60 * 1000);

// Allow graceful shutdown of the interval
if (typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}

module.exports = router;
