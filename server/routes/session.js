const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CLAUDE_PROJECTS_DIR, SESSIONS_DIR, STATS_DIR, getUserDataDir } = require('../config');

// 从 init-config.json 读取代理地址，默认 127.0.0.1:15721
function getProxyUrl() {
  try {
    const configFile = path.join(path.resolve(__dirname, '..', '..'), 'init-config.json');
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (cfg.proxyUrl) return cfg.proxyUrl;
    }
  } catch {}
  return 'http://127.0.0.1:15721';
}
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

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Extract file paths from Bash commands and their results ──
function extractBashFilePaths(command, resultContent, cwd) {
  const paths = [];
  if (!command || !cwd) return paths;

  // 1. Output redirection: > file, >> file, 2> file, &> file
  for (const m of command.matchAll(/(?:^|\s)(?:[12]?>>?|&>)\s*(\S+)/g)) {
    const p = m[1].replace(/^['"]|['"]$/g, '');
    if (p && !p.startsWith('/dev/')) paths.push(p);
  }

  // 2. tee command (tee file, tee -a file)
  for (const m of command.matchAll(/tee\s+(?:-[a-zA-Z]+\s+)*(\S+)/g)) {
    if (!m[1].startsWith('-')) paths.push(m[1]);
  }

  // 3. touch command
  const touchM = command.match(/touch\s+(.+?)(?:\s*&&|\s*;|\s*\||\s*$)/);
  if (touchM) {
    touchM[1].split(/\s+/).forEach(p => {
      if (p && !p.startsWith('-')) paths.push(p.replace(/^['"]|['"]$/g, ''));
    });
  }

  // 4. mkdir -p
  for (const m of command.matchAll(/mkdir\s+(?:-[a-zA-Z]+\s+)*(\S+)/g)) {
    if (!m[1].startsWith('-')) paths.push(m[1]);
  }

  // 5. curl -o / wget -O
  for (const m of command.matchAll(/(?:curl|wget)\s+.*?\s-(o|O)\s*(\S+)/g)) {
    paths.push(m[2]);
  }

  // 6. dd of=
  for (const m of command.matchAll(/dd\s+.*?\bof=(\S+)/g)) {
    paths.push(m[1]);
  }

  // 6b. tar -czf / -cf / -xf etc (output follows -f)
  for (const m of command.matchAll(/tar\s+(?:-[a-zA-Z]*f\s*)(\S+)/g)) {
    if (!m[1].startsWith('-')) paths.push(m[1]);
  }

  // 6c. zip output.zip files... (first positional arg after flags is output)
  const zipM = command.match(/(?:^|\s)zip\s+(?:-[a-zA-Z0-9]+\s+)*(\S+)/);
  if (zipM && !zipM[1].startsWith('-')) paths.push(zipM[1]);

  // 6d. 7z a output.7z files... (arg after 'a' is output)
  const sevenZM = command.match(/(?:^|\s)7z\s+a\s+(\S+)/);
  if (sevenZM) paths.push(sevenZM[1]);

  // 6e. gzip / bzip2 / xz file (output is file.gz / file.bz2 / file.xz)
  for (const m of command.matchAll(/(?:^|\s)(?:gzip|bzip2|xz)\s+(?:-[a-zA-Z0-9]+\s+)*(\S+)/g)) {
    const p = m[1];
    if (!p.startsWith('-')) {
      paths.push(p);
      // Also check if the compressed file exists (e.g. file.gz from gzip file)
      const extMap = { gzip: '.gz', bzip2: '.bz2', xz: '.xz' };
      const cmdName = m[0].trim().split(/\s+/)[0];
      const ext = extMap[cmdName];
      if (ext) paths.push(p + ext);
    }
  }

  // 7. cp/mv destination (last arg before && / ; / |)
  const cpMvM = command.match(/(?:^|;\s*)(?:cp|mv)\s+(?:-[a-zA-Z]+\s+)*(?:\S+\s+)+?(\S+?)(?:\s*&&|\s*;|\s*\||\s*$)/);
  if (cpMvM && !cpMvM[1].match(/^-[a-zA-Z]/)) paths.push(cpMvM[1]);

  // 8. From result: "The file /path has been updated successfully."
  for (const m of (resultContent || '').matchAll(/(?:^|\n)The file (\S+) has been updated/gm)) {
    paths.push(m[1]);
  }

  // 9. From result: "File created/written at: /path"
  for (const m of (resultContent || '').matchAll(/File (?:created|written) (?:successfully )?at:\s*(\S+)/gi)) {
    paths.push(m[1]);
  }

  // 10. From result: "create mode 100644 path/to/file" (git output)
  for (const m of (resultContent || '').matchAll(/create mode \d+ (.+)/g)) {
    paths.push(m[1]);
  }

  // Resolve relative paths and deduplicate
  const os = require('os');
  const resolved = [...new Set(paths.map(p => {
    p = p.replace(/^['"]|['"]$/g, '');
    if (p.startsWith('/')) return p;
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return path.join(cwd, p);
  }))];

  // Only return actual files that exist (not directories)
  return resolved.filter(p => {
    try { return fs.existsSync(p) && !fs.statSync(p).isDirectory(); } catch { return false; }
  });
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
      // Store Bash commands for later path extraction
      if (!runtime.bashCommands) runtime.bashCommands = new Map();
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
          runtime.bashCommands.set(block.id, block.input?.command || '');
        }
      }
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
      // Extract file paths from Bash tool results
      const extractedPaths = {};
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const cmd = runtime.bashCommands?.get(block.tool_use_id);
          if (cmd) {
            const paths = extractBashFilePaths(cmd, typeof block.content === 'string' ? block.content : '', runtime.cwd);
            if (paths.length > 0) {
              extractedPaths[block.tool_use_id] = paths;
            }
            runtime.bashCommands.delete(block.tool_use_id);
          }
        }
      }
      broadcast(runtime, 'message', {
        type: 'user',
        uuid: message.uuid || '',
        session_id: message.session_id || '',
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id || null,
        extractedPaths,
      });
    }
    return;
  }

  if (message.type === 'result') {
    if (message.subtype === 'success') {
      const usage = message.usage || {};
      const sdkCost = message.total_cost_usd;
      const sdkTokens = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cache: { read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0 },
      };

      // Apply custom pricing if configured for this model
      let cost = sdkCost;
      let currency;
      try {
        const pricingFile = path.join(path.resolve(__dirname, '..', '..'), 'pricing-config.json');
        if (fs.existsSync(pricingFile)) {
          const pricing = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
          const modelPricing = pricing.models?.[runtime.model];
          // Always use custom pricing if config exists — unconfigured models default to 0
          const ip = modelPricing?.input || 0;
          const op = modelPricing?.output || 0;
          const crp = modelPricing?.cacheInput || 0;
          const cwp = modelPricing?.cacheOutput || 0;
          cost = ((sdkTokens.input * ip)
                + (sdkTokens.output * op)
                + (sdkTokens.cache.read * crp)
                + (sdkTokens.cache.write * cwp)) / 1_000_000;
          currency = '¥';
        }
      } catch {}

      return { cost, currency, tokens: sdkTokens };
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

  const proxyUrl = getProxyUrl();

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
    // Always route SDK through built-in proxy
    // IMPORTANT: ...process.env must be first so the subprocess inherits PATH etc.
    // The SDK query() `env` parameter COMPLETELY REPLACES the subprocess environment.
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyUrl,
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
      // Store resolver so frontend can resolve via /session/:id/message/resolve
      // Return a Promise that waits for the user's answers (with 2-minute timeout)
      const sessionKey = runtime.sessionId || 'pending';
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          askQuestionContext.delete(sessionKey);
          console.log('[AskUserQuestion] 超时，自动允许继续');
          // Timeout: allow with empty answers so the model can continue
          resolve({ behavior: 'allow', updatedInput: { ...input, answers: {} } });
        }, 120000); // 2 minute timeout
        askQuestionContext.set(sessionKey, (result) => {
          clearTimeout(timeout);
          // Inject user answers into the tool input
          resolve({ behavior: 'allow', updatedInput: { ...input, answers: result.answers || {} } });
        });
      });
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
      const sessionKey = runtime.sessionId || 'pending';
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingApprovals.delete(sessionKey); // clean up without calling resolver
        console.log('[canUseTool] 用户确认超时，自动允许:', action);
        resolve({ behavior: 'allow', updatedInput: input });
      }, 120000); // 2 minute timeout
      setPendingApproval(sessionKey, (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.log('[canUseTool] user answered:', JSON.stringify(result));
        resolve(result);
      }, 'confirm', input);
      broadcast(runtime, 'tool_confirm', { tool: toolName, action, input });
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

