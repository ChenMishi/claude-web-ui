const BASE = '/api';

let accessToken = localStorage.getItem('claude-ui:accessToken') || null;
let refreshToken = localStorage.getItem('claude-ui:refreshToken') || null;
let onTokenExpired = null;
let isRefreshing = false;
let refreshPromise = null;

export function setTokens(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('claude-ui:accessToken', access);
  if (refresh) localStorage.setItem('claude-ui:refreshToken', refresh);
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('claude-ui:accessToken');
  localStorage.removeItem('claude-ui:refreshToken');
}

export function getAccessToken() { return accessToken; }
export function getRefreshToken() { return refreshToken; }
export function setOnTokenExpired(cb) { onTokenExpired = cb; }

function authHeaders(headers = {}) {
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  return headers;
}
export { authHeaders };

async function tryRefresh() {
  if (!refreshToken) return false;
  if (isRefreshing && refreshPromise) {
    try { await refreshPromise; return true; } catch { return false; }
  }
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) throw new Error('refresh failed');
      const data = await res.json();
      setTokens(data.accessToken, data.refreshToken);
      return true;
    } catch {
      clearTokens();
      if (onTokenExpired) onTokenExpired();
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();
  try { return await refreshPromise; } catch { return false; }
}

export async function fetchJSON(url, opts = {}) {
  const headers = authHeaders({ ...opts.headers });
  if (opts.method && opts.method !== 'GET' && opts.body) {
    headers['Content-Type'] = 'application/json';
  }
  const fullUrl = `${BASE}${url}`;
  let res = await fetch(fullUrl, { ...opts, headers });
  if (res.status === 401 && refreshToken) {
    const ok = await tryRefresh();
    if (ok) {
      const newHeaders = authHeaders({ ...opts.headers });
      if (opts.method && opts.method !== 'GET' && opts.body) {
        newHeaders['Content-Type'] = 'application/json';
      }
      res = await fetch(fullUrl, { ...opts, headers: newHeaders });
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Projects
export const getProjects = () => fetchJSON('/project');
export const getDirs = (path) => fetchJSON(`/fs/dirs?path=${encodeURIComponent(path)}`);
export const linkProject = (cwd) => fetchJSON('/project/link', { method: 'POST', body: JSON.stringify({ cwd }) });
export const unlinkProject = (id) => fetchJSON(`/project/${id}`, { method: 'DELETE' });
export const getProjectSessions = (id) => fetchJSON(`/project/${id}/session`);
export const getProjectTree = (id, path = '/') => fetchJSON(`/project/${id}/tree?path=${encodeURIComponent(path)}`);
export const readFile = (id, path) => fetchJSON(`/project/${id}/file?path=${encodeURIComponent(path)}`);

// Auth
export const login = (username, password) => fetchJSON('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
export const refreshAuth = (rt) => fetchJSON('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) });
export const getMe = () => fetchJSON('/auth/me');
export const getAuthStatus = () => fetchJSON('/auth/status');
export const getUsers = () => fetchJSON('/auth/users');
export const createUser = (username, password, role) => fetchJSON('/auth/users', { method: 'POST', body: JSON.stringify({ username, password, role }) });
export const deleteUser = (id) => fetchJSON(`/auth/users/${id}`, { method: 'DELETE' });
export const changePassword = (oldPassword, newPassword) => fetchJSON('/auth/me/password', { method: 'PUT', body: JSON.stringify({ oldPassword, newPassword }) });
export const updateAvatar = (avatar) => fetchJSON('/auth/me/avatar', { method: 'PUT', body: JSON.stringify({ avatar }) });

// Version
export const checkVersion = (opts = {}) => fetchJSON('/version/check', { method: 'POST', body: JSON.stringify(opts) });
export const getVersionInfo = () => fetchJSON('/version/info');
export const upgradeVersion = (opts = {}) => fetchJSON('/version/upgrade', { method: 'POST', body: JSON.stringify(opts) });
export const getUpgradeLog = () => fetchJSON('/version/upgrade/log');
export const getUpgradeStatus = () => fetchJSON('/version/upgrade/status');

// Init
export const getInitStatus = () => fetchJSON('/init/status');
export const saveInitConfig = (data) => fetchJSON('/init/config', { method: 'POST', body: JSON.stringify(data) });
export const testProxy = (data) => fetchJSON('/init/test-proxy', { method: 'POST', body: JSON.stringify(data) });
export const checkClaudeUpdate = () => fetchJSON('/init/check-claude-update', { method: 'POST' });
export const getCcswitchConfig = () => fetchJSON('/init/ccswitch-config');
export const saveCcswitchConfig = (data) => fetchJSON('/init/ccswitch-config', { method: 'POST', body: JSON.stringify(data) });
export const getCcswitchStatus = () => fetchJSON('/init/ccswitch-status');
export const restartCcswitch = () => fetchJSON('/init/ccswitch-restart', { method: 'POST' });
export const initCcswitchProvider = () => fetchJSON('/init/ccswitch-init-provider', { method: 'POST' });

// File system (write / delete)
export const writeFile = (filePath, content) => fetchJSON('/fs/write', { method: 'POST', body: JSON.stringify({ filePath, content }) });
export const deleteFileOrDir = (filePath) => fetchJSON('/fs/delete', { method: 'DELETE', body: JSON.stringify({ filePath }) });

// Sessions
export const getSessionInfo = (id) => fetchJSON(`/session/${id}`);
export const deleteSession = (id) => fetchJSON(`/session/${id}`, { method: 'DELETE' });
export const renameSession = (id, title) => fetchJSON(`/session/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
export const abortSession = (id) => fetchJSON(`/session/${id}/abort`, { method: 'POST' });
export const generateTitle = (id, prompt, cwd) => fetchJSON(`/session/${id}/title`, { method: 'POST', body: JSON.stringify({ prompt, cwd }) });
export const reconnectSession = (id) => fetch(`${BASE}/session/${id}/stream`, {
  headers: authHeaders({ Accept: 'text/event-stream' }),
});
export const getSessionMessages = (id, offset) => fetchJSON(`/session/${id}/message${offset != null ? `?offset=${offset}` : ''}`);
export const resolveQuestion = (id, answers) => fetchJSON(`/session/${id}/message/resolve`, { method: 'POST', body: JSON.stringify(answers) });

// Agent SDK chat (full tool calling via session endpoint)
export async function runAgent({ sessionId, cwd, prompt, options = {}, onSystem, onAssistant, onToolResult, onToolUse, onAskUser, onThinking, onDone, onError, onTitle }) {
  const body = { prompt, cwd, options };

  let response;
  try {
    response = await fetch(`${BASE}/session/${sessionId}/message?stream=1`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });
  } catch (err) {
    onError?.(new Error(`无法连接服务器: ${err.message}`));
    return;
  }

  if (!response.ok) {
    if (response.status === 401 && refreshToken) {
      const ok = await tryRefresh();
      if (ok) {
        // Retry once after refresh
        try {
          response = await fetch(`${BASE}/session/${sessionId}/message?stream=1`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            onError?.(new Error(err.error || `HTTP ${response.status}`));
            return;
          }
        } catch (err2) {
          onError?.(new Error(`无法连接服务器: ${err2.message}`));
          return;
        }
      } else {
        return; // token refresh failed, onTokenExpired already called
      }
    } else {
      try {
        const err = await response.json();
        onError?.(new Error(err.error || `HTTP ${response.status}`));
      } catch {
        onError?.(new Error(`HTTP ${response.status}`));
      }
      return;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let receivedDone = false;

  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (!currentEvent) onError?.(new Error(`连接中断: ${err.message}`));
        break;
      }
      const { done, value } = chunk;

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);

              switch (currentEvent) {
                case 'message':
                  if (parsed.type === 'assistant') {
                    const content = parsed.message?.content || [];
                    const textBlocks = content.filter(c => c.type === 'text');
                    const toolBlocks = content.filter(c => c.type === 'tool_use');
                    const thinkingBlocks = content.filter(c => c.type === 'thinking');
                    const usage = parsed.message?.usage || null;

                    if (thinkingBlocks.length > 0) {
                      onThinking?.({ text: thinkingBlocks.map(t => t.thinking).join(' '), usage });
                    }
                    if (textBlocks.length > 0) {
                      onAssistant?.({ uuid: parsed.uuid, session_id: parsed.session_id, content: textBlocks.map(t => t.text).join(''), raw: parsed.message, usage });
                    }
                    if (toolBlocks.length > 0) {
                      toolBlocks.forEach(t => onToolUse?.({ uuid: parsed.uuid, session_id: parsed.session_id, tool: t.name, input: t.input, tool_use_id: t.id, usage }));
                    }
                  } else if (parsed.type === 'user') {
                    const content = parsed.message?.content || [];
                    const toolResults = content.filter(c => c.type === 'tool_result');
                    if (toolResults.length > 0) {
                      toolResults.forEach(t => {
                        let text;
                        if (typeof t.content === 'string') {
                          text = t.content;
                        } else if (Array.isArray(t.content)) {
                          text = t.content.map(b => (b && b.type === 'text') ? b.text : JSON.stringify(b)).join('');
                        } else {
                          text = JSON.stringify(t.content || '');
                        }
                        onToolResult?.({ tool_use_id: t.tool_use_id, content: text, is_error: t.is_error });
                      });
                    }
                  }
                  break;

                case 'ask_user':
                  onAskUser?.(parsed);
                  break;

                case 'done':
                  receivedDone = true;
                  onDone?.(parsed);
                  break;

                case 'title':
                  onTitle?.(parsed);
                  break;

                case 'error':
                  onError?.(new Error(parsed.message));
                  break;
              }
            } catch {}
            currentEvent = '';
          }
        }
      }

      if (done) {
        if (!receivedDone) {
          onError?.(new Error('连接中断: 服务器提前关闭了连接'));
        }
        break;
      }
    }
  } catch (err) {
    onError?.(err);
  }
}
