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

/** 从项目目录读取当前活跃工作目录（扫描最近修改的项目） */
function getDefaultCwd() {
  // Prefer explicit sync file set by Web UI
  const f = path.join(os.homedir(), '.claude-web-ui', 'bot-current-project.json');
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (d.cwd && fs.existsSync(d.cwd)) return d.cwd;
    }
  } catch {}
  return os.homedir();
}

/** session map key: {channelType}:{userId}:{cwdHash} — each project has its own session */
function mapKey(channelType, userId, cwd) {
  const h = require('crypto').createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return `${channelType}:${userId}:${h}`;
}

function sessionExists(id, cwd) {
  if (id === 'new' || !id) return false;
  if (!fs.existsSync(C_PROJ)) return false;
  for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const cf = path.join(C_PROJ, e.name, '.cwd');
    let dcwd = '';
    try { if (fs.existsSync(cf)) dcwd = fs.readFileSync(cf, 'utf8').trim(); } catch {}
    if (dcwd !== cwd) continue;  // Only match current project
    if (fs.existsSync(path.join(C_PROJ, e.name, `${id}.jsonl`))) return true;
  }
  return false;
}


/** 列出指定工作目录下的所有会话 */
function listSessionsForCwd(targetCwd) {
  const result = [];
  if (!fs.existsSync(C_PROJ)) return result;
  for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const cf = path.join(C_PROJ, e.name, '.cwd');
    let cwd = '';
    try { if (fs.existsSync(cf)) cwd = fs.readFileSync(cf, 'utf8').trim(); } catch {}
    if (cwd !== targetCwd) continue;
    const pDir = path.join(C_PROJ, e.name);
    for (const f of fs.readdirSync(pDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.replace('.jsonl', '');
      const jp = path.join(pDir, f);
      let title = sid.slice(0, 8), channelName = null;
      const mp = path.join(pDir, `${sid}.meta.json`);
      if (fs.existsSync(mp)) {
        try { const m = JSON.parse(fs.readFileSync(mp, 'utf8')); if (m.title) title = m.title; channelName = m.channelName || null; } catch {}
      }
      if (channelName && !title.startsWith(`${channelName}:`)) title = `${channelName}: ${title}`;
      let ts = 0; try { ts = fs.statSync(jp).mtimeMs; } catch {}
      result.push({ id: sid, title, ts });
    }
  }
  result.sort((a, b) => b.ts - a.ts);
  return result;
}

function listSessions() {
  return listSessionsForCwd(getDefaultCwd());
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

// ── Pending selection state: { type:'session'|'dir', items, deadline } ──
const PENDING = new Map();

function cleanPending() {
  const now = Date.now();
  for (const [k, v] of PENDING) { if (now > v.deadline) PENDING.delete(k); }
}

/** 邮件渠道：直接以助手消息写入 JSONL，不调 Claude */
async function displayEmail(text, channelCfg, workCwd, map, key, channelType) {
  const saved = map[key];
  const sid = (saved && sessionExists(saved, workCwd)) ? saved : 'new';
  let realSid = sid;

  try {
    if (sid === 'new') {
      realSid = require('crypto').randomUUID();
      map[key] = realSid; save(map);
    }

    // Write directly to first project dir with matching cwd
    let jsonlPath = null, projDir = null;
    if (fs.existsSync(C_PROJ)) {
      for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const cf = path.join(C_PROJ, e.name, '.cwd');
        let dcwd = '';
        try { if (fs.existsSync(cf)) dcwd = fs.readFileSync(cf, 'utf8').trim(); } catch {}
        if (dcwd !== workCwd) continue;
        jsonlPath = path.join(C_PROJ, e.name, `${realSid}.jsonl`);
        projDir = path.join(C_PROJ, e.name);
        break;
      }
    }
    // Fallback: use -root project
    if (!jsonlPath) {
      jsonlPath = path.join(C_PROJ, '-root', `${realSid}.jsonl`);
      projDir = path.join(C_PROJ, '-root');
    }

    if (jsonlPath) {
      const assistantMsg = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        timestamp: new Date().toISOString(),
      });
      fs.appendFileSync(jsonlPath, assistantMsg + '\n', 'utf8');
      console.log('[bot] displayEmail: wrote to', jsonlPath);

      const mp = path.join(projDir, `${realSid}.meta.json`);
      const existing = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : {};
      if (!existing.source) {
        existing.source = 'bot'; existing.channelName = channelCfg.name || '邮件Bot';
        fs.writeFileSync(mp, JSON.stringify(existing), 'utf8');
      }
      // Return valid sessionId so frontend gets notified
      return { reply: null, sessionId: realSid };
    }
    // No file written — don't notify
    return { reply: null, sessionId: null };
  } catch (err) {
    console.error('[bot] displayEmail error:', err.message);
    return { reply: null, sessionId: sid };
  }
}

