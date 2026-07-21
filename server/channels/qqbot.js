/**
 * QQ Bot 渠道 — WebSocket 网关收消息 + HTTP API 发回复
 *
 * 接入：
 *   QQ 开放平台 (q.qq.com) → 创建机器人 → 获取 AppID + AppSecret
 *
 * 协议参考：
 *   https://bot.q.qq.com/wiki/develop/api-v2/
 *   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/websocket/ws-handle.html
 */

const { WebSocket } = require('ws');
const ChannelBase = require('./base');

const API_BASE = 'https://api.sgroup.qq.com';
const AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
const HEARTBEAT_LEEWAY = 5000; // 提前 5s 发心跳
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

class QQBotChannel extends ChannelBase {
  static get type() { return 'qqbot'; }

  static get configSchema() {
    return [
      { key: 'appId', label: 'App ID', required: true, placeholder: 'QQ 开放平台获取' },
      { key: 'appSecret', label: 'App Secret', required: true, secret: true, placeholder: 'QQ 开放平台获取' },
      { key: 'intents', label: '订阅事件 Intents（默认群聊+私聊）', default: String((1 << 25) | (1 << 30)) },
      { key: 'sandbox', label: '沙箱模式（true/false）', default: 'false' },
      { key: 'systemPrompt', label: '自定义 System Prompt (可选)' },
    ];
  }

  constructor(cfg, onMessage) {
    super(cfg);
    this.appId = cfg.appId || '';
    this.appSecret = cfg.appSecret || '';
    this.intents = parseInt(cfg.intents) || ((1 << 25) | (1 << 30));
    this.sandbox = cfg.sandbox === 'true';
    this.systemPrompt = cfg.systemPrompt || '';
    this.onMessage = onMessage;

    // Runtime state
    this.ws = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.heartbeatTimer = null;
    this.tokenTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN;
    this.shouldReconnect = false;
    this.seqNum = null; // last s (sequence number) from server, for resume
    this.sessionId = null; // for resume
  }

  // ── Token management ──

  async fetchToken() {
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60000) return this.accessToken;

