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
export const listDir = (p) => fetchJSON(`/fs/list?path=${encodeURIComponent(p || '/')}`);
export const mkdir = (path, name) => fetchJSON('/fs/mkdir', { method: 'POST', body: JSON.stringify({ path, name }) });
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
export const getProviderConfig = () => fetchJSON('/init/provider-config');
export const saveProviderConfig = (data) => fetchJSON('/init/provider-config', { method: 'POST', body: JSON.stringify(data) });

export const getPricing = () => fetchJSON('/init/pricing');
export const savePricing = (models) => fetchJSON('/init/pricing', { method: 'POST', body: JSON.stringify({ models }) });
export const fetchModels = (baseUrl, token) => fetchJSON('/init/fetch-models', { method: 'POST', body: JSON.stringify({ baseUrl, token }) });

// File system (write / delete)
export const writeFile = (filePath, content) => fetchJSON('/fs/write', { method: 'POST', body: JSON.stringify({ filePath, content }) });
export const deleteFileOrDir = (filePath) => fetchJSON('/fs/delete', { method: 'DELETE', body: JSON.stringify({ filePath }) });

// Upload a single file with progress (base64 via JSON, XHR for progress events)
export function uploadFile(dir, file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const body = JSON.stringify({ dir, fileName: file.name, content: base64 });
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/fs/upload');
      xhr.setRequestHeader('Content-Type', 'application/json');
      const headers = authHeaders({});
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress({ loaded: e.loaded, total: e.total, fileName: file.name });
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || `HTTP ${xhr.status}`));
        } catch { reject(new Error('解析响应失败')); }
      };
      xhr.onerror = () => reject(new Error('上传失败'));
      xhr.send(body);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

// Download a file with progress
export function downloadFile(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/fs/download?path=${encodeURIComponent(filePath)}`);
    xhr.responseType = 'blob';
    const headers = authHeaders({});
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress({ loaded: e.loaded, total: e.total, fileName: filePath.split('/').pop() });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filePath.split('/').pop();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resolve({ ok: true });
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || `HTTP ${xhr.status}`));
        } catch { reject(new Error(`HTTP ${xhr.status}`)); }
      }
    };
    xhr.onerror = () => reject(new Error('下载失败'));
    xhr.send();
  });
}

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
        if (response.status === 409 && err.canReconnect) {
          onError?.(new Error('会话正在执行中，请等待当前任务完成或刷新页面重连'));
        } else {
          onError?.(new Error(err.error || `HTTP ${response.status}`));
        }
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

// ── Skills API ──

export async function listSkills(projectDir) {
  const params = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
  return fetchJSON(`/skills${params}`);
}

export async function getSkill(name, projectDir) {
  const params = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
  return fetchJSON(`/skills/${encodeURIComponent(name)}${params}`);
}

export async function createSkill(data) {
  return fetchJSON('/skills', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateSkill(name, data, projectDir) {
  const params = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
  return fetchJSON(`/skills/${encodeURIComponent(name)}${params}`, {
    method: 'PUT', body: JSON.stringify(data),
  });
}

export async function deleteSkillApi(name, projectDir) {
  const params = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
  return fetchJSON(`/skills/${encodeURIComponent(name)}${params}`, { method: 'DELETE' });
}

export async function listMarketplaceSkills() {
  return fetchJSON('/skills/marketplace/list');
}

export async function installMarketplaceSkill({ url, targetScope, skillName }) {
  const body = skillName ? { skillName, targetScope } : { url, targetScope };
  return fetchJSON('/skills/marketplace/install', {
    method: 'POST', body: JSON.stringify(body),
  });
}

// ── Model API (built-in proxy provider) ──

export async function listModels() {
  return fetchJSON('/models');
}

export async function switchModel(model) {
  return fetchJSON('/models/switch', {
    method: 'POST', body: JSON.stringify({ model }),
  });
}

// Server restart (admin only)
export async function restartServer() {
  return fetchJSON('/restart', { method: 'POST' });
}

// Backup
export async function getBackupList() { return fetchJSON('/backup/list'); }
export async function createBackup() { return fetchJSON('/backup/create', { method: 'POST' }); }
export async function deleteBackup(filename) { return fetchJSON(`/backup/${filename}`, { method: 'DELETE' }); }
export async function getBackupConfig() { return fetchJSON('/backup/config'); }
export async function saveBackupConfig(cfg) { return fetchJSON('/backup/config', { method: 'POST', body: JSON.stringify(cfg) }); }
export async function restoreBackup(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/backup/restore`);
    const headers = authHeaders({});
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `HTTP ${xhr.status}`));
      } catch { reject(new Error('解析响应失败')); }
    };
    xhr.onerror = () => reject(new Error('上传失败'));
    xhr.send(formData);
  });
}
export function getBackupDownloadUrl(filename) {
  return `${BASE}/backup/download/${encodeURIComponent(filename)}`;
}

// Stats
export async function getStatsSummary(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return fetchJSON(`/stats/summary${qs ? '?' + qs : ''}`);
}
export async function getStatsUsage(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return fetchJSON(`/stats/usage${qs ? '?' + qs : ''}`);
}
