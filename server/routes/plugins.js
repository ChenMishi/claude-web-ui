const { Router } = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const router = Router();
const PLUGINS_DIR = path.join(os.homedir(), '.claude-web-ui', 'plugins');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Ensure plugins directory exists
if (!fs.existsSync(PLUGINS_DIR)) {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

// ── Built-in plugins (auto-installed at server startup) ──

// Superpowers skills that use background Agent dispatch — not compatible with Web UI SDK
const SUPERPOWERS_EXCLUDED = new Set(['dispatching-parallel-agents', 'subagent-driven-development']);

const BUILTIN_PLUGINS = [
  {
    id: 'superpowers',
    name: 'Superpowers',
    githubUrl: 'https://github.com/obra/superpowers',
  },
  {
    id: 'agency-agents-zh',
    name: 'Agency Agents 中文版',
    githubUrl: 'https://github.com/jnMetaCode/agency-agents-zh',
  },
  {
    id: 'andrej-karpathy-skills',
    name: 'Karpathy Skills',
    githubUrl: 'https://github.com/multica-ai/andrej-karpathy-skills',
  },
  {
    id: 'bug-tracker',
    name: 'Bug Tracker',
    local: true,  // local plugin bundled with app, not from GitHub
  },
];

// ── Karpathy Guidelines content (appended to project CLAUDE.md) ──
const KARPATHY_MARKER_START = '<!-- KARPATHY_GUIDELINES_START -->';
const KARPATHY_MARKER_END = '<!-- KARPATHY_GUIDELINES_END -->';
const KARPATHY_CONTENT = `## 🤖 Karpathy 编码规范（AI Agent 行为准则）

> 源自 Andrej Karpathy 对 LLM 编码常见问题的观察。由插件 andrej-karpathy-skills 管理。

### 1. 先想再写 (Think Before Coding)

**不要假设。不要隐藏困惑。明确权衡。**

- 在实现前显式陈述假设。如果不确定，直接问。
- 如果存在多种理解方式，全部列出来 — 不要偷偷选一个。
- 如果有更简单的方法，直接说出来。在需要时回绝不合理的需求。
- 如果有不清楚的地方，停止。说出困惑点。询问。

### 2. 简洁优先 (Simplicity First)

**用最少代码解决问题。不写推测性代码。**

- 不写超出需求范围的功能。
- 不为只使用一次的代码创建抽象。
- 不添加需求之外的"灵活性"或"可配置性"。
- 不处理不可能发生的错误场景。
- 如果写了 200 行代码但 50 行就能解决，重写。

**问自己：** "资深工程师会不会说这过度设计了？" 如果是，简化。

### 3. 手术式修改 (Surgical Changes)

**只动必须动的。只清理你自己弄乱的部分。**

- 不要"顺便优化"相邻代码、注释或格式。
- 不要重构没坏的东西。
- 匹配现有代码风格，即使你更喜欢另一种写法。
- 如果注意到不相关的死代码，提出来 — 但不要删。

当你的修改产生孤立代码时:
- 清理你**自己的**修改导致不再使用的导入/变量/函数。
- 不要删除修改前就存在的死代码，除非明确要求。

**检验标准:** 每一行改动都应能直接追溯到用户的需求。

### 4. 目标驱动执行 (Goal-Driven Execution)

**定义成功标准。循环直到验证通过。**

将任务转化为可验证的目标:
- "加验证" → "为无效输入写测试，让测试通过"
- "修复 Bug" → "写一个能复现 Bug 的测试，然后修到通过"
- "重构 X" → "确保重构前后测试全部通过"

多步骤任务，先写简要计划:
1. [步骤] → 验证: [检查项]
2. [步骤] → 验证: [检查项]

强成功标准让你能自主循环。弱标准 ("让它能用") 需要不断澄清。

| 原则 | 防止什么 |
|------|---------|
| 先想再写 | 默认真假设、隐藏困惑、遗漏权衡 |
| 简洁优先 | 过度工程、臃肿抽象、推测性功能 |
| 手术式修改 | 顺手重写、无关清理、意外行为变更 |
| 目标驱动执行 | 模糊完成标准、未验证的修改 |
`;

// ── Bug Tracker content (injected into project CLAUDE.md when enabled) ──
const BUG_TRACKER_MARKER_START = '<!-- BUG_TRACKER_START -->';
const BUG_TRACKER_MARKER_END = '<!-- BUG_TRACKER_END -->';
const BUG_TRACKER_CONTENT = `## 🐛 Bug 追踪器（会话级，全消息激活）

> 由插件 bug-tracker 管理。每次收到用户消息都先读取该会话的历史 Bug 记录，修复后自动归档。

### 每次回复前必须执行

用 Bash 读取当前会话的 Bug 记录文件（session UUID 可从系统提示路径提取）：
\`\`\`bash
cat ~/.claude-web-ui/bug-records/<session-uuid>.md 2>/dev/null || echo "（无历史记录）"
\`\`\`

如果不确定 session UUID，用 \`ls ~/.claude-web-ui/bug-records/\` 查看。

### 修复 Bug 后必须记录

修复完成后追加到记录文件，格式：

\`\`\`markdown
## Bug #<序号>

- **时间**：<YYYY-MM-DD HH:MM>
- **问题**：<简要描述>
- **根因**：<根本原因>
- **修复**：<方案和关键代码变更>
- **教训**：<如何防止同类问题>
- **关联文件**：<涉及的文件路径>
\`\`\`

同步更新文件顶部的汇总表格。

### 规则

1. **每轮必读** — 每个回复前先读历史 Bug 记录（静默，不告诉用户）
2. **每 Bug 必录** — 修复即记录
3. **复用经验** — 同类 Bug 引用历史记录编号
`;

/**
 * Auto-install built-in plugins on server startup.
 * Clones if missing, pulls if already present.
 * Also ensures Karpathy guidelines are injected into project CLAUDE.md.
 * Runs in background — does not block server startup.
 */
function autoInstallBuiltinPlugins() {
  for (const plugin of BUILTIN_PLUGINS) {
    // Skip local plugins (bundled with app, no git clone needed)
    if (plugin.local) continue;
    const targetDir = path.join(PLUGINS_DIR, plugin.id);
    // Skip only if the clone was successful (has .git directory)
    if (fs.existsSync(targetDir)) {
      const dotGit = path.join(targetDir, '.git');
      if (fs.existsSync(dotGit)) continue; // healthy clone, skip
      // Directory exists but no .git → failed/corrupted clone. Retry.
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    }
    exec(`git clone --depth 1 "${plugin.githubUrl}" "${targetDir}"`, { timeout: 15000, encoding: 'utf8' }, (err) => {
      if (err) {
        console.error(`[plugins] ${plugin.name}: clone failed (will retry on next restart):`, err.message.slice(0, 80));
      } else {
        console.log(`[plugins] ${plugin.name}: auto-installed`);
      }
    });
  }

  // Karpathy CLAUDE.md injection — idempotent, runs every startup
  try {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      let content = fs.readFileSync(claudeMdPath, 'utf8');
      if (!content.includes(KARPATHY_MARKER_START)) {
        if (!content.endsWith('\n')) content += '\n';
        content += '\n' + KARPATHY_MARKER_START + '\n' + KARPATHY_CONTENT + '\n' + KARPATHY_MARKER_END + '\n';
        fs.writeFileSync(claudeMdPath, content, 'utf8');
        console.log('[plugins] Karpathy guidelines: injected into CLAUDE.md');
      }
    }
  } catch (err) {
    console.error('[plugins] Karpathy guidelines injection failed:', err.message);
  }

  // Bug Tracker CLAUDE.md injection — idempotent
  try {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      let content = fs.readFileSync(claudeMdPath, 'utf8');
      if (!content.includes(BUG_TRACKER_MARKER_START)) {
        if (!content.endsWith('\n')) content += '\n';
        content += '\n' + BUG_TRACKER_MARKER_START + '\n' + BUG_TRACKER_CONTENT + '\n' + BUG_TRACKER_MARKER_END + '\n';
        fs.writeFileSync(claudeMdPath, content, 'utf8');
        console.log('[plugins] Bug Tracker: injected into CLAUDE.md');
      }
    }
  } catch (err) {
    console.error('[plugins] Bug Tracker CLAUDE.md injection failed:', err.message);
  }

  // Superpowers auto-registration with Claude Code — idempotent
  try {
    const claudePluginsDir = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins');
    const targetPath = path.join(claudePluginsDir, 'superpowers');
    const sourcePath = path.join(PLUGINS_DIR, 'superpowers');
    if (fs.existsSync(sourcePath)) {
      // Symlink for CLI
      if (!fs.existsSync(targetPath)) {
        if (!fs.existsSync(claudePluginsDir)) {
          fs.mkdirSync(claudePluginsDir, { recursive: true });
        }
        fs.symlinkSync(sourcePath, targetPath, 'dir');
        console.log('[plugins] Superpowers: registered with Claude Code');
      }
      // Sync skill files for web UI auto-trigger
      const superpowersSkillsDir = path.join(sourcePath, 'skills');
      const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
      if (fs.existsSync(superpowersSkillsDir)) {
        if (!fs.existsSync(claudeSkillsDir)) {
          fs.mkdirSync(claudeSkillsDir, { recursive: true });
        }
        const skillDirs = fs.readdirSync(superpowersSkillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !SUPERPOWERS_EXCLUDED.has(d.name));
        let synced = 0;
        for (const d of skillDirs) {
          const srcMd = path.join(superpowersSkillsDir, d.name, 'SKILL.md');
          if (!fs.existsSync(srcMd)) continue;
          const dstMd = path.join(claudeSkillsDir, `${d.name}.md`);
          if (!fs.existsSync(dstMd)) {
            fs.copyFileSync(srcMd, dstMd);
            synced++;
          }
        }
        if (synced > 0) console.log(`[plugins] Superpowers: auto-synced ${synced} skills`);
      }
    }
  } catch (err) {
    console.error('[plugins] Superpowers auto-registration failed:', err.message);
  }

  // Deploy local plugins from project source to runtime directory
  // (Other plugins use git clone, but local plugins are bundled with the app source)
  const LOCAL_PLUGINS = ['bug-tracker'];
  for (const lpId of LOCAL_PLUGINS) {
    const src = path.join(PROJECT_ROOT, 'plugins', lpId);
    const dst = path.join(PLUGINS_DIR, lpId);
    try {
      if (fs.existsSync(src)) {
        // Copy if not present or if source changed
        const srcMd = path.join(src, 'SKILL.md');
        const dstMd = path.join(dst, 'SKILL.md');
        if (fs.existsSync(srcMd) && (!fs.existsSync(dstMd) || fs.statSync(srcMd).mtimeMs > fs.statSync(dstMd).mtimeMs)) {
          if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
          fs.copyFileSync(srcMd, dstMd);
          console.log(`[plugins] Bug Tracker: deployed from source`);
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  // Bug Tracker skill sync — always ensure skill file is in ~/.claude/skills/
  try {
    const btSource = path.join(PLUGINS_DIR, 'bug-tracker', 'SKILL.md');
    const btDest = path.join(os.homedir(), '.claude', 'skills', 'bug-tracker.md');
    if (fs.existsSync(btSource)) {
      // Only copy if not already present or source is newer
      if (!fs.existsSync(btDest) || fs.statSync(btSource).mtimeMs > fs.statSync(btDest).mtimeMs) {
        const skillsDir = path.dirname(btDest);
        if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
        fs.copyFileSync(btSource, btDest);
        console.log('[plugins] Bug Tracker: skill synced');
      }
    }
  } catch (err) {
    console.error('[plugins] Bug Tracker skill sync failed:', err.message);
  }
}

// Run auto-install (async, don't block)
setTimeout(autoInstallBuiltinPlugins, 2000);

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

/**
 * Extract owner/repo from a GitHub URL.
 * Supports: https://github.com/owner/repo, https://github.com/owner/repo.git,
 *           https://github.com/owner/repo/tree/branch, git@github.com:owner/repo.git
 */
function parseGithubUrl(url) {
  url = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const match = url.match(/github\.com[/:]([^/]+)\/([^/\s#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * POST /api/plugins/install
 * Body: { githubUrl, pluginId }
 * Clone/pull the plugin repo to PLUGINS_DIR/<pluginId>
 */
router.post('/plugins/install', (req, res) => {
  try {
    const { githubUrl, pluginId } = req.body || {};
    if (!githubUrl || !pluginId) {
      return res.status(400).json({ error: 'githubUrl 和 pluginId 为必填项' });
    }

    // Sanitize pluginId — disallow path traversal
    if (pluginId.includes('/') || pluginId.includes('..') || pluginId.includes('\\')) {
      return res.status(400).json({ error: 'pluginId 不能包含路径分隔符' });
    }

    const targetDir = path.join(PLUGINS_DIR, pluginId);

    if (fs.existsSync(targetDir)) {
      // Already exists — try git pull instead
      try {
        const result = execSync('git pull --ff-only', { cwd: targetDir, timeout: 30000, encoding: 'utf8' });
        // Check if plugin is still functional by validating install script presence
        const hasInstallScript = fs.existsSync(path.join(targetDir, 'scripts', 'install.sh'));
        const hasReadme = fs.existsSync(path.join(targetDir, 'README.md'));
        if (!hasInstallScript && !hasReadme) {
          // Corrupted — re-clone
          fs.rmSync(targetDir, { recursive: true, force: true });
          execSync(`git clone --depth 1 "${githubUrl}" "${targetDir}"`, { timeout: 60000, encoding: 'utf8' });
          return res.json({ ok: true, action: 'recloned', pluginId });
        }
        return res.json({ ok: true, action: 'pulled', output: result.trim(), pluginId });
      } catch (pullErr) {
        // Pull failed — re-clone
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
        execSync(`git clone --depth 1 "${githubUrl}" "${targetDir}"`, { timeout: 60000, encoding: 'utf8' });
        return res.json({ ok: true, action: 'recloned', pluginId });
      }
    }

    // Fresh clone
    execSync(`git clone --depth 1 "${githubUrl}" "${targetDir}"`, { timeout: 60000, encoding: 'utf8' });
    res.json({ ok: true, action: 'cloned', pluginId });
  } catch (err) {
    console.error('[plugins] install error:', err.message);
    res.status(500).json({ error: `安装失败: ${err.message}` });
  }
});

/**
 * POST /api/plugins/:id/uninstall
 * Delete the plugin directory.
 */
router.post('/plugins/:id/uninstall', (req, res) => {
  try {
    const pluginId = req.params.id;
    if (pluginId.includes('/') || pluginId.includes('..') || pluginId.includes('\\')) {
      return res.status(400).json({ error: '无效的 pluginId' });
    }

    const targetDir = path.join(PLUGINS_DIR, pluginId);
    if (!fs.existsSync(targetDir)) {
      return res.json({ ok: true, action: 'noop', message: '插件目录不存在' });
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ ok: true, action: 'removed', pluginId });
  } catch (err) {
    console.error('[plugins] uninstall error:', err.message);
    res.status(500).json({ error: `卸载失败: ${err.message}` });
  }
});

/**
 * POST /api/plugins/info
 * Body: { githubUrl }
 * Fetch GitHub repo metadata (description, stars, topics, README excerpt).
 */
router.post('/plugins/info', async (req, res) => {
  try {
    const { githubUrl } = req.body || {};
    if (!githubUrl) {
      return res.status(400).json({ error: 'githubUrl 为必填项' });
    }

    const parsed = parseGithubUrl(githubUrl);
    if (!parsed) {
      return res.status(400).json({ error: '无效的 GitHub URL' });
    }

    // Fetch repo metadata
    let repoInfo = null;
    try {
      const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
      const resp = await fetch(apiUrl, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Claude-Web-UI' },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        repoInfo = {
          name: data.name,
          fullName: data.full_name,
          description: data.description || '',
          stars: data.stargazers_count || 0,
          topics: data.topics || [],
          language: data.language || '',
          license: data.license?.spdx_id || '',
          htmlUrl: data.html_url,
          defaultBranch: data.default_branch || 'main',
        };
      }
    } catch (err) {
      console.error('[plugins] GitHub API fetch failed:', err.message);
    }

    // Try to fetch README excerpt
    let readmeExcerpt = '';
    if (repoInfo) {
      try {
        const readmeUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${repoInfo.defaultBranch}/README.md`;
        const content = await httpsGet(readmeUrl);
        // Extract first paragraph after title
        const lines = content.split('\n');
        let inContent = false;
        const excerpt = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!inContent) {
            if (trimmed.startsWith('#') && trimmed.length > 2 && !trimmed.startsWith('##')) {
              inContent = true;
            }
            continue;
          }
          if (trimmed === '' || trimmed.startsWith('##') || trimmed.startsWith('---') || trimmed.startsWith('![') || trimmed.startsWith('```')) {
            if (excerpt.length > 0) break;
            continue;
          }
          const clean = trimmed.replace(/^[>\s*-]+/, '').trim();
          if (clean) excerpt.push(clean);
          if (excerpt.length >= 3) break;
        }
        readmeExcerpt = excerpt.join(' ');
        if (readmeExcerpt.length > 300) {
          readmeExcerpt = readmeExcerpt.slice(0, 300) + '…';
        }
      } catch {}
    }

    res.json({
      ok: true,
      info: {
        ...repoInfo,
        readmeExcerpt: readmeExcerpt || repoInfo?.description || '',
      },
    });
  } catch (err) {
    console.error('[plugins] info error:', err.message);
    res.status(500).json({ error: `获取信息失败: ${err.message}` });
  }
});

/**
 * POST /api/plugins/karpathy/toggle
 * Body: { enabled }
 * Enable: append Karpathy guidelines to project's CLAUDE.md
 * Disable: remove guidelines section from project's CLAUDE.md
 * Path is derived from __dirname (server/routes → project root), NOT from client input,
 * so it works regardless of machine deployment path or session working directory.
 */
router.post('/plugins/karpathy/toggle', (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 为必填项 (boolean)' });
    }

    // Resolve CLAUDE.md relative to the server code location — always correct
    const projectRoot = path.resolve(__dirname, '..', '..');
    const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      return res.status(404).json({ error: `项目 CLAUDE.md 不存在: ${claudeMdPath}` });
    }

    let content = fs.readFileSync(claudeMdPath, 'utf8');

    if (enabled) {
      // Enable: append if not already present
      if (content.includes(KARPATHY_MARKER_START)) {
        return res.json({ ok: true, action: 'noop', message: 'Karpathy 规范已存在，无需重复添加' });
      }
      // Ensure a blank line before appending
      if (!content.endsWith('\n')) content += '\n';
      content += '\n' + KARPATHY_MARKER_START + '\n' + KARPATHY_CONTENT + '\n' + KARPATHY_MARKER_END + '\n';
      fs.writeFileSync(claudeMdPath, content, 'utf8');
      res.json({ ok: true, action: 'appended', path: claudeMdPath });
    } else {
      // Disable: remove the section between markers
      const startIdx = content.indexOf(KARPATHY_MARKER_START);
      const endIdx = content.indexOf(KARPATHY_MARKER_END);

      if (startIdx === -1) {
        return res.json({ ok: true, action: 'noop', message: 'Karpathy 规范不存在，无需移除' });
      }

      // Find end of the END marker line
      const endLineEnd = content.indexOf('\n', endIdx);
      const removeEnd = endLineEnd !== -1 ? endLineEnd + 1 : content.length;

      // Remove the section including markers, clean up surrounding blank lines
      let before = content.slice(0, startIdx);
      let after = content.slice(removeEnd);

      // Remove trailing blank lines from before
      before = before.replace(/\n{2,}$/, '\n');
      // Remove leading blank lines from after
      after = after.replace(/^\n+/, '');

      content = before + after;
      fs.writeFileSync(claudeMdPath, content, 'utf8');
      res.json({ ok: true, action: 'removed', path: claudeMdPath });
    }
  } catch (err) {
    console.error('[plugins] karpathy toggle error:', err.message);
    res.status(500).json({ error: `操作失败: ${err.message}` });
  }
});

