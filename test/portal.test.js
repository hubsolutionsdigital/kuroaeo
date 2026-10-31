const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
process.env.ADMIN_PASSWORD = 'secret-pass';

const { parseWorkbook } = require('../lib/excel');
const app = require('../server');

async function sampleWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Projected Rankings');
  ws.addRow(['Client Keyword Proposal']);
  ws.addRow([]);
  ws.addRow(['S/N', 'Keyword', 'Search vol.', 'Actual Ranking (Month 1)', 'Actual Ranking (Month 2)', 'Phase 2 (Month 2-3)', 'Notes']);
  ws.addRow([1, 'family lawyer singapore', 480, '>100', 67, new Date(Date.UTC(2026, 11, 5)), 'core term']);
  ws.addRow([2, 'probate lawyer singapore', 390, 55, 41, '40-70', null]);
  ws.addRow([3, null, null, null, null, null, null]);
  const bl = wb.addWorksheet('Backlinks');
  bl.addRow(['No.', 'Backlink URL', 'Anchor']);
  bl.addRow([1, 'lawsociety.org.sg', 'family lawyer singapore']);
  wb.addWorksheet('Tasks').addRow(['No.', 'Task']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('parses sheets the way the team formats them', async () => {
  const sheets = await parseWorkbook(await sampleWorkbook());
  const [kw, bl, tasks] = sheets;
  assert.equal(kw.title, 'Client Keyword Proposal');
  assert.deepEqual(kw.columns.slice(0, 3), ['S/N', 'Keyword', 'Search vol.']);
  assert.equal(kw.rows.length, 2, 'rows with only a serial number are dropped');
  assert.equal(kw.rows[0][5], '5-12', 'ranges Excel turned into dates are restored');
  assert.equal(kw.suggestedTab, 'keywords');
  assert.equal(bl.suggestedTab, 'backlinks');
  assert.equal(tasks.suggestedTab, 'skip');
});

test('reads Google Sheets exports with comments and labelled ranking columns', async () => {
  const JSZip = require('jszip');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Keywords');
  ws.addRow([null, null, 'Google AI Overview', 'ChatGpt Ranking', 'Google Ranking']);
  ws.addRow(['No.', 'Keyword', 'Current Ranking - 28-09-2026', 'Current Ranking - 28-09-2026', 'Current Ranking - 28-09-2026']);
  ws.addRow([1, 'hearing aid sg', 'NA', 'NA', 27]);
  ws.getCell('B3').note = 'Check this one';
  // Rewrite relationship targets the way Google Sheets does (absolute paths).
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.rels'))) {
    const xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/Target="(?:\.\.\/)?(?!\/|https?:)([^"]+)"/g, (m, t) => `Target="/xl/${t.replace(/^xl\//, '')}"`));
  }
  const [sheet] = await parseWorkbook(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(sheet.columns.slice(2), [
    'Google AI Overview · Current Ranking - 28-09-2026',
    'ChatGpt Ranking · Current Ranking - 28-09-2026',
    'Google Ranking · Current Ranking - 28-09-2026',
  ]);
  assert.equal(sheet.rows[0][4], 27);
});

test('admin upload → client review → agency reply', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, isForm) => {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await call('GET', '/api/admin/projects')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret-pass' })).status, 200);

  const { body: { project } } = await call('POST', '/api/admin/projects', { name: 'Dot Chambers', website: 'dotchambers.com' });
  assert.ok(project.token.length >= 20);

  const fd = new FormData();
  fd.append('file', new Blob([await sampleWorkbook()]), 'Overview.xlsx');
  const preview = await call('POST', `/api/admin/projects/${project.id}/excel/preview`, fd, true);
  assert.equal(preview.status, 200);
  const imported = await call('POST', `/api/admin/projects/${project.id}/excel/import`, {
    uploadId: preview.body.uploadId,
    sheets: [{ index: 0, tab: 'keywords', name: 'Projected Rankings', period: 'Oct 2026' }, { index: 1, tab: 'backlinks', period: 'Oct 2026' }],
  });
  assert.equal(imported.body.created.length, 2);

  // Client: link only, no login.
  const tok = project.token;
  assert.equal((await fetch(`${base}/api/c/not-a-real-token`)).status, 404);
  const portal = await call('GET', `/api/c/${tok}`);
  assert.equal(portal.body.project.name, 'Dot Chambers');
  assert.equal(portal.body.progress.keywords.items, 2);
  const kwSet = portal.body.datasets.find((d) => d.tab === 'keywords');
  const { body: ds } = await call('GET', `/api/c/${tok}/datasets/${kwSet.id}`);
  assert.equal(ds.dataset.primary, 1);
  const item = ds.items[0];
  assert.equal(item.item_key, 'keywords:family lawyer singapore');

  assert.equal((await call('POST', `/api/c/${tok}/feedback`, { item_key: item.item_key, type: 'love', name: '' })).status, 400, 'name is required');
  assert.equal((await call('POST', `/api/c/${tok}/feedback`, { item_key: item.item_key, type: 'change', name: 'Dorothy' })).status, 400, 'a change needs a comment');
  assert.equal((await call('POST', `/api/c/${tok}/feedback`, { item_key: item.item_key, type: 'love', name: 'Dorothy' })).status, 200);
  assert.equal((await call('POST', `/api/c/${tok}/feedback`, { item_key: item.item_key, type: 'question', name: 'Dorothy', comment: 'Why this one?' })).status, 200);
  const bulk = await call('POST', `/api/c/${tok}/feedback/bulk`, { item_keys: ds.items.map((i) => i.item_key), dataset_id: kwSet.id, type: 'like', name: 'Dorothy' });
  assert.equal(bulk.body.count, 2, 'bulk feedback covers every selected item');
  assert.equal((await call('POST', `/api/c/${tok}/feedback/bulk`, { item_keys: [], type: 'approve', name: 'Dorothy' })).status, 400);
  const approveAll = await call('POST', `/api/c/${tok}/datasets/${kwSet.id}/approve-all`, { name: 'Dorothy' });
  assert.equal(approveAll.body.approved, 2);

  // Agency answers the question; it is resolved and visible to the client.
  const { body: detail } = await call('GET', `/api/admin/projects/${project.id}`);
  const question = detail.feedback.find((f) => f.type === 'question');
  assert.equal(question.status, 'open');
  await call('POST', `/api/admin/feedback/${question.id}/reply`, { comment: 'Highest-intent term.', resolve: true });
  const after = await call('GET', `/api/c/${tok}/feedback`);
  assert.equal(after.body.feedback.find((f) => f.id === question.id).status, 'resolved');
  assert.ok(after.body.feedback.some((f) => f.parent_id === question.id && f.author_role === 'agency'));

  // Next month's upload of the same sheet becomes a new version and keeps feedback on the keyword.
  const fd2 = new FormData();
  fd2.append('file', new Blob([await sampleWorkbook()]), 'Overview.xlsx');
  const p2 = await call('POST', `/api/admin/projects/${project.id}/excel/preview`, fd2, true);
  assert.equal(p2.body.sheets[0].existingVersion, true);
  const imp2 = await call('POST', `/api/admin/projects/${project.id}/excel/import`, { uploadId: p2.body.uploadId, sheets: [{ index: 0, tab: 'keywords', name: 'Projected Rankings', period: 'Nov 2026' }] });
  const { body: ds2 } = await call('GET', `/api/c/${tok}/datasets/${imp2.body.created[0]}`);
  assert.equal(ds2.previous.period, 'Oct 2026');
  assert.ok(ds2.previous.rows['keywords:family lawyer singapore']);

  // A new link invalidates the old one.
  await call('PATCH', `/api/admin/projects/${project.id}`, { regenerate_token: true });
  assert.equal((await fetch(`${base}/api/c/${tok}`)).status, 404);
});

