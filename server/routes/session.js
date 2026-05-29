const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CLAUDE_PROJECTS_DIR, SESSIONS_DIR, getUserDataDir, PROXY_BASE } = require('../config');
const { dirNameToCwd, parseTitleFromJsonl } = require('../utils');
const { findUserById } = require('../auth/users');
const {
  getRuntimeSession, deleteRuntimeSession, getOrCreateRuntime,
  createPendingRuntime, assignSessionId, resolvePendingApproval, setPendingApproval,
  broadcast, subscribeToStream, broadcastDone,
} = require('../store');

// Agent SDK — enables full tool calling (Bash, Read, Write, Edit, etc.)
// The SDK and its platform binary are npm dependencies (see package.json)
let query;
try { query = require('@anthropic-ai/claude-agent-sdk').query; } catch { /* will fall back to no-tool mode */ }

function findSDKBinary() {
  try {
    // sdkEntry = .../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    // Go to the SDK package dir, then sibling binary package
    const sdkDir = path.dirname(sdkEntry);
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    // Binary is a sibling of the SDK package: @anthropic-ai/claude-agent-sdk-linux-x64/claude
    const candidates = [
      path.join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${arch}`, 'claude'),
      path.join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${arch}-musl`, 'claude'),
    ];
    for (const bin of candidates) {
      if (fs.existsSync(bin)) {
        console.log('[SDK] Binary found at:', bin);
        return bin;
      }
    }
    console.warn('[SDK] Binary not found, SDK will search internally. Checked:', candidates[0]);
    return null;
  } catch (err) {
    console.warn('[SDK] Error finding binary:', err.message);
    return null;
  }
}

const SDK_BINARY = findSDKBinary();

// Separate storage for AskUserQuestion context (module-level)
const askQuestionContext = new Map();

const router = Router();

function sseWrite(res, ev) {
  try {
    if (res.writableEnded) return;
    const chunk = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
    if (!res.write(chunk)) {
      // Backpressure — drain is fine, we just wait for it
      res.once('drain', () => {});
    }
  } catch {}
}

function logError(msg, err) {
  try {
    const { LOG_DIR } = require('../config');
    const fs = require('fs');
    const dir = LOG_DIR || '/tmp';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(`${dir}/server-error.log`, `${new Date().toISOString()} ${msg} ${err?.message || err}\n`);
  } catch {}
}

function handleSDKMessage(message, runtime, isStreaming) {

  if (message.type === 'system') {
    if (message.session_id && !runtime.sessionId) {
      assignSessionId(runtime, message.session_id);
    }
    return;
  }

  if (message.type === 'assistant') {
    if (isStreaming) {
      // Log usage for debugging
      if (message.message?.usage) {
        console.log('[SDK usage]', JSON.stringify(message.message.usage));
      }
      broadcast(runtime, 'message', {
        type: 'assistant',
        uuid: message.uuid || '',
        session_id: message.session_id || '',
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id || null,
      });
    }
    return;
  }

  if (message.type === 'user') {
    const hasToolResult = (message.message?.content || []).some(b => b.type === 'tool_result');
    if (hasToolResult && isStreaming) {
      broadcast(runtime, 'message', {
        type: 'user',
        uuid: message.uuid || '',
        session_id: message.session_id || '',
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id || null,
      });
    }
    return;
  }

  if (message.type === 'result') {
    if (message.subtype === 'success') {
      const usage = message.usage || {};
      return {
        cost: message.total_cost_usd,
        tokens: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0,
          cache: { read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0 },
        },
      };
    }
    return;
  }
}

// ── Security: user sandbox helpers ──

// Commands that remote tools (ssh/scp/rsync/ansible) are allowed to use on OTHER machines
const REMOTE_PREFIXES = ['ssh ', 'scp ', 'rsync ', 'ansible', 'ansible-playbook'];