/** 列出所有项目目录 */
function listProjects() {
  const result = [];
  if (!fs.existsSync(C_PROJ)) return result;
  const seen = new Set();
  for (const e of fs.readdirSync(C_PROJ, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const cf = path.join(C_PROJ, e.name, '.cwd');
    let cwd = '';
    try { if (fs.existsSync(cf)) cwd = fs.readFileSync(cf, 'utf8').trim(); } catch {}
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    result.push(cwd);
  }
  result.sort();
  return result;
}

/** @returns {{ reply: string, sessionId: string|null }} */
async function botMessage(channelType, userId, text, channelCfg) {
  const c = cfg();
  if (!c) return { reply: 'Provider 配置文件不存在，请先在设置→初始化中配置 Provider' };

  // Fallback: use first available provider if model is not set
  let model = c.model || '';
  if (!model && c.providers && c.providers.length > 0) {
    const p = c.providers[0];
    const firstModel = ((c.providerModels || {})[p.id] || {}).selected?.[0]
      || ((c.providerModels || {})[p.id] || {}).available?.[0];
    model = firstModel ? `${p.id}/${firstModel}` : '';
  }
  if (!model) return { reply: 'Provider 未配置模型，请在 Web UI 中先拉取并选择模型' };

  const workCwd = getDefaultCwd();
  const map = load();
  const uid = channelType === 'email' ? 'all' : userId;
  const key = mapKey(channelType, uid, workCwd);

  // ── 邮件渠道：直接展示，不调 Claude ──
  if (channelType === 'email') return displayEmail(text, channelCfg, workCwd, map, key, channelType);
  const saved = map[key];
  const sid = (saved && sessionExists(saved, workCwd)) ? saved : 'new';

  // ── 命令: 切换目录（before 切换会话, since "切换" also matches 切换目录） ──
  if (/^(切换目录|项目列表|工作目录|目录)/i.test(text.trim())) {
    const dirs = listProjects();
    if (dirs.length === 0) return { reply: '暂无可用项目目录', sessionId: sid };
    let resp = '📁 项目目录列表（回复编号选择）：\n';
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      const mark = d === workCwd ? ' ← 当前' : '';
      resp += `[${i + 1}] ${d}${mark}\n`;
    }
    PENDING.set(userId, { type: 'dir', items: dirs, deadline: Date.now() + 60000 });
    cleanPending();
    return { reply: resp, sessionId: sid };
  }

  // ── 命令: 切换会话 / 会话列表 ──
  if (/^(切换会话|会话列表|切换|列表|ls|sessions)/i.test(text.trim())) {
    const sessions = listSessions();
    if (sessions.length === 0) return { reply: '暂无可用会话', sessionId: sid };
    const current = (saved && sessionExists(saved, workCwd)) ? saved : null;
    let resp = '📋 会话列表（回复编号选择）：\n';
    for (let i = 0; i < Math.min(sessions.length, 15); i++) {
      const s = sessions[i];
      const mark = s.id === current ? ' ← 当前' : '';
      resp += `[${i + 1}] ${s.title}${mark}\n`;
    }
    PENDING.set(userId, { type: 'session', items: sessions, deadline: Date.now() + 60000 });
    cleanPending();
    return { reply: resp, sessionId: sid };
  }

  // ── 命令: 选择编号（会话/目录） ──
  const numMatch = text.trim().match(/^(\d+)$/);
  if (numMatch && PENDING.has(userId)) {
    const pending = PENDING.get(userId);
    if (Date.now() > pending.deadline) { PENDING.delete(userId); return { reply: '选择已过期，请重新发送命令', sessionId: sid }; }
    const idx = parseInt(numMatch[1]) - 1;
    if (idx < 0 || idx >= pending.items.length) {
      return { reply: `请输入 1-${pending.items.length} 之间的编号`, sessionId: sid };
    }
    PENDING.delete(userId);

    // ── 目录选择 ──
    if (pending.type === 'dir') {
      const newCwd = pending.items[idx];
      const f = path.join(os.homedir(), '.claude-web-ui', 'bot-current-project.json');
      const d = path.dirname(f);
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ cwd: newCwd, ts: Date.now() }), 'utf8');

      // List sessions in this directory for user to choose binding
      const sessions = listSessionsForCwd(newCwd);
      PENDING.set(userId, { type: 'session', items: sessions, deadline: Date.now() + 60000 });

      let resp = `✅ 已切换到 ${newCwd}`;
      if (sessions.length > 0) {
        resp += `\n\n📋 该目录下的会话（回复编号绑定，或直接发消息自动创建）：\n`;
        for (let i = 0; i < Math.min(sessions.length, 15); i++) {
          const s = sessions[i];
          resp += `[${i+1}] ${s.title}\n`;
        }
      } else {
        resp += '\n\n该目录暂无会话，直接发消息将自动创建。';
      }
      return { reply: resp, sessionId: 'new' };
    }

    // ── 会话选择 ──
    const target = pending.items[idx];
    map[key] = target.id;
    save(map);
    const recent = recentMessages(target.id);
    let resp = `✅ 已切换到 ${target.title}\n\n`;
    if (recent.length === 0) resp += '(暂无消息)';
    else resp += recent.join('\n\n');
    return { reply: resp, sessionId: target.id };
  }

  // ── 正常对话 ──

  const body = {
    prompt: text, cwd: workCwd,
    options: { model, systemPrompt: channelCfg.systemPrompt || '', permissionLevel: 'auto' },
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
          existing.channelName = channelCfg.name || (channelType === 'wechat' ? '企微Bot' : channelType === 'email' ? '邮件Bot' : channelType);
          fs.writeFileSync(mp, JSON.stringify(existing), 'utf8');
        }
      } catch {}
    } else {
      // Existing session — no need to update cwd, always read from getDefaultCwd()
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
    for (const [key, val] of Object.entries(map)) {
      const sid = typeof val === 'string' ? val : (val?.sid || val?.sessionId);
      if (sid === sessionId) {
        // key format: channelType:userId or channelType:userId:cwdHash
        const [ct, ...rest] = key.split(':');
        const uid = rest.length > 1 ? rest[0] : rest.join('');
        return { userId: uid, channelType: ct };
      }
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
