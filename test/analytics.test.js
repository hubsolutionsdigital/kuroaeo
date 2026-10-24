const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-analytics-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'portal@demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.SEMRUSH_API_KEY = 'test-key';

const { db } = require('../lib/db');
const analytics = require('../lib/analytics');
const { parseWorkbook } = require('../lib/excel');

function project() {
  const r = db.prepare("INSERT INTO projects (name, token) VALUES ('Demo', ?)").run(crypto.randomBytes(8).toString('hex'));
  return Number(r.lastInsertRowid);
}

test('reads months the way people write them', () => {
  assert.equal(analytics.toMonth('Oct 2026'), '2026-10');
  assert.equal(analytics.toMonth('October 2026'), '2026-10');
  assert.equal(analytics.toMonth('2026-10-05'), '2026-10');
  assert.equal(analytics.toMonth('10/2026'), '2026-10');
  assert.equal(analytics.toMonth(new Date(Date.UTC(2026, 9, 1))), '2026-10');
  assert.equal(analytics.toMonth('Phase 1'), null);
});

test('syncs Search Console, GA4 and SEMrush into monthly numbers', async () => {
  const pid = project();
  analytics.saveSettings(pid, {
    gscSite: 'sc-domain:example.com', ga4Property: '123456', start: '2026-10',
    semrush: { enabled: true, clientToggle: true, domain: 'example.com', database: 'sg' },
  });
  // A keyword sheet so the dashboard has tracked keywords to match.
  const ds = Number(db.prepare("INSERT INTO datasets (project_id, tab, name, kind, columns) VALUES (?, 'keywords', 'Keywords', 'table', ?)")
    .run(pid, JSON.stringify(['No.', 'Keyword', 'Existing Ranking', 'Actual Ranking (Month 1)'])).lastInsertRowid);
  const ins = db.prepare("INSERT INTO items (dataset_id, project_id, tab, kind, item_key, label, position, data) VALUES (?, ?, 'keywords', 'row', ?, ?, ?, ?)");
  ins.run(ds, pid, 'keywords:hearing aids', 'hearing aids', 0, JSON.stringify([1, 'hearing aids', '>100', 8]));
  ins.run(ds, pid, 'keywords:hearing test', 'hearing test', 1, JSON.stringify([2, 'hearing test', 40, 25]));

  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const assertion = new URLSearchParams(opts.body).get('assertion');
      assert.equal(assertion.split('.').length, 3, 'signed JWT');
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.includes('searchAnalytics')) {
      const body = JSON.parse(opts.body);
      if (body.dimensions[0] === 'date') {
        return json({ rows: [
          { keys: ['2026-10-01'], clicks: 10, impressions: 100, position: 20 },
          { keys: ['2026-10-02'], clicks: 30, impressions: 300, position: 10 },
          { keys: ['2026-11-01'], clicks: 80, impressions: 500, position: 8 },
        ] });
      }
      // Keyword positions are filtered to the client's country (Singapore by default).
      assert.equal(body.dimensionFilterGroups[0].filters[0].expression, 'sgp');
      if (body.dimensions[1] === 'date') {
        return json({ rows: [
          { keys: ['Hearing Aids', '2026-10-03'], clicks: 2, impressions: 40, position: 9.2 },
          { keys: ['Hearing Aids', '2026-10-05'], clicks: 3, impressions: 50, position: 4 },
          { keys: ['hearing test', '2026-10-04'], clicks: 0, impressions: 5, position: 15 },
        ] });
      }
      return json({ rows: [{ keys: ['Hearing Aids'], clicks: 12, impressions: 400, position: 7.4 }] });
    }
    if (url.includes('analyticsdata')) {
      const body = JSON.parse(opts.body);
      if (body.dimensions.length === 1) {
        return json({ rows: [
          { dimensionValues: [{ value: '202610' }], metricValues: [{ value: '200' }, { value: '5' }, { value: '0' }] },
          { dimensionValues: [{ value: '202611' }], metricValues: [{ value: '260' }, { value: '9' }, { value: '0' }] },
        ] });
      }
      return json({ rows: [
        { dimensionValues: [{ value: '202611' }, { value: 'chatgpt.com' }], metricValues: [{ value: '6' }] },
        { dimensionValues: [{ value: '202611' }, { value: 'perplexity.ai' }], metricValues: [{ value: '2' }] },
      ] });
    }
    if (url.startsWith('https://api.semrush.com/')) {
      return { ok: true, status: 200, text: async () => 'Keyword;Position;Search Volume;Url\nhearing aids;6;2900;https://example.com/hearing-aids\n' };
    }
    throw new Error(`unexpected ${url}`);
  };

  const r = await analytics.syncProject(pid, { fetchImpl: fakeFetch });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.synced, ['gsc', 'ga4', 'semrush']);

  const d = analytics.dashboard(pid);
  assert.equal(d.series.gsc.clicks['2026-10'], 40);
  assert.equal(d.series.gsc.impressions['2026-10'], 400);
  assert.equal(d.series.gsc.position['2026-10'], 12.5, 'impression-weighted average position');
  assert.equal(d.series.ga4.organic_key_events['2026-11'], 9);
  assert.equal(d.series.ga4.ai_sessions['2026-11'], 8);
  const kw = d.keywords.find((k) => k.keyword === 'hearing aids');
  assert.equal(kw.gscPosition, 7.4);
  assert.equal(kw.gscBest, 4, 'best single day');
  assert.equal(kw.start, 101, 'ranking when we started, from the sheet');
  assert.equal(kw.reported, 8);
  assert.equal(kw.reportedLabel, 'Month 1');
  // Read-only month-by-month report for the Performance view.
  assert.deepEqual(d.rankingReport.months.map((m) => m.label), ['Month 1']);
  assert.deepEqual(d.rankingReport.rows[0], { keyword: 'hearing aids', volume: null, start: '>100', months: [{ rank: 8, target: null }], next: null });
  assert.equal(kw.gscBestDate, '2026-10-05');
  const test2 = d.keywords.find((k) => k.keyword === 'hearing test');
  assert.equal(test2.gscPosition, null, 'no data this week');
  assert.equal(test2.gscBest, 15);
  assert.equal(kw.semrushPosition, 6);
  assert.deepEqual(d.timelines.seo.map((p) => [p.label, p.top10]), [['Start', 0], ['Month 1', 1]]);
});

