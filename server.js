const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { db, transaction } = require('./lib/db');
const { parseWorkbook, primaryColumn, normalizeKey, TABS } = require('./lib/excel');
const { parseBlogDoc, sanitizeEdit, sanitizeIntro, stripTags } = require('./lib/docx');
const analytics = require('./lib/analytics');

const PORT = Number(process.env.PORT) || 3000;
const AGENCY_NAME = process.env.AGENCY_NAME || 'Hub Solutions Digital';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`portal:${ADMIN_PASSWORD}`).digest('hex');
analytics.setSecret(SESSION_SECRET);
if (!process.env.ADMIN_PASSWORD) {
  if (process.env.NODE_ENV === 'production') throw new Error('Set ADMIN_PASSWORD before running in production.');
  console.warn('ADMIN_PASSWORD is not set; using the default password "admin".');
}

const FEEDBACK_TYPES = ['love', 'like', 'great', 'approve', 'change', 'question', 'reply'];
const NEEDS_ACTION = new Set(['change', 'question']);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const newToken = () => crypto.randomBytes(18).toString('base64url');
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function defaultPeriod() {
  return new Date().toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// ---------- admin session ----------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isAdmin(req) {
  const c = readCookie(req, 'portal_admin');
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(`admin:${exp}`);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Please log in.' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const want = Buffer.from(ADMIN_PASSWORD);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  res.cookie('portal_admin', `${exp}.${sign(`admin:${exp}`)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000, path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('portal_admin', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req), agency: AGENCY_NAME }));

// ---------- shared queries ----------

function getProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Project not found.');
  return p;
}

function listDatasets(projectId) {
  return db.prepare(`
    SELECT d.id, d.tab, d.name, d.period, d.phase, d.kind, d.source_file, d.created_at,
           (SELECT COUNT(*) FROM items i WHERE i.dataset_id = d.id) AS item_count
    FROM datasets d WHERE d.project_id = ? ORDER BY d.tab, d.name, d.id DESC
  `).all(projectId);
}

function listFeedback(projectId) {
  return db.prepare('SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at, id').all(projectId);
}

// What is inside each sheet or document (newest version), for the client's
// home page: the keyword, page or article names, without the full data.
function reviewContents(projectId) {
  const latest = db.prepare(`
    SELECT d.id, d.tab, d.name, d.period, d.phase, d.kind FROM datasets d
    WHERE d.id IN (SELECT MAX(id) FROM datasets WHERE project_id = ? GROUP BY tab, name) ORDER BY d.id
  `).all(projectId);
  const items = db.prepare('SELECT kind, item_key, label FROM items WHERE dataset_id = ? ORDER BY position');
  return latest.map((d) => {
    const all = items.all(d.id);
    return {
      ...d,
      checks: all.filter((i) => i.kind === 'check').length,
      items: all.filter((i) => i.kind !== 'check').map((i) => ({ key: i.item_key, label: i.label })),
    };
  });
}

// Review progress per tab, counted over the newest version of each sheet/doc.
function tabProgress(projectId) {
  const latest = db.prepare(`
    SELECT MAX(id) AS id FROM datasets WHERE project_id = ? GROUP BY tab, name
  `).all(projectId).map((r) => r.id);
  const reviewed = new Set(db.prepare(`
    SELECT DISTINCT item_key FROM feedback WHERE project_id = ? AND parent_id IS NULL AND author_role = 'client'
  `).all(projectId).map((r) => r.item_key));
  const out = Object.fromEntries(TABS.map((t) => [t, { items: 0, reviewed: 0 }]));
  if (!latest.length) return out;
  const keys = db.prepare(`
    SELECT DISTINCT tab, item_key FROM items WHERE dataset_id IN (${latest.map(() => '?').join(',')})
  `).all(...latest);
  for (const k of keys) {
    if (!out[k.tab]) continue;
    out[k.tab].items++;
    if (reviewed.has(k.item_key)) out[k.tab].reviewed++;
  }
  return out;
}