test('a bold lead-in at the end of an article does not swallow the next article', async () => {
  const JSZip = require('jszip');
  const { parseBlogDoc } = require('../lib/docx');
  const para = (runs) => `<w:p>${runs.map(([text, bold]) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`).join('')}</w:p>`;
  const body = [
    para([['Article 1: First article', true]]),
    para([['Body of the first article.']]),
    para([['Visit us at the clinic.', true], [' Book online for a quick reply.']]),
    para([['Article 2: Second article', true]]),
    para([['Body of the second article.']]),
    para([['Article 3: Third article', true]]),
    para([['Body of the third article.']]),
  ].join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  const doc = await parseBlogDoc(await zip.generateAsync({ type: 'nodebuffer' }), 'Blogs.docx');
  assert.deepEqual(doc.articles.map((a) => a.title), ['First article', 'Second article', 'Third article']);
  assert.match(doc.articles[0].html, /Visit us at the clinic/);
});

test('clients edit blog text directly and the agency sees what changed', async (t) => {
  const { db } = require('../lib/db');
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const pid = Number(db.prepare("INSERT INTO projects (name, token) VALUES ('Blog Co', 'blog-edit-token')").run().lastInsertRowid);
  const ds = Number(db.prepare("INSERT INTO datasets (project_id, tab, name, kind) VALUES (?, 'blogs', 'Blogs', 'doc')").run(pid).lastInsertRowid);
  const html = '<h2>Free hearing tests</h2><p>We offer <strong>free</strong> hearing tests in Singapore.</p>';
  db.prepare("INSERT INTO items (dataset_id, project_id, tab, kind, item_key, label, position, data) VALUES (?, ?, 'blogs', 'article', 'blogs:article:a', 'Article A', 0, ?)")
    .run(ds, pid, JSON.stringify({ title: 'Article A', html }));
  const edit = (block, original, edited, name = 'Tina') => call('PUT', '/api/c/blog-edit-token/edits', {
    dataset_id: ds, item_key: 'blogs:article:a', block, original_html: original, html: edited, name,
  });

  let r = await edit(1, 'We offer <strong>free</strong> hearing tests in Singapore.', 'We offer <strong>affordable</strong> hearing tests at City Hall.<script>alert(1)</script>');
  assert.equal(r.status, 200);
  assert.equal(r.body.edits.length, 1);
  assert.doesNotMatch(r.body.edits[0].html, /script/, 'edits are sanitised');

  // The "before" must be text from the article itself.
  assert.equal((await edit(0, 'Something we never wrote', 'x')).status, 400);
  assert.equal((await edit(0, 'Free hearing tests', 'x', '')).status, 400, 'a name is required');

  const payload = await call('GET', `/api/c/blog-edit-token/datasets/${ds}`);
  assert.equal(payload.body.edits[0].block, 1);

  // Editing back to the original wording removes the edit.
  r = await edit(1, 'We offer <strong>free</strong> hearing tests in Singapore.', 'We offer <strong>free</strong>  hearing tests in Singapore.');
  assert.equal(r.body.edits.length, 0);

  // Images have their own feedback, separate from the article's approval.
  const fb = (item_key, type) => call('POST', '/api/c/blog-edit-token/feedback', { item_key, dataset_id: ds, type, name: 'Tina', quote: 'Image: clinic' });
  assert.equal((await fb('blogs:article:a#img1', 'love')).status, 200);
  assert.equal((await fb('blogs:article:a#img1', 'approve')).status, 200);
  assert.equal((await fb('blogs:article:missing#img1', 'love')).status, 404);
  const rows = db.prepare("SELECT item_key, item_label FROM feedback WHERE project_id = ? ORDER BY id").all(pid);
  assert.deepEqual(rows.map((r) => r.item_label), ['Article A · Image', 'Article A · Image']);
  const prog = await call('GET', '/api/c/blog-edit-token');
  assert.equal(prog.body.progress.blogs.reviewed, 0, 'approving an image does not approve the article');

  await edit(0, 'Free hearing tests', 'Affordable hearing tests');
  r = await call('DELETE', '/api/c/blog-edit-token/edits', { dataset_id: ds, item_key: 'blogs:article:a', block: 0 });
  assert.equal(r.body.edits.length, 0, 'undo');
});

test('reads Google Business Profile posts: "POST 1 · title", a repeated banner and a CTA table', async () => {
  const JSZip = require('jszip');
  const { parseBlogDoc } = require('../lib/docx');
  const p = (text, bold) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const cta = (url) => `<w:tbl><w:tr>${cell('CTA')}${cell('Learn More')}</w:tr><w:tr>${cell('Landing page')}${cell(url)}</w:tr></w:tbl>`;
  const post = (n, title) => [
    p('DOT CHAMBERS LLC  |  GOOGLE BUSINESS PROFILE', true),
    p(`POST ${n}  ·  ${title}`),
    p('GOOGLE BUSINESS PROFILE POST COPY', true),
    p(`Copy for ${title}.`),
    cta('https://www.dotchambers.com/divorce'),
  ].join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${post(1, 'Affordable Divorce Lawyer in Singapore')}${post(2, 'Divorce Legal Advice in Singapore')}</w:body></w:document>`);
  const doc = await parseBlogDoc(await zip.generateAsync({ type: 'nodebuffer' }), 'GBP Posts.docx');
  assert.deepEqual(doc.articles.map((a) => [a.number, a.title]), [[1, 'Affordable Divorce Lawyer in Singapore'], [2, 'Divorce Legal Advice in Singapore']]);
  assert.deepEqual(doc.articles[0].seo, [['CTA', 'Learn More'], ['Landing page', 'https://www.dotchambers.com/divorce']]);
  assert.notEqual(doc.articles[0].key, doc.articles[1].key, 'posts sharing a landing page keep their own keys');
  for (const a of doc.articles) assert.doesNotMatch(a.html, /GOOGLE BUSINESS PROFILE|<table/, 'banner, label and CTA table are not in the copy');
});

