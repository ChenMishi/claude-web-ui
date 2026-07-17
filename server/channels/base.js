/**
 * 渠道基类 — 所有消息渠道（企微/QQ/邮箱）的抽象接口
 *
 * 子类只需实现 onStart / onMessage / sendReply / onStop
 * 消息路由、会话隔离、Claude SDK 调用由 ChannelManager 统一处理
 */

class ChannelBase {
  constructor(config) {
    this.id = config.id || require('crypto').randomUUID();
    this.name = config.name || '';
    this.enabled = config.enabled !== false;
    this.config = config;
    this.status = 'stopped'; // stopped | running | error
  }

  /** 启动渠道监听/连接 */
  async start() { throw new Error('Not implemented'); }

  /** 停止渠道 */
  async stop() { throw new Error('Not implemented'); }

  /** 向消息发送者回复文本 */
  async sendReply(ctx, text) { throw new Error('Not implemented'); }

  /** 获取渠道类型标识 */
  static get type() { return 'base'; }

  /** 获取渠道所需配置项 */
  static get configSchema() { return []; }
}

module.exports = ChannelBase;
