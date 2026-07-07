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
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
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

function createProxy() {
  const server = http.createServer(async (req, res) => {
    const config = readConfig();

    let apiKey = config.apiKey;
    let baseUrl = config.baseUrl;
    let chatUrl = config.chatUrl;

    // Read body and route by model name BEFORE setting up headers
    let requestBody = '';
    try {
      const rawBody = await readBody(req);
      if (rawBody.length > 0) {
        requestBody = rawBody.toString();
        const bodyObj = JSON.parse(requestBody);
        const modelName = bodyObj.model || '';
        const slashIdx = modelName.indexOf('/');
        if (slashIdx > 0) {
          const providerName = modelName.slice(0, slashIdx);
          const realModel = modelName.slice(slashIdx + 1);
          for (const p of (config.providers || [])) {
            if (p.name === providerName && p.apiKey && p.baseUrl) {
              apiKey = p.apiKey;
              baseUrl = p.baseUrl;
              chatUrl = p.chatUrl || '';
              bodyObj.model = realModel;
              requestBody = JSON.stringify(bodyObj);
              break;
            }
          }
        }
      }
    } catch {}

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

    // 注入真实的 API Key
    headers['x-api-key'] = apiKey;
    headers['authorization'] = `Bearer ${apiKey}`;
    headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';

    if (req.method === 'GET' || req.method === 'HEAD') {
      delete headers['content-type'];
      delete headers['content-length'];
    }

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

      // 转发状态码和头
      const responseHeaders = {};
      for (const [k, v] of upstream.headers) {
        // 跳过 hop-by-hop 头
        if (['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate',
             'proxy-authorization', 'te', 'trailer', 'upgrade'].includes(k.toLowerCase())) {
          continue;
        }
        responseHeaders[k] = v;
      }

      res.writeHead(upstream.status, responseHeaders);

      // 流式转发响应体（ReadableStream → Node.js res）
      // HEAD / 204 / 304 等响应没有 body，直接结束
      if (!upstream.body) {
        res.end();
      } else {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // value is Uint8Array — write raw bytes
            res.write(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
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
