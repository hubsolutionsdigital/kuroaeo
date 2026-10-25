/* Feedback alerts for the agency: one summary email per review round, not one
 * per comment. A round is sent when the client presses "Submit feedback", or
 * after QUIET_MINUTES without new feedback from them. */

const { db, transaction } = require('./db');
const { sendMail, smtpConfig, emailList } = require('./mailer');

const QUIET_MINUTES = 10;

db.exec(`
  CREATE TABLE IF NOT EXISTS alert_state (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    last_feedback_id INTEGER NOT NULL DEFAULT 0,
    last_edit_at TEXT NOT NULL DEFAULT ''
  );
`);
const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
// Who gets the alerts for this project; empty means ALERT_EMAIL.
if (!projectCols.includes('alert_emails')) db.exec("ALTER TABLE projects ADD COLUMN alert_emails TEXT NOT NULL DEFAULT ''");

const TYPE_LABEL = {
  love: '❤️ Love it', like: '👍 Like this', great: '🎉 This is great', approve: '✅ Approved',
  change: '✏️ Change requested', question: '❓ Question', reply: '↩️ Reply', edit: '✏️ Edited text',
};
const TAB_LABEL = { keywords: 'Keywords', onpage: 'On-Page SEO', prompts: 'Prompts', backlinks: 'Backlinks', blogs: 'Blogs', landing: 'Landing Pages' };

