const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CLAUDE_PROJECTS_DIR, getUserDataDir } = require('../config');
const { dirNameToCwd, isPathInside, parseTitleFromJsonl } = require('../utils');

const router = Router();

const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', '.cache', '.DS_Store']);

// Resolve the real project directory for a given dirName, checking user-specific path first
function resolveProjectPath(dirName, authUser) {
  const { projects: userProjects } = getUserDataDir(authUser);
  const userPath = path.join(userProjects, dirName);
  if (fs.existsSync(userPath)) return userPath;
  const globalPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
  if (fs.existsSync(globalPath)) return globalPath;
  return (authUser && authUser.role !== 'admin') ? userPath : globalPath;
}

// Scan a directory for JSONL files and build project info
function scanProjectDir(dirPath, dirName) {
  let files = [];
  try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  let cwd = null;
  const cwdFile = path.join(dirPath, '.cwd');
  if (fs.existsSync(cwdFile)) {
    try { cwd = fs.readFileSync(cwdFile, 'utf8').trim(); } catch {}
  }
  if (!cwd) {
    for (const f of files) {
      try {
        const firstLine = fs.readFileSync(path.join(dirPath, f), 'utf8').split('\n').find(l => l.includes('"cwd"'));
        if (firstLine) { const obj = JSON.parse(firstLine); if (typeof obj.cwd === 'string') { cwd = obj.cwd; break; } }
      } catch {}
    }
  }
  if (!cwd) cwd = dirNameToCwd(dirName);
  let updatedAt = 0;
  for (const f of files) {
    try { const stat = fs.statSync(path.join(dirPath, f)); if (stat.mtimeMs > updatedAt) updatedAt = stat.mtimeMs; } catch {}
  }
  if (updatedAt === 0) { try { updatedAt = fs.statSync(dirPath).mtimeMs; } catch {} }
  return { id: dirName, cwd, sessionCount: files.length, updatedAt };
}

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

// List all projects — each user sees only their own directory
router.get('/project', async (req, res) => {
  const { projects: myProjectsDir } = getUserDataDir(req.user);
  const projects = [];
  const seenCwds = new Set();

  // Scan user's own project directory
  if (fs.existsSync(myProjectsDir)) {
    const entries = fs.readdirSync(myProjectsDir, { withFileTypes: true });
    // Sort: _-prefix (new naming) before --prefix (old naming) so dedup prefers new
    entries.sort((a, b) => {
      const aNew = a.name.startsWith('_') ? 0 : a.name.startsWith('-') ? 1 : 2;
      const bNew = b.name.startsWith('_') ? 0 : b.name.startsWith('-') ? 1 : 2;
      return aNew - bNew;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(myProjectsDir, entry.name);
      const info = scanProjectDir(dirPath, entry.name);
      if (!info || seenCwds.has(info.cwd)) continue;
      seenCwds.add(info.cwd);
      projects.push(info);
    }
  }

  projects.sort((a, b) => b.updatedAt - a.updatedAt);

  // Ensure default project exists for the user
  const defaultCwd = req.user && req.user.role !== 'admin'
    ? (req.user.homeDir || `/home/${req.user.username}`)
    : os.homedir();

  if (!seenCwds.has(defaultCwd)) {
    const dirName = require('../store').getProjectDirName(defaultCwd);
    const projDir = path.join(myProjectsDir, dirName);
    if (!fs.existsSync(projDir)) {
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, '.cwd'), defaultCwd, 'utf8');
    }
    projects.unshift({ id: dirName, cwd: defaultCwd, sessionCount: 0, updatedAt: Date.now() });
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
      .filter(e => e.isDirectory())
      .filter(e => req.query.all ? true : !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }));
  } catch {}
  res.json({ path: dirPath, dirs: entries });
});

// List both files and directories

// Read file content by absolute path
router.get('/fs/read', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  if (!path.isAbsolute(filePath) || filePath.includes('..')) {
    return res.status(403).json({ error: 'Forbidden — invalid path' });
  }
  const err = restrictPath(req, filePath);
  if (err) return res.status(403).json({ error: err });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ path: filePath, content, size: stat.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Write / overwrite a file
router.post('/fs/write', (req, res) => {
  const { filePath, content } = req.body || {};
  if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content are required' });
  if (!path.isAbsolute(filePath) || filePath.includes('..')) {
    return res.status(403).json({ error: 'Forbidden — invalid path' });
  }
  const err = restrictPath(req, filePath);
  if (err) return res.status(403).json({ error: err });
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true, path: filePath, size: content.length });
  } catch (err) {
    res.status(500).json({ error: `写入文件失败: ${err.message}` });
  }
});

