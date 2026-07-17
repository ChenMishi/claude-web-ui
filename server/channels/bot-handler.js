/**
 * Bot 消息处理 — 企微消息走 Web UI 完全相同的 POST /session/:id/message 路径
 * 支持命令: 切换会话 / 列表 → 编号选择 → 绑定新会话
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const MAP = path.join(os.homedir(), '.claude-web-ui', 'bot-sessions.json');
const C_PROJ = path.join(os.homedir(), '.claude', 'projects');

function port() { return parseInt(process.env.PORT) || 3000; }
function cfg() { try { const p = path.resolve(__dirname, '..', '..', 'provider-config.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; }}
function tok() { const f = path.join(os.homedir(), '.claude-web-ui', '.internal-token'); try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); } catch {} const t = require('crypto').randomBytes(32).toString('hex'); const d = path.dirname(f); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(f, t, 'utf8'); return t; }
function load() { try { return fs.existsSync(MAP) ? JSON.parse(fs.readFileSync(MAP, 'utf8')) : {}; } catch { return {}; }}
function save(m) { const d = path.dirname(MAP); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(MAP, JSON.stringify(m, null, 2), 'utf8'); }

function sessionExists(id) {
  if (id === 'new' || !id) return false;
  if (!fs.existsSync(C_PROJ)) return false;
  for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(C_PROJ, e.name, `${id}.jsonl`))) return true;
  }
  return false;
}

/** 列出当前项目所有会话 */
function listSessions() {
  const result = [];
  if (!fs.existsSync(C_PROJ)) return result;
  const homedir = os.homedir();
  // Find the matching project dir for homedir
  let rootDir = null;
  for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const cwdFile = path.join(C_PROJ, e.name, '.cwd');
    let cwd = '';
    try { if (fs.existsSync(cwdFile)) cwd = fs.readFileSync(cwdFile, 'utf8').trim(); } catch {}
    if (cwd === homedir || (!cwd && e.name === '-root')) { rootDir = path.join(C_PROJ, e.name); break; }
  }
  if (!rootDir) return result;
  for (const f of fs.readdirSync(rootDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const sid = f.replace('.jsonl', '');
    const jp = path.join(rootDir, f);
    let title = sid.slice(0, 8), channelName = null;
    const mp = path.join(rootDir, `${sid}.meta.json`);
    if (fs.existsSync(mp)) {
      try { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); if (m.title) title = m.title; channelName = m.channelName || null; } catch {}
    }
    if (channelName && !title.startsWith(`${channelName}:`)) title = `${channelName}: ${title}`;
    let ts = 0; try { ts = fs.statSync(jp).mtimeMs; } catch {}
    result.push({ id: sid, title, ts });
  }
  result.sort((a, b) => b.ts - a.ts);
  return result;
}

/** 读取会话最近2条用户消息，以及每条用户消息之后的所有Claude回复 */
function recentMessages(sid) {
  if (!fs.existsSync(C_PROJ)) return [];
  for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const jp = path.join(C_PROJ, e.name, `${sid}.jsonl`);
    if (!fs.existsSync(jp)) continue;
    try {
      const lines = fs.readFileSync(jp, 'utf8').split('\n').filter(Boolean);
      // Parse all messages
      const all = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          const obj = JSON.parse(lines[i]);
          const content = obj.message?.content || [];
          if (obj.type === 'user') {
            const text = Array.isArray(content)
              ? content.filter(c => c.type === 'text').map(c => c.text).join('')
              : (typeof content === 'string' ? content : '');
            if (text) all.push({ role: 'user', text });
          } else if (obj.type === 'assistant' && Array.isArray(content)) {
            const reply = content.filter(c => c.type === 'text').map(c => c.text).join('');
            if (reply) all.push({ role: 'assistant', text: reply });
          }
        } catch {}
      }

      // Find indices of last 2 user messages
      const userIndices = [];
      for (let i = 0; i < all.length; i++) {
        if (all[i].role === 'user') userIndices.push(i);
      }
      const startIdx = userIndices.length >= 2 ? userIndices[userIndices.length - 2] : (userIndices[0] || 0);

      // Collect from the 2nd-to-last user onward
      const result = [];
      for (let i = startIdx; i < all.length; i++) {
        const m = all[i];
        if (m.role === 'user') {
          result.push(`👤 用户：\n${m.text.slice(0, 120)}`);
        } else {
          result.push(`🤖 助手：\n${m.text.slice(0, 120)}`);
        }
      }
      return result;
    } catch {}
  }
  return [];
}

// ── Session selection state ──
const PENDING = new Map();

function cleanPending() {
  const now = Date.now();
  for (const [k, v] of PENDING) { if (now > v.deadline) PENDING.delete(k); }
}

