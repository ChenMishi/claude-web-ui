const { Router } = require('express');
const { PROXY_BASE } = require('../config');

const router = Router();

router.post('/chat', async (req, res) => {
  const { messages, system, model } = req.body;
  const body = { model: model || 'claude-opus-4-7', max_tokens: 4096, messages, stream: true };
  if (system) body.system = system;

  try {
    const proxyRes = await fetch(`${PROXY_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'proxy', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });

    if (!proxyRes.ok) {
      const err = await proxyRes.text();
      return res.status(proxyRes.status).json({ error: err });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = proxyRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
            }
          } catch {}
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: `无法连接到本地 Claude 代理 (${PROXY_BASE})。${err.message}` });
  }
});

module.exports = router;