    const resp = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`获取 access_token 失败 (${resp.status}): ${err}`);
    }
    const data = await resp.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in || 7200) * 1000;
    console.log('[qqbot] Token refreshed, expires in', data.expires_in, 's');
    return this.accessToken;
  }

  scheduleTokenRefresh() {
    clearTimeout(this.tokenTimer);
    const delay = Math.max(60000, this.tokenExpiresAt - Date.now() - 120000);
    this.tokenTimer = setTimeout(() => {
      this.fetchToken().catch(e => console.error('[qqbot] Token refresh error:', e.message));
    }, delay);
  }

  // ── API helpers ──

  async api(method, path, body) {
    const token = await this.fetchToken();
    const headers = { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    if (body === null) delete opts.body; // GET with no body
    const url = this.sandbox ? `https://sandbox.api.sgroup.qq.com${path}` : `${API_BASE}${path}`;
    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API ${method} ${path} (${resp.status}): ${err}`);
    }
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('application/json') ? resp.json() : resp.text();
  }

  // ── WebSocket ──

  async connect() {
    try {
      const token = await this.fetchToken();
      // Get gateway URL
      const gwResp = await fetch(`${this.sandbox ? 'https://sandbox.api.sgroup.qq.com' : API_BASE}/gateway/bot`, {
        headers: { Authorization: `QQBot ${token}` },
      });
      if (!gwResp.ok) {
        const err = await gwResp.text();
        throw new Error(`获取网关失败 (${gwResp.status}): ${err}`);
      }
      const gw = await gwResp.json();
      const wsUrl = gw.url;
      console.log('[qqbot] Gateway URL:', wsUrl);

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[qqbot] WebSocket connected');
        // Don't identify here — wait for opcode 10 (Hello)
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleWSMessage(msg);
        } catch (err) {
          console.error('[qqbot] WS parse error:', err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log('[qqbot] WebSocket closed (code:', code, ')', reason?.toString());
        this.stopHeartbeat();
        clearTimeout(this.tokenTimer);
        if (this.shouldReconnect) {
          this.status = 'error';
          this.emitStatusChange();
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.error('[qqbot] WebSocket error:', err.message);
      });
    } catch (err) {
      console.error('[qqbot] Connect error:', err.message);
      this.status = 'error';
      this.emitStatusChange();
      if (this.shouldReconnect) this.scheduleReconnect();
    }
  }

  handleWSMessage(msg) {
    const { op, d, s, t } = msg;

    // Track sequence number for resume
    if (s != null) this.seqNum = s;

    switch (op) {
      case 10: { // Hello — start heartbeat + identify
        const interval = d?.heartbeat_interval || 30000;
        console.log('[qqbot] Hello received, heartbeat interval:', interval, 'ms');

        // Identify
        const identify = {
          op: 2,
          d: {
            token: `QQBot ${this.accessToken}`,
            intents: this.intents,
            shard: [0, 1],
            properties: {},
          },
        };
        this.send(identify);

        // Heartbeat: jitter the first one to avoid thundering herd
        const jitter = Math.floor(Math.random() * 5000);
        this.startHeartbeat(interval, jitter);
        break;
      }

      case 11: // Heartbeat ACK
        break;

      case 0: { // Dispatch
        this.handleDispatch(t, d);
        break;
      }

      case 7: // Reconnect — server requested reconnect
        console.log('[qqbot] Server requested reconnect');
        if (this.ws) { try { this.ws.close(4000); } catch {} }
        break;

      case 9: // Invalid session
        console.log('[qqbot] Invalid session, will re-identify');
        this.sessionId = null;
        this.seqNum = null;
        break;

      default:
        break;
    }
  }

  handleDispatch(type, data) {
    switch (type) {
      case 'READY': {
        console.log('[qqbot] Ready — session:', data?.session_id);
        this.sessionId = data?.session_id;
        this.status = 'running';
        this.reconnectDelay = RECONNECT_MIN;
        this.scheduleTokenRefresh();
        this.emitStatusChange();
        break;
      }

      case 'C2C_MESSAGE_CREATE': {
        // 私聊消息
        const userId = data?.author?.id || data?.author?.user_openid || 'unknown';
        const content = data?.content || '';
        const msgId = data?.id || '';
        console.log(`[qqbot] C2C from ${userId}: ${content.slice(0, 50)}`);
        if (this.onMessage && content.trim()) {
          this.onMessage(userId, content, {
            msgId,
            msgType: 'c2c',
            userOpenId: userId,
          }).catch(e => console.error('[qqbot] onMessage error:', e.message));
        }
        break;
      }

      case 'GROUP_AT_MESSAGE_CREATE': {
        // 群聊 @机器人 消息
        const userId = data?.author?.member_openid || data?.author?.id || 'unknown';
        const groupId = data?.group_openid || data?.group_id || '';
        const content = data?.content || '';
        const msgId = data?.id || '';
        console.log(`[qqbot] Group @ from ${userId} in ${groupId}: ${content.slice(0, 50)}`);
        if (this.onMessage && content.trim()) {
          this.onMessage(userId, content, {
            msgId,
            msgType: 'group',
            groupOpenId: groupId,
            userOpenId: userId,
          }).catch(e => console.error('[qqbot] onMessage error:', e.message));
        }
        break;
      }

      case 'AT_MESSAGE_CREATE': {
        // 频道 @消息
        const userId = data?.author?.id || 'unknown';
        const channelId = data?.channel_id || '';
        const guildId = data?.guild_id || '';
        const content = data?.content || '';
        const msgId = data?.id || '';
        console.log(`[qqbot] Guild @ from ${userId} in channel ${channelId}: ${content.slice(0, 50)}`);
        if (this.onMessage && content.trim()) {
          this.onMessage(userId, content, {
            msgId,
            msgType: 'guild',
            channelId,
            guildId,
            userOpenId: userId,
          }).catch(e => console.error('[qqbot] onMessage error:', e.message));
        }
        break;
      }

      case 'DIRECT_MESSAGE_CREATE': {
        // 频道私信
        const userId = data?.author?.id || 'unknown';
        const guildId = data?.guild_id || '';
        const content = data?.content || '';
        const msgId = data?.id || '';
        console.log(`[qqbot] Guild DM from ${userId}: ${content.slice(0, 50)}`);
        if (this.onMessage && content.trim()) {
          this.onMessage(userId, content, {
            msgId,
            msgType: 'guild_dm',
            guildId,
            userOpenId: userId,
          }).catch(e => console.error('[qqbot] onMessage error:', e.message));
        }
        break;
      }

      default:
        break;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ── Heartbeat ──

  startHeartbeat(interval, initialDelay = 0) {
    this.stopHeartbeat();
    const sendBeat = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ op: 1, d: this.seqNum });
    };
    // First heartbeat after initialDelay (jitter), then every interval
    const first = Math.max(0, interval - HEARTBEAT_LEEWAY);
    setTimeout(() => {
      sendBeat();
      this.heartbeatTimer = setInterval(sendBeat, Math.max(10000, interval - HEARTBEAT_LEEWAY));
    }, initialDelay || first);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // ── Reconnect ──

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    console.log(`[qqbot] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    }, this.reconnectDelay);
  }

  // ── Send replies ──

  async sendReply(ctx, text) {
    if (!ctx) return false;
    try {
      switch (ctx.msgType) {
        case 'group': {
          // 群聊回复：引用回复
          await this.api('POST', `/v2/groups/${ctx.groupOpenId}/messages`, {
            content: text,
            msg_type: 0,
            msg_id: ctx.msgId, // 引用回复
          });
          return true;
        }
        case 'c2c': {
          // 私聊回复
          await this.api('POST', `/v2/users/${ctx.userOpenId}/messages`, {
            content: text,
            msg_type: 0,
          });
          return true;
        }
        case 'guild': {
          // 频道回复
          await this.api('POST', `/channels/${ctx.channelId}/messages`, {
            content: text,
          });
          return true;
        }
        case 'guild_dm': {
          // 频道私信回复 — create DM channel first, then send
          const dm = await this.api('POST', `/users/@me/dms`, {
            recipient_id: ctx.userOpenId,
          });
          if (dm?.guild_id) {
            await this.api('POST', `/dms/${dm.guild_id}/messages`, {
              content: text,
            });
          }
          return true;
        }
        default:
          console.error('[qqbot] Unknown msgType for reply:', ctx.msgType);
          return false;
      }
    } catch (err) {
      console.error('[qqbot] sendReply error:', err.message);
      return false;
    }
  }

  /** Active push (Web UI → QQ user, no callback context) */
  async sendText(userId, text) {
    try {
      await this.api('POST', `/v2/users/${userId}/messages`, {
        content: text,
        msg_type: 0,
      });
      return true;
    } catch (err) {
      console.error('[qqbot] sendText error:', err.message);
      return false;
    }
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
    clearTimeout(this.tokenTimer);
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.status = 'stopped';
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }
}

module.exports = QQBotChannel;
