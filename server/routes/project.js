const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CLAUDE_PROJECTS_DIR } = require('../config');
const { dirNameToCwd, isPathInside, parseTitleFromJsonl } = require('../utils');

const router = Router();

const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', '.cache', '.DS_Store']);

// Restrict path access for regular users to their home directory
function restrictPath(req, targetPath) {
  if (!req.user || req.user.role !== 'user') return null; // admin: no restriction
  const { findUserById } = require('../auth/users');
  const user = findUserById(req.user.userId);
  if (!user) return '用户不存在';
  if (!isPathInside(targetPath, user.homeDir)) {
    return `权限不足 — 只能访问 ${user.homeDir} 下的目录`;
  }
  return null; // allowed
}

// List all projects
router.get('/project', async (req, res) => {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    // No projects dir — still inject user's project if non-admin
    if (req.user && req.user.role !== 'admin') {
      const { findUserById } = require('../auth/users');
      const user = findUserById(req.user.userId);
      if (user) {
        return res.json([{ id: `user-${user.username}`, cwd: user.homeDir, sessionCount: 0, updatedAt: Date.now() }]);
      }
    }
    return res.json([]);
  }
  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  const seenCwds = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    // Prefer cwd from .cwd metadata file, then JSONL metadata, then dirNameToCwd
    let cwd = null;
    const cwdFile = path.join(dirPath, '.cwd');
    if (fs.existsSync(cwdFile)) {
      try { cwd = fs.readFileSync(cwdFile, 'utf8').trim(); } catch {}
    }
    if (!cwd) {
      for (const f of files) {
        try {
          const firstLine = fs.readFileSync(path.join(dirPath, f), 'utf8').split('\n').find(l => l.includes('"cwd"'));
          if (firstLine) {
            const obj = JSON.parse(firstLine);
            if (typeof obj.cwd === 'string') { cwd = obj.cwd; break; }
          }
        } catch {}
      }
    }
    if (!cwd) cwd = dirNameToCwd(dirName);
    // Deduplicate by cwd
    if (seenCwds.has(cwd)) continue;
    seenCwds.add(cwd);
    let updatedAt = 0;
    for (const f of files) {
      try { const stat = fs.statSync(path.join(dirPath, f)); if (stat.mtimeMs > updatedAt) updatedAt = stat.mtimeMs; } catch {}
    }
    if (updatedAt === 0) { try { updatedAt = fs.statSync(dirPath).mtimeMs; } catch {} }
    projects.push({ id: dirName, cwd, sessionCount: files.length, updatedAt });
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt);

  // For non-admin users, only show their homeDir project (filter out everything else)
  if (req.user && req.user.role !== 'admin') {
    const { findUserById } = require('../auth/users');
    const user = findUserById(req.user.userId);
    if (user) {
      const myProject = projects.find(p => p.cwd === user.homeDir);
      if (myProject) {
        projects = [myProject];
      } else {
        projects = [{ id: `user-${user.username}`, cwd: user.homeDir, sessionCount: 0, updatedAt: Date.now() }];
      }
    } else {
      projects = [];
    }
  }

  res.json(projects);
});

// Browse filesystem directories (for link dialog)
router.get('/fs/dirs', (req, res) => {
  const dirPath = req.query.path ?? os.homedir();
  // Only block traversal above root filesystem
  if (!path.isAbsolute(dirPath) || dirPath.includes('..')) {
    return res.status(403).json({ error: 'Forbidden — invalid path' });
  }
  // Apply user path restriction
  const err = restrictPath(req, dirPath);
  if (err) return res.status(403).json({ error: err });
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Path not found' });
  if (!fs.statSync(dirPath).isDirectory()) return res.status(400).json({ error: 'Not a directory' });
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }));
  } catch {}
  res.json({ path: dirPath, dirs: entries });
});

// Create a new directory (for the link dialog)
router.post('/fs/mkdir', (req, res) => {
  const { path: parentPath, name } = req.body || {};
  if (!parentPath || !name) return res.status(400).json({ error: 'path and name are required' });
  // Validate name (no slashes, no traversal)
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return res.status(400).json({ error: 'Invalid directory name' });
  }
  if (!path.isAbsolute(parentPath) || parentPath.includes('..')) {
    return res.status(403).json({ error: 'Forbidden — invalid path' });
  }
  // Apply user path restriction
  const err = restrictPath(req, parentPath);
  if (err) return res.status(403).json({ error: err });
  const newPath = path.join(parentPath, name);
  if (fs.existsSync(newPath)) return res.status(409).json({ error: 'Directory already exists' });
  try {
    fs.mkdirSync(newPath, { recursive: true });
    res.json({ ok: true, path: newPath });
  } catch (err) {
    res.status(500).json({ error: `创建目录失败: ${err.message}` });
  }
});

// Link a new project
router.post('/project/link', (req, res) => {
  const cwd = (req.body.cwd || '').trim();
  if (!cwd) return res.status(400).json({ error: 'cwd is required' });
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: 'Directory does not exist' });
  if (!fs.statSync(cwd).isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
  // Apply user path restriction
  const err = restrictPath(req, cwd);
  if (err) return res.status(403).json({ error: err });
  const dirName = cwd.replace(/[/\\]+/g, '-').replace(/-$/, '') || '-';
  const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) fs.mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true });
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, '.cwd'), cwd, 'utf8');
  res.json({ ok: true, id: dirName, cwd });
});