// Projects that exist when alerts start begin from "now", so the first deploy
// does not email everything ever submitted. Projects added later start from
// the beginning, so their first feedback is never skipped.
function initAll() {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO alert_state (project_id, last_feedback_id, last_edit_at)
    SELECT p.id,
      (SELECT COALESCE(MAX(id), 0) FROM feedback f WHERE f.project_id = p.id),
      (SELECT COALESCE(MAX(updated_at), '') FROM doc_edits e WHERE e.project_id = p.id)
    FROM projects p
  `);
  ins.run();
}
initAll();

function stateOf(projectId) {
  let st = db.prepare('SELECT * FROM alert_state WHERE project_id = ?').get(projectId);
  if (!st) {
    db.prepare("INSERT OR IGNORE INTO alert_state (project_id, last_feedback_id, last_edit_at) VALUES (?, 0, '')").run(projectId);
    st = { project_id: projectId, last_feedback_id: 0, last_edit_at: '' };
  }
  return st;
}

function pending(projectId) {
  const st = stateOf(projectId);
  const feedback = db.prepare(`
    SELECT id, tab, item_label, type, name, comment, quote, area, created_at FROM feedback
    WHERE project_id = ? AND id > ? AND author_role = 'client' ORDER BY id
  `).all(projectId, st.last_feedback_id);
  const edits = db.prepare(`
    SELECT e.item_key, e.html, e.original_html, e.name, e.updated_at, d.tab, i.label AS item_label FROM doc_edits e
    JOIN datasets d ON d.id = e.dataset_id LEFT JOIN items i ON i.dataset_id = e.dataset_id AND i.item_key = e.item_key
    WHERE e.project_id = ? AND e.updated_at > ? ORDER BY e.updated_at
  `).all(projectId, st.last_edit_at);
  return { feedback, edits };
}

function recipients(project) {
  const own = emailList(project.alert_emails);
  return own.length ? own : emailList(process.env.ALERT_EMAIL);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const joinNames = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

function digest(project, { feedback, edits }, { submittedBy, baseUrl } = {}) {
  const rows = [
    ...feedback.map((f) => ({
      when: f.created_at, tab: f.tab, item: f.item_label, type: f.type, name: f.name,
      detail: [f.comment, f.quote && f.type !== 'reply' ? `“${f.quote}”` : ''].filter(Boolean).join(' · '),
    })),
    ...edits.map((e) => ({
      when: e.updated_at, tab: e.tab, item: e.item_label || e.item_key, type: 'edit', name: e.name,
      detail: `Before: ${plain(e.original_html).slice(0, 200)} → After: ${plain(e.html).slice(0, 200)}`,
    })),
  ].sort((a, b) => (a.when < b.when ? -1 : 1));
  const names = [...new Set(rows.map((r) => r.name))];
  const who = submittedBy && names.includes(submittedBy) ? joinNames([submittedBy, ...names.filter((n) => n !== submittedBy)]) : joinNames(names);
  const n = rows.length;
  const subject = `${who} ${submittedBy ? 'submitted feedback' : 'left feedback'} · ${project.name} (${n} ${n === 1 ? 'comment' : 'comments'})`;
  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
  const countLine = Object.entries(counts).map(([t, c]) => `${TYPE_LABEL[t] || t}: ${c}`).join(' · ');
  const link = baseUrl ? `${baseUrl}/admin#/project/${project.id}/feedback` : null;
  const needs = (counts.change || 0) + (counts.question || 0);

  const text = [
    subject, '', countLine, needs ? `${needs} need a reply.` : '', '',
    ...rows.map((r) => `- [${TAB_LABEL[r.tab] || r.tab}] ${r.item} — ${TYPE_LABEL[r.type] || r.type} by ${r.name}${r.detail ? `: ${r.detail}` : ''}`),
    '', link ? `Open in the portal: ${link}` : '',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#17213a">
<div style="max-width:680px;margin:0 auto;padding:24px 16px">
  <div style="background:#1d3a6b;color:#fff;border-radius:14px 14px 0 0;padding:18px 22px">
    <div style="font-size:13px;opacity:.8">Review portal · ${esc(project.name)}</div>
    <div style="font-size:19px;font-weight:700;margin-top:4px">${esc(who)} ${submittedBy ? 'submitted feedback' : 'left feedback'} (${n} ${n === 1 ? 'comment' : 'comments'})</div>
  </div>
  <div style="background:#fff;border:1px solid #e3e8f0;border-top:none;border-radius:0 0 14px 14px;padding:18px 22px">
    <p style="margin:0 0 6px;font-size:14px">${esc(countLine)}</p>
    ${needs ? `<p style="margin:0 0 14px;font-size:14px;color:#8a5a00;font-weight:600">${needs} ${needs === 1 ? 'needs' : 'need'} a reply from the team.</p>` : ''}
    <table style="width:100%;border-collapse:collapse;font-size:13.5px">
      ${rows.slice(0, 80).map((r) => `<tr>
        <td style="padding:8px 6px;border-top:1px solid #eef1f6;vertical-align:top;white-space:nowrap;color:#7d869c">${esc(TAB_LABEL[r.tab] || r.tab)}</td>
        <td style="padding:8px 6px;border-top:1px solid #eef1f6;vertical-align:top"><strong>${esc(r.item)}</strong><br><span>${esc(TYPE_LABEL[r.type] || r.type)}</span> <span style="color:#7d869c">by ${esc(r.name)}</span>${r.detail ? `<div style="margin-top:3px;color:#4a5570">${esc(r.detail)}</div>` : ''}</td>
      </tr>`).join('')}
    </table>
    ${rows.length > 80 ? `<p style="font-size:13px;color:#7d869c">…and ${rows.length - 80} more.</p>` : ''}
    ${link ? `<p style="margin:18px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#1d3a6b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">Open feedback in the portal</a></p>` : ''}
  </div>
</div></body></html>`;
  return { subject, text, html, count: n };
}

// Send what is waiting for a project. Returns { count, sent, reason }.
let sendImpl = sendMail;
async function flush(projectId, { submittedBy, baseUrl, force } = {}) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return { count: 0, sent: false, reason: 'no project' };
  const p = pending(projectId);
  const count = p.feedback.length + p.edits.length;
  if (!count) return { count: 0, sent: false, reason: 'nothing new' };
  if (!force) {
    const newest = [...p.feedback.map((f) => f.created_at), ...p.edits.map((e) => e.updated_at)].sort().pop();
    const age = (Date.now() - Date.parse(`${newest.replace(' ', 'T')}Z`)) / 60000;
    if (age < QUIET_MINUTES) return { count, sent: false, reason: 'waiting' };
  }
  const markDone = () => transaction(() => db.prepare('UPDATE alert_state SET last_feedback_id = ?, last_edit_at = ? WHERE project_id = ?').run(
    p.feedback.length ? p.feedback[p.feedback.length - 1].id : stateOf(projectId).last_feedback_id,
    p.edits.length ? p.edits[p.edits.length - 1].updated_at : stateOf(projectId).last_edit_at,
    projectId,
  ));
  const to = recipients(project);
  if (!to.length || !smtpConfig()) { markDone(); return { count, sent: false, reason: 'not set up' }; }
  const mail = digest(project, p, { submittedBy, baseUrl: baseUrl || publicUrl() });
  markDone(); // mark first, so a slow or failing mail server never sends the same round twice
  try {
    await sendImpl({ to, subject: mail.subject, text: mail.text, html: mail.html, fromName: 'Review portal' });
    return { count, sent: true };
  } catch (err) {
    console.error(`Feedback alert for project ${projectId} failed: ${err.message}`);
    return { count, sent: false, reason: err.message };
  }
}

// The portal's own address for links in emails: PUBLIC_URL, or the last
// address the team used to open the admin.
let seenUrl = '';
function rememberUrl(url) { if (url && !process.env.PUBLIC_URL) seenUrl = url.replace(/\/$/, ''); }
function publicUrl() { return (process.env.PUBLIC_URL || seenUrl || '').replace(/\/$/, ''); }

let timer = null;
function startAlerts() {
  if (timer) return;
  timer = setInterval(async () => {
    for (const { id } of db.prepare('SELECT id FROM projects').all()) {
      try { await flush(id); } catch (err) { console.error('Feedback alerts:', err.message); }
    }
  }, 60 * 1000);
  timer.unref();
}

module.exports = {
  flush, startAlerts, rememberUrl, recipients, stateOf, initAll, digest, pending, QUIET_MINUTES,
  setSender: (fn) => { sendImpl = fn; },
};
