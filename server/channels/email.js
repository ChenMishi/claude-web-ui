/**
 * 邮箱 Bot 渠道 — IMAP 收 + SMTP 发
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Imap = require('imap');
const tls = require('tls');
const { simpleParser } = require('mailparser');
const ChannelBase = require('./base');

const ATTACH_DIR = path.join(os.homedir(), '.claude-web-ui', 'email-attachments');

async function sendSMTP(host, port, user, pass, from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false });
    sock.setEncoding('utf8');
    let buf = '';
    const wait = (code) => new Promise((res, rej) => {
      const timer = setInterval(() => {
        // 用 m 标志让 ^ 匹配每行开头，SMTP 多行响应 250-xxx...250 OK 才能正确识别
        if (new RegExp(`^${code}\\s`, 'm').test(buf)) { clearInterval(timer); res(); }
      }, 50);
      setTimeout(() => { clearInterval(timer); rej(new Error('SMTP timeout')); }, 15000);
    });
    // 消费 buf 中最后一个匹配行之前的所有数据
    const consume = (code) => {
      const lines = buf.split('\r\n');
      let lastIdx = -1;
      const re = new RegExp(`^${code}\\s`);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) lastIdx = i;
      }
      if (lastIdx >= 0) buf = lines.slice(lastIdx + 1).join('\r\n');
    };
    sock.on('data', (d) => { buf += d; });
    (async () => {
      try {
        await wait('220'); consume('220'); sock.write(`EHLO bot\r\n`);
        await wait('250'); consume('250'); sock.write(`AUTH LOGIN\r\n`);
        await wait('334'); consume('334'); sock.write(`${Buffer.from(user).toString('base64')}\r\n`);
        await wait('334'); consume('334'); sock.write(`${Buffer.from(pass).toString('base64')}\r\n`);
        await wait('235'); consume('235'); sock.write(`MAIL FROM:<${from}>\r\n`);
        await wait('250'); consume('250'); sock.write(`RCPT TO:<${to}>\r\n`);
        await wait('250'); consume('250'); sock.write(`DATA\r\n`);
        await wait('354'); consume('354');
        const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`;
        sock.write(msg);
        await wait('250'); sock.write('QUIT\r\n'); sock.end();
        resolve(true);
      } catch (err) { try { sock.end(); } catch {} reject(err); }
    })();
    sock.on('error', reject);
  });
}

class EmailChannel extends ChannelBase {
  static get type() { return 'email'; }
  static get configSchema() {
    return [
      { key: 'imapHost', label: 'IMAP 服务器', required: true, placeholder: 'imap.qq.com' },
      { key: 'imapPort', label: 'IMAP 端口', default: '993' },
      { key: 'smtpHost', label: 'SMTP 服务器', required: true, placeholder: 'smtp.qq.com' },
      { key: 'smtpPort', label: 'SMTP 端口', default: '465' },
      { key: 'emailUser', label: '邮箱账号', required: true },
      { key: 'emailPass', label: '授权码', required: true, secret: true },
      { key: 'pollInterval', label: '轮询间隔(秒)', default: '60' },
      { key: 'systemPrompt', label: '自定义回复风格 (可选)' },
    ];
  }

  constructor(cfg, onMessage) {
    super(cfg);
    this.imapHost = cfg.imapHost || ''; this.imapPort = parseInt(cfg.imapPort) || 993;
    this.smtpHost = cfg.smtpHost || ''; this.smtpPort = parseInt(cfg.smtpPort) || 465;
    this.emailUser = cfg.emailUser || ''; this.emailPass = cfg.emailPass || '';
    this.pollInterval = parseInt(cfg.pollInterval) || 60;
    this.systemPrompt = cfg.systemPrompt || '';
    this.onMessage = onMessage;
    this.timer = null;
    this.lastReplyTo = this.emailUser;
    this.seenUids = new Set(); // track processed UIDs in memory (QQ IMAP ignores STORE \Seen)
    this.recentSenders = []; // [{from, subject, time}] for multi-reply selection
  }

  addSender(fromAddr, subject) {
    this.recentSenders.unshift({ from: fromAddr, subject, time: Date.now() });
    if (this.recentSenders.length > 10) this.recentSenders = this.recentSenders.slice(0, 10);
  }

  pickSender(idx) {
    if (idx >= 0 && idx < this.recentSenders.length) {
      this.lastReplyTo = this.recentSenders[idx].from;
      return this.recentSenders[idx];
    }
    return null;
  }

  async poll() {
    if (this.status !== 'running') return;
    const self = this;
    return new Promise((resolve) => {
      const imap = new Imap({
        user: self.emailUser, password: self.emailPass,
        host: self.imapHost, port: self.imapPort,
        tls: true, tlsOptions: { rejectUnauthorized: false },
        connTimeout: 15000, authTimeout: 15000,
      });
      let done = false;
      const finish = () => { if (done) return; done = true; try { imap.end(); } catch {} resolve(); };
      setTimeout(finish, 25000);

      imap.once('error', (err) => { console.error('[email-bot]', err.message); finish(); });
      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) { console.error('[email-bot] openBox:', err.message); finish(); return; }
          imap.search(['UNSEEN'], (err, results) => {
            if (err) { console.error('[email-bot] search:', err.message); finish(); return; }
            if (!results || results.length === 0) { finish(); return; }

            console.log('[email-bot] found', results.length, 'unseen');
            const f = imap.fetch(results.slice(-5), { bodies: '' });
            let msgCount = 0, msgDone = 0;

            f.on('message', (msg, seqno) => {
              msgCount++;
              const uid = msg.attributes?.uid || seqno; // prefer UID, fallback to seqno
              let body = '';
              msg.on('body', (stream) => { stream.on('data', (c) => { body += c.toString('utf8'); }); });
              msg.once('attributes', (attrs) => {
                if (attrs.uid) msg.attributes = { uid: attrs.uid };
              });
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(body);
                  const fromAddr = parsed.from?.value?.[0]?.address || '';
                  const text = (parsed.text || '').trim() || (parsed.html || '').replace(/<[^>]*>/g, '').trim() || '';
                  const subject = parsed.subject || '(无主题)';
                  const realUid = msg.attributes?.uid || seqno;

                  if (text || fromAddr) {
                    // Dedup: skip if already seen in this session
                    if (!self.seenUids.has(realUid)) {
                      self.seenUids.add(realUid);
                      if (self.seenUids.size > 200) {
                        const arr = [...self.seenUids]; self.seenUids = new Set(arr.slice(-100));
                      }
                      self.lastReplyTo = fromAddr;
                      self.addSender(fromAddr, subject);
                      imap.setFlags(seqno, '\\Seen', () => {});

                      // Save inline images (embedded in email body) to disk
                      const inlineImages = [];
                      const fileAttachments = [];
                      const allParts = [...(parsed.attachments || [])];
                      for (const a of allParts) {
                        try {
                          if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });
                          const ext = path.extname(a.filename || '');
                          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
                          const filePath = path.join(ATTACH_DIR, safeName);
                          fs.writeFileSync(filePath, a.content);
                          const originalName = a.filename || 'attachment';
                          const url = `/api/channels/email-attachments/${encodeURIComponent(safeName)}`;
                          if (a.contentType?.startsWith('image/') && (!a.contentDisposition || a.contentDisposition === 'inline')) {
                            inlineImages.push({ filename: originalName, url, contentType: a.contentType, size: a.size });
                          } else {
                            fileAttachments.push({ filename: originalName, url, contentType: a.contentType, size: a.size });
                          }
                        } catch (e) {}
                      }

                      // Build display text: inline images as markdown, attachments as file list
                      let displayText = text || '';
                      if (inlineImages.length > 0) {
                        displayText += '\n\n' + inlineImages.map(img => `![${img.filename}](${img.url})`).join('\n');
                      }
                      if (fileAttachments.length > 0) {
                        displayText += '\n\n📎 附件: ' + fileAttachments.map(a => `[${a.filename}](${a.url})`).join(', ');
                      }

                      console.log(`[email-bot] Message from ${fromAddr}: ${subject}${inlineImages.length > 0 ? ' (' + inlineImages.length + ' images)' : ''}${fileAttachments.length > 0 ? ' (' + fileAttachments.length + ' files)' : ''}`);
                      if (self.onMessage) {
                        self.onMessage(fromAddr, displayText, { from: fromAddr, subject, userId: fromAddr });
                      }
                    }
                  }
                } catch (err) { console.error('[email-bot] Parse:', err.message); }
                msgDone++;
                if (msgDone >= msgCount) finish();
              });
            });
            f.once('end', () => { if (msgCount === 0) finish(); });
          });
        });
      });
      imap.connect();
    });
  }

  async sendReply(ctx, text) { return true; }
  async sendText(_userId, text) {
    try {
      await sendSMTP(this.smtpHost, this.smtpPort, this.emailUser, this.emailPass,
        this.emailUser, this.lastReplyTo || this.emailUser, 'Re: 你的消息', text);
      return true;
    } catch (err) { console.error('[email-bot] Send error:', err.message); return false; }
  }

  async start() {
    this.status = 'running';
    console.log(`[email-bot] Started polling every ${this.pollInterval}s`);
    setTimeout(() => this.poll(), 3000);
    this.timer = setInterval(() => this.poll(), this.pollInterval * 1000);
  }
  async stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } this.status = 'stopped'; }
}

module.exports = EmailChannel;