function getDatasetPayload(projectId, datasetId) {
  const d = db.prepare('SELECT * FROM datasets WHERE id = ? AND project_id = ?').get(datasetId, projectId);
  if (!d) throw new HttpError(404, 'Not found.');
  const items = db.prepare('SELECT id, kind, item_key, label, data FROM items WHERE dataset_id = ? ORDER BY position')
    .all(d.id).map((i) => ({ ...i, data: parseJSON(i.data, null) }));

  // Previous version of the same sheet, so the client can see month-on-month movement.
  let previous = null;
  if (d.kind === 'table') {
    const prev = db.prepare(`
      SELECT id, period, columns FROM datasets
      WHERE project_id = ? AND tab = ? AND name = ? AND kind = 'table' AND id < ? ORDER BY id DESC LIMIT 1
    `).get(projectId, d.tab, d.name, d.id);
    if (prev) {
      const rows = {};
      for (const r of db.prepare('SELECT item_key, data FROM items WHERE dataset_id = ?').all(prev.id)) {
        rows[r.item_key] = parseJSON(r.data, []);
      }
      previous = { period: prev.period, columns: parseJSON(prev.columns, []), rows };
    }
  }

  return {
    dataset: {
      id: d.id, tab: d.tab, name: d.name, period: d.period, phase: d.phase, kind: d.kind, created_at: d.created_at,
      columns: parseJSON(d.columns, []), meta: parseJSON(d.meta, {}),
      primary: d.kind === 'table' ? primaryColumn(parseJSON(d.columns, []), d.tab) : null,
    },
    items,
    previous,
    edits: d.kind === 'doc' ? listEdits({ datasetId: d.id }) : [],
  };
}

function listEdits({ datasetId, projectId }) {
  return db.prepare(`
    SELECT e.dataset_id, e.item_key, e.block, e.original_html, e.html, e.name, e.updated_at, d.name AS dataset_name, d.tab, i.label AS item_label
    FROM doc_edits e JOIN datasets d ON d.id = e.dataset_id
    LEFT JOIN items i ON i.dataset_id = e.dataset_id AND i.item_key = e.item_key
    WHERE ${datasetId ? 'e.dataset_id = ?' : 'e.project_id = ?'} ORDER BY e.dataset_id, e.item_key, e.block
  `).all(datasetId || projectId);
}

// Optional campaign phase (1-12) an upload belongs to, e.g. the blogs for Phase 2.
const phaseOf = (v) => { const n = parseInt(v, 10); return n >= 1 && n <= 12 ? n : null; };

