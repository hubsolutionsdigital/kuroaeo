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