test('exports a document to Word with the client’s edits applied', async () => {
  const JSZip = require('jszip');
  const mammoth = require('mammoth');
  const { DocxWriter, withEdits } = require('../lib/docxExport');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const html = `<h2>Why it matters</h2><p>We offer <strong>free</strong> tests.</p><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol><table><tr><td>Fee</td><td>S$100</td></tr></table><p><img src="${png}" alt="Clinic"></p><p>Visit <a href="https://example.com">our site</a>.</p>`;
  // Block 1 is the first paragraph; block 3 the second bullet; block 6 the fee cell.
  const nodes = withEdits(html, [{ block: 1, html: 'We offer <strong>affordable</strong> tests.' }, { block: 3, html: 'Two, edited' }, { block: 6, html: 'S$120' }]);
  const doc = new DocxWriter();
  doc.title('Blogs');
  doc.details([['Meta title', 'Hearing tests']], 'SEO details');
  doc.html(nodes);
  const buf = await doc.toBuffer({ title: 'Blogs' });
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file('word/media/image1.png'), 'the image is embedded');
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  assert.match(value, /<h2>Why it matters<\/h2>/);
  assert.match(value, /We offer <strong>affordable<\/strong> tests\./);
  assert.doesNotMatch(value, /free/);
  assert.match(value, /<li>Two, edited<\/li>/);
  assert.match(value, /S\$120/);
  assert.match(value, /<a href="https:\/\/example.com">our site<\/a>/);
  assert.match(value, /<img /);
});