/**
 * POST /api/plugins/superpowers/toggle
 * Body: { enabled }
 * Enable: symlink + sync skills to ~/.claude/skills/ so Claude Code SDK can auto-trigger them
 * Disable: remove symlink + remove synced skill files
 */
router.post('/plugins/superpowers/toggle', (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 为必填项 (boolean)' });
    }

    const claudePluginsDir = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'external_plugins');
    const targetPath = path.join(claudePluginsDir, 'superpowers');
    const sourcePath = path.join(PLUGINS_DIR, 'superpowers');
    const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    const superpowersSkillsDir = path.join(sourcePath, 'skills');

    // Race condition: autoInstallBuiltinPlugins uses async clone → startup hasn't finished yet.
    // If source doesn't exist but plugin is builtin, try a quick sync clone before rejecting.
    if (!fs.existsSync(sourcePath)) {
      // Check if Superpowers is a builtin plugin
      const bp = BUILTIN_PLUGINS.find(p => p.id === 'superpowers');
      if (bp) {
        try {
          execSync(`git clone --depth 1 "${bp.githubUrl}" "${sourcePath}"`, { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
          console.log('[plugins] Superpowers: cloned on-demand for toggle');
        } catch (cloneErr) {
          return res.status(404).json({ error: 'Superpowers 插件未安装，请先在插件管理页面安装' });
        }
      } else {
        return res.status(404).json({ error: 'Superpowers 插件未安装，请先在插件管理页面安装' });
      }
    }

    if (enabled) {
      const actions = [];

      // 1. Symlink for CLI usage
      if (!fs.existsSync(targetPath)) {
        if (!fs.existsSync(claudePluginsDir)) {
          fs.mkdirSync(claudePluginsDir, { recursive: true });
        }
        fs.symlinkSync(sourcePath, targetPath, 'dir');
        actions.push('registered-symlink');
      }

      // 2. Sync skill files to ~/.claude/skills/ for SDK auto-trigger
      if (fs.existsSync(superpowersSkillsDir)) {
        if (!fs.existsSync(claudeSkillsDir)) {
          fs.mkdirSync(claudeSkillsDir, { recursive: true });
        }
        const skillDirs = fs.readdirSync(superpowersSkillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !SUPERPOWERS_EXCLUDED.has(d.name));
        let synced = 0;
        for (const d of skillDirs) {
          const srcMd = path.join(superpowersSkillsDir, d.name, 'SKILL.md');
          if (!fs.existsSync(srcMd)) continue;
          const dstMd = path.join(claudeSkillsDir, `${d.name}.md`);
          fs.copyFileSync(srcMd, dstMd);
          synced++;
        }
        actions.push(`skills-synced-${synced}`);
        console.log(`[plugins] Superpowers: synced ${synced} skills to ~/.claude/skills/`);
      }

      res.json({ ok: true, action: actions.join(',') || 'noop' });
    } else {
      const actions = [];

      // 1. Remove symlink
      if (fs.existsSync(targetPath)) {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(targetPath);
        } else {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
        actions.push('unregistered-symlink');
      }

      // 2. Remove synced skill files from ~/.claude/skills/
      if (fs.existsSync(claudeSkillsDir) && fs.existsSync(superpowersSkillsDir)) {
        const skillDirs = fs.readdirSync(superpowersSkillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !SUPERPOWERS_EXCLUDED.has(d.name));
        let removed = 0;
        for (const d of skillDirs) {
          const dstMd = path.join(claudeSkillsDir, `${d.name}.md`);
          try { if (fs.existsSync(dstMd)) { fs.unlinkSync(dstMd); removed++; } } catch {}
        }
        actions.push(`skills-removed-${removed}`);
        console.log(`[plugins] Superpowers: removed ${removed} skills from ~/.claude/skills/`);
      }

      res.json({ ok: true, action: actions.join(',') || 'noop' });
    }
  } catch (err) {
    console.error('[plugins] superpowers toggle error:', err.message);
    res.status(500).json({ error: `操作失败: ${err.message}` });
  }
});