function insertDataset(projectId, { tab, name, period, phase = null, kind, columns = [], meta = {}, source }) {
  const r = db.prepare(`
    INSERT INTO datasets (project_id, tab, name, period, phase, kind, columns, meta, source_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, tab, name, period, phase, kind, JSON.stringify(columns), JSON.stringify(meta), source || '');
  return Number(r.lastInsertRowid);
}

const insertItem = () => db.prepare(`
  INSERT INTO items (dataset_id, project_id, tab, kind, item_key, label, position, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function importSheet(projectId, sheet, { tab, name, period, phase, source }) {
  const datasetId = insertDataset(projectId, {
    tab, name, period, phase, kind: 'table', columns: sheet.columns, meta: { title: sheet.title || '' }, source,
  });
  const pi = primaryColumn(sheet.columns, tab);
  const seen = new Map();
  const stmt = insertItem();
  sheet.rows.forEach((row, i) => {
    const label = row[pi] == null ? `Row ${i + 1}` : String(row[pi]);
    let key = `${tab}:${normalizeKey(label)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `#${n}`;
    stmt.run(datasetId, projectId, tab, 'row', key, label.slice(0, 300), i, JSON.stringify(row));
  });
  return datasetId;
}

// Word documents for review: blog articles or landing pages, one section per page.
const DOC_TABS = ['blogs', 'landing'];

function importBlogDoc(projectId, doc, { tab = 'blogs', name, period, phase, source }) {
  const datasetId = insertDataset(projectId, {
    tab, name, period, phase, kind: 'doc', meta: { title: doc.title, introHtml: doc.introHtml }, source,
  });
  const stmt = insertItem();
  let pos = 0;
  for (const c of doc.checks) {
    stmt.run(datasetId, projectId, tab, 'check', `${tab}:${c.key}`, c.text.slice(0, 300), pos++, JSON.stringify({ text: c.text }));
  }
  for (const a of doc.articles) {
    stmt.run(datasetId, projectId, tab, 'article', `${tab}:${a.key}`, a.title.slice(0, 300), pos++,
      JSON.stringify({ number: a.number, title: a.title, seo: a.seo, html: a.html }));
  }
  return datasetId;
}

// ---------- admin: projects ----------

app.get('/api/admin/projects', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM datasets d WHERE d.project_id = p.id) AS dataset_count,
      (SELECT COUNT(*) FROM feedback f WHERE f.project_id = p.id AND f.status = 'open') AS open_count,
      (SELECT COUNT(*) FROM feedback f WHERE f.project_id = p.id AND f.author_role = 'client') AS feedback_count,
      (SELECT MAX(created_at) FROM feedback f WHERE f.project_id = p.id AND f.author_role = 'client') AS last_feedback_at
    FROM projects p ORDER BY p.id DESC
  `).all();
  res.json({ projects: rows });
});

app.post('/api/admin/projects', requireAdmin, (req, res) => {
  const name = str(req.body?.name, 120);
  if (!name) throw new HttpError(400, 'Project name is required.');
  const r = db.prepare('INSERT INTO projects (name, client_name, website, token) VALUES (?, ?, ?, ?)')
    .run(name, str(req.body?.client_name, 120), str(req.body?.website, 300), newToken());
  res.json({ project: getProject(Number(r.lastInsertRowid)) });
});

app.get('/api/admin/projects/:id', requireAdmin, (req, res) => {
  const project = getProject(req.params.id);
  res.json({
    project,
    datasets: listDatasets(project.id),
    feedback: listFeedback(project.id),
    progress: tabProgress(project.id),
  });
});

app.patch('/api/admin/projects/:id', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, 120) : p.name;
  if (!name) throw new HttpError(400, 'Project name is required.');
  db.prepare('UPDATE projects SET name = ?, client_name = ?, website = ?, token = ? WHERE id = ?').run(
    name,
    b.client_name !== undefined ? str(b.client_name, 120) : p.client_name,
    b.website !== undefined ? str(b.website, 300) : p.website,
    b.regenerate_token ? newToken() : p.token,
    p.id,
  );
  res.json({ project: getProject(p.id) });
});

app.delete('/api/admin/projects/:id', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---------- admin: uploads ----------

// Excel import is two steps: preview (detect sheets and suggest a tab for each),
// then import with the admin's choices. Parsed sheets wait here in between.
const pendingUploads = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingUploads) if (v.expires < now) pendingUploads.delete(k);
}, 60 * 1000).unref();

// Detected sheets of a workbook, for the team to choose which tab each goes to.
async function previewWorkbook(project, buffer, filename) {
  let sheets;
  try {
    sheets = await parseWorkbook(buffer);
  } catch {
    throw new HttpError(400, 'That file could not be read as an Excel workbook.');
  }
  const uploadId = crypto.randomBytes(12).toString('hex');
  pendingUploads.set(uploadId, { projectId: project.id, sheets, filename, expires: Date.now() + 60 * 60 * 1000 });
  const existing = listDatasets(project.id).filter((d) => d.kind === 'table');
  return {
    uploadId,
    filename,
    period: defaultPeriod(),
    sheets: sheets.map((s, index) => {
      // Suggest re-using the existing name so monthly uploads become new versions.
      const match = existing.find((d) => d.name.toLowerCase() === s.name.toLowerCase());
      return {
        index, name: s.name, title: s.title, columns: s.columns, rowCount: s.rows.length,
        sample: s.rows.slice(0, 3), suggestedTab: match ? match.tab : s.suggestedTab,
        existingVersion: Boolean(match),
      };
    }),
  };
}

app.post('/api/admin/projects/:id/excel/preview', requireAdmin, upload.single('file'), async (req, res) => {
  const project = getProject(req.params.id);
  if (!req.file) throw new HttpError(400, 'Choose an Excel file (.xlsx).');
  if (!/\.xlsx$/i.test(req.file.originalname)) throw new HttpError(400, 'Only .xlsx files are supported. In Google Sheets use File → Download → Microsoft Excel, or pick the sheet with “From Google Sheets”.');
  res.json(await previewWorkbook(project, req.file.buffer, req.file.originalname));
});

// Google Sheets: the same preview, read straight from the connected Google account.
// The chosen spreadsheet is remembered per project ("upload" or "metrics").
async function fetchSheet(project, fileId, purpose) {
  let file;
  try { file = await analytics.downloadSpreadsheet(fileId); } catch (err) { throw new HttpError(400, err.message); }
  const settings = analytics.getSettings(project.id);
  analytics.saveSettings(project.id, { ...settings, sheets: { ...(settings.sheets || {}), [purpose]: { id: String(fileId), name: file.name } } });
  return file;
}

app.get('/api/admin/google/status', requireAdmin, (req, res) => {
  res.json({ ...analytics.googleIdentity(), oauthConfigured: Boolean(analytics.oauthClient()) });
});

app.get('/api/admin/google/sheets', requireAdmin, async (req, res) => {
  try { res.json({ files: await analytics.listSpreadsheets(str(req.query.q, 100)) }); } catch (err) { throw new HttpError(400, err.message); }
});

app.get('/api/admin/projects/:id/gsheet', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  res.json({ sheets: analytics.getSettings(p.id).sheets || {} });
});

app.post('/api/admin/projects/:id/gsheet/preview', requireAdmin, async (req, res) => {
  const project = getProject(req.params.id);
  const file = await fetchSheet(project, req.body?.fileId, 'upload');
  res.json(await previewWorkbook(project, file.buffer, `${file.name} (Google Sheets)`));
});

app.post('/api/admin/projects/:id/excel/import', requireAdmin, (req, res) => {
  const project = getProject(req.params.id);
  const pending = pendingUploads.get(String(req.body?.uploadId || ''));
  if (!pending || pending.projectId !== project.id) throw new HttpError(400, 'Upload expired. Please choose the file again.');
  const choices = Array.isArray(req.body?.sheets) ? req.body.sheets : [];
  const created = transaction(() => {
    const ids = [];
    for (const c of choices) {
      const sheet = pending.sheets[c.index];
      if (!sheet || !TABS.includes(c.tab)) continue;
      ids.push(importSheet(project.id, sheet, {
        tab: c.tab,
        name: str(c.name, 120) || sheet.name,
        period: str(c.period, 60) || defaultPeriod(),
        phase: phaseOf(c.phase),
        source: pending.filename,
      }));
    }
    return ids;
  });
  if (!created.length) throw new HttpError(400, 'Pick at least one sheet to import.');
  pendingUploads.delete(req.body.uploadId);
  res.json({ ok: true, created });
});

app.post('/api/admin/projects/:id/docx', requireAdmin, upload.single('file'), async (req, res) => {
  const project = getProject(req.params.id);
  if (!req.file) throw new HttpError(400, 'Choose a Word document (.docx).');
  if (!/\.docx$/i.test(req.file.originalname)) throw new HttpError(400, 'Only .docx files are supported. In Google Docs use File → Download → Microsoft Word.');
  let doc;
  try {
    doc = await parseBlogDoc(req.file.buffer, req.file.originalname);
  } catch {
    throw new HttpError(400, 'That file could not be read as a Word document.');
  }
  const id = transaction(() => importBlogDoc(project.id, doc, {
    tab: DOC_TABS.includes(req.body?.tab) ? req.body.tab : 'blogs',
    name: str(req.body?.name, 120) || doc.title,
    period: str(req.body?.period, 60) || defaultPeriod(),
    phase: phaseOf(req.body?.phase),
    source: req.file.originalname,
  }));
  res.json({ ok: true, id, articles: doc.articles.length, checks: doc.checks.length });
});

app.get('/api/admin/projects/:id/datasets/:datasetId', requireAdmin, (req, res) => {
  const project = getProject(req.params.id);
  res.json(getDatasetPayload(project.id, req.params.datasetId));
});

app.patch('/api/admin/datasets/:id', requireAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(req.params.id);
  if (!d) throw new HttpError(404, 'Not found.');
  const b = req.body || {};
  const tab = b.tab !== undefined ? b.tab : d.tab;
  if (!TABS.includes(tab)) throw new HttpError(400, 'Unknown tab.');
  if (tab !== d.tab && d.kind === 'doc' && !DOC_TABS.includes(tab)) throw new HttpError(400, 'Word documents can only move between Blogs and Landing Pages.');
  transaction(() => {
    db.prepare('UPDATE datasets SET name = ?, period = ?, phase = ?, tab = ? WHERE id = ?').run(
      b.name !== undefined ? (str(b.name, 120) || d.name) : d.name,
      b.period !== undefined ? str(b.period, 60) : d.period,
      b.phase !== undefined ? phaseOf(b.phase) : d.phase,
      tab, d.id,
    );
    // The team can edit a document's overview text (e.g. remove a question).
    if (d.kind === 'doc' && typeof b.introHtml === 'string') {
      const meta = parseJSON(d.meta, {});
      meta.introHtml = sanitizeIntro(b.introHtml.slice(0, 500000));
      db.prepare('UPDATE datasets SET meta = ? WHERE id = ?').run(JSON.stringify(meta), d.id);
    }
    if (tab !== d.tab && d.kind === 'doc') {
      db.prepare("UPDATE items SET tab = ?, item_key = ? || substr(item_key, instr(item_key, ':')) WHERE dataset_id = ?").run(tab, tab, d.id);
    } else if (tab !== d.tab) {
      // Re-key rows for the new tab so feedback is tracked against the right section.
      const columns = parseJSON(d.columns, []);
      const pi = primaryColumn(columns, tab);
      const seen = new Map();
      const upd = db.prepare('UPDATE items SET tab = ?, item_key = ?, label = ? WHERE id = ?');
      for (const it of db.prepare('SELECT id, data, position FROM items WHERE dataset_id = ? ORDER BY position').all(d.id)) {
        const row = parseJSON(it.data, []);
        const label = row[pi] == null ? `Row ${it.position + 1}` : String(row[pi]);
        let key = `${tab}:${normalizeKey(label)}`;
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        if (n > 1) key += `#${n}`;
        upd.run(tab, key, label.slice(0, 300), it.id);
      }
    }
  });
  res.json({ ok: true });
});

