const { Router } = require('express');
const {
  listSkills, getSkill, createSkill,
  updateSkill, deleteSkill, getUserSkillsDir,
} = require('../skills/store');
const { parseSkillFile, parseSkillContent } = require('../skills/parser');
const { getSaveDir } = require('../skills/store');
const fs = require('fs');
const path = require('path');

const router = Router();

// Official Claude Code skills repository
const GITHUB_SKILLS_API = 'https://api.github.com/repos/anthropics/skills/contents/skills';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/anthropics/skills/main/skills';

// Chinese descriptions for official marketplace skills
const SKILL_CN = {
  'algorithmic-art': { displayName: '算法艺术', desc: '使用 p5.js 创建算法艺术作品，支持种子随机性与交互式参数探索，生成独特的生成艺术、流场和粒子系统' },
  'brand-guidelines': { displayName: '品牌规范', desc: '应用 Anthropic 官方品牌色彩、字体和设计规范，确保输出符合品牌视觉标准' },
  'canvas-design': { displayName: '画布设计', desc: '使用设计哲学在画布上创建精美的 PNG 和 PDF 视觉作品，支持海报、插画等平面设计' },
  'claude-api': { displayName: 'Claude API 开发', desc: '构建、调试和优化 Claude API / Anthropic SDK 应用，包含 prompt 缓存、thinking、工具调用等最佳实践' },
  'doc-coauthoring': { displayName: '协作文档', desc: '引导用户完成结构化文档协作流程，适用于撰写技术文档、提案、规范等场景' },
  'docx': { displayName: 'Word 文档', desc: '创建、读取、编辑和操作 Word 文档 (.docx)，支持格式设置、批注、修订跟踪等' },
  'frontend-design': { displayName: '前端设计', desc: '创建独特的生产级前端界面，具备高设计质量和视觉冲击力，支持 React/Tailwind 等技术栈' },
  'internal-comms': { displayName: '内部沟通', desc: '撰写各类企业内部沟通文档，包括周报、公告、FAQ、项目更新等标准化格式' },
  'mcp-builder': { displayName: 'MCP 构建器', desc: '创建高质量的 MCP (Model Context Protocol) 服务器，让 LLM 与外部服务和工具进行交互' },
  'pdf': { displayName: 'PDF 处理', desc: '全面的 PDF 处理工具：读取和提取文本/表格、创建新 PDF、合并/拆分文档、表单填写等' },
  'pptx': { displayName: 'PPT 演示文稿', desc: '创建和编辑 PowerPoint 演示文稿 (.pptx)，支持幻灯片布局、图表、动画和模板应用' },
  'skill-creator': { displayName: '技能创建器', desc: '创建新技能、修改和改进现有技能、评估技能性能。用于从头构建或优化 Claude Code 技能' },
  'slack-gif-creator': { displayName: 'Slack GIF 制作', desc: '创建优化用于 Slack 的动画 GIF，提供尺寸约束验证、动画优化工具和最佳实践' },
  'theme-factory': { displayName: '主题工厂', desc: '为文档、幻灯片、网页等产出物应用统一的主题样式，包含品牌色彩和排版方案' },
  'web-artifacts-builder': { displayName: 'Web Artifacts 构建器', desc: '使用 React、Tailwind CSS 等现代前端技术创建复杂的多组件 HTML artifacts，支持 claude.ai 渲染' },
  'webapp-testing': { displayName: 'Web 应用测试', desc: '使用 Playwright 与本地 Web 应用交互和测试，支持前端功能验证、截图对比和自动化测试脚本' },
  'xlsx': { displayName: 'Excel 电子表格', desc: '创建、读取和操作 Excel 电子表格 (.xlsx/.csv)，支持公式计算、数据透视表、图表和数据可视化' },
};