test('re-uploading a document keeps approvals on unchanged articles', async (t) => {
  const { db } = require('../lib/db');
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const pid = Number(db.prepare("INSERT INTO projects (name, token) VALUES ('Reupload Co', 'reupload-token')").run().lastInsertRowid);
  const version = (at, bText) => {
    const id = Number(db.prepare("INSERT INTO datasets (project_id, tab, name, kind, created_at) VALUES (?, 'blogs', 'Blogs', 'doc', ?)").run(pid, at).lastInsertRowid);
    const ins = db.prepare("INSERT INTO items (dataset_id, project_id, tab, kind, item_key, label, position, data) VALUES (?, ?, 'blogs', ?, ?, ?, ?, ?)");
    ins.run(id, pid, 'article', 'blogs:article:a', 'A', 0, JSON.stringify({ title: 'A', html: '<p>Same text</p>' }));
    ins.run(id, pid, 'article', 'blogs:article:b', 'B', 1, JSON.stringify({ title: 'B', html: `<p>${bText}</p>` }));
    ins.run(id, pid, 'check', 'blogs:check:1', 'Confirm prices', 2, JSON.stringify({ text: 'Confirm prices' }));
    return id;
  };
  version('2026-10-01 10:00:00', 'First draft');
  const approve = db.prepare("INSERT INTO feedback (project_id, tab, item_key, item_label, type, author_role, name, status, created_at) VALUES (?, 'blogs', ?, 'x', 'approve', 'client', 'Tina', 'noted', '2026-10-02 10:00:00')");
  for (const k of ['blogs:article:a', 'blogs:article:b', 'blogs:check:1']) approve.run(pid, k);
  // The team uploads the document again; only article B's text changed.
  version('2026-10-03 10:00:00', 'Revised draft');
  const d = await (await fetch(`${base}/api/c/reupload-token`)).json();
  const c = d.contents.find((x) => x.name === 'Blogs');
  assert.equal(c.since['blogs:article:a'], '2026-10-01 10:00:00', 'unchanged since the first upload');
  assert.equal(c.since['blogs:article:b'], '2026-10-03 10:00:00', 'changed in the new upload');
  assert.equal(c.since['blogs:check:1'], '2026-10-01 10:00:00');
  assert.deepEqual(d.progress.blogs, { items: 3, reviewed: 2 }, 'only the changed article needs review again');
});
