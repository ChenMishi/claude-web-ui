const path = require('path');
const { CLAUDE_PROJECTS_DIR } = require('./config');

const runtimeSessions = new Map();
const pendingApprovals = new Map();

function getProjectDirName(cwd) {
  const normalized = path.resolve(cwd);
  return normalized.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1').replace(/[^a-zA-Z0-9]/g, '-');
}

function getSessionFile(dirName, sessionId) {
  return path.join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
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
  const session = { sessionId, projectDirName: getProjectDirName(cwd), cwd, status: 'idle', abort: null };
  runtimeSessions.set(sessionId, session);
  return session;
}

function createPendingRuntime(cwd) {
  return { sessionId: null, projectDirName: getProjectDirName(cwd), cwd, status: 'idle', abort: null };
}

function assignSessionId(runtime, sessionId) {
  runtime.sessionId = sessionId;
  runtimeSessions.set(sessionId, runtime);
}

function setPendingApproval(sessionId, resolve) {
  pendingApprovals.set(sessionId, resolve);
}

function resolvePendingApproval(sessionId, decision) {
  const resolve = pendingApprovals.get(sessionId);
  if (!resolve) return false;
  pendingApprovals.delete(sessionId);
  resolve(decision);
  return true;
}

module.exports = {
  runtimeSessions, pendingApprovals,
  getProjectDirName, getSessionFile,
  getRuntimeSession, deleteRuntimeSession,
  getOrCreateRuntime, createPendingRuntime, assignSessionId,
  setPendingApproval, resolvePendingApproval,
};