// In-memory marketplace cache (5 min TTL)
let marketCache = null;
let marketCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function kebabToTitle(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── HTTPS helper (workaround for Node fetch + Fastly CDN incompatibility) ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const lib = require(url.startsWith('https') ? 'https' : 'http');
    const req = lib.get(url, { headers: { 'User-Agent': 'Claude-Web-UI' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function fetchMarketplaceFromGitHub() {
  // Fetch directory listing from GitHub API
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Claude-Web-UI' };
  const dirsResp = await fetch(GITHUB_SKILLS_API, {
    signal: AbortSignal.timeout(10000),
    headers,
  });
  if (!dirsResp.ok) throw new Error(`GitHub API returned ${dirsResp.status}`);
  const dirs = await dirsResp.json();
  const skillDirs = dirs.filter(d => d.type === 'dir');

  // Fetch each SKILL.md in parallel from raw URLs
  const results = await Promise.all(skillDirs.map(async (d) => {
    try {
      const rawUrl = `${GITHUB_RAW_BASE}/${d.name}/SKILL.md`;
      const content = await httpsGet(rawUrl);
      const parsed = parseSkillContent(content);
      const cn = SKILL_CN[d.name] || null;
      return {
        name: parsed.meta.name || d.name,
        displayName: parsed.meta.displayName || kebabToTitle(d.name),
        description: parsed.meta.description || '',
        displayNameCN: cn ? cn.displayName : kebabToTitle(d.name),
        descriptionCN: cn ? cn.desc : '',
        icon: parsed.meta.icon || '📦',
        category: parsed.meta.category || '',
        version: parsed.meta.version || '1.0.0',
        author: parsed.meta.author || 'Anthropic',
        downloads: 0,
        downloadUrl: rawUrl,
      };
    } catch {
      const cn = SKILL_CN[d.name] || null;
      return {
        name: d.name,
        displayName: kebabToTitle(d.name),
        description: '',
        displayNameCN: cn ? cn.displayName : kebabToTitle(d.name),
        descriptionCN: cn ? cn.desc : '',
        icon: '📦',
        category: '',
        version: '1.0.0',
        author: 'Anthropic',
        downloads: 0,
        downloadUrl: `${GITHUB_RAW_BASE}/${d.name}/SKILL.md`,
      };
    }
  }));

  return { skills: results.filter(Boolean) };
}

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

/**
 * GET /api/skills/marketplace/list
 * Get marketplace skills from the official Claude Code skills repo (with caching).
 */
router.get('/skills/marketplace/list', async (req, res) => {
  try {
    // Return cached data if fresh
    if (marketCache && (Date.now() - marketCacheTime) < CACHE_TTL) {
      return res.json(marketCache);
    }

    let data;
    try {
      data = await fetchMarketplaceFromGitHub();
      marketCache = data;
      marketCacheTime = Date.now();
    } catch (err) {
      console.error('[skills] GitHub marketplace fetch failed:', err.message);
      // Use stale cache if available
      if (marketCache) {
        return res.json(marketCache);
      }
      throw err;
    }

    res.json(data);
  } catch {
    // Ultimate fallback: local builtin skills
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
      return res.json({ skills });
    }
    res.json({ skills: [] });
  }
});

/**
 * POST /api/skills/marketplace/install
 * Install a skill from the official GitHub repo or a URL.
 * Body: { url?, skillName?, targetScope? }
 */
router.post('/skills/marketplace/install', async (req, res) => {
  try {
    const { url, skillName, targetScope } = req.body || {};

    let content;

    if (skillName) {
      // Install from official GitHub skills repo
      try {
        content = await httpsGet(`${GITHUB_RAW_BASE}/${skillName}/SKILL.md`);
      } catch {
        // Fallback: try local builtin
        const builtinPath = path.join(__dirname, '..', 'builtin-skills', `${skillName}.md`);
        if (fs.existsSync(builtinPath)) {
          content = fs.readFileSync(builtinPath, 'utf8');
        } else {
          return res.status(404).json({ error: `技能 "${skillName}" 未在官方仓库中找到` });
        }
      }
    } else if (url) {
      // Install from a custom URL
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

module.exports = router;
