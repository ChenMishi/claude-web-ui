/**
 * 渠道管理器 — 统一管理所有消息渠道
 *
 * 职责：
 *   1. 加载/保存渠道配置
 *   2. 启动/停止各渠道
 *   3. 消息路由：渠道消息 → Claude SDK → 回复
 *   4. 会话隔离：每个渠道用户独立会话
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const ChannelBase = require('./base');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(PROJECT_DIR, 'channel-config.json');

// 内置渠道类型注册表
const CHANNEL_TYPES = {
  wechat: require('./wechat'),
  email: require('./email'),
};

class ChannelManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    /** @type {Map<string, ChannelBase>} */
    this.channels = new Map();
    /** 用户 → 会话 ID 映射 */
    this.userSessions = new Map();
    /** 外部回调：处理消息 (userId, text, channelId) => Promise<string> */
    this.messageHandler = null;
  }

  /** 通知前端：机器人会话有新消息（SSE 推送） */
  notifyFrontend(type, data) {
    this.emit('bot-event', { type, ...data });
  }

  /** 加载所有渠道配置并启动已启用的渠道 */
  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      }
    } catch {}
    return { channels: [] };
  }

  /** 保存配置到磁盘 */
  saveConfig(config) {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  }

  /** 启动所有已启用的渠道 */
  async startAll() {
    const config = this.loadConfig();
    for (const ch of (config.channels || [])) {
      if (ch.enabled !== false) {
        await this.startChannel(ch);
      }
    }
    console.log(`[channels] Started ${this.channels.size} channels`);
  }

  /** 停止所有渠道 */
  async stopAll() {
    for (const [id, channel] of this.channels) {
      try { await channel.stop(); } catch {}
    }
    this.channels.clear();
    console.log('[channels] All channels stopped');
  }

  /** 启动单个渠道 */
  async startChannel(cfg) {
    const Type = CHANNEL_TYPES[cfg.type];
    if (!Type) throw new Error(`Unknown channel type: ${cfg.type}`);

    if (this.channels.has(cfg.id)) {
      await this.channels.get(cfg.id).stop();
    }

    const channel = new Type(cfg, (userId, text, replyCtx) => {
      return this.handleMessage(cfg.id, userId, text, replyCtx);
    });

    await channel.start();
    this.channels.set(cfg.id, channel);
    console.log(`[channels] Started: ${cfg.name} (${cfg.type})`);
    return channel;
  }

  /** 停止单个渠道 */
  async stopChannel(id) {
    const ch = this.channels.get(id);
    if (ch) {
      await ch.stop();
      this.channels.delete(id);
    }
  }

  /** 消息处理入口：渠道收到消息 → 调此方法 → Claude → 回复 */
  async handleMessage(channelId, userId, text, replyCtx) {
    console.log(`[channels] Message from ${channelId}/${userId}: ${text.slice(0, 50)}`);
    let sessionId = null;
    if (this.messageHandler) {
      try {
        const result = await this.messageHandler(userId, text, channelId);
        const reply = typeof result === 'string' ? result : result.reply;
        sessionId = typeof result === 'string' ? null : result.sessionId;
        if (reply && replyCtx) {
          const ch = this.channels.get(channelId);
          if (ch) await ch.sendReply(replyCtx, reply);
        }
      } catch (err) {
        console.error(`[channels] Message handler error:`, err.message);
        if (replyCtx) {
          const ch = this.channels.get(channelId);
          if (ch) await ch.sendReply(replyCtx, '处理消息时出错，请稍后重试').catch(() => {});
        }
      }
    }
    if (sessionId) {
      this.notifyFrontend('session-update', { channelId, userId, sessionId, timestamp: Date.now() });
    }
  }

  /** 获取渠道实例 */
  get(id) {
    return this.channels.get(id);
  }

  /** 获取所有渠道状态 */
  getStatus() {
    const config = this.loadConfig();
    return (config.channels || []).map(c => ({
      ...c,  // spread all config fields (botId, secret, etc.)
      status: this.channels.get(c.id)?.status || 'stopped',
    }));
  }

  /** 获取可用渠道类型 */
  getChannelTypes() {
    return Object.entries(CHANNEL_TYPES).map(([type, Cls]) => ({
      type,
      label: type === 'wechat' ? '企业微信' : type === 'email' ? '邮箱' : type,
      configSchema: Cls.configSchema || [],
    }));
  }
}

// 单例
let instance = null;
function getChannelManager() {
  if (!instance) instance = new ChannelManager();
  return instance;
}

module.exports = { ChannelManager, getChannelManager, CHANNEL_TYPES };
