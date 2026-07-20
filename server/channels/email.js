/**
 * 邮箱 Bot 渠道 — IMAP 收 + SMTP 发
 */

const Imap = require('imap');
const tls = require('tls');
const { simpleParser } = require('mailparser');
const ChannelBase = require('./base');

async function sendSMTP(host, port, user, pass, from, to, subject, body) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false });
    sock.setEncoding('utf8');
    let buf = '';
    const wait = (code) => new Promise((res, rej) => {
      const timer = setInterval(() => {
        if (new RegExp(`^${code}\\s`).test(buf)) { clearInterval(timer); res(); }
      }, 50);
      setTimeout(() => { clearInterval(timer); rej(new Error('SMTP timeout')); }, 10000);
    });

    sock.on('data', (d) => { buf += d; });
    (async () => {
      try {
        await wait('220'); buf = '';
        sock.write(`EHLO bot\r\n`);
        await wait('250'); buf = '';
        sock.write(`AUTH LOGIN\r\n`);
        await wait('334'); buf = '';
        sock.write(`${Buffer.from(user).toString('base64')}\r\n`);
        await wait('334'); buf = '';
        sock.write(`${Buffer.from(pass).toString('base64')}\r\n`);
        await wait('235'); buf = '';
        sock.write(`MAIL FROM:<${from}>\r\n`);
        await wait('250'); buf = '';
        sock.write(`RCPT TO:<${to}>\r\n`);
        await wait('250'); buf = '';
        sock.write(`DATA\r\n`);
        await wait('354'); buf = '';
        const msg = `From: ${from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`;
        sock.write(msg);
        await wait('250');
        sock.write('QUIT\r\n');
        sock.end();
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
  }

  async poll() {
    if (this.status !== 'running') return;
    return new Promise((resolve) => {
      const imap = new Imap({
        user: this.emailUser, password: this.emailPass,
        host: this.imapHost, port: this.imapPort,
        tls: true, tlsOptions: { rejectUnauthorized: false },
        connTimeout: 15000, authTimeout: 15000,
      });

      let done = false;
      const abort = () => { if (!done) { done = true; try { imap.end(); } catch {} resolve(); } };
      setTimeout(abort, 30000);

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err) => {
          if (err) { console.error('[email-bot] openBox error:', err.message); abort(); return; }
          imap.search(['UNSEEN'], (err, results) => {
            if (err) { console.error('[email-bot] search err:', err.message); abort(); return; }
            console.log('[email-bot] UNSEEN results:', results?.length || 0);
            if (!results || results.length === 0) { abort(); return; }
            const toFetch = results.slice(-5);
            const f = imap.fetch(toFetch, { bodies: '' });
            let msgCount = 0, msgDone = 0;

            f.on('message', (msg, seqno) => {
              msgCount++;
              let body = '';
              msg.on('body', (stream) => { stream.on('data', (c) => { body += c.toString('utf8'); }); });
              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(body);
                  const fromAddr = parsed.from?.value?.[0]?.address || 'unknown';
                  const text = (parsed.text || '').trim() || (parsed.html || '').replace(/<[^>]*>/g, '').trim() || '';
                  const subject = parsed.subject || '(无主题)';
                  const attachments = (parsed.attachments || []).map(a => ({
                    filename: a.filename || '附件', contentType: a.contentType, size: a.size,
                  }));

                  if (text || fromAddr) {
                    this.lastReplyTo = fromAddr;
                    imap.setFlags(seqno, '\\Seen', (e) => {
                      if (e) console.error('[email-bot] Flag error:', e.message);
                    });
                    const display = text + (attachments.length > 0
                      ? `\n\n📎 附件(${attachments.length}): ${attachments.map(a => a.filename).join(', ')}`
                      : '');
                    console.log(`[email-bot] Message from ${fromAddr}: ${subject}`);
                    if (this.onMessage) {
                      this.onMessage(fromAddr, display, { from: fromAddr, subject, userId: fromAddr, attachments });
                    }
                  }
                } catch (err) { console.error('[email-bot] Parse error:', err.message); }
                msgDone++;
                if (msgDone >= msgCount) { console.log('[email-bot] poll done, msgs:', msgCount); try { imap.end(); } catch {} resolve(); }
              });
            });
            f.once('end', () => { if (msgCount === 0) { try { imap.end(); } catch {} resolve(); } });
          });
        });
      });
      imap.once('error', (err) => { console.error('[email-bot] IMAP error:', err.message); abort(); });
    });
  }

  async sendReply(ctx, text) { return true; } // no auto-reply
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
