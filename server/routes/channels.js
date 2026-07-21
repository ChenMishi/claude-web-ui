/**
 * 渠道管理 API
 *
 * GET  /api/channels/types       — 列出可用渠道类型及配置schema
 * GET  /api/channels/status      — 列出所有渠道运行状态
 * POST /api/channels/save        — 保存渠道配置
 * POST /api/channels/:id/toggle  — 启用/禁用渠道
 * POST /api/channels/:id/delete  — 删除渠道
 */

const { Router } = require('express');
const router = Router();
const crypto = require('crypto');
const { getChannelManager } = require('../channels');

// ── 渠道管理 ──

// 列出可用渠道类型
router.get('/channels/types', (_req, res) => {
  const mgr = getChannelManager();
  res.json({ types: mgr.getChannelTypes() });
});

// 列出所有渠道状态
router.get('/channels/status', (_req, res) => {
  const mgr = getChannelManager();
  res.json({ channels: mgr.getStatus() });
});

// 保存渠道配置
router.post('/channels/save', async (req, res) => {
  try {
    const { channel } = req.body || {};
    if (!channel || !channel.type || !channel.name) {
      return res.status(400).json({ error: 'channel.type 和 channel.name 为必填项' });
    }

    const mgr = getChannelManager();
    const config = mgr.loadConfig();

    let target;
    if (channel.id) {
      target = (config.channels || []).find(c => c.id === channel.id);
    }
    if (!target) {
      target = { id: channel.id || crypto.randomUUID(), type: channel.type };
      if (!config.channels) config.channels = [];
      config.channels.push(target);
    }

    // Merge config
    Object.assign(target, channel);
    target.id = target.id; // preserve ID
    mgr.saveConfig(config);

    // Restart if enabled
    if (target.enabled !== false) {
      await mgr.startChannel(target);
    } else {
      await mgr.stopChannel(target.id);
    }

    res.json({ ok: true, channel: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启用/禁用渠道
router.post('/channels/:id/toggle', async (req, res) => {
  try {
    const mgr = getChannelManager();
    const config = mgr.loadConfig();
    const target = (config.channels || []).find(c => c.id === req.params.id);
    if (!target) return res.status(404).json({ error: '渠道不存在' });

    target.enabled = !target.enabled;
    mgr.saveConfig(config);

    if (target.enabled) {
      await mgr.startChannel(target);
    } else {
      await mgr.stopChannel(target.id);
    }

    res.json({ ok: true, enabled: target.enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除渠道
router.post('/channels/:id/delete', async (req, res) => {
  try {
    const mgr = getChannelManager();
    await mgr.stopChannel(req.params.id);

    const config = mgr.loadConfig();
    config.channels = (config.channels || []).filter(c => c.id !== req.params.id);
    mgr.saveConfig(config);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve email attachments ──

const path = require('path');
const fs = require('fs');
const os = require('os');
const ATTACH_DIR = path.join(os.homedir(), '.claude-web-ui', 'email-attachments');

router.use('/channels/email-attachments', (req, res) => {
  const raw = path.basename(req.path);
  const filename = decodeURIComponent(raw);
  const filePath = path.join(ATTACH_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
});

// ── SSE events: notify frontend when bot sessions get new messages ──

router.get('/channels/events', (req, res) => {
  const mgr = getChannelManager();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send keepalive every 30s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    try { if (!res.writableEnded) res.write(':keepalive\n\n'); } catch {}
  }, 30000);

  const listener = (event) => {
    try {
      if (!res.writableEnded) {
        res.write(`event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch {}
  };

  mgr.on('bot-event', listener);

  res.on('close', () => {
    clearInterval(keepalive);
    mgr.off('bot-event', listener);
  });

  req.on('error', () => {
    clearInterval(keepalive);
    mgr.off('bot-event', listener);
  });
});

// ── Sync current project cwd for bot channels ──

router.post('/channels/sync-cwd', (req, res) => {
  try {
    const { cwd } = req.body || {};
    if (!cwd) return res.status(400).json({ error: 'cwd required' });
    const f = require('path').join(require('os').homedir(), '.claude-web-ui', 'bot-current-project.json');
    const d = require('path').dirname(f);
    if (!require('fs').existsSync(d)) require('fs').mkdirSync(d, { recursive: true });
    require('fs').writeFileSync(f, JSON.stringify({ cwd, ts: Date.now() }), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