/**
 * POST /api/plugins/bug-tracker/toggle
 * Body: { enabled }
 * Enable: sync bug-tracker skill to ~/.claude/skills/
 * Disable: remove skill from ~/.claude/skills/
 */
router.post('/plugins/bug-tracker/toggle', (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 为必填项 (boolean)' });
    }

    const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    let sourceFile = path.join(PLUGINS_DIR, 'bug-tracker', 'SKILL.md');
    const destFile = path.join(claudeSkillsDir, 'bug-tracker.md');

    // Fallback: copy from project source to runtime dir on first toggle
    if (!fs.existsSync(sourceFile)) {
      const srcFallback = path.join(PROJECT_ROOT, 'plugins', 'bug-tracker', 'SKILL.md');
      if (fs.existsSync(srcFallback)) {
        const dstDir = path.dirname(sourceFile);
        if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcFallback, sourceFile);
        console.log('[plugins] Bug Tracker: deployed from source (on toggle)');
      }
    }

    if (!fs.existsSync(sourceFile)) {
      return res.status(404).json({ error: 'Bug Tracker 插件文件未找到' });
    }

    if (enabled) {
      if (!fs.existsSync(claudeSkillsDir)) {
        fs.mkdirSync(claudeSkillsDir, { recursive: true });
      }
      fs.copyFileSync(sourceFile, destFile);
      // Ensure bug-records directory exists
      const recordsDir = path.join(os.homedir(), '.claude-web-ui', 'bug-records');
      if (!fs.existsSync(recordsDir)) fs.mkdirSync(recordsDir, { recursive: true });

      // Inject into project CLAUDE.md
      const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        let md = fs.readFileSync(claudeMdPath, 'utf8');
        if (!md.includes(BUG_TRACKER_MARKER_START)) {
          if (!md.endsWith('\n')) md += '\n';
          md += '\n' + BUG_TRACKER_MARKER_START + '\n' + BUG_TRACKER_CONTENT + '\n' + BUG_TRACKER_MARKER_END + '\n';
          fs.writeFileSync(claudeMdPath, md, 'utf8');
        }
      }

      console.log('[plugins] Bug Tracker: enabled');
      res.json({ ok: true, action: 'synced' });
    } else {
      if (fs.existsSync(destFile)) {
        fs.unlinkSync(destFile);
      }
      // Remove from project CLAUDE.md
      const claudeMdPath = path.join(PROJECT_ROOT, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        let md = fs.readFileSync(claudeMdPath, 'utf8');
        if (md.includes(BUG_TRACKER_MARKER_START)) {
          const si = md.indexOf(BUG_TRACKER_MARKER_START);
          const ei = md.indexOf(BUG_TRACKER_MARKER_END, si);
          if (ei > si) {
            md = (md.slice(0, si - 1) + md.slice(ei + BUG_TRACKER_MARKER_END.length + 1)).replace(/\n{3,}/g, '\n\n');
            fs.writeFileSync(claudeMdPath, md, 'utf8');
          }
        }
      }
      console.log('[plugins] Bug Tracker: disabled');
      res.json({ ok: true, action: 'removed' });
    }
  } catch (err) {
    console.error('[plugins] bug-tracker toggle error:', err.message);
    res.status(500).json({ error: `操作失败: ${err.message}` });
  }
});

