/**
 * 企业微信 智能机器人 渠道 — 长连接模式
 *
 * 接入：
 *   企微 → 工作台 → 智能机器人 → 手动创建 → API 模式 → 使用长连接
 *   获取 BotID + Secret 即可
 *
 * 协议参考：https://developer.work.weixin.qq.com/document/path/101463
 */

const crypto = require('crypto');
const { WebSocket } = require('ws');
const ChannelBase = require('./base');

const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

class WechatChannel extends ChannelBase {
  static get type() { return 'wechat'; }

  static get configSchema() {
    return [
      { key: 'botId', label: 'Bot ID', required: true, placeholder: '创建机器人后获取' },
      { key: 'botSecret', label: 'Secret', required: true, secret: true, placeholder: '创建机器人后获取' },
      { key: 'maxTokens', label: '回复最大 Token', default: '2000' },
      { key: 'systemPrompt', label: '自定义 System Prompt (可选)' },
    ];
  }

  constructor(cfg, onMessage) {
    super(cfg);
    this.botId = cfg.botId || '';
    this.botSecret = cfg.botSecret || '';
    this.maxTokens = parseInt(cfg.maxTokens) || 2000;
    this.systemPrompt = cfg.systemPrompt || '';
    this.onMessage = onMessage;
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN;
    this.shouldReconnect = false;
  }

  reqId() {
    return crypto.randomUUID();
  }

  // ── WebSocket ──

  connect() {
    console.log('[wecom-bot] Connecting to', WECOM_WS_URL);
    this.ws = new WebSocket(WECOM_WS_URL);

    this.ws.on('open', () => {
      console.log('[wecom-bot] Connected, sending subscribe...');
      this.status = 'connecting';
      this.send({
        cmd: 'aibot_subscribe',
        headers: { req_id: this.reqId() },
        body: { bot_id: this.botId, secret: this.botSecret },
      });
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this.handleMessage(data);
      } catch (err) {
        console.error('[wecom-bot] Parse error:', err.message);
      }
    });

    this.ws.on('close', (code) => {
      console.log('[wecom-bot] Disconnected (code:', code, ')');
      this.stopHeartbeat();
      if (this.shouldReconnect) {
        this.status = 'error';
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[wecom-bot] Error:', err.message);
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ── Heartbeat ──

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ cmd: 'ping', headers: { req_id: this.reqId() } });
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // ── Reconnect ──

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log(`[wecom-bot] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    }, this.reconnectDelay);
  }

  // ── Message Handling ──

  handleMessage(msg) {
    // Subscribe response has no "cmd" field — just errcode (official doc format)
    if (!msg.cmd && msg.errcode !== undefined) {
      if (msg.errcode === 0) {
        console.log('[wecom-bot] Subscribed successfully');
        this.status = 'running';
        this.reconnectDelay = RECONNECT_MIN;
        this.startHeartbeat();
        this.emitStatusChange();
      } else {
        console.error('[wecom-bot] Subscribe failed:', msg.errmsg, '(code:', msg.errcode, ')');
        this.status = 'error';
        this.emitStatusChange();
        try { this.ws.close(); } catch {}
      }
      return;
    }

    switch (msg.cmd) {
      case 'pong': {
        break; // heartbeat response
      }

      case 'aibot_msg_callback': {
        const b = msg.body || {};
        if (b.msgtype === 'text' && b.text?.content) {
          const userId = b.from?.userid || 'unknown';
          const content = b.text.content;
          const reqId = (msg.headers || {}).req_id || '';
          const chatid = b.chatid || '';
          console.log(`[wecom-bot] Message from ${userId}: ${content.slice(0, 50)}`);

          if (this.onMessage) {
            this.onMessage(userId, content, { reqId, chatid }).catch(e =>
              console.error('[wecom-bot] onMessage error:', e.message));
          }
        }
        break;
      }

      case 'aibot_event_callback': {
        // Enter session event — could send welcome message
        break;
      }

      default:
        break;
    }
  }

  // ── Send Reply (streaming, for callback replies) ──

  async sendReply(ctx, text) {
    if (!ctx.reqId) {
      console.error('[wecom-bot] No reqId for reply');
      return false;
    }

    // Split into chunks for streaming effect
    const maxChars = 2000;
    const chunks = [];
    let remain = text;
    while (remain.length > 0) {
      chunks.push(remain.slice(0, maxChars));
      remain = remain.slice(maxChars);
    }

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      this.send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: ctx.reqId },
        body: {
          msgtype: 'stream',
          stream: { id: ctx.reqId, content: chunks[i], finish: isLast, feedback: isLast ? { id: `reply_${Date.now()}` } : undefined },
        },
      });
      if (!isLast) await new Promise(r => setTimeout(r, 200));
    }
    return true;
  }

  // ── Active push (Web UI → WeChat user, no callback reqId) ──

  async sendText(userId, text) {
    this.send({
      cmd: 'aibot_send_msg',
      headers: { req_id: this.reqId() },
      body: {
        chatid: userId,
        msgtype: 'text',
        text: { content: text.slice(0, 2048) },
      },
    });
    return true;
  }

  // ── Lifecycle ──

  emitStatusChange() {
    const { getChannelManager } = require('./index');
    const mgr = getChannelManager();
    mgr.notifyFrontend('channel-status', { channelId: this.id, status: this.status });
  }

  async start() {
    this.shouldReconnect = true;
    this.reconnectDelay = RECONNECT_MIN;
    this.status = 'connecting';
    this.connect();
  }

  async stop() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.status = 'stopped';
  }
}

module.exports = WechatChannel;