test('keeps SEMrush out of the client view until it is allowed', async () => {
  const pid = project();
  analytics.saveSettings(pid, { semrush: { enabled: true, clientToggle: false, domain: 'example.com' } });
  db.prepare("INSERT INTO live_ranks (project_id, source, keyword, position) VALUES (?, 'semrush', 'x', 3)").run(pid);
  assert.equal(analytics.dashboard(pid).sources.semrush, false);
  assert.equal(analytics.dashboard(pid, { forAdmin: true }).sources.semrush, true);
});

test('imports monthly business numbers and Search Console exports from Excel', async () => {
  const pid = project();
  const wb = new ExcelJS.Workbook();
  const biz = wb.addWorksheet('Business');
  biz.addRow(['Month', 'Enquiries', 'Revenue (S$)']);
  biz.addRow([new Date(Date.UTC(2026, 9, 1)), 12, 'S$4,200']);
  biz.addRow(['Nov 2026', 18, 6100]);
  const dates = wb.addWorksheet('Dates');
  dates.addRow(['Date', 'Clicks', 'Impressions', 'CTR', 'Position']);
  dates.addRow(['2026-10-01', 5, 50, '10%', 9]);
  dates.addRow(['2026-10-02', 5, 150, '3%', 13]);
  const sheets = await parseWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
  const r = analytics.importMetricSheets(pid, sheets);
  assert.equal(r.found.length, 2);
  const d = analytics.dashboard(pid);
  assert.equal(d.series.manual.Enquiries['2026-10'], 12);
  assert.equal(d.series.manual['Revenue (S$)']['2026-10'], 4200);
  assert.equal(d.series.gsc.clicks['2026-10'], 10);
  assert.equal(d.series.gsc.position['2026-10'], 12);
});