// Dangerous commands blocked for regular users on the LOCAL machine
const LOCAL_DANGEROUS = [
  // Privilege escalation
  'sudo', 'su ', 'su -', 'pkexec',
  // System power control
  'reboot', 'shutdown', 'poweroff', 'halt',
  'init 0', 'init 6', 'telinit',
  'systemctl reboot', 'systemctl poweroff', 'systemctl halt', 'systemctl suspend',
  // Process termination
  'kill -9 1', 'kill -9 -1', 'killall',
  // System service control
  'systemctl stop', 'systemctl disable', 'systemctl mask',
  'service stop', 'service disable',
  // User/password management
  'passwd', 'usermod', 'userdel', 'groupdel',
  // Filesystem / Ownership
  'chown', 'chmod 777', 'chmod -R 777',
  'mount ', 'umount ', 'mkfs', 'fdisk', 'parted',
  'mkswap', 'swapon', 'swapoff',
  // Network / Firewall
  'iptables -F', 'iptables -X', 'iptables -P', 'nft flush',
  // Data destruction
  'dd if=', 'rm -rf /', 'shred',
  // Fork bomb
  ':(){ :|:& };:',
  // Kernel / Module
  'modprobe -r', 'rmmod',
];

function getUserSandbox(authUser) {
  if (!authUser || authUser.role === 'admin') return null;
  const user = findUserById(authUser.userId);
  if (!user) return null;
  return {
    username: user.username,
    homeDir: user.homeDir || `/home/${user.username}`,
    osUid: user.osUid,
    osGid: user.osGid,
  };
}

function isPathAllowed(filePath, homeDir) {
  if (!filePath || !homeDir) return false;
  const resolved = path.resolve(filePath);
  const home = path.resolve(homeDir);
  if (resolved === home || resolved.startsWith(home + path.sep)) return true;
  if (resolved.startsWith('/tmp/')) return true;
  return false;
}

function sandboxBashCommand(command, sandbox) {
  if (!sandbox) return command; // admin, no sandboxing

  const lower = (command || '').toLowerCase();

  // Check if this is a remote operation — if so, skip local dangerous checks
  const isRemote = REMOTE_PREFIXES.some(prefix => lower.startsWith(prefix));
  if (!isRemote) {
    for (const dc of LOCAL_DANGEROUS) {
      if (lower.includes(dc.toLowerCase())) {
        throw new Error(`安全限制：普通用户不能执行包含 "${dc}" 的命令`);
      }
    }
  }

  // Wrap with sudo -u to run as the user
  return `sudo -u ${sandbox.username} -i bash -c ${JSON.stringify(command)}`;
}

// ── End security helpers ──