app.delete('/api/admin/datasets/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM datasets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: feedback ----------

function getFeedback(id) {
  const f = db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  if (!f) throw new HttpError(404, 'Feedback not found.');
  return f;
}

app.post('/api/admin/feedback/:id/reply', requireAdmin, (req, res) => {
  const parent = getFeedback(req.params.id);
  const root = parent.parent_id ? getFeedback(parent.parent_id) : parent;
  const comment = str(req.body?.comment, 5000);
  if (!comment) throw new HttpError(400, 'Write a reply first.');
  const name = str(req.body?.name, 80) || AGENCY_NAME;
  transaction(() => {
    db.prepare(`
      INSERT INTO feedback (project_id, parent_id, dataset_id, tab, item_key, item_label, type, author_role, name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'reply', 'agency', ?, ?, 'noted')
    `).run(root.project_id, root.id, root.dataset_id, root.tab, root.item_key, root.item_label, name, comment);
    if (req.body?.resolve) db.prepare("UPDATE feedback SET status = 'resolved' WHERE id = ?").run(root.id);
  });
  res.json({ ok: true });
});

app.patch('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  const f = getFeedback(req.params.id);
  const status = req.body?.status;
  if (!['open', 'resolved', 'noted'].includes(status)) throw new HttpError(400, 'Unknown status.');
  db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, f.id);
  res.json({ ok: true });
});