// Unlink a project
router.delete('/project/:id', (req, res) => {
  const { id } = req.params;
  if (!id || id.includes('..') || id.includes('/')) {
    return res.status(400).json({ error: 'Invalid project id' });
  }
  const dirPath = path.join(CLAUDE_PROJECTS_DIR, id);
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Project not found' });

  // Non-admin users can only unlink projects within their homeDir
  let cwd = null;
  const cwdFile = path.join(dirPath, '.cwd');
  if (fs.existsSync(cwdFile)) {
    try { cwd = fs.readFileSync(cwdFile, 'utf8').trim(); } catch {}
  }
  if (cwd) {
    const err = restrictPath(req, cwd);
    if (err) return res.status(403).json({ error: err });
  }

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除失败: ${err.message}` });
  }
});

// List sessions for a project
router.get('/project/:id/session', (req, res) => {
  const { id } = req.params;
  const dirPath = path.join(CLAUDE_PROJECTS_DIR, id);
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Project not found' });
  const cwd = dirNameToCwd(id);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
  const sessions = files.map(f => {
    const sessionId = f.replace('.jsonl', '');
    const filePath = path.join(dirPath, f);
    let title = null;
    // Check sidecar metadata
    const metaPath = path.join(dirPath, `${sessionId}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try { title = JSON.parse(fs.readFileSync(metaPath, 'utf8')).title; } catch {}
    }
    if (!title) title = parseTitleFromJsonl(filePath);
    if (!title) title = sessionId.slice(0, 8);
    let lastModified = 0;
    try { lastModified = fs.statSync(filePath).mtimeMs; } catch {}
    return { id: sessionId, title, cwd, lastModified };
  });
  sessions.sort((a, b) => b.lastModified - a.lastModified);
  res.json(sessions);
});

// File tree
router.get('/project/:id/tree', (req, res) => {
  const { id } = req.params;
  // Prefer .cwd metadata file, fallback to dirNameToCwd
  let cwd = null;
  const cwdFile = path.join(CLAUDE_PROJECTS_DIR, id, '.cwd');
  if (fs.existsSync(cwdFile)) {
    try { cwd = fs.readFileSync(cwdFile, 'utf8').trim(); } catch {}
  }
  if (!cwd) cwd = dirNameToCwd(id);
  if (!fs.existsSync(cwd)) return res.status(404).json({ error: `项目目录不存在: ${cwd}` });
  // Apply user path restriction
  const pathErr = restrictPath(req, cwd);
  if (pathErr) return res.status(403).json({ error: pathErr });
  const relPath = req.query.path ?? '/';
  const absPath = path.resolve(cwd, relPath.replace(/^[/\\]/, ''));
  if (!isPathInside(absPath, cwd)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Path not found' });

  function buildTree(dir, depth = 0) {
    if (depth > 8) return [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => {
        const fullPath = path.join(dir, e.name);
        const relToRoot = '/' + path.relative(cwd, fullPath).replace(/\\/g, '/');
        if (e.isDirectory()) {
          return { name: e.name, path: relToRoot, type: 'dir', children: buildTree(fullPath, depth + 1) };
        }
        let size;
        try { size = fs.statSync(fullPath).size; } catch {}
        return { name: e.name, path: relToRoot, type: 'file', size };
      });
  }
  res.json(buildTree(absPath));
});

// Read file content
router.get('/project/:id/file', (req, res) => {
  const { id } = req.params;
  const cwd = dirNameToCwd(id);
  if (!fs.existsSync(cwd)) return res.status(404).json({ error: 'Project not found' });
  // Apply user path restriction
  const pathErr = restrictPath(req, cwd);
  if (pathErr) return res.status(403).json({ error: pathErr });
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  const absPath = path.resolve(cwd, req.query.path.replace(/^[/\\]/, ''));
  if (!isPathInside(absPath, cwd)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large' });
  const content = fs.readFileSync(absPath, 'utf8');
  res.json({ path: req.query.path, content, size: stat.size });
});

// Serve raw/binary file
router.get('/project/:id/file/raw', (req, res) => {
  const { id } = req.params;
  const cwd = dirNameToCwd(id);
  if (!fs.existsSync(cwd)) return res.status(404).json({ error: 'Project not found' });
  // Apply user path restriction
  const pathErr = restrictPath(req, cwd);
  if (pathErr) return res.status(403).json({ error: pathErr });
  if (!req.query.path) return res.status(400).json({ error: 'path is required' });
  const absPath = path.resolve(cwd, req.query.path.replace(/^[/\\]/, ''));
  if (!isPathInside(absPath, cwd)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
  if (stat.size > 20 * 1024 * 1024) return res.status(413).json({ error: 'File too large' });
  const ext = path.extname(absPath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.flac': 'audio/flac', '.aac': 'audio/aac',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(absPath);
});

module.exports = router;