function buildSDKOptions(runtime, body, authUser) {
  const agentOptions = body.options || {};
  const level = agentOptions.permissionLevel || 'auto';
  const sandbox = getUserSandbox(authUser);

  // ── Active skill integration ──
  const activeSkillName = agentOptions.activeSkill || null;
  let skillAllowedTools = null; // null = no restriction, [] = allow nothing, [...] = allow list
  let skillDeniedTools = [];

  if (activeSkillName) {
    try {
      const { getSkill } = require('../skills/store');
      const skill = getSkill(activeSkillName, authUser, sandbox ? sandbox.homeDir : runtime.cwd);
      if (skill) {
        // Prepend skill body to system prompt with explicit activation notice.
        // The Skill tool is NOT used for custom skills — the instructions are inline
        // and must be followed directly.
        const skillPrompt = [
          `[已激活技能: ${skill.displayName || skill.name}]`,
          `(技能注册名: ${skill.name})`,
          `此技能已在当前对话中激活，以下指令已生效。你必须直接遵守这些指令，`,
          `不要通过 Skill 工具来调用此技能，因为 Skill 工具只识别系统内置技能。`,
          ``,
          `${skill.body}`,
        ].join('\n');
        const userPrompt = agentOptions.systemPrompt || '';
        agentOptions.systemPrompt = skillPrompt + (userPrompt ? '\n\n---\n\n' + userPrompt : '');

        // Collect skill tool restrictions
        if (skill.allowedTools && skill.allowedTools.length > 0) {
          skillAllowedTools = new Set(skill.allowedTools);
        }
        if (skill.deniedTools && skill.deniedTools.length > 0) {
          skillDeniedTools = skill.deniedTools;
        }

        // Skill model preference (lower priority than explicit user choice)
        if (skill.model && agentOptions.model === undefined) {
          agentOptions.model = skill.model;
        }
      }
    } catch (err) {
      console.error('[skills] Error loading skill:', err.message);
    }
  }

  const options = {
    cwd: sandbox ? sandbox.homeDir : runtime.cwd,
    permissionMode: 'acceptEdits',
    pathToClaudeCodeExecutable: SDK_BINARY,
    ...runtime.sessionId ? { resume: runtime.sessionId } : {},
    ...agentOptions.model !== undefined ? { model: agentOptions.model } : {},
    ...agentOptions.maxTurns !== undefined ? { maxTurns: agentOptions.maxTurns } : {},
    ...agentOptions.systemPrompt !== undefined ? { systemPrompt: agentOptions.systemPrompt } : {},
    ...agentOptions.maxBudgetUsd !== undefined ? { maxBudgetUsd: agentOptions.maxBudgetUsd } : {},
    ...agentOptions.effort !== undefined ? { effort: agentOptions.effort } : {},
    // Non-admin users: strip additionalDirectories (could be used to bypass sandbox)
    ...(sandbox ? {} : (agentOptions.additionalDirectories?.length ? { additionalDirectories: agentOptions.additionalDirectories } : {})),
    ...agentOptions.env !== undefined ? { env: agentOptions.env } : {},
    // Always route SDK through CC-Switch proxy (avoid "Not logged in" error)
    env: {
      ANTHROPIC_BASE_URL: PROXY_BASE,
      ANTHROPIC_API_KEY: 'proxy',
      ...(agentOptions.env || {}),
    },
    ...agentOptions.thinking !== undefined ? { thinking: agentOptions.thinking } : {},
    stream_options: { include_usage: true },
    ...runtime.abort ? { abortController: runtime.abort } : {},
  };

  options.canUseTool = async (toolName, input) => {
    // ── Skill tool restrictions (applied first, before sandbox) ──
    // Custom skills are injected inline — block Skill tool to prevent "Unknown skill" errors
    if (activeSkillName && toolName === 'Skill') {
      return { behavior: 'deny', message: `无需使用 Skill 工具：自定义技能 "${activeSkillName}" 已激活并注入到系统提示中，请直接按技能指令执行。` };
    }
    if (skillDeniedTools.includes(toolName)) {
      return { behavior: 'deny', message: `技能限制：不允许使用 ${toolName} 工具` };
    }
    if (skillAllowedTools !== null && !skillAllowedTools.has(toolName)) {
      return { behavior: 'deny', message: `技能限制：${toolName} 不在允许列表中` };
    }

    if (toolName === 'AskUserQuestion') {
      broadcast(runtime, 'ask_user', { questions: input.questions || [] });
      // Abort after ensuring broadcast reaches client
      setTimeout(() => {
        try { runtime.abort?.abort(); } catch {}
      }, 500);
      return { behavior: 'allow', updatedInput: input };
    }

    // ── Sandbox checks for non-admin users ──
    if (sandbox) {
      try {
        // Bash: wrap command with sudo -u to run as the user
        if (toolName === 'Bash' && input.command) {
          input.command = sandboxBashCommand(input.command, sandbox);
        }
        // Write / Edit: check target path is within homeDir
        if ((toolName === 'Write' || toolName === 'Edit') && input.file_path) {
          if (!isPathAllowed(input.file_path, sandbox.homeDir)) {
            throw new Error(`安全限制：不能写入 ${input.file_path}，只能在 ${sandbox.homeDir} 目录下操作`);
          }
        }
        // Read / Glob / Grep: limit search scope for non-admin users
        if ((toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') && input.file_path) {
          const resolved = path.resolve(input.file_path || input.pattern || '');
          const basePath = resolved.split(path.sep).slice(0, 3).join(path.sep) || resolved;
          if (!isPathAllowed(basePath, sandbox.homeDir) &&
              !basePath.startsWith('/etc/') && !basePath.startsWith('/usr/') &&
              basePath !== '/etc' && basePath !== '/usr') {
            throw new Error(`安全限制：不能${toolName === 'Read' ? '读取' : '搜索'} ${input.file_path || input.pattern}`);
          }
        }
      } catch (err) {
        return { behavior: 'deny', message: err.message };
      }
    }

    // Auto mode: allow all tools
    if (level === 'auto') return { behavior: 'allow', updatedInput: input };

    // confirm-dangerous: only pause for Bash / Write / Edit
    const dangerous = new Set(['Bash', 'Write', 'Edit']);
    if (level === 'confirm-dangerous' && !dangerous.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // confirm-all or dangerous tool: ask user
    const desc = input?.description || input?.command || input?.file_path || '';
    const action = desc ? `${toolName}: ${desc}`.slice(0, 80) : toolName;
    return new Promise((resolve) => {
      setPendingApproval(runtime.sessionId || 'pending', (result) => {
        console.log('[canUseTool] user answered:', JSON.stringify(result));
        resolve(result);
      }, 'confirm', input);
      broadcast(runtime, 'ask_user', {
        questions: [{ question: `允许执行 ${action}？`, header: action, options: ['允许', '拒绝'] }],
      });
    });
  };

  return options;
}

// ── User-specific data migration ──
// After SDK executes, move session files to user's home directory
function migrateSessionToUserDir(sessionId, cwd, authUser) {
  const { projects: userProjectsDir } = getUserDataDir(authUser);
  if (userProjectsDir === CLAUDE_PROJECTS_DIR) return; // admin — no migration needed

  // Find the session JSONL in global projects dir (SDK may use different dir naming)
  const srcFile = findSessionInDir(CLAUDE_PROJECTS_DIR, sessionId);
  if (!srcFile) return;

  const { getProjectDirName } = require('../store');
  const projectDir = getProjectDirName(cwd);
  const dstDir = path.join(userProjectsDir, projectDir);
  const dstFile = path.join(dstDir, `${sessionId}.jsonl`);

  try {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(srcFile, dstFile);
    fs.writeFileSync(path.join(dstDir, '.cwd'), cwd, 'utf8');
    // Delete source file so admin's global directory doesn't see it
    try { fs.unlinkSync(srcFile); } catch {}
    // Clean up empty source directory
    const srcDir = path.dirname(srcFile);
    try {
      const remaining = fs.readdirSync(srcDir).filter(f => !f.startsWith('.'));
      if (remaining.length === 0) fs.rmdirSync(srcDir);
    } catch {}
  } catch (err) {
    console.error(`[migrate] Failed to migrate session ${sessionId}:`, err.message);
  }
}

// Scan a base directory for a specific session JSONL file
function findSessionInDir(baseDir, sessionId) {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(baseDir, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Resolve project directory for a user — check user-specific dir first, fallback to global
function resolveProjectDir(cwd, authUser) {
  const { projects: userProjectsDir } = getUserDataDir(authUser);
  const { getProjectDirName } = require('../store');
  const projectDir = getProjectDirName(cwd);
  const userPath = path.join(userProjectsDir, projectDir);
  if (fs.existsSync(userPath)) return userPath;
  const globalPath = path.join(CLAUDE_PROJECTS_DIR, projectDir);
  if (fs.existsSync(globalPath)) return globalPath;
  // Neither exists — return user path for creation
  return (authUser && authUser.role !== 'admin') ? userPath : globalPath;
}

// Shared helper — generate a short AI title using the proxy
async function generateSessionTitle(sessionId, prompt, cwd, authUser) {
  try {
    const title = await generateTitleText(prompt);
    if (title) {
      storeSessionTitle(sessionId, title, cwd, authUser);
    }
    return title || null;
  } catch (err) {
    console.error('Title generation error:', err?.message);
    return null;
  }
}

// Lightweight: just call Haiku API, return title text (no disk I/O)
async function generateTitleText(prompt) {
  const { PROXY_BASE: proxyBase } = require('../config');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const proxyRes = await fetch(`${proxyBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content: `用不超过15个汉字为以下对话生成一个简短的标题，直接返回标题文本，不要带引号、不要解释：${prompt}` }],
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
    if (!proxyRes.ok) return null;
    const data = await proxyRes.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    if (textBlock?.text) return textBlock.text.trim().slice(0, 30);
    // Fallback: try thinking block or any string content
    for (const c of (data.content || [])) {
      if (c.text) return String(c.text).trim().slice(0, 30);
      if (c.thinking) return String(c.thinking).trim().slice(0, 30);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Store title .meta.json to disk
function storeSessionTitle(sessionId, title, cwd, authUser) {
  const { projects: projectsDir } = getUserDataDir(authUser);
  const dirPath = path.join(projectsDir, require('../store').getProjectDirName(cwd || ''));
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, `${sessionId}.meta.json`), JSON.stringify({ title }), 'utf8');
}

// --- Session info ---
router.get('/session/:id', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);
  let found = null;
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`);
      if (fs.existsSync(file)) {
        let title = parseTitleFromJsonl(file) || id.slice(0, 8);
        const metaPath = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.meta.json`);
        if (fs.existsSync(metaPath)) {
          try { title = JSON.parse(fs.readFileSync(metaPath, 'utf8')).title; } catch {}
        }
        const cwd = runtime?.cwd || dirNameToCwd(entry.name);
        let lastModified = 0;
        try { lastModified = fs.statSync(file).mtimeMs; } catch {}
        found = { id, title, cwd, status: runtime?.status || 'idle', lastModified };
        break;
      }
    }
  }
  if (!found) {
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const f of fs.readdirSync(SESSIONS_DIR)) {
          if (!f.endsWith('.json')) continue;
          try {
            const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
            if (data.sessionId === id) {
              found = { id, title: data.summary || id.slice(0, 8), cwd: data.cwd || '', status: runtime?.status || 'idle', lastModified: data.startedAt || 0 };
              break;
            }
          } catch {}
        }
      }
    } catch {}
  }
  if (!found) return res.status(404).json({ error: 'Session not found' });
  res.json(found);
});

// Delete session
router.delete('/session/:id', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);
  runtime?.abort?.abort();
  deleteRuntimeSession(id);
  let deleted = false;
  // Scan both global and user-specific project directories
  const dirsToScan = [CLAUDE_PROJECTS_DIR];
  const { projects: userProjects } = getUserDataDir(req.user);
  if (userProjects !== CLAUDE_PROJECTS_DIR && fs.existsSync(userProjects)) {
    dirsToScan.push(userProjects);
  }
  for (const baseDir of dirsToScan) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(baseDir, entry.name, `${id}.jsonl`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        const metaFile = path.join(baseDir, entry.name, `${id}.meta.json`);
        if (fs.existsSync(metaFile)) fs.rmSync(metaFile, { force: true });
        deleted = true;
      }
    }
  }
  if (!deleted) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// Abort session
router.post('/session/:id/abort', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);
  if (!runtime) return res.status(404).json({ error: 'Session not found' });
  if (runtime.status !== 'busy') return res.status(409).json({ error: 'Session is not busy' });
  runtime.abort?.abort();
  res.json({ ok: true });
});

// Rename session (sidecar .meta.json)
router.patch('/session/:id', (req, res) => {
  const { id } = req.params;
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  let found = false;
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`);
      if (fs.existsSync(file)) {
        const metaPath = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.meta.json`);
        fs.writeFileSync(metaPath, JSON.stringify({ title }), 'utf8');
        found = true;
        break;
      }
    }
  }
  if (!found) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// Get session messages
router.get('/session/:id/message', (req, res) => {
  const { id } = req.params;
  const limit = 500;
  let jsonlPath = null;
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`);
      if (fs.existsSync(file)) { jsonlPath = file; break; }
    }
  }
  if (!jsonlPath) return res.json([]);

  const messages = [];
  try {
    const allLines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    // Collect all user/assistant records
    const msgRecords = [];
    for (let i = 0; i < allLines.length; i++) {
      try {
        const rec = JSON.parse(allLines[i]);
        if (rec.type === 'user' || rec.type === 'assistant') {
          msgRecords.push(rec);
        }
      } catch {}
    }
    // offset = how many of the LATEST messages to skip (reverse pagination).
    // Default 0: return the last <limit> messages.
    // offset=200: skip the last 200, return the 200 before them, etc.
    const reqOffset = req.query.offset !== undefined ? parseInt(req.query.offset) : null;
    const skip = reqOffset !== null && !isNaN(reqOffset) ? reqOffset : 0;
    const start = Math.max(0, msgRecords.length - skip - limit);
    const end = Math.max(0, msgRecords.length - skip);
    messages.push(...msgRecords.slice(start, end));
  } catch {}
  res.json(messages);
});

// Send message (SSE stream using Agent SDK with full tool calling)
router.post('/session/:id/message', async (req, res) => {
  const { id } = req.params;
  const isNew = id === 'new';
  const body = req.body || {};

  if (!query) {
    return res.status(500).json({ error: 'Agent SDK not available. Tool calling is disabled.' });
  }

  // ── Sandbox: non-admin users get their homeDir as cwd ──
  const sandbox = getUserSandbox(req.user);
  if (sandbox) {
    // Only override cwd if it's outside the user's homeDir (allow subdirectories)
    const { isPathInside } = require('../utils');
    if (!isPathInside(body.cwd || '/', sandbox.homeDir)) {
      body.cwd = sandbox.homeDir;
    }
  }

  let runtime;
  if (isNew) {
    if (!body.cwd) return res.status(400).json({ error: 'cwd is required for new sessions' });
    runtime = createPendingRuntime(body.cwd);
  } else {
    let cwd = body.cwd;
    let foundInDir = null;
    if (!cwd) {
      const existing = getRuntimeSession(id);
      cwd = existing?.cwd;
      if (!cwd && fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (fs.existsSync(path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`))) {
            // Read cwd from the JSONL metadata
            try {
              const content = fs.readFileSync(path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`), 'utf8');
              const firstLine = content.split('\n').find(l => l.includes('"cwd"'));
              if (firstLine) {
                const obj = JSON.parse(firstLine);
                if (typeof obj.cwd === 'string') cwd = obj.cwd;
              }
            } catch {}
            if (!cwd) cwd = dirNameToCwd(entry.name);
            foundInDir = entry.name;
            break;
          }
        }
      }
    }
    if (!cwd) return res.status(400).json({ error: 'cwd not found for session' });

    // Ensure session file is in the SDK's expected directory
    if (foundInDir && fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const { getProjectDirName } = require('../store');
      const expectedDir = getProjectDirName(cwd);
      if (foundInDir !== expectedDir) {
        const srcFile = path.join(CLAUDE_PROJECTS_DIR, foundInDir, `${id}.jsonl`);
        const dstDir = path.join(CLAUDE_PROJECTS_DIR, expectedDir);
        const dstFile = path.join(dstDir, `${id}.jsonl`);
        if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
        if (!fs.existsSync(dstFile)) {
          fs.copyFileSync(srcFile, dstFile);
          // Write .cwd for future lookups
          fs.writeFileSync(path.join(dstDir, '.cwd'), cwd, 'utf8');
        }
      }
    }

    runtime = getOrCreateRuntime(id, cwd);
  }

  if (runtime.status === 'busy') {
    return res.status(409).json({ error: 'Session is busy', canReconnect: true });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const wantsStream = req.headers.accept?.includes('text/event-stream') || req.query.stream === '1';

  runtime.status = 'busy';
  runtime.abort = new AbortController();
  runtime.buffer = []; // clear buffer from any previous run

  try {
    const options = buildSDKOptions(runtime, body, req.user);

    if (wantsStream) {
      // SSE streaming mode — disable all timeouts for long-running agent sessions
      req.setTimeout(0);
      req.socket?.setTimeout?.(0);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Prevent uncaught socket errors from crashing the process
      res.on('error', (e) => { logError('Response socket error', e); });
      req.on('error', (e) => { logError('Request socket error', e); });

      // Subscribe this response to the broadcast stream
      subscribeToStream(runtime, res);

      // Send keepalive comments every 15s to prevent proxy timeouts
      let keepalive = null;
      keepalive = setInterval(() => {
        try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
      }, 15000);
      res.on('close', () => { if (keepalive) clearInterval(keepalive); });
    }

    // Generate AI title immediately before SDK execution
    // Always broadcast for TaskPanel; only persist to disk for new sessions
    let aiTitle = null;
    if (wantsStream && prompt) {
      try {
        aiTitle = await generateTitleText(prompt);
        if (aiTitle) {
          if (isNew) {
            runtime.pendingTitle = aiTitle;
          }
          broadcast(runtime, 'title', { title: aiTitle, sessionId: isNew ? null : id });
        }
      } catch (err) {
        logError('Title generation error', err);
      }
    }

    let result;
    const allMessages = [];

    for await (const message of query({ prompt, options })) {
      const info = handleSDKMessage(message, runtime, wantsStream);
      if (message.type === 'assistant' || message.type === 'user') {
        allMessages.push(message);
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          const errText = (message.errors || []).join('; ') || `SDK result: ${message.subtype}`;
          logError('SDK result error', errText);
          result = { error: errText };
        } else {
          result = info;
        }
      }
    }

    if (wantsStream) {
      // If we have a pending title from before and now know the sessionId, store it
      if (runtime.pendingTitle && runtime.sessionId && isNew) {
        storeSessionTitle(runtime.sessionId, runtime.pendingTitle, runtime.cwd, req.user);
      }

      // Migrate session data to user-specific directory
      if (runtime.sessionId) {
        migrateSessionToUserDir(runtime.sessionId, runtime.cwd, req.user);
      }

      broadcast(runtime, 'done', {
        sessionId: runtime.sessionId,
        cost: result?.cost,
        tokens: result?.tokens,
      });
      broadcastDone(runtime, {
        sessionId: runtime.sessionId,
        cost: result?.cost,
        tokens: result?.tokens,
      });
    } else {
      // Blocking mode — return all messages
      res.json({
        sessionId: runtime.sessionId,
        cost: result?.cost,
        tokens: result?.tokens,
        messages: allMessages,
      });
    }
  } catch (err) {
    console.error('[SESSION] Error details:', err?.message, err?.stack?.split('\n').slice(0,3).join('\n'));
    logError('Session message error', err);
    if (err.name === 'AbortError') {
      try {
        broadcast(runtime, 'error', { message: 'aborted' });
        broadcastDone(runtime, { aborted: true });
      } catch {}
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        broadcast(runtime, 'error', { message: errMsg });
        broadcastDone(runtime, { error: errMsg });
      } catch {}
    }
  } finally {
    runtime.status = 'idle';
    runtime.abort = null;
    runtime.buffer = [];
  }
});