// Delete a file or empty directory
router.delete('/fs/delete', (req, res) => {
  const { filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'filePath is required' });
  if (!path.isAbsolute(filePath) || filePath.includes('..')) {
    return res.status(403).json({ error: 'Forbidden — invalid path' });
  }
  const err = restrictPath(req, filePath);
  if (err) return res.status(403).json({ error: err });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Path not found' });
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除失败: ${err.message}` });
  }
});

// Rename file or directory
router.post('/fs/rename', (req, res) => {
  const { filePath, newName } = req.body || {};
  if (!filePath || !newName) return res.status(400).json({ error: 'filePath and newName are required' });
  if (!path.isAbsolute(filePath) || filePath.includes('..')) {
    return res.status(403).json({ error: 'Forbidden — invalid path' });
  }
  if (newName.includes('/') || newName.includes('\\')) {
    return res.status(400).json({ error: 'newName must not contain path separators' });
  }
  const err = restrictPath(req, filePath);
  if (err) return res.status(403).json({ error: err });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Path not found' });
  const dir = path.dirname(filePath);
  const newPath = path.join(dir, newName);
  if (fs.existsSync(newPath)) return res.status(409).json({ error: '目标名称已存在' });
  try {
    fs.renameSync(filePath, newPath);
    res.json({ ok: true, newPath });
  } catch (err) {
    res.status(500).json({ error: `重命名失败: ${err.message}` });
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
  const { getProjectDirName } = require('../store');
  const dirName = getProjectDirName(cwd);
  const { projects: myProjectsDir } = getUserDataDir(req.user);
  const dirPath = path.join(myProjectsDir, dirName);
  if (!fs.existsSync(myProjectsDir)) fs.mkdirSync(myProjectsDir, { recursive: true });
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
  const dirPath = resolveProjectPath(id, req.user);
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

// Collect session info from a directory
function collectSessionsFromDir(dirPath, cwd, excludeIds) {
  if (!fs.existsSync(dirPath)) return [];
  const exclude = new Set(excludeIds || []);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && !exclude.has(f.replace('.jsonl', '')));
  return files.map(f => {
    const sessionId = f.replace('.jsonl', '');
    const filePath = path.join(dirPath, f);
    // Skip broken symlinks (session data was deleted — e.g. by storage cleaning)
    try {
      if (fs.lstatSync(filePath).isSymbolicLink() && !fs.existsSync(filePath)) return null;
    } catch { return null; }
    let title = null;
    const metaPath = path.join(dirPath, `${sessionId}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try { title = JSON.parse(fs.readFileSync(metaPath, 'utf8')).title; } catch {}
    }
    if (!title) title = parseTitleFromJsonl(filePath);
    if (!title) title = sessionId.slice(0, 8);
    let lastModified = 0;
    try { lastModified = fs.statSync(filePath).mtimeMs; } catch {}
    return { id: sessionId, title, cwd, lastModified };
  }).filter(Boolean);
}

// List sessions for a project
router.get('/project/:id/session', (req, res) => {
  const { id } = req.params;
  const dirPath = resolveProjectPath(id, req.user);
  if (!fs.existsSync(dirPath)) return res.status(404).json({ error: 'Project not found' });
  const cwd = dirNameToCwd(id);
  const sessions = collectSessionsFromDir(dirPath, cwd);

  // Also check old-naming counterpart (_ → -) for sessions SDK wrote there
  const legacyId = id.replace(/_/g, '-');
  if (legacyId !== id) {
    const legacyPath = path.join(path.dirname(dirPath), legacyId);
    const existingIds = sessions.map(s => s.id);
    sessions.push(...collectSessionsFromDir(legacyPath, cwd, existingIds));
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  res.json(sessions);
});

// File tree
router.get('/project/:id/tree', (req, res) => {
  const { id } = req.params;
  const projDir = resolveProjectPath(id, req.user);
  let cwd = null;
  const cwdFile = path.join(projDir, '.cwd');
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