/**
 * GET /api/plugins/status
 * Check actual installation status of built-in plugins (directory exists + has .git).
 * Used by frontend to show true state when auto-install fails on slow networks.
 */
router.get('/plugins/status', (req, res) => {
  try {
    const result = {};
    for (const plugin of BUILTIN_PLUGINS) {
      const targetDir = path.join(PLUGINS_DIR, plugin.id);
      if (plugin.local) {
        result[plugin.id] = fs.existsSync(targetDir);
      } else {
        const dotGit = path.join(targetDir, '.git');
        result[plugin.id] = fs.existsSync(targetDir) && fs.existsSync(dotGit);
      }
    }
    res.json({ plugins: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/plugins/agents/list
 * Scan agency-agents-zh plugin directory and return all agent roles.
 */
router.get('/plugins/agents/list', (req, res) => {
  try {
    const agentsDir = path.join(PLUGINS_DIR, 'agency-agents-zh');
    if (!fs.existsSync(agentsDir)) {
      return res.json({ agents: [] });
    }

    const agents = [];
    const deptDirs = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
      .map(d => d.name);

    const deptNames = {
      engineering: '工程', marketing: '营销', design: '设计',
      security: '安全', product: '产品', testing: '测试',
      sales: '销售', 'paid-media': '付费媒体', hr: 'HR',
      legal: '法务', finance: '金融', strategy: '战略',
      support: '支持', academic: '学术', gis: 'GIS',
      'game-development': '游戏', 'spatial-computing': '空间计算',
      specialized: '专项', 'supply-chain': '供应链',
      'project-management': '项目管理',
      examples: '示例', integrations: '集成',
    };

    // Recursively scan for .md files — some departments have subdirectories (e.g. game-development/unity/)
    function scanDir(dept, dir, depth) {
      if (depth > 3) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
          scanDir(dept, path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
            const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (!match) continue;
            const frontmatter = match[1];
            const name = (frontmatter.match(/^name:\s*(.+)$/m) || [])[1];
            const description = (frontmatter.match(/^description:\s*(.+)$/m) || [])[1];
            const emoji = (frontmatter.match(/^emoji:\s*(.+)$/m) || [])[1];
            if (!name) continue;
            agents.push({
              id: entry.name.replace('.md', ''),
              name: name.trim(),
              description: description ? description.trim() : '',
              emoji: emoji ? emoji.trim() : '🤖',
              department: dept,
              departmentName: deptNames[dept] || dept,
            });
          } catch {}
        }
      }
    }

    for (const dept of deptDirs) {
      scanDir(dept, path.join(agentsDir, dept), 0);
    }

    res.json({ agents });
  } catch (err) {
    console.error('[plugins] agent list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