app.delete('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
}

app.get('/api/admin/projects/:id/edits', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  res.json({ edits: listEdits({ projectId: p.id }) });
});

app.get('/api/admin/projects/:id/feedback.csv', requireAdmin, (req, res) => {
  const project = getProject(req.params.id);
  const all = listFeedback(project.id);
  const header = ['Date (UTC)', 'Tab', 'Item', 'Section', 'Type', 'Name', 'Role', 'Comment', 'Highlighted text', 'Status', 'Reply to'];
  const lines = [header.join(',')];
  for (const f of all) {
    lines.push([f.created_at, f.tab, f.item_label, f.area, f.type, f.name, f.author_role, f.comment, f.quote, f.status, f.parent_id || '']
      .map(csvCell).join(','));
  }
  for (const e of listEdits({ projectId: project.id })) {
    lines.push([e.updated_at, e.tab, e.item_label || e.item_key, `Paragraph ${e.block + 1}`, 'edit', e.name, 'client', `After: ${words(e.html)}`, `Before: ${words(e.original_html)}`, '', '']
      .map(csvCell).join(','));
  }
  const filename = `${project.name.replace(/[^a-z0-9]+/gi, '-')}-feedback.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${lines.join('\r\n')}`);
});

// ---------- admin: performance dashboard ----------

// "Sign in with Google": one agency Google account, connected once, reads every
// client's Search Console and GA4 that the account has access to.
function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/admin/google/callback`;
}

app.get('/api/admin/google/connect', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin');
  const project = Number(req.query.project) || 0;
  const view = ['performance', 'upload'].includes(req.query.back) ? req.query.back : 'performance';
  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = `${nonce}.${project}.${view}`;
  let url;
  try { url = analytics.googleAuthUrl(googleRedirectUri(req), state); } catch (err) {
    return res.redirect(`/admin?google=error&msg=${encodeURIComponent(err.message)}#/${project ? `project/${project}/${view}` : ''}`);
  }
  res.cookie('portal_google', `${state}.${sign(`google:${state}`)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000, path: '/api/admin/google',
  });
  res.redirect(url);
});

app.get('/api/admin/google/callback', async (req, res) => {
  const cookie = readCookie(req, 'portal_google') || '';
  res.clearCookie('portal_google', { path: '/api/admin/google' });
  const state = String(req.query.state || '');
  const project = Number(state.split('.')[1]) || 0;
  const view = state.split('.')[2] === 'upload' ? 'upload' : 'performance';
  const back = (status, message) => res.redirect(`/admin?google=${status}${message ? `&msg=${encodeURIComponent(message)}` : ''}#/${project ? `project/${project}/${view}` : ''}`);
  const expected = `${state}.${sign(`google:${state}`)}`;
  const validState = state && cookie.length === expected.length && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(expected));
  if (!isAdmin(req) || !validState) return back('error', 'The sign-in link expired. Please click Connect again.');
  if (req.query.error) return back('error', req.query.error === 'access_denied' ? 'Google access was not granted.' : String(req.query.error).slice(0, 100));
  try {
    const email = await analytics.connectGoogle(String(req.query.code || ''), googleRedirectUri(req));
    back('connected', email);
  } catch (err) { back('error', err.message); }
});

app.post('/api/admin/google/disconnect', requireAdmin, async (req, res) => {
  await analytics.disconnectGoogle();
  res.json({ ok: true });
});

app.get('/api/admin/google/properties', requireAdmin, async (req, res) => {
  res.json(await analytics.googleProperties());
});