/** @returns {{ reply: string, sessionId: string|null }} */
async function botMessage(channelType, userId, text, channelCfg) {
  const c = cfg();
  if (!c || !c.model) return { reply: 'Provider 未配置' };

  const map = load();
  const key = `${channelType}:${userId}`;
  const saved = map[key];
  const sid = (saved && sessionExists(saved)) ? saved : 'new';

  // ── 命令: 切换会话 / 会话列表 ──
  if (/^(切换会话|会话列表|切换|列表|ls|sessions)/i.test(text.trim())) {
    const sessions = listSessions();
    if (sessions.length === 0) return { reply: '暂无可用会话', sessionId: sid };
    const current = (saved && sessionExists(saved)) ? saved : null;
    let resp = '📋 会话列表（回复编号选择）：\n';
    for (let i = 0; i < Math.min(sessions.length, 15); i++) {
      const s = sessions[i];
      const mark = s.id === current ? ' ← 当前' : '';
      resp += `[${i + 1}] ${s.title}${mark}\n`;
    }
    PENDING.set(userId, { sessions, deadline: Date.now() + 60000 });
    cleanPending();
    return { reply: resp, sessionId: sid };
  }

  // ── 命令: 选择会话编号 ──
  const numMatch = text.trim().match(/^(\d+)$/);
  if (numMatch && PENDING.has(userId)) {
    const pending = PENDING.get(userId);
    if (Date.now() > pending.deadline) { PENDING.delete(userId); return { reply: '会话选择已过期，请重新发送"切换会话"', sessionId: sid }; }
    const idx = parseInt(numMatch[1]) - 1;
    if (idx < 0 || idx >= pending.sessions.length) {
      return { reply: `请输入 1-${pending.sessions.length} 之间的编号`, sessionId: sid };
    }
    const target = pending.sessions[idx];
    map[key] = target.id;
    save(map);
    PENDING.delete(userId);
    const recent = recentMessages(target.id);
    let resp = `✅ 已切换到 ${target.title}\n\n`;
    if (recent.length === 0) resp += '(暂无消息)';
    else resp += recent.join('\n\n');
    return { reply: resp, sessionId: target.id };
  }

  // ── 正常对话 ──
  const body = {
    prompt: text, cwd: os.homedir(),
    options: { model: c.model || '', systemPrompt: channelCfg.systemPrompt || '', permissionLevel: 'auto' },
  };

  try {
    const resp = await fetch(`http://127.0.0.1:${port()}/api/session/${sid}/message?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-internal-token': tok() },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
    });
    if (!resp.ok) return { reply: `错误 (${resp.status})` };

    const textBuf = await resp.text();
    let reply = '', newSid = null, ev = '';

    for (const raw of textBuf.split('\n')) {
      const l = raw.trim();
      if (l.startsWith('event: ')) { ev = l.slice(7).trim(); continue; }
      if (!l.startsWith('data: ')) continue;
      try {
        const j = JSON.parse(l.slice(6));
        if (ev === 'session' && j.sessionId && sid === 'new') newSid = j.sessionId;
        else if (ev === 'message' && j.type === 'assistant')
          reply += (j.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      } catch {} ev = '';
    }

    if (newSid) {
      map[key] = newSid; save(map);
      // Only tag NEW sessions created by bot — don't touch existing ones from user switching
      try {
        const realSid = newSid;
        let projDir = null;
        if (fs.existsSync(C_PROJ)) {
          for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (fs.existsSync(path.join(C_PROJ, e.name, `${realSid}.jsonl`))) { projDir = path.join(C_PROJ, e.name); break; }
          }
        }
        if (projDir) {
          const mp = path.join(projDir, `${realSid}.meta.json`);
          const existing = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : {};
          existing.source = 'bot';
          existing.channelName = channelType === 'wechat' ? '企微Bot' : channelType;
          fs.writeFileSync(mp, JSON.stringify(existing), 'utf8');
        }
      } catch {}
    }
    return { reply: reply || '未生成回复', sessionId: newSid || sid };
  } catch (err) {
    if (err.name === 'AbortError') return { reply: '请求超时，请重试' };
    return { reply: `处理出错: ${err.message}` };
  }
}

module.exports = {
  botMessage, getInternalToken: tok,
  sessionToUser(sessionId) {
    const map = load();
    for (const [key, sid] of Object.entries(map)) {
      if (sid === sessionId) { const [ct, uid] = key.split(':'); return { userId: uid, channelType: ct }; }
    }
    return null;
  },
  async pushToUser(sessionId, text, channelId) {
    const user = this.sessionToUser(sessionId);
    if (!user) return false;
    const { getChannelManager } = require('./index');
    const mgr = getChannelManager();
    const ch = channelId ? mgr.get(channelId) : [...mgr.channels.values()].find(c => c.constructor.type === user.channelType);
    if (!ch) return false;
    return ch.sendText(user.userId, text);
  },
};
