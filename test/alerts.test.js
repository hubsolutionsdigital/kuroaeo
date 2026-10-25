const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-alerts-'));
const { db } = require('../lib/db');
const alerts = require('../lib/alerts');
const { sendMail } = require('../lib/mailer');

test('speaks SMTP: login, recipients and the message', async (t) => {
  const seen = [];
  const server = net.createServer((sock) => {
    let data = false;
    let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; sock.write('250 queued\r\n'); } else seen.push(`DATA:${line}`); continue; }
        seen.push(line);
        if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (seen.filter((l) => !/^(EHLO|AUTH|MAIL|RCPT|DATA|QUIT)/.test(l)).length === 1) sock.write('334 UGFzc3dvcmQ6\r\n');
        else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n');
        else if (line === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (line === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('235 authenticated\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const cfg = { host: '127.0.0.1', port: server.address().port, user: 'alerts@agency.test', pass: 'secret', from: 'alerts@agency.test', tlsMode: 'plain' };
  const r = await sendMail({ to: 'a@agency.test, b@agency.test, not-an-email', subject: 'Dorothy submitted feedback', text: 'hi', html: '<p>hi</p>' }, cfg);
  assert.equal(r.sent, 2);
  assert.ok(seen.includes(Buffer.from('alerts@agency.test').toString('base64')), 'username sent');
  assert.ok(seen.includes('RCPT TO:<a@agency.test>') && seen.includes('RCPT TO:<b@agency.test>'));
  assert.ok(seen.includes('DATA:Subject: Dorothy submitted feedback'));
});

test('one summary email per review round', async () => {
  process.env.ALERT_EMAIL = 'team@agency.test';
  process.env.SMTP_HOST = 'smtp.test'; process.env.SMTP_USER = 'alerts@agency.test'; process.env.SMTP_PASS = 'x';
  const sent = [];
  alerts.setSender(async (m) => { sent.push(m); });
  const pid = Number(db.prepare("INSERT INTO projects (name, token) VALUES ('Dot Chambers', 'alerts-token')").run().lastInsertRowid);
  // Feedback from before alerts existed is never emailed.
  const add = (type, name, comment = '') => db.prepare("INSERT INTO feedback (project_id, tab, item_key, item_label, type, author_role, name, comment, status) VALUES (?, 'blogs', 'blogs:article:a', 'Divorce by Mutual Agreement', ?, 'client', ?, ?, 'noted')").run(pid, type, name, comment);
  add('approve', 'Old reviewer');
  alerts.initAll(); // what happens when the server starts with existing projects

  add('approve', 'Dorothy');
  add('change', 'Dorothy', 'Please mention mediation');
  db.prepare("INSERT INTO feedback (project_id, tab, item_key, item_label, type, author_role, name, comment, status) VALUES (?, 'blogs', 'x', 'x', 'reply', 'agency', 'Team', 'Done', 'noted')").run(pid);

  let r = await alerts.flush(pid);
  assert.equal(r.reason, 'waiting', 'waits for the reviewer to finish');
  assert.equal(sent.length, 0);

  r = await alerts.flush(pid, { submittedBy: 'Dorothy', force: true, baseUrl: 'https://portal.test' });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Dorothy submitted feedback · Dot Chambers (2 comments)');
  assert.deepEqual(sent[0].to, ['team@agency.test']);
  assert.match(sent[0].html, /Please mention mediation/);
  assert.match(sent[0].html, /https:\/\/portal\.test\/admin#\/project\/\d+\/feedback/);
  assert.doesNotMatch(sent[0].text, /Old reviewer|Team/, 'only this round, only the client');

  r = await alerts.flush(pid, { force: true });
  assert.equal(r.reason, 'nothing new', 'the same round is never sent twice');

  // A project's own addresses replace the default.
  db.prepare("UPDATE projects SET alert_emails = 'am@agency.test' WHERE id = ?").run(pid);
  add('question', 'Tina', 'When does this go live?');
  await alerts.flush(pid, { force: true });
  assert.deepEqual(sent[1].to, ['am@agency.test']);
  assert.equal(sent[1].subject, 'Tina left feedback · Dot Chambers (1 comment)');
});