app.get('/api/admin/projects/:id/analytics', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  res.json({
    settings: analytics.getSettings(p.id),
    serviceAccount: analytics.serviceAccount()?.client_email || null,
    google: { ...analytics.googleIdentity(), oauthConfigured: Boolean(analytics.oauthClient()), redirectUri: googleRedirectUri(req) },
    semrushConfigured: Boolean(process.env.SEMRUSH_API_KEY),
    dashboard: analytics.dashboard(p.id, { forAdmin: true }),
  });
});

app.put('/api/admin/projects/:id/analytics', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  const b = req.body || {};
  const cur = analytics.getSettings(p.id);
  const start = analytics.toMonth(b.start);
  analytics.saveSettings(p.id, {
    ...cur,
    ga4Property: str(b.ga4Property, 40).replace(/[^0-9]/g, ''),
    gscSite: str(b.gscSite, 200),
    start: start || null,
    country: ['', 'sgp', 'mys', 'aus', 'gbr', 'usa', 'hkg'].includes(b.country) ? b.country : 'sgp',
    semrush: {
      enabled: Boolean(b.semrush && b.semrush.enabled),
      clientToggle: Boolean(b.semrush && b.semrush.clientToggle),
      domain: str(b.semrush && b.semrush.domain, 200),
      database: str(b.semrush && b.semrush.database, 10).toLowerCase() || 'sg',
    },
  });
  res.json({ ok: true, settings: analytics.getSettings(p.id) });
});

app.post('/api/admin/projects/:id/analytics/sync', requireAdmin, async (req, res) => {
  const p = getProject(req.params.id);
  res.json(await analytics.syncProject(p.id, { only: req.body?.only }));
});

app.post('/api/admin/projects/:id/analytics/upload', requireAdmin, upload.single('file'), async (req, res) => {
  const p = getProject(req.params.id);
  if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw new HttpError(400, 'Choose an Excel file (.xlsx).');
  let sheets;
  try { sheets = await parseWorkbook(req.file.buffer); } catch { throw new HttpError(400, 'That file could not be read as an Excel workbook.'); }
  const r = analytics.importMetricSheets(p.id, sheets);
  if (!r.count) throw new HttpError(400, 'No monthly numbers found. Use a sheet with a Month column (e.g. "Oct 2026") and one column per number, or a Search Console "Dates" export.');
  res.json({ ok: true, ...r });
});

app.post('/api/admin/projects/:id/analytics/gsheet', requireAdmin, async (req, res) => {
  const p = getProject(req.params.id);
  const file = await fetchSheet(p, req.body?.fileId, 'metrics');
  let sheets;
  try { sheets = await parseWorkbook(file.buffer); } catch { throw new HttpError(400, 'That spreadsheet could not be read.'); }
  const r = analytics.importMetricSheets(p.id, sheets);
  if (!r.count) throw new HttpError(400, 'No monthly numbers found. Use a sheet with a Month column (e.g. "Oct 2026") and one column per number.');
  res.json({ ok: true, ...r });
});

app.delete('/api/admin/projects/:id/analytics/metrics', requireAdmin, (req, res) => {
  const p = getProject(req.params.id);
  db.prepare('DELETE FROM metrics WHERE project_id = ? AND source = ? AND metric = ?').run(p.id, str(req.body?.source, 20), str(req.body?.metric, 60));
  res.json({ ok: true });
});

// ---------- client (link-only access) ----------

function projectByToken(token) {
  const p = db.prepare('SELECT * FROM projects WHERE token = ?').get(String(token));
  if (!p) throw new HttpError(404, 'This review link is not valid. Please ask your account manager for the latest link.');
  return p;
}

const clientProject = (p) => ({ name: p.name, client_name: p.client_name, website: p.website });

app.get('/api/c/:token', (req, res) => {
  const p = projectByToken(req.params.token);
  res.json({
    agency: AGENCY_NAME,
    project: clientProject(p),
    datasets: listDatasets(p.id).map(({ source_file, ...d }) => d),
    feedback: listFeedback(p.id),
    progress: tabProgress(p.id),
    contents: reviewContents(p.id),
  });
});

app.get('/api/c/:token/datasets/:id', (req, res) => {
  const p = projectByToken(req.params.token);
  res.json(getDatasetPayload(p.id, req.params.id));
});

app.get('/api/c/:token/analytics', (req, res) => {
  const p = projectByToken(req.params.token);
  res.json(analytics.dashboard(p.id));
});

app.get('/api/c/:token/feedback', (req, res) => {
  const p = projectByToken(req.params.token);
  res.json({ feedback: listFeedback(p.id), progress: tabProgress(p.id) });
});

