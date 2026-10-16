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
