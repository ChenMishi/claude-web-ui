const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { requireAuth, requireRole } = require('../middleware/auth');
const { findUserById, verifyPassword } = require('../auth/users');
const { CLAUDE_PROJECTS_DIR, LOG_DIR, STATS_DIR } = require('../config');

const router = express.Router();
const HOME = os.homedir();

// Helper: get dir size via du (fast, handles large dirs)
function dirSize(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const out = execSync(`du -sk "${dirPath}"`, { encoding: 'utf-8', timeout: 10000 });
    return parseInt(out) * 1024; // KB -> bytes
  } catch {
    try {
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory()) {
        let size = 0;
        const walk = (d) => {
          for (const f of fs.readdirSync(d)) {
            const fp = path.join(d, f);
            try {
              const s = fs.statSync(fp);
              if (s.isDirectory()) walk(fp);
              else size += s.size;
            } catch {}
          }
        };
        walk(dirPath);
        return size;
      }
      return stat.size;
    } catch { return 0; }
  }
}

function safePath(p) {
  return p.replace(HOME, '~');
}

// GET /api/storage/info — returns organized storage breakdown
router.get('/storage/info', requireAuth, requireRole('admin'), (req, res) => {
  try {
    // 1. Chat records — session .jsonl files under projects (exclude subdirs)
    let chatRecordsSize = 0;
    let artifactSize = 0;
    const artifactSessions = [];

    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      for (const project of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
        const projectPath = path.join(CLAUDE_PROJECTS_DIR, project);
        try {
          if (!fs.statSync(projectPath).isDirectory()) continue;
        } catch { continue; }

        for (const session of fs.readdirSync(projectPath)) {
          const sessionPath = path.join(projectPath, session);
          try {
            const st = fs.statSync(sessionPath);
            if (st.isFile() && session.endsWith('.jsonl')) {
              chatRecordsSize += st.size;
            } else if (st.isDirectory()) {
              // tool-results/ and subagents/ are inside session UUID directories
              for (const sub of ['tool-results', 'subagents']) {
                const subPath = path.join(sessionPath, sub);
                try {
                  if (fs.statSync(subPath).isDirectory()) {
                    const sz = dirSize(subPath);
                    artifactSize += sz;
                    if (sz > 0) {
                      artifactSessions.push({
                        session: session,
                        project: project,
                        path: safePath(subPath),
                        size: sz,
                      });
                    }
                  }
                } catch {}
              }
            }
          } catch {}
        }
      }
    }

    // 2. Other cache items
    // NOTE: "sessions" (~/.claude/sessions/) is intentionally excluded
    // because it can contain active session data when project cwd == HOME.
    // Deleting it would destroy all .jsonl and .meta.json files for those sessions.
    const cacheItems = [
      { key: 'telemetry', label: '遥测事件', path: path.join(HOME, '.claude', 'telemetry') },
      { key: 'file-history', label: '文件历史', path: path.join(HOME, '.claude', 'file-history') },
      { key: 'shell-snapshots', label: 'Shell 快照', path: path.join(HOME, '.claude', 'shell-snapshots') },
      { key: 'plans', label: '计划文件', path: path.join(HOME, '.claude', 'plans') },
      { key: 'logs', label: '运行日志', path: LOG_DIR },
      { key: 'uploads', label: '上传临时文件', path: path.join(HOME, '.claude-web-ui', 'uploads') },
      { key: 'backups', label: '系统备份', path: path.join(HOME, '.claude', 'backups') },
    ];

    const cacheDetails = cacheItems.map(item => ({
      ...item,
      path: safePath(item.path),
      size: dirSize(item.path),
    })).filter(item => item.size > 0)
      .sort((a, b) => b.size - a.size);

    const otherCacheSize = cacheDetails.reduce((s, i) => s + i.size, 0);
    const total = chatRecordsSize + artifactSize + otherCacheSize;

    res.json({
      chatRecords: { size: chatRecordsSize, label: '聊天记录', protected: true },
      artifacts: { size: artifactSize, label: '产物文件', sessions: artifactSessions },
      otherCache: { size: otherCacheSize, label: '其它文件缓存', items: cacheDetails },
      total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/storage/clean — clean specified targets
router.post('/storage/clean', requireAuth, requireRole('admin'), async (req, res) => {
  const { targets, password } = req.body; // ['telemetry', 'file-history', ...]
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets is required' });
  }

  // Chat records require admin password verification
  if (targets.includes('chat-records')) {
    if (!password) {
      return res.status(400).json({ error: '清理聊天记录需要验证管理员密码' });
    }
    const user = findUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    const valid = await verifyPassword(user, password);
    if (!valid) return res.status(403).json({ error: '密码错误' });
  }

  const targetMap = {
    'telemetry': path.join(HOME, '.claude', 'telemetry'),
    'file-history': path.join(HOME, '.claude', 'file-history'),
    'shell-snapshots': path.join(HOME, '.claude', 'shell-snapshots'),
    'plans': path.join(HOME, '.claude', 'plans'),
    'logs': LOG_DIR,
    'uploads': path.join(HOME, '.claude-web-ui', 'uploads'),
    'backups': path.join(HOME, '.claude', 'backups'),
    'tool-results': 'tool-results', // special: clean all tool-results across projects
    'subagents': 'subagents',       // special: clean all subagents across projects
    'chat-records': 'chat-records', // special: clean all .jsonl files across projects
  };

  let freed = 0;
  const results = [];

  for (const target of targets) {
    const targetPath = targetMap[target];
    if (!targetPath) { results.push({ target, error: 'unknown target' }); continue; }

    try {
      if (target === 'tool-results' || target === 'subagents' || target === 'chat-records') {
        // Clean across all projects
        if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
          for (const project of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
            const projectPath = path.join(CLAUDE_PROJECTS_DIR, project);
            try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }
            for (const session of fs.readdirSync(projectPath)) {
              const sessionPath = path.join(projectPath, session);
              try {
                if (target === 'chat-records') {
                  if (fs.statSync(sessionPath).isFile() && session.endsWith('.jsonl')) {
                    const sz = fs.statSync(sessionPath).size;
                    // If it's a symlink, also delete the real file
                    try {
                      if (fs.lstatSync(sessionPath).isSymbolicLink()) {
                        const realPath = fs.realpathSync(sessionPath);
                        try { fs.unlinkSync(realPath); } catch {}
                      }
                    } catch {}
                    fs.unlinkSync(sessionPath);
                    freed += sz;
                  }
                } else if (fs.statSync(sessionPath).isDirectory()) {
                  // tool-results/ and subagents/ are inside session UUID directories
                  const subPath = path.join(sessionPath, target);
                  try {
                    if (fs.statSync(subPath).isDirectory()) {
                      const sz = dirSize(subPath);
                      fs.rmSync(subPath, { recursive: true, force: true });
                      freed += sz;
                    }
                  } catch {}
                }
              } catch {}
            }
          }
        }
      } else {
        // Clean single directory
        if (fs.existsSync(targetPath)) {
          const sz = dirSize(targetPath);
          fs.rmSync(targetPath, { recursive: true, force: true });
          // Recreate empty dir so app doesn't break
          fs.mkdirSync(targetPath, { recursive: true });
          freed += sz;
        }
      }
      results.push({ target, ok: true });
    } catch (err) {
      results.push({ target, error: err.message });
    }
  }

  res.json({ ok: true, freed, results });
});

module.exports = router;