// The client edits a paragraph of a blog or landing page directly. The edit
// replaces any earlier one for that paragraph; an edit back to the original
// words removes it.
const words = (html) => stripTags(String(html || '')).replace(/\s+/g, ' ').trim();
function editTarget(p, b) {
  const d = db.prepare("SELECT id, tab FROM datasets WHERE id = ? AND project_id = ? AND kind = 'doc'").get(Number(b.dataset_id), p.id);
  if (!d) throw new HttpError(404, 'Not found.');
  const item = db.prepare("SELECT data FROM items WHERE dataset_id = ? AND item_key = ? AND kind = 'article'").get(d.id, String(b.item_key || ''));
  if (!item) throw new HttpError(404, 'Not found.');
  const block = Number(b.block);
  if (!Number.isInteger(block) || block < 0 || block > 5000) throw new HttpError(400, 'Invalid request.');
  return { d, item, block };
}

app.put('/api/c/:token/edits', (req, res) => {
  const p = projectByToken(req.params.token);
  const b = req.body || {};
  const { d, item, block } = editTarget(p, b);
  const name = str(b.name, 80);
  if (!name) throw new HttpError(400, 'Please add your name.');
  const html = sanitizeEdit(String(b.html || '').slice(0, 50000));
  const originalHtml = sanitizeEdit(String(b.original_html || '').slice(0, 50000));
  // The original must be text from this article, so the agency sees a true before and after.
  const article = words(parseJSON(item.data, {}).html);
  if (!article.includes(words(originalHtml))) throw new HttpError(400, 'This article has changed. Please reload the page.');
  if (words(html) === words(originalHtml)) {
    db.prepare('DELETE FROM doc_edits WHERE dataset_id = ? AND item_key = ? AND block = ?').run(d.id, b.item_key, block);
  } else {
    db.prepare(`
      INSERT INTO doc_edits (project_id, dataset_id, item_key, block, original_html, html, name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT (dataset_id, item_key, block) DO UPDATE SET html = excluded.html, name = excluded.name, updated_at = excluded.updated_at
    `).run(p.id, d.id, b.item_key, block, originalHtml, html, name);
  }
  res.json({ ok: true, edits: listEdits({ datasetId: d.id }) });
});

app.delete('/api/c/:token/edits', (req, res) => {
  const p = projectByToken(req.params.token);
  const { d, block } = editTarget(p, req.body || {});
  db.prepare('DELETE FROM doc_edits WHERE dataset_id = ? AND item_key = ? AND block = ?').run(d.id, req.body.item_key, block);
  res.json({ ok: true, edits: listEdits({ datasetId: d.id }) });
});

function validateClientFeedback(b) {
  const type = String(b.type || '');
  const name = str(b.name, 80);
  const comment = str(b.comment, 5000);
  if (!FEEDBACK_TYPES.includes(type)) throw new HttpError(400, 'Pick how you feel about it first.');
  if (!name) throw new HttpError(400, 'Please add your name so the team knows who is reviewing.');
  if ((NEEDS_ACTION.has(type) || type === 'reply') && !comment) throw new HttpError(400, 'Please add a comment.');
  return { type, name, comment, quote: str(b.quote, 1000), area: str(b.area, 200) };
}

