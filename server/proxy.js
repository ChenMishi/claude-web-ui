/**
 * 内置 HTTP 反向代理 — 替代 CC-Switch
 *
 * 监听 127.0.0.1:15721，SDK 将请求发到这里，
 * 代理读取 provider-config.json 注入 API Key 后转发到上游。
 *
 * 支持：
 *  - 普通 JSON 请求/响应
 *  - SSE (Server-Sent Events) 流式转发
 *  - 配置热加载（每次请求都读取最新配置文件）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const logTs = () => new Date().toLocaleString("sv-SE");
const PROJECT_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_DIR, 'provider-config.json');

let logFile = null;
try {
  const LOG_DIR = path.join(PROJECT_DIR, 'logs');
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  logFile = path.join(LOG_DIR, 'proxy.log');
} catch {}

function proxyLog(msg) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${logTs()} ${msg}\n`);
  } catch {}
}

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      // Return a dummy config so the proxy starts but rejects requests gracefully
      return { apiKey: '', baseUrl: '', model: '' };
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    proxyLog(`读取配置失败: ${err.message}`);
    return { apiKey: '', baseUrl: '', model: '' };
  }
}

// ── 请求体结构清洗（代理层统一兜底，Bug #11 回归 / system 400 / role 错位 / CLI 注入）──
// Claude Code SDK live 运行时内存里的 messages 不经 session.js 磁盘清洗，脏结构会直达代理：
//   - content 数组里缺 text 键 / 空 / 纯空白的 text 块 → 上游 SGLang 400（Bug #11 回归）
//   - messages 里 role:system 的消息 → 经 ApiRouter 转 OpenAI 后 system 不在首位 → 400
//   - 相邻同 role / 首条非 user / 纯 text 块数组 → 上游交替校验 400
//   - CLI 注入的 continue 消息 → 上下文污染、任务中断（Bug #12/#14 live 兜底）
// 这里对请求体做统一清洗，session.js 磁盘清洗继续保留（双保险）。
const INJECTED_PREFIXES = [
  '[Your previous response had no visible output',
  'Continue from where you left off',
  'The previous response failed to produce a valid tool call',
  'Your tool call was malformed',
];

function extractText(content) {
  if (typeof content === 'string') return content.trim() ? content : '';
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('\n').trim();
  }
  return '';
}

// 清洗单条消息的 content：剔除空/缺 text 键的 text 块；aggressive 时剥 thinking、cache_control
function sanitizeContent(content, aggressive) {
  if (typeof content === 'string') return { blocks: content, changed: false, empty: !content.trim() };
  if (!Array.isArray(content)) return { blocks: content, changed: false, empty: false };
  const out = [];
  let changed = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') { changed = true; continue; }
    if (b.type === 'text') {
      const t = String(b.text || '');
      if (!t.trim()) { changed = true; continue; }        // 空/缺 text 键 → 剔除（Bug #11）
      let nb = b;
      if (b.text !== t) { nb = { ...b, text: t }; changed = true; }
      if (aggressive && nb.cache_control) { delete nb.cache_control; changed = true; }
      out.push(nb);
    } else if (b.type === 'thinking') {
      if (aggressive) { changed = true; continue; }        // aggressive：剥 thinking
      out.push(b);
    } else if (b.type === 'tool_result') {
      const nested = sanitizeContent(b.content, aggressive);
      if (nested.changed) { b.content = nested.empty ? '' : nested.blocks; changed = true; }
      out.push(b);
    } else {
      if (aggressive && b.cache_control) { delete b.cache_control; changed = true; }
      out.push(b);
    }
  }
  return { blocks: out, changed, empty: out.length === 0 };
}

// 统一清洗请求体：返回 { changed: 是否改动, structural: 是否有结构性修复（用于日志） }
function sanitizeRequestBody(body, aggressive) {
  let changed = false, structural = false;
  const mark = (isStructural) => { changed = true; if (isStructural) structural = true; };

  // 1) role:system 消息 → 并入顶层 system 字段（上游要求 system 在首位）
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sysParts = [];
  if (typeof body.system === 'string') {
    if (body.system.trim()) sysParts.push({ text: body.system });
  } else if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (b && b.type === 'text' && String(b.text || '').trim()) {
        sysParts.push({ text: String(b.text), cache_control: aggressive ? undefined : b.cache_control });
      }
    }
  }
  const keptMsgs = [];
  for (const m of msgs) {
    if (m && m.role === 'system') {
      const t = extractText(m.content);
      if (t) sysParts.push({ text: t });
      mark(true);
    } else {
      keptMsgs.push(m);
    }
  }
  if (keptMsgs.length !== msgs.length) body.messages = keptMsgs;
  if (sysParts.length === 0) {
    if (body.system !== undefined) { delete body.system; mark(true); }
  } else if (sysParts.length === 1 && !sysParts[0].cache_control) {
    if (body.system !== sysParts[0].text) { body.system = sysParts[0].text; mark(true); }
  } else {
    const arr = sysParts.map(p => p.cache_control
      ? { type: 'text', text: p.text, cache_control: p.cache_control }
      : { type: 'text', text: p.text });
    if (JSON.stringify(body.system) !== JSON.stringify(arr)) { body.system = arr; mark(true); }
  }

  // 2) 清洗 messages 数组
  if (Array.isArray(body.messages)) {
    const cleanMsgs = [];
    for (const m of body.messages) {
      if (!m || typeof m !== 'object' || !m.role) { mark(true); continue; }
      // CLI 注入消息 / 占位回复 → 整条丢弃（live 兜底，Bug #12/#14）
      if (m.role === 'user' && INJECTED_PREFIXES.some(p => extractText(m.content).startsWith(p))) { mark(true); continue; }
      if (m.role === 'assistant' && extractText(m.content) === 'No response requested.') { mark(true); continue; }
      const r = sanitizeContent(m.content, aggressive);
      if (r.empty) { mark(true); continue; }               // 内容全空 → 整条丢弃
      if (r.changed) { m.content = r.blocks; mark(true); }
      // 纯 text 块数组 → 拍平成 string（上游 SGLang 对非 thinking 消息 content 要求字符串）
      if (Array.isArray(m.content) && m.content.length > 0
          && m.content.every(b => b && b.type === 'text' && !b.cache_control)) {
        m.content = m.content.map(b => b.text).join('\n');
        mark(false);
      }
      cleanMsgs.push(m);
    }
    // 相邻同 role 合并（上游交替校验 user,assistant,user,...）
    const merged = [];
    for (const m of cleanMsgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) {
        if (typeof last.content === 'string' && typeof m.content === 'string') {
          last.content += '\n' + m.content;
        } else {
          const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
          const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
          last.content = a.concat(b);
        }
        mark(true);
      } else {
        merged.push(m);
      }
    }
    body.messages = merged;
    // 首条必须 user：丢弃开头的 assistant/system
    while (body.messages.length > 0 && body.messages[0].role !== 'user') { body.messages.shift(); mark(true); }
    // 空对话兜底
    if (body.messages.length === 0) {
      body.messages = [{ role: 'user', content: '（空对话，请继续）' }];
      mark(true);
    }
  }

  return { changed, structural };
}

function createProxy() {
  const server = http.createServer(async (req, res) => {
    const config = readConfig();

    let apiKey = config.apiKey;
    let baseUrl = config.baseUrl;
    let chatUrl = config.chatUrl;

    // Read body and route by model name
    let requestBody = '';
    let bodyObj = null;
    try {
      const rawBody = await readBody(req);
      if (rawBody.length > 0) {
        requestBody = rawBody.toString();
        bodyObj = JSON.parse(requestBody);
        const modelName = bodyObj.model || '';
        const slashIdx = modelName.indexOf('/');
        if (slashIdx > 0) {
          const realModel = modelName.slice(slashIdx + 1);
          // Match by provider name (guaranteed unique) or ID as fallback
          const searchKey = modelName.slice(0, slashIdx);
          for (const p of (config.providers || [])) {
            if ((p.name === searchKey || p.id === searchKey) && p.apiKey && p.baseUrl) {
              apiKey = p.apiKey;
              baseUrl = p.baseUrl;
              chatUrl = p.chatUrl || '';
              break;
            }
          }
          bodyObj.model = realModel;
        }
        // ── 请求体结构清洗（代理层统一兜底，见 sanitizeRequestBody）──
        // SDK live 运行时的内存 messages 不经 session.js 磁盘清洗，空 text 块 / system 错位 /
        // role 错位 / CLI 注入 continue 都可能在代理层堵住并 400。这里在转发前统一清洗。
        try {
          const clean = sanitizeRequestBody(bodyObj, false);
          if (clean.changed) requestBody = JSON.stringify(bodyObj);
          if (clean.structural) {
            proxyLog(`[CLEAN] ${bodyObj.model || ''} 结构修复：空块/system错位/role错位/注入消息`);
          }
        } catch (ce) { proxyLog(`[CLEAN] 清洗失败: ${ce.message}`); }
      }
    } catch (e) {
      proxyLog(`Body routing failed: ${e.message}`);
    }

    if (!apiKey || !baseUrl) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: '代理未配置 — 请在初始化页面填写 API Key 和 Base URL',
      }));
      proxyLog('请求被拒绝: 代理未配置');
      return;
    }

    const upstreamBase = chatUrl || baseUrl;
    const upstreamUrl = upstreamBase.replace(/\/$/, '') + req.url;
    const headers = { ...req.headers };

    // 清除代理相关头
    delete headers['host'];
    delete headers['connection'];
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    delete headers['proxy-authenticate'];
    // 关键：禁止向上游请求压缩。Node fetch 会按上游返回的 content-encoding 自动解压 body，
    // 但解压后 upstream.headers 仍保留 content-encoding 头。若透传给 SDK 客户端，
    // 客户端收到 content-encoding: gzip 却拿到已解压的明文 body → 解压崩溃（Z_DATA_ERROR）
    // → 表现为"任务突然中断"。删除 accept-encoding 让上游返回明文，从源头避免该问题。
    delete headers['accept-encoding'];

    // 注入真实的 API Key
    headers['x-api-key'] = apiKey;
    headers['authorization'] = `Bearer ${apiKey}`;
    headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';

    if (req.method === 'GET' || req.method === 'HEAD') {
      delete headers['content-type'];
      delete headers['content-length'];
    }

    // ── 诊断：识别 DeepSeek 系列模型 + 是否流式，用于空响应抓包（Bug #14 排查） ──
    let diagModel = '';
    let diagIsStream = false;
    let diagIsDeepSeek = false;
    try {
      const bo = JSON.parse(requestBody);
      diagModel = bo.model || '';
      diagIsStream = !!bo.stream;
      diagIsDeepSeek = /deepseek/i.test(diagModel);
    } catch {}

    proxyLog(`${req.method} ${req.url} → ${upstreamBase.replace(/\/\/.*@/, '//***@')}`);

    try {
      const fetchOptions = {
        method: req.method,
        headers,
        signal: AbortSignal.timeout(300000),
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOptions.body = requestBody;
        if (requestBody) headers['content-length'] = String(Buffer.byteLength(requestBody));
      }

      const upstream = await fetch(upstreamUrl, fetchOptions);

      // ── 400 兜底重试（最后防线）──
      // 结构性 400（空块/system 错位/role 错位等）若基础清洗遗漏，用更激进清洗（剥 thinking、
      // cache_control）后重试一次。命中 400 时先把错误体读干净，决定不重试再用它重建响应。
      if (upstream.status === 400 && req.method !== 'GET' && req.method !== 'HEAD' && requestBody) {
        const reader = upstream.body && upstream.body.getReader();
        let errText = '';
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              errText += Buffer.from(value).toString('utf8');
            }
          } finally { try { reader.releaseLock(); } catch {} }
        }
        proxyLog(`[400] ${req.method} ${req.url} ${errText.slice(0, 300)}`);
        let retried = false;
        try {
          const bo = JSON.parse(requestBody);
          const agg = sanitizeRequestBody(bo, true);
          if (agg.changed) {
            requestBody = JSON.stringify(bo);
            fetchOptions.body = requestBody;
            headers['content-length'] = String(Buffer.byteLength(requestBody));
            upstream = await fetch(upstreamUrl, fetchOptions);
            retried = true;
            proxyLog(`[400][RETRY] aggressive cleaned → ${upstream.status}`);
          }
        } catch (re) { proxyLog(`[400][RETRY] 失败: ${re.message}`); }
        if (!retried) {
          // 未重试：用缓冲的 400 响应重建，走下方正常转发
          const hdrs = {};
          for (const [k, v] of upstream.headers) hdrs[k] = v;
          upstream = new Response(errText, { status: 400, statusText: upstream.statusText, headers: hdrs });
        }
      }

      // 转发状态码和头
      const responseHeaders = {};
      for (const [k, v] of upstream.headers) {
        // 跳过 hop-by-hop 头 + 压缩相关头。
        // content-encoding: Node fetch 已自动解压 body（见上方 accept-encoding 注释），
        //   若透传 gzip 头 + 明文 body → 客户端解压崩溃 → 任务中断。
        // content-length: 解压后长度已变化，透传会与真实 body 不符；Node 会用 chunked 自动补。
        if (['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate',
             'proxy-authorization', 'te', 'trailer', 'upgrade',
             'content-encoding', 'content-length'].includes(k.toLowerCase())) {
          continue;
        }
        responseHeaders[k] = v;
      }

      res.writeHead(upstream.status, responseHeaders);

      // ── DeepSeek 空响应守护 + 诊断（Bug #14） ──
      // 根因：DeepSeek-V4-Flash-0731 经 ApiRouter 偶发返回空/无可见输出响应（content 全空、
      // stop_reason=end_turn）。Claude Code CLI 判定"无可见输出"后注入
      //   [Your previous response had no visible output. Please continue...]
      // 模型误解为续写指令 → 产出乱码（如 "bash()</parameter>Looking for bask..."）→ 再次空输出
      // → 循环 → 任务突然中断。Bug #12 的注入清洗只对 resume 生效，挡不住 live 运行。
      //
      // 修复：对 DeepSeek 流式响应逐事件转发（保留实时性），在 message_delta(end_turn) 时若
      // content 全空，紧接其后、message_stop 前注入一个非空 text block，让 CLI 判定"有可见输出"，
      // 不再注入 continue。同时落盘诊断铁证。
      // 非流式响应同样兜底：空 content 时注入 text 后再返回。
      const isSSE = /text\/event-stream/i.test(upstream.headers.get('content-type') || '');
      const guardActive = diagIsDeepSeek && isSSE && diagIsStream && upstream.status === 200;
      const guardNonStream = diagIsDeepSeek && !diagIsStream && upstream.status === 200
        && /application\/json/i.test(upstream.headers.get('content-type') || '');
      let gBlocks = {};          // index -> {type, textLen, trimmedNonEmpty, tool}
      let gStopReason = null;
      let gInjected = false;
      const PLACEHOLDER = '（本轮模型未产生可见输出，已自动占位以继续对话）';
      // text 块 trim 后是否非空（CLI 据此判定"有可见输出"，纯空白 text 仍算无输出）
      const blockHasVisibleText = b => b.type === 'text' && b.trimmedNonEmpty;

      // HEAD / 204 / 304 等响应没有 body，直接结束
      if (!upstream.body) {
        res.end();
      } else if (guardNonStream) {
        // ── 非流式 DeepSeek：缓冲整个 JSON 响应，空 content 时注入 text ──
        const reader = upstream.body.getReader();
        let chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        let bodyStr = Buffer.concat(chunks).toString('utf8');
        try {
          const bj = JSON.parse(bodyStr);
          const hasText = (bj.content || []).some(b => b.type === 'text' && String(b.text || '').trim());
          const hasTool = (bj.content || []).some(b => b.type === 'tool_use');
          if (!hasText && !hasTool && bj.stop_reason === 'end_turn') {
            bj.content = [{ type: 'text', text: PLACEHOLDER }];
            bodyStr = JSON.stringify(bj);
            gInjected = true;
            proxyLog(`[GUARD][NONSTREAM][INJECT] model=${diagModel} stop=${bj.stop_reason} — 注入占位 text`);
            try {
              fs.writeFileSync(path.join(PROJECT_DIR, 'logs', `empty-resp-${Date.now()}.txt`),
                `model=${diagModel}\nstop_reason=${bj.stop_reason}\nmode=nonstream\nINJECTED_PLACEHOLDER\nrequestBody=${requestBody.slice(0, 2000)}\n`, 'utf8');
            } catch {}
          }
        } catch {}
        res.write(bodyStr);
        res.end();
      } else if (guardActive) {
        // ── 流式 DeepSeek：逐事件转发，空响应时在 message_stop 前注入 text block ──
        const reader = upstream.body.getReader();
        let evtBuf = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            evtBuf += Buffer.from(value).toString('utf8');
            let sep;
            while ((sep = evtBuf.indexOf('\n\n')) >= 0) {
              const rawEvt = evtBuf.slice(0, sep);
              evtBuf = evtBuf.slice(sep + 2);
              // 解析事件
              let ev = null;
              for (const ln of rawEvt.split('\n')) {
                if (ln.startsWith('data: ')) { try { ev = JSON.parse(ln.slice(6)); } catch {} }
              }
              if (ev) {
                if (ev.type === 'content_block_start') {
                  const cb = ev.content_block || {};
                  gBlocks[ev.index] = { type: cb.type, textLen: 0, trimmedNonEmpty: false, tool: cb.name || '' };
                } else if (ev.type === 'content_block_delta') {
                  const d = ev.delta || {};
                  if (d.type === 'text_delta' && gBlocks[ev.index]) {
                    gBlocks[ev.index].textLen += (d.text || '').length;
                    if ((d.text || '').trim()) gBlocks[ev.index].trimmedNonEmpty = true;
                  }
                } else if (ev.type === 'message_delta') {
                  gStopReason = (ev.delta || {}).stop_reason || gStopReason;
                }
              }
              // 转发原始事件
              res.write(rawEvt + '\n\n');
              // ── 注入点：message_delta(end_turn) 后、message_stop 前 ──
              if (ev && ev.type === 'message_delta' && gStopReason === 'end_turn' && !gInjected) {
                const hasText = Object.values(gBlocks).some(blockHasVisibleText);
                const hasTool = Object.values(gBlocks).some(b => b.type === 'tool_use');
                if (!hasText && !hasTool) {
                  const idx = Object.keys(gBlocks).length;
                  const inject =
                    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })}\n\n` +
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: PLACEHOLDER } })}\n\n` +
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
                  res.write(inject);
                  gInjected = true;
                  const blockSummary = Object.values(gBlocks).map(b => `${b.type}${b.type === 'text' ? `(${b.textLen})` : ''}`).join(',');
                  proxyLog(`[GUARD][STREAM][INJECT] model=${diagModel} stop=${gStopReason} blocks=[${blockSummary}] — 注入占位 text 阻止CLI空输出判定`);
                  try {
                    fs.writeFileSync(path.join(PROJECT_DIR, 'logs', `empty-resp-${Date.now()}.txt`),
                      `model=${diagModel}\nstop_reason=${gStopReason}\nmode=stream\nblocks=${blockSummary}\nINJECTED_PLACEHOLDER\nrequestBody=${requestBody.slice(0, 2000)}\n`, 'utf8');
                  } catch {}
                }
              }
            }
          }
        } finally { reader.releaseLock(); }
        res.end();
      } else {
        // ── 其他响应：原样按 chunk 转发（零影响） ──
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        res.end();
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        proxyLog(`上游超时: ${req.method} ${req.url}`);
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '上游请求超时' }));
        } else {
          res.end();
        }
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        proxyLog(`上游连接失败: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `无法连接上游: ${err.message}` }));
        } else {
          res.end();
        }
      } else {
        proxyLog(`代理错误: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `代理错误: ${err.message}` }));
        } else {
          res.end();
        }
      }
    }
  });

  // 全局错误处理
  server.on('error', (err) => {
    proxyLog(`服务器错误: ${err.message}`);
    console.error('[proxy] 服务器错误:', err.message);
  });

  server.on('clientError', (err, socket) => {
    proxyLog(`客户端错误: ${err.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function startProxy(host = '127.0.0.1', port = 15721) {
  return new Promise((resolve, reject) => {
    // 先关闭旧代理（如果有的话）
    if (startProxy._server) {
      startProxy._server.close();
      startProxy._server = null;
    }

    const server = createProxy();

    server.listen(port, host, () => {
      console.log(`[proxy] 内置代理已启动 http://${host}:${port}`);
      proxyLog(`代理启动成功 ${host}:${port}`);
      startProxy._server = server;
      resolve(server);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[proxy] 端口 ${port} 已被占用，跳过启动`);
        proxyLog(`端口 ${host}:${port} 已被占用`);
        resolve(null);
      } else {
        reject(err);
      }
    });
  });
}

function stopProxy(server) {
  if (!server) return;
  return new Promise((resolve) => {
    server.close(() => {
      console.log('[proxy] 代理已停止');
      proxyLog('代理已停止');
      resolve();
    });
  });
}

module.exports = { createProxy, startProxy, stopProxy, readConfig, CONFIG_FILE };