// Lightweight: just call the proxy, return title text (no disk I/O)
async function generateTitleText(prompt) {
  const proxyBase = getProxyUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  // 读取 provider 配置，选择标题生成用的模型
  let titleModel = 'claude-haiku-4-5-20251001'; // 默认 Anthropic
  try {
    const providerFile = path.join(path.resolve(__dirname, '..', '..'), 'provider-config.json');
    if (fs.existsSync(providerFile)) {
      const cfg = JSON.parse(fs.readFileSync(providerFile, 'utf8'));
      // 优先用 haikuModel，其次 sonnetModel，最后用主 model
      titleModel = cfg.haikuModel || cfg.sonnetModel || cfg.model || titleModel;
    }
  } catch {}

  try {
    const proxyRes = await fetch(`${proxyBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: titleModel,
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
  } catch (err) {
    console.error('generateTitleText error:', err?.message);
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
// 从文件末尾倒读，避免把整个大文件（可能几十 MB）一次读入内存
function readLastUserAssistantRecords(jsonlPath, needed) {
  const CHUNK_SIZE = 65536; // 64KB 块
  let fd;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const stat = fs.fstatSync(fd);
    const records = [];
    let pos = stat.size;
    let leftover = '';

    while (pos > 0 && records.length < needed) {
      const readSize = Math.min(CHUNK_SIZE, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      const chunk = buf.toString('utf8') + leftover;
      const lines = chunk.split('\n');
      // 第一段可能是不完整的行，留给下一轮拼接到 chunk 前面
      leftover = lines.shift() || '';

      // 从后往前解析，尽早凑够 needed 条
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'user' || rec.type === 'assistant') {
            records.unshift(rec);
            if (records.length >= needed) break;
          }
        } catch { /* 跳过损坏行 */ }
      }
    }

    // 文件开头剩余的第一行
    if (leftover.trim() && records.length < needed) {
      try {
        const rec = JSON.parse(leftover);
        if (rec.type === 'user' || rec.type === 'assistant') {
          records.unshift(rec);
        }
      } catch {}
    }

    return records;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

router.get('/session/:id/message', (req, res) => {
  const { id } = req.params;
  const limit = 200;
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
    const reqOffset = req.query.offset !== undefined ? parseInt(req.query.offset) : null;
    const skip = reqOffset !== null && !isNaN(reqOffset) ? reqOffset : 0;
    const needed = skip + limit;
    // 从文件末尾倒读，只解析需要的行数
    const msgRecords = readLastUserAssistantRecords(jsonlPath, needed);
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
  if (!prompt && (!body.attachments || body.attachments.length === 0)) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // ── Attachments: prepend file info to prompt so Claude knows to Read them ──
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  let fullPrompt = prompt || '';
  if (attachments.length > 0) {
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const officeExts = ['.docx', '.xlsx', '.pptx'];
    const archiveExts = ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'];
    const fileLines = attachments.map(a => {
      const name = a.fileName || a.originalName || '';
      const ext = name.toLowerCase();
      const isImage = imageExts.some(ie => ext.endsWith(ie));
      const isOffice = officeExts.some(oe => ext.endsWith(oe));
      const isArchive = archiveExts.some(ae => ext.endsWith(ae)) || ext.endsWith('.tar.gz');
      if (isArchive && a.extractedPath) {
        return `- 📦 ${a.fileName || a.originalName}: 已解压至 ${a.extractedPath}（见下方文件树）`;
      }
      if (isOffice && a.extractedText) {
        const label = ext.endsWith('.xlsx') ? '📊' : '📄';
        return `- ${label} ${a.fileName || a.originalName}: 文本已提取（见下方内容）`;
      }
      const label = isImage ? '🖼 图片' : '📄 文件';
      return `- ${label}: ${a.path} (${a.mimeType || 'unknown'}, ${formatSize(a.size || 0)})`;
    }).join('\n');
    const imageHint = attachments.some(a => imageExts.some(ie => (a.fileName || a.originalName || '').toLowerCase().endsWith(ie)))
      ? '\n（图片文件请使用 Read 工具的 base64 编码模式读取，以便查看图片内容）' : '';

    // Include extracted text from Office documents / archive file trees directly in prompt
    const extractedBlocks = attachments
      .filter(a => a.extractedText)
      .map(a => {
        const name = a.fileName || a.originalName || 'unknown';
        const isArchive = archiveExts.some(ae => (a.fileName || a.originalName || '').toLowerCase().endsWith(ae))
          || (a.fileName || a.originalName || '').toLowerCase().endsWith('.tar.gz');
        const label = isArchive ? '📦' : '📄';
        const maxLen = 8000; // prevent prompt from becoming too large
        const text = a.extractedText.length > maxLen
          ? a.extractedText.slice(0, maxLen) + '\n\n...（内容过长，已截断）'
          : a.extractedText;
        return `\n── ${label} ${name} ──\n${text}`;
      })
      .concat(attachments
        .filter(a => a.extractedPath && !a.extractedText)
        .map(a => {
          const name = a.fileName || a.originalName || 'unknown';
          return `\n── 📦 ${name} ──\n文件已解压至: ${a.extractedPath}\n请用 Read 工具读取其中的文件`;
        }));

    fullPrompt = `用户上传了以下文件：\n${fileLines}${imageHint}${extractedBlocks.join('\n')}\n\n---\n\n${prompt}`;
  }

  const wantsStream = req.headers.accept?.includes('text/event-stream') || req.query.stream === '1';

  runtime.status = 'busy';
  runtime.abort = new AbortController();
  runtime.buffer = []; // clear buffer from any previous run
  runtime.model = body.options?.model || 'unknown';

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

    for await (const message of query({ prompt: fullPrompt, options })) {
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
        currency: result?.currency,
      });
      broadcastDone(runtime, {
        sessionId: runtime.sessionId,
        cost: result?.cost,
        tokens: result?.tokens,
        currency: result?.currency,
      });

      // Write stats record
      try {
        if (result?.tokens && result?.cost != null && runtime.sessionId) {
          if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR, { recursive: true });
          const now = new Date();
          const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          const statsFile = path.join(STATS_DIR, `${ym}.jsonl`);
          const record = JSON.stringify({
            t: now.toISOString(),
            userId: req.user?.id,
            username: req.user?.username || 'anonymous',
            model: runtime.model || 'unknown',
            sessionId: runtime.sessionId,
            input: result.tokens.input || 0,
            output: result.tokens.output || 0,
            cacheRead: result.tokens.cache?.read || 0,
            cacheWrite: result.tokens.cache?.write || 0,
            cost: result.cost,
            currency: result.currency || '$',
          }) + '\n';
          fs.appendFileSync(statsFile, record);
        }
      } catch {}

    } else {
      // Blocking mode — return all messages
      res.json({
        sessionId: runtime.sessionId,
        cost: result?.cost,
        currency: result?.currency,
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
