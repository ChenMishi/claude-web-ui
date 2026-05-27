const { Router } = require('express');
const {
  listSkills, getSkill, createSkill,
  updateSkill, deleteSkill, getUserSkillsDir,
} = require('../skills/store');
const { parseSkillFile } = require('../skills/parser');
const fs = require('fs');
const path = require('path');

const router = Router();

// Default marketplace registry URL (can be configured)
const MARKETPLACE_URL = process.env.SKILLS_REGISTRY ||
  'https://raw.githubusercontent.com/anthropics/claude-web-ui-skills/main/registry.json';

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
      allowedTools: allowedTools || skill.allowedTools,
      deniedTools: deniedTools || skill.deniedTools,
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

/**
 * GET /api/skills/marketplace/list
 * Get marketplace skills from the remote registry (with local fallback).
 */
router.get('/skills/marketplace/list', async (req, res) => {
  try {
    let data = null;
    // Try fetching remote registry
    try {
      const resp = await fetch(MARKETPLACE_URL, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        data = await resp.json();
      }
    } catch {
      // Remote unavailable — use local fallback
    }

    // Local fallback registry
    if (!data || !data.skills) {
      const localRegistry = path.resolve(__dirname, '..', 'builtin-skills');
      if (fs.existsSync(localRegistry)) {
        const files = fs.readdirSync(localRegistry).filter(f => f.endsWith('.md'));
        const skills = [];
        for (const f of files) {
          const parsed = parseSkillFile(path.join(localRegistry, f));
          if (parsed && parsed.meta.name) {
            skills.push({
              name: parsed.meta.name,
              displayName: parsed.meta.displayName || parsed.meta.name,
              description: parsed.meta.description || '',
              icon: parsed.meta.icon || '🔧',
              category: parsed.meta.category || '其他',
              version: parsed.meta.version || '1.0.0',
              author: parsed.meta.author || 'Claude Web UI',
              downloads: 0,
            });
          }
        }
        data = { skills };
      } else {
        data = { skills: [] };
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/skills/marketplace/install
 * Install a skill from a URL or built-in name.
 * Body: { url?, skillName?, targetScope? }
 */
router.post('/skills/marketplace/install', async (req, res) => {
  try {
    const { url, skillName, targetScope } = req.body || {};

    const { parseSkillContent } = require('../skills/parser');
    const { getSaveDir, getSkill } = require('../skills/store');

    let content;

    if (skillName) {
      // Install from built-in skills
      const builtinPath = path.join(__dirname, '..', 'builtin-skills', `${skillName}.md`);
      if (!fs.existsSync(builtinPath)) {
        return res.status(404).json({ error: `内置技能 "${skillName}" 不存在` });
      }
      content = fs.readFileSync(builtinPath, 'utf8');
    } else if (url) {
      // Fetch remote skill file
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) {
          return res.status(400).json({ error: `下载失败: HTTP ${resp.status}` });
        }
        content = await resp.text();
      } catch (err) {
        return res.status(400).json({ error: `下载失败: ${err.message}` });
      }
    } else {
      return res.status(400).json({ error: 'url 或 skillName 为必填项' });
    }

    // Parse to validate
    const parsed = parseSkillContent(content);
    if (!parsed.meta.name) {
      return res.status(400).json({ error: '技能文件格式无效：缺少 name 字段' });
    }

    // Save to the user's skills directory
    const saveDir = getSaveDir(req.user, targetScope);
    const filePath = path.join(saveDir, `${parsed.meta.name}.md`);

    if (fs.existsSync(filePath)) {
      return res.status(409).json({ error: `技能 "${parsed.meta.name}" 已安装` });
    }

    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf8');

    res.json({
      ok: true,
      name: parsed.meta.name,
      displayName: parsed.meta.displayName || parsed.meta.name,
      filePath,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
