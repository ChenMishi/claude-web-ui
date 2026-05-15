const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const { CLAUDE_PROJECTS_DIR, SESSIONS_DIR } = require('../config');
const { dirNameToCwd, parseTitleFromJsonl } = require('../utils');
const {
  getRuntimeSession, deleteRuntimeSession, getOrCreateRuntime,
  createPendingRuntime, assignSessionId, resolvePendingApproval, setPendingApproval
} = require('../store');

// Agent SDK — enables full tool calling (Bash, Read, Write, Edit, etc.)
// The SDK and its platform binary are npm dependencies (see package.json)
let query;
try { query = require('@anthropic-ai/claude-agent-sdk').query; } catch { /* will fall back to no-tool mode */ }

function findSDKBinary() {
  try {
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    // sdkEntry: .../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
    const base = path.dirname(path.dirname(sdkEntry)); // .../node_modules
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    const candidates = [
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}`,
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}-musl`,
    ];
    for (const name of candidates) {
      const bin = path.join(base, name, 'claude');
      if (fs.existsSync(bin)) return bin;
    }
    return null;
  } catch { return null; }
}

const SDK_BINARY = findSDKBinary();

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

function handleSDKMessage(message, runtime, res, isStreaming) {
  const log = (msg) => { /* silent in production */ };

  if (message.type === 'system') {
    if (message.session_id && !runtime.sessionId) {
      assignSessionId(runtime, message.session_id);
    }
    return;
  }

  if (message.type === 'assistant') {
    if (isStreaming) {
      sseWrite(res, {
        event: 'message',
        data: {
          type: 'assistant',
          uuid: message.uuid || '',
          session_id: message.session_id || '',
          message: message.message,
          parent_tool_use_id: message.parent_tool_use_id || null,
        },
      });
    }
    return;
  }

  if (message.type === 'user') {
    const hasToolResult = (message.message?.content || []).some(b => b.type === 'tool_result');
    if (hasToolResult && isStreaming) {
      sseWrite(res, {
        event: 'message',
        data: {
          type: 'user',
          uuid: message.uuid || '',
          session_id: message.session_id || '',
          message: message.message,
          parent_tool_use_id: message.parent_tool_use_id || null,
        },
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

function buildSDKOptions(runtime, body, sseWriter) {
  const agentOptions = body.options || {};

  const options = {
    cwd: runtime.cwd,
    allowedTools: agentOptions.allowedTools || ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'],
    permissionMode: 'default',
    pathToClaudeCodeExecutable: SDK_BINARY,
    ...runtime.sessionId ? { resume: runtime.sessionId } : {},
    ...agentOptions.model !== undefined ? { model: agentOptions.model } : {},
    ...agentOptions.maxTurns !== undefined ? { maxTurns: agentOptions.maxTurns } : {},
    ...agentOptions.systemPrompt !== undefined ? { systemPrompt: agentOptions.systemPrompt } : {},
    ...agentOptions.maxBudgetUsd !== undefined ? { maxBudgetUsd: agentOptions.maxBudgetUsd } : {},
    ...agentOptions.effort !== undefined ? { effort: agentOptions.effort } : {},
    ...agentOptions.additionalDirectories?.length ? { additionalDirectories: agentOptions.additionalDirectories } : {},
    ...agentOptions.env !== undefined ? { env: agentOptions.env } : {},
    ...agentOptions.thinking !== undefined ? { thinking: agentOptions.thinking } : {},
    ...runtime.abort ? { abortController: runtime.abort } : {},
  };

  // canUseTool approves all tools; AskUserQuestion pauses for user input
  options.canUseTool = async (toolName, input) => {
    if (toolName === 'AskUserQuestion') {
      if (!sseWriter) return { behavior: 'deny', message: 'AskUserQuestion requires stream mode' };
      return new Promise((resolve) => {
        setPendingApproval(runtime.sessionId || 'pending', resolve);
        sseWriter({ event: 'ask_user', data: { questions: input.questions || [] } });
      });
    }
    return { behavior: 'allow', updatedInput: input };
  };

  return options;
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
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const entry of fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.jsonl`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        const metaFile = path.join(CLAUDE_PROJECTS_DIR, entry.name, `${id}.meta.json`);
        if (fs.existsSync(metaFile)) fs.rmSync(metaFile, { force: true });
        deleted = true;
        break;
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
  const offset = parseInt(req.query.offset || '0') || 0;
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
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.type === 'user' || rec.type === 'assistant') {
          messages.push(rec);
        }
      } catch {}
    }
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
    return res.status(409).json({ error: 'Session is busy' });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const wantsStream = req.headers.accept?.includes('text/event-stream') || req.query.stream === '1';

  runtime.status = 'busy';
  runtime.abort = new AbortController();

  const sseWriter = wantsStream ? (ev) => sseWrite(res, ev) : null;

  try {
    const options = buildSDKOptions(runtime, body, sseWriter);

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

      // Send keepalive comments every 15s to prevent proxy timeouts
      let keepalive = null;
      keepalive = setInterval(() => {
        try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
      }, 15000);
      res.on('close', () => { if (keepalive) clearInterval(keepalive); });
    }

    let result;
    const allMessages = [];

    for await (const message of query({ prompt, options })) {
      const info = handleSDKMessage(message, runtime, res, wantsStream);
      if (message.type === 'assistant' || message.type === 'user') {
        allMessages.push(message);
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          // SDK returned an error result — surface it
          const errText = (message.errors || []).join('; ') || `SDK result: ${message.subtype}`;
          logError('SDK result error', errText);
          result = { error: errText };
        } else {
          result = info;
        }
      }
    }

    if (wantsStream) {
      sseWrite(res, {
        event: 'done',
        data: {
          sessionId: runtime.sessionId,
          cost: result?.cost,
          tokens: result?.tokens,
        },
      });
      res.end();
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
    logError('Session message error', err);
    if (err.name === 'AbortError') {
      try {
        if (!res.headersSent) res.status(499).json({ error: 'aborted' });
        else if (!res.writableEnded) res.end();
      } catch {}
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        if (wantsStream && res.headersSent && !res.writableEnded) {
          sseWrite(res, { event: 'error', data: { message: errMsg } });
          res.end();
        } else if (!res.headersSent) {
          res.status(500).json({ error: errMsg });
        }
      } catch {}
    }
  } finally {
    runtime.status = 'idle';
    runtime.abort = null;
  }
});

// Resolve AskUserQuestion
router.post('/session/:id/message/resolve', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  if (!body.answers || typeof body.answers !== 'object') {
    return res.status(400).json({ error: 'answers is required' });
  }
  // Try URL param first; for new sessions (id='new') the approval was stored under 'pending'
  let ok = resolvePendingApproval(id, { behavior: 'allow', updatedInput: { answers: body.answers } });
  if (!ok) ok = resolvePendingApproval('pending', { behavior: 'allow', updatedInput: { answers: body.answers } });
  if (!ok) return res.status(409).json({ error: 'No pending question for this session' });
  res.json({ ok: true });
});

// Generate session title from first user message via Claude
router.post('/session/:id/title', async (req, res) => {
  const { id } = req.params;
  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const { PROXY_BASE } = require('../config');
    const proxyRes = await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: `用不超过15个汉字为以下对话生成一个简短的标题，直接返回标题文本，不要带引号、不要解释：${prompt}` }],
        stream: false,
      }),
    });

    if (!proxyRes.ok) {
      const err = await proxyRes.text().catch(() => '');
      return res.status(proxyRes.status).json({ error: err });
    }

    const data = await proxyRes.json();
    const textBlock = (data.content || []).find(c => c.type === 'text');
    const title = (textBlock?.text || '').trim().slice(0, 30);

    if (title) {
      // Save title to sidecar metadata
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, require('../store').getProjectDirName(req.body.cwd || ''));
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, `${id}.meta.json`), JSON.stringify({ title }), 'utf8');
    }

    res.json({ title: title || null });
  } catch (err) {
    console.error('Title generation error:', err);
    res.status(500).json({ error: `标题生成失败: ${err.message}` });
  }
});

module.exports = router;
