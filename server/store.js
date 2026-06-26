const path = require('path');
const { CLAUDE_PROJECTS_DIR } = require('./config');

const runtimeSessions = new Map();
const pendingApprovals = new Map();

function getProjectDirName(cwd) {
  const normalized = path.resolve(cwd);
  // Only replace path separators (/ \) and Windows drive colon with _
  // Preserve hyphens, dots, spaces etc. from the original path
  return normalized.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1').replace(/\//g, '_');
}

function getSessionFile(dirName, sessionId) {
  return path.join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
}

// Returns the real session data directory for a working directory
// e.g. /data/temp/.claude/sessions/
function getSessionWorkDir(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  return path.join(resolved, '.claude', 'sessions');
}

function getRuntimeSession(sessionId) {
  return runtimeSessions.get(sessionId) ?? null;
}

function deleteRuntimeSession(sessionId) {
  runtimeSessions.delete(sessionId);
}

function getOrCreateRuntime(sessionId, cwd) {
  const existing = runtimeSessions.get(sessionId);
  if (existing) return existing;
  const session = {
    sessionId,
    projectDirName: getProjectDirName(cwd),
    cwd,
    status: 'idle',
    abort: null,
    buffer: [],           // buffered messages for reconnecting clients
    subscribers: new Set(), // active SSE response objects
  };
  runtimeSessions.set(sessionId, session);
  return session;
}

function createPendingRuntime(cwd) {
  return {
    sessionId: null,
    projectDirName: getProjectDirName(cwd),
    cwd,
    status: 'idle',
    abort: null,
    buffer: [],
    subscribers: new Set(),
  };
}

function assignSessionId(runtime, sessionId) {
  runtime.sessionId = sessionId;
  runtimeSessions.set(sessionId, runtime);
}

function setPendingApproval(sessionId, resolve, type, input) {
  pendingApprovals.set(sessionId, { resolve, type: type || 'ask', input });
}

function resolvePendingApproval(sessionId, decision) {
  const entry = pendingApprovals.get(sessionId);
  if (!entry) return false;
  pendingApprovals.delete(sessionId);
  console.log('[store] resolvePending type:', entry.type, 'decision:', JSON.stringify(decision));
  if (entry.type === 'confirm' && decision.behavior === 'allow') {
    entry.resolve({ behavior: 'allow', updatedInput: {} });
  } else {
    entry.resolve(decision);
  }
  return true;
}

// Broadcast an SSE event to all subscribers and buffer it for reconnects
function broadcast(runtime, event, data) {
  const ev = { event, data };
  runtime.buffer.push(ev);
  // Keep buffer bounded (last 500 events)
  if (runtime.buffer.length > 500) runtime.buffer.shift();
  // Send to all active subscribers
  for (const sub of runtime.subscribers) {
    try {
      if (!sub.writableEnded) {
        sub.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch {}
  }
}

// Subscribe an SSE response to a running session — first replays buffer, then streams live
function subscribeToStream(runtime, res) {
  // Replay buffered messages
  for (const ev of runtime.buffer) {
    try {
      if (!res.writableEnded) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      }
    } catch {}
  }
  // Subscribe for future messages
  runtime.subscribers.add(res);
  res.on('close', () => runtime.subscribers.delete(res));
}

// Notify all subscribers that the session is done
function broadcastDone(runtime, result) {
  broadcast(runtime, 'done', result);
  // 延迟关闭连接，确保 done 事件已刷写到客户端
  setTimeout(() => {
    for (const sub of runtime.subscribers) {
      try { if (!sub.writableEnded) sub.end(); } catch {}
    }
    runtime.subscribers.clear();
  }, 100);
}

// Reset all runtime statuses to idle (called on server startup)
function resetAllRuntimes() {
  for (const rt of runtimeSessions.values()) {
    rt.status = 'idle';
    rt.buffer = [];
  }
}

module.exports = {
  runtimeSessions, pendingApprovals,
  getProjectDirName, getSessionFile, getSessionWorkDir,
  getRuntimeSession, deleteRuntimeSession,
  getOrCreateRuntime, createPendingRuntime, assignSessionId,
  setPendingApproval, resolvePendingApproval,
  broadcast, subscribeToStream, broadcastDone,
  resetAllRuntimes,
};