app.post('/api/c/:token/feedback', (req, res) => {
  const p = projectByToken(req.params.token);
  const b = req.body || {};
  const v = validateClientFeedback(b);

  if (v.type === 'reply') {
    const parent = getFeedback(b.parent_id);
    if (parent.project_id !== p.id) throw new HttpError(404, 'Feedback not found.');
    const root = parent.parent_id ? getFeedback(parent.parent_id) : parent;
    transaction(() => {
      db.prepare(`
        INSERT INTO feedback (project_id, parent_id, dataset_id, tab, item_key, item_label, type, author_role, name, comment, status)
        VALUES (?, ?, ?, ?, ?, ?, 'reply', 'client', ?, ?, 'noted')
      `).run(p.id, root.id, root.dataset_id, root.tab, root.item_key, root.item_label, v.name, v.comment);
      // A client follow-up on a resolved thread puts it back in the team's queue.
      if (root.status === 'resolved' && NEEDS_ACTION.has(root.type)) db.prepare("UPDATE feedback SET status = 'open' WHERE id = ?").run(root.id);
    });
    return res.json({ ok: true });
  }

  // Images in an article have their own feedback: "<article key>#img<n>".
  const key = String(b.item_key || '');
  const img = key.match(/^(.+)#img(\d{1,3})$/);
  const item = img
    ? db.prepare("SELECT tab, label FROM items WHERE project_id = ? AND item_key = ? AND kind = 'article' ORDER BY id DESC LIMIT 1").get(p.id, img[1])
    : db.prepare('SELECT tab, label FROM items WHERE project_id = ? AND item_key = ? ORDER BY id DESC LIMIT 1').get(p.id, key);
  if (!item) throw new HttpError(404, 'That item is no longer available.');
  const label = img ? `${item.label} · Image${img[2] === '1' ? '' : ` ${img[2]}`}`.slice(0, 300) : item.label;
  const datasetId = db.prepare('SELECT id FROM datasets WHERE id = ? AND project_id = ?').get(Number(b.dataset_id) || 0, p.id)?.id ?? null;
  db.prepare(`
    INSERT INTO feedback (project_id, dataset_id, tab, item_key, item_label, type, author_role, name, comment, quote, area, status)
    VALUES (?, ?, ?, ?, ?, ?, 'client', ?, ?, ?, ?, ?)
  `).run(p.id, datasetId, item.tab, key, label, v.type, v.name, v.comment, v.quote, v.area, NEEDS_ACTION.has(v.type) ? 'open' : 'noted');
  res.json({ ok: true });
});

// The same feedback on several selected rows at once (e.g. approve 5 keywords).
app.post('/api/c/:token/feedback/bulk', (req, res) => {
  const p = projectByToken(req.params.token);
  const b = req.body || {};
  const v = validateClientFeedback(b);
  if (v.type === 'reply') throw new HttpError(400, 'Replies are sent one at a time.');
  const keys = [...new Set((Array.isArray(b.item_keys) ? b.item_keys : []).map(String))].slice(0, 1000);
  if (!keys.length) throw new HttpError(400, 'Select at least one item.');
  const datasetId = db.prepare('SELECT id FROM datasets WHERE id = ? AND project_id = ?').get(Number(b.dataset_id) || 0, p.id)?.id ?? null;
  const find = db.prepare('SELECT tab, label FROM items WHERE project_id = ? AND item_key = ? ORDER BY id DESC LIMIT 1');
  const items = keys.map((k) => ({ key: k, item: find.get(p.id, k) })).filter((x) => x.item);
  if (!items.length) throw new HttpError(404, 'Those items are no longer available.');
  transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO feedback (project_id, dataset_id, tab, item_key, item_label, type, author_role, name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'client', ?, ?, ?)
    `);
    for (const { key, item } of items) {
      stmt.run(p.id, datasetId, item.tab, key, item.label, v.type, v.name, v.comment, NEEDS_ACTION.has(v.type) ? 'open' : 'noted');
    }
  });
  res.json({ ok: true, count: items.length });
});

// Sign off a whole sheet or document at once.
app.post('/api/c/:token/datasets/:id/approve-all', (req, res) => {
  const p = projectByToken(req.params.token);
  const d = db.prepare('SELECT id FROM datasets WHERE id = ? AND project_id = ?').get(req.params.id, p.id);
  if (!d) throw new HttpError(404, 'Not found.');
  const name = str(req.body?.name, 80);
  if (!name) throw new HttpError(400, 'Please add your name so the team knows who is approving.');
  const comment = str(req.body?.comment, 5000);
  const approved = new Set(db.prepare(`
    SELECT DISTINCT item_key FROM feedback WHERE project_id = ? AND type = 'approve' AND parent_id IS NULL
  `).all(p.id).map((r) => r.item_key));
  const items = db.prepare('SELECT tab, item_key, label FROM items WHERE dataset_id = ?').all(d.id).filter((i) => !approved.has(i.item_key));
  transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO feedback (project_id, dataset_id, tab, item_key, item_label, type, author_role, name, comment, status)
      VALUES (?, ?, ?, ?, ?, 'approve', 'client', ?, ?, 'noted')
    `);
    for (const i of items) stmt.run(p.id, d.id, i.tab, i.item_key, i.label, name, comment);
  });
  res.json({ ok: true, approved: items.length });
});

// ---------- pages ----------

const pub = path.join(__dirname, 'public');

// Pages are never cached, and every script/stylesheet link carries a hash of the
// current files, so a new deploy shows up on the next page load.
const assetVersion = crypto.createHash('sha1')
  .update(fs.readdirSync(pub).sort().map((f) => fs.readFileSync(path.join(pub, f))).join('\n'))
  .digest('hex').slice(0, 10);
const page = (file) => fs.readFileSync(path.join(pub, file), 'utf8')
  .replace(/(\/static\/[\w.-]+\.(?:js|css))"/g, `$1?v=${assetVersion}"`);
const pages = { admin: page('admin.html'), client: page('client.html') };
function sendPage(res, name) {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(pages[name]);
}

app.use('/static', express.static(pub, {
  setHeaders: (res, file, stat) => res.setHeader('Cache-Control', res.req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => sendPage(res, 'admin'));
app.get('/p/:token', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  sendPage(res, 'client');
});
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (30 MB max).' : err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Review portal running on http://localhost:${PORT}`));
  analytics.startScheduler();
}

module.exports = app;