// Reconnect to a running session stream (after page refresh)
router.get('/session/:id/stream', (req, res) => {
  const { id } = req.params;
  const runtime = getRuntimeSession(id);

  if (!runtime) return res.status(404).json({ error: 'Session not found' });
  if (runtime.status !== 'busy') return res.status(404).json({ error: 'Session is not running', status: runtime.status });

  // Set up SSE
  req.setTimeout(0);
  req.socket?.setTimeout?.(0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.on('error', (e) => { logError('Reconnect response error', e); });
  req.on('error', (e) => { logError('Reconnect request error', e); });

  // Replay buffer + subscribe to live stream
  subscribeToStream(runtime, res);

  let keepalive = null;
  keepalive = setInterval(() => {
    try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
  }, 15000);
  res.on('close', () => { if (keepalive) clearInterval(keepalive); });
});

// Resolve AskUserQuestion
router.post('/session/:id/message/resolve', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  if (!body.answers || typeof body.answers !== 'object') {
    return res.status(400).json({ error: 'answers is required' });
  }
  const firstVal = Object.values(body.answers)[0];

  // Tool confirmation (允许/拒绝)
  if (firstVal === '允许' || firstVal === '拒绝') {
    const decision = firstVal === '拒绝'
      ? { behavior: 'deny', message: '用户拒绝执行' }
      : { behavior: 'allow', updatedInput: {} };
    let ok = resolvePendingApproval(id, decision);
    if (!ok) ok = resolvePendingApproval('pending', decision);
    if (!ok) return res.status(409).json({ error: 'No pending question for this session' });
    return res.json({ ok: true });
  }

  // AskUserQuestion — resolve with plain answers
  const askResolve = askQuestionContext.get(id) || askQuestionContext.get('pending');
  if (askResolve && firstVal !== '允许' && firstVal !== '拒绝') {
    askQuestionContext.delete(id);
    askQuestionContext.delete('pending');
    askResolve({ answers: body.answers });
    return res.json({ ok: true });
  }
});

// Generate session title from first user message via Claude
router.post('/session/:id/title', async (req, res) => {
  const { id } = req.params;
  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const title = await generateSessionTitle(id, prompt, req.body.cwd, req.user);
  res.json({ title });
});

module.exports = router;
