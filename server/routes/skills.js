const { Router } = require('express');
const {
  listSkills, getSkill, createSkill,
  updateSkill, deleteSkill, getUserSkillsDir,
} = require('../skills/store');
const { parseSkillFile, parseSkillContent } = require('../skills/parser');
const { getSaveDir } = require('../skills/store');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

/**
 * GET /api/skills
 * List all available skills for the current user.
 * Query params: ?projectDir=<path> (optional, for project skills)
 */
router.get('/skills', (req, res) => {
  try {
    const projectDir = req.query.projectDir || null;
    const skills = listSkills(req.user, projectDir);
    // Remove body from list response (too large)
    const list = skills.map(s => ({
      name: s.name,
      displayName: s.displayName || s.name,
      description: s.description || '',
      icon: s.icon || '🔧',
      category: s.category || '其他',
      version: s.version || '1.0.0',
      author: s.author || '',
      source: s.source,
      editable: s.editable,
      allowedTools: s.allowedTools || [],
      deniedTools: s.deniedTools || [],
      model: s.model || null,
      permissionMode: s.permissionMode || null,
    }));
    res.json({ skills: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/skills/:name
 * Get a single skill with full body content.
 */
router.get('/skills/:name', (req, res) => {
  try {
    const projectDir = req.query.projectDir || null;
    const skill = getSkill(req.params.name, req.user, projectDir);
    if (!skill) {
      return res.status(404).json({ error: `技能 "${req.params.name}" 不存在` });
    }
    res.json({ skill });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skills/:name/export — download skill as .md file
router.get('/skills/:name/export', (req, res) => {
  try {
    const projectDir = req.query.projectDir || null;
    const skill = getSkill(req.params.name, req.user, projectDir);
    if (!skill) {
      return res.status(404).json({ error: `技能 "${req.params.name}" 不存在` });
    }
    // Reconstruct markdown: YAML frontmatter + body
    const meta = {
      name: skill.name,
      displayName: skill.displayName || skill.name,
      description: skill.description || '',
      icon: skill.icon || '🔧',
      category: skill.category || '其他',
      version: skill.version || '1.0.0',
      author: skill.author || '',
      allowedTools: skill.allowedTools || [],
      deniedTools: skill.deniedTools || [],
      model: skill.model || null,
      permissionMode: skill.permissionMode || null,
    };
    const yaml = Object.entries(meta)
      .filter(([_, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`)
      .join('\n');
    const md = `---\n${yaml}\n---\n\n${skill.body || ''}`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(skill.name)}.md"`);
    res.send(md);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/skills
 * Create a new skill.
 * Body: { name, displayName, description?, icon?, category?, model?,
 *         allowedTools?, deniedTools?, permissionMode?, version?,
 *         body, targetScope? }
 */
router.post('/skills', (req, res) => {
  try {
    const {
      name, displayName, description, icon, category,
      model, allowedTools, deniedTools, permissionMode,
      version, body, targetScope,
    } = req.body || {};

    if (!name || !displayName || !body) {
      return res.status(400).json({ error: 'name、displayName 和 body 为必填项' });
    }

    const meta = {
      name, displayName,
      description: description || '',
      icon: icon || '🔧',
      category: category || '其他',
      model: model || null,
      allowedTools: allowedTools || [],
      deniedTools: deniedTools || [],
      permissionMode: permissionMode || 'acceptEdits',
      version: version || '1.0.0',
      author: req.user?.username || 'unknown',
    };

    const result = createSkill(meta, body, req.user, targetScope);
    if (!result.ok) {
      return res.status(400).json({ error: result.errors.join('; ') });
    }
    res.json({ ok: true, name: meta.name, filePath: result.filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/skills/:name
 * Update an existing skill.
 */
router.put('/skills/:name', (req, res) => {
  try {
    const projectDir = req.query.projectDir || null;
    const {
      displayName, description, icon, category,
      model, allowedTools, deniedTools, permissionMode,
      version, body,
    } = req.body || {};

    const skill = getSkill(req.params.name, req.user, projectDir);
    if (!skill) {
      return res.status(404).json({ error: `技能 "${req.params.name}" 不存在` });
    }
    if (!skill.editable) {
      return res.status(403).json({ error: '不能修改内置技能' });
    }

    // Merge new values with existing meta
    const meta = {
      name: req.params.name,
      displayName: displayName || skill.displayName,
      description: description !== undefined ? description : skill.description,
      icon: icon || skill.icon,
      category: category || skill.category,
      model: model !== undefined ? model : skill.model,
      allowedTools: allowedTools !== undefined ? allowedTools : skill.allowedTools,
      deniedTools: deniedTools !== undefined ? deniedTools : skill.deniedTools,
      permissionMode: permissionMode || skill.permissionMode,
      version: version || skill.version,
      author: skill.author,
    };

    const result = updateSkill(req.params.name, meta, body || skill.body, req.user, projectDir);
    if (!result.ok) {
      return res.status(400).json({ error: result.errors.join('; ') });
    }
    res.json({ ok: true, name: req.params.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/skills/:name
 * Delete a skill.
 */
router.delete('/skills/:name', (req, res) => {
  try {
    const projectDir = req.query.projectDir || null;
    const result = deleteSkill(req.params.name, req.user, projectDir);
    if (!result.ok) {
      return res.status(400).json({ error: result.errors.join('; ') });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parse .md file content — extract YAML frontmatter + body
router.post('/skills/parse-md', (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }
    const result = parseSkillContent(content);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import skill from uploaded file (.md / .zip / .tar.gz)
router.post('/skills/import-file', upload.single('file'), (req, res) => {
  const tmpDir = path.join(os.tmpdir(), `skill-import-${Date.now()}`);
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'no file uploaded' });

    const ext = path.extname(file.originalname).toLowerCase();
    let mdContent = '';

    if (ext === '.md') {
      mdContent = file.buffer.toString('utf8');
    } else if (ext === '.zip') {
      fs.mkdirSync(tmpDir, { recursive: true });
      const zipPath = path.join(tmpDir, file.originalname);
      fs.writeFileSync(zipPath, file.buffer);
      execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { timeout: 10000 });
      const mdFiles = findMdFiles(tmpDir);
      if (mdFiles.length === 0) return res.status(400).json({ error: '压缩包中未找到 .md 文件' });
      mdContent = fs.readFileSync(mdFiles[0], 'utf8');
    } else if (ext === '.gz' || ext === '.tgz') {
      fs.mkdirSync(tmpDir, { recursive: true });
      const tgzPath = path.join(tmpDir, file.originalname);
      fs.writeFileSync(tgzPath, file.buffer);
      execSync(`tar -xzf "${tgzPath}" -C "${tmpDir}"`, { timeout: 10000 });
      const mdFiles = findMdFiles(tmpDir);
      if (mdFiles.length === 0) return res.status(400).json({ error: '压缩包中未找到 .md 文件' });
      mdContent = fs.readFileSync(mdFiles[0], 'utf8');
    } else if (ext === '.tar') {
      fs.mkdirSync(tmpDir, { recursive: true });
      const tarPath = path.join(tmpDir, file.originalname);
      fs.writeFileSync(tarPath, file.buffer);
      execSync(`tar -xf "${tarPath}" -C "${tmpDir}"`, { timeout: 10000 });
      const mdFiles = findMdFiles(tmpDir);
      if (mdFiles.length === 0) return res.status(400).json({ error: '压缩包中未找到 .md 文件' });
      mdContent = fs.readFileSync(mdFiles[0], 'utf8');
    } else {
      return res.status(400).json({ error: `不支持的文件格式: ${ext}` });
    }

    const result = parseSkillContent(mdContent);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `导入失败: ${err.message}` });
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

function findMdFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMdFiles(full));
      } else if (entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

module.exports = router;
