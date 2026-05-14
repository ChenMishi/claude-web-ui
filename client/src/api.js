const BASE = '/api';

export async function fetchJSON(url, opts = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
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
export const getProjectSessions = (id) => fetchJSON(`/project/${id}/session`);
export const getProjectTree = (id, path = '/') => fetchJSON(`/project/${id}/tree?path=${encodeURIComponent(path)}`);
export const readFile = (id, path) => fetchJSON(`/project/${id}/file?path=${encodeURIComponent(path)}`);

// Sessions
export const getSessionInfo = (id) => fetchJSON(`/session/${id}`);
export const deleteSession = (id) => fetchJSON(`/session/${id}`, { method: 'DELETE' });
export const renameSession = (id, title) => fetchJSON(`/session/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
export const abortSession = (id) => fetchJSON(`/session/${id}/abort`, { method: 'POST' });
export const getSessionMessages = (id, offset = 0) => fetchJSON(`/session/${id}/message?offset=${offset}`);
export const resolveQuestion = (id, answers) => fetchJSON(`/session/${id}/message/resolve`, { method: 'POST', body: JSON.stringify({ answers }) });

// Agent SDK chat (full tool calling via session endpoint)
export async function runAgent({ sessionId, cwd, prompt, options = {}, onSystem, onAssistant, onToolResult, onToolUse, onAskUser, onDone, onError }) {
  const body = { prompt, cwd, options };

  let response;
  try {
    response = await fetch(`${BASE}/session/${sessionId}/message?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    onError?.(new Error(`无法连接服务器: ${err.message}`));
    return;
  }

  if (!response.ok) {
    try {
      const err = await response.json();
      onError?.(new Error(err.error || `HTTP ${response.status}`));
    } catch {
      onError?.(new Error(`HTTP ${response.status}`));
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        // Reader error — stream interrupted
        if (!currentEvent) onError?.(new Error(`连接中断: ${err.message}`));
        break;
      }
      const { done, value } = chunk;
      if (done) break;

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

                  if (textBlocks.length > 0) {
                    onAssistant?.({ uuid: parsed.uuid, session_id: parsed.session_id, content: textBlocks.map(t => t.text).join(''), raw: parsed.message });
                  }
                  if (toolBlocks.length > 0) {
                    toolBlocks.forEach(t => onToolUse?.({ uuid: parsed.uuid, session_id: parsed.session_id, tool: t.name, input: t.input, tool_use_id: t.id }));
                  }
                } else if (parsed.type === 'user') {
                  const content = parsed.message?.content || [];
                  const toolResults = content.filter(c => c.type === 'tool_result');
                  if (toolResults.length > 0) {
                    toolResults.forEach(t => onToolResult?.({ tool_use_id: t.tool_use_id, content: t.content, is_error: t.is_error }));
                  }
                }
                break;

              case 'ask_user':
                onAskUser?.(parsed);
                break;

              case 'done':
                onDone?.(parsed);
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
  } catch (err) {
    onError?.(err);
  }
}
