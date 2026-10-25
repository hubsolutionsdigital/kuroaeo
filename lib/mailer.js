/* A small SMTP client for feedback alerts, using only Node's net/tls.
 * Works with Zoho Mail, Google Workspace, Outlook and most providers:
 *   SMTP_HOST, SMTP_PORT (465 = TLS, 587 = STARTTLS), SMTP_USER, SMTP_PASS,
 *   ALERT_FROM (defaults to SMTP_USER). */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s<>@,;:"'()\\[\]]+@[^\s<>@,;:"'()\\[\]]+\.[^\s<>@,;:"'()\\[\]]+$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());
const emailList = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(isEmail);

function smtpConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  if (!host || !user || !process.env.SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT) || 465;
  const from = (process.env.ALERT_FROM || user).trim();
  return { host, port, user, pass: process.env.SMTP_PASS, from: isEmail(from) ? from : user };
}

// Reads SMTP replies: "250-..." lines continue, "250 ..." ends a reply.
function replyReader(socket) {
  let buf = '';
  const waiting = [];
  const ready = [];
  let failed = null;
  const take = () => {
    for (;;) {
      const lines = buf.split('\r\n');
      const end = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (end < 0 || end === lines.length - 1) return;
      const reply = { code: Number(lines[end].slice(0, 3)), text: lines.slice(0, end + 1).join('\n') };
      buf = lines.slice(end + 1).join('\r\n');
      if (waiting.length) waiting.shift().resolve(reply); else ready.push(reply);
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); take(); };
  const onError = (err) => { failed = err; while (waiting.length) waiting.shift().reject(err); };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', () => onError(failed || new Error('The mail server closed the connection.')));
  return {
    next: () => (ready.length ? Promise.resolve(ready.shift()) : failed ? Promise.reject(failed) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    stop: () => { socket.off('data', onData); },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function buildMessage({ from, fromName, to, subject, text, html }) {
  const boundary = `b_${crypto.randomBytes(12).toString('hex')}`;
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    `From: ${fromName ? `${header(clean(fromName))} <${from}>` : from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${header(clean(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text || '')),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html || '')),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

async function sendMail({ to, subject, text, html, fromName }, cfg = smtpConfig()) {
  if (!cfg) throw new Error('Email is not set up. Add SMTP_HOST, SMTP_USER and SMTP_PASS in Railway.');
  const rcpts = (Array.isArray(to) ? to : emailList(to)).filter(isEmail);
  if (!rcpts.length) throw new Error('No valid email address to send to.');

  const connect = (opts, event) => new Promise((resolve, reject) => {
    const s = opts.socket ? tls.connect(opts) : (opts.secure ? tls.connect(opts) : net.connect(opts));
    s.setTimeout(20000, () => s.destroy(new Error('The mail server did not answer in time.')));
    s.once(event, () => resolve(s));
    s.once('error', reject);
  });
  // tlsMode 'plain' exists only for tests against a local fake server.
  const mode = cfg.tlsMode || (cfg.port === 465 ? 'tls' : 'starttls');
  const secure = mode === 'tls';
  let socket = await connect({ host: cfg.host, port: cfg.port, servername: cfg.host, secure }, secure ? 'secureConnect' : 'connect');
  let reader = replyReader(socket);
  const send = async (line, ok, hide) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const r = await reader.next();
    if (!ok.includes(r.code)) throw new Error(`Mail server refused ${hide || (line || 'the connection').split(' ')[0]}: ${r.text.split('\n').pop()}`);
    return r;
  };
  try {
    await send(null, [220]);
    let ehlo = await send('EHLO review-portal', [250]);
    if (mode === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('The mail server does not offer a secure connection on this port. Use port 465.');
      await send('STARTTLS', [220]);
      reader.stop();
      socket = await connect({ socket, servername: cfg.host }, 'secureConnect');
      reader = replyReader(socket);
      ehlo = await send('EHLO review-portal', [250]);
    }
    await send('AUTH LOGIN', [334]);
    await send(b64(cfg.user), [334], 'the username');
    await send(b64(cfg.pass), [235], 'the password (check SMTP_USER and SMTP_PASS; Zoho and Gmail need an app password)');
    await send(`MAIL FROM:<${cfg.from}>`, [250]);
    for (const r of rcpts) await send(`RCPT TO:<${r}>`, [250, 251], `the address ${r}`);
    await send('DATA', [354]);
    const body = buildMessage({ from: cfg.from, fromName, to: rcpts, subject, text, html })
      .replace(/\r\n\./g, '\r\n..');
    await send(`${body}\r\n.`, [250], 'the message');
    socket.write('QUIT\r\n');
  } finally {
    setTimeout(() => socket.destroy(), 500);
  }
  return { sent: rcpts.length };
}

module.exports = { sendMail, smtpConfig, emailList, isEmail, buildMessage };