test('parses SEMrush errors clearly', () => {
  assert.throws(() => analytics.parseSemrush('ERROR 50 :: NOTHING FOUND'), /SEMrush: ERROR 50/);
});

test('reads Google data through a connected Google account instead of a key', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  analytics.setSecret('test-secret');
  const pid = project();
  analytics.saveSettings(pid, { gscSite: 'sc-domain:example.com' });

  const grants = [];
  const auth = [];
  const fakeFetch = async (url, opts = {}) => {
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === 'https://oauth2.googleapis.com/token') {
      const b = new URLSearchParams(opts.body);
      grants.push(b.get('grant_type'));
      if (b.get('grant_type') === 'authorization_code') {
        assert.equal(b.get('code'), 'the-code');
        const idToken = `x.${Buffer.from(JSON.stringify({ email: 'seo@hubsolutions.one' })).toString('base64url')}.y`;
        return json({
          access_token: 'first', expires_in: 1, refresh_token: 'refresh-123', id_token: idToken,
          scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/drive.readonly',
        });
      }
      assert.equal(b.get('refresh_token'), 'refresh-123');
      return json({ access_token: 'refreshed', expires_in: 3600 });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) { grants.push('revoke'); return json({}); }
    auth.push(opts.headers.Authorization);
    if (url.endsWith('/webmasters/v3/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' }] });
    if (url.includes('accountSummaries')) return json({ accountSummaries: [{ displayName: 'Hearing Room', propertySummaries: [{ property: 'properties/987', displayName: 'Website' }] }] });
    if (url.includes('searchAnalytics')) return json({ rows: [] });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      const q = new URL(url).searchParams.get('q');
      assert.match(q, /name contains 'Ranking\\'s'/, 'search text is escaped');
      return json({ files: [{ id: 'sheet1234567', name: "Ranking's 2026", mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-20T00:00:00Z' }] });
    }
    if (url.includes('/drive/v3/files/sheet1234567/export')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url.includes('/drive/v3/files/sheet1234567?')) return json({ id: 'sheet1234567', name: "Ranking's 2026", mimeType: 'application/vnd.google-apps.spreadsheet' });
    throw new Error(`unexpected ${url}`);
  };

  const url = new URL(analytics.googleAuthUrl('https://portal.test/api/admin/google/callback', 'state-1'));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /webmasters\.readonly/);

  assert.equal(await analytics.connectGoogle('the-code', 'https://portal.test/api/admin/google/callback', fakeFetch), 'seo@hubsolutions.one');
  assert.deepEqual(analytics.googleIdentity().mode, 'oauth');
  const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'google_oauth'").get().value;
  assert.ok(!stored.includes('refresh-123'), 'refresh token is stored encrypted');

  const r = await analytics.syncProject(pid, { only: 'gsc', fetchImpl: fakeFetch });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
  assert.ok(auth.every((a) => a === 'Bearer refreshed'));

  const props = await analytics.googleProperties(fakeFetch);
  assert.deepEqual(props.gsc, ['sc-domain:example.com']);
  assert.deepEqual(props.ga4, [{ id: '987', name: 'Website (Hearing Room)' }]);

  assert.equal(analytics.googleIdentity().sheets, true);
  const files = await analytics.listSpreadsheets("Ranking's", fakeFetch);
  assert.deepEqual(files.map((f) => f.name), ["Ranking's 2026"]);
  const file = await analytics.downloadSpreadsheet('sheet1234567', fakeFetch);
  assert.equal(file.buffer.length, 3);
  await assert.rejects(analytics.downloadSpreadsheet('../etc', fakeFetch), /Choose a spreadsheet/);

  await analytics.disconnectGoogle(fakeFetch);
  assert.equal(grants.at(-1), 'revoke');
  await assert.rejects(analytics.listSpreadsheets('', fakeFetch), /Connect your Google account/);
  assert.equal(analytics.googleIdentity().mode, 'service', 'falls back to the service account');
});
