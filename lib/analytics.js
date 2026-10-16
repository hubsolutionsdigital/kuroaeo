/* Performance data for the client dashboard:
 * - Google Search Console and GA4, through a connected Google account or a service account
 * - optional SEMrush live rankings
 * - monthly numbers uploaded from Excel (business results, GSC exports)
 * - SEO / AEO timelines built from the uploaded ranking sheets
 * Monthly values are stored per project as (source, metric, month 'YYYY-MM', value). */

const crypto = require('crypto');
const { db, transaction } = require('./db');
const { primaryColumn, normalizeKey } = require('./excel');

db.exec(`
  CREATE TABLE IF NOT EXISTS metrics (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    metric TEXT NOT NULL,
    month TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (project_id, source, metric, month)
  );
  CREATE TABLE IF NOT EXISTS live_ranks (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    keyword TEXT NOT NULL,
    position REAL,
    url TEXT NOT NULL DEFAULT '',
    volume REAL,
    clicks REAL,
    impressions REAL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, source, keyword)
  );
`);
const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
if (!projectCols.includes('analytics')) db.exec("ALTER TABLE projects ADD COLUMN analytics TEXT NOT NULL DEFAULT '{}'");

const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function getSettings(projectId) {
  const row = db.prepare('SELECT analytics FROM projects WHERE id = ?').get(projectId);
  return row ? parseJSON(row.analytics, {}) : {};
}
function saveSettings(projectId, settings) {
  db.prepare('UPDATE projects SET analytics = ? WHERE id = ?').run(JSON.stringify(settings), projectId);
}

/* ---------- months ---------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

// "Oct 2026", "October 2026", "2026-10", "10/2026", a Date or an Excel date -> "2026-10".
function toMonth(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}`;
  const s = String(v ?? '').trim().toLowerCase();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/);
  if (m) return `${m[1]}-${pad(m[2])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[2]}-${pad(m[1])}`;
  m = s.match(/^\d{1,2}[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[2]}-${pad(m[1])}`;
  m = s.match(/^([a-z]{3})[a-z]*\.?[\s-]+'?(\d{2,4})$/);
  if (m && MONTHS.includes(m[1])) return `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${pad(MONTHS.indexOf(m[1]) + 1)}`;
  return null;
}
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1].replace(/^./, (c) => c.toUpperCase())} ${y}`; };
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function putMetrics(projectId, source, rows) {
  const stmt = db.prepare(`
    INSERT INTO metrics (project_id, source, metric, month, value) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id, source, metric, month) DO UPDATE SET value = excluded.value
  `);
  transaction(() => { for (const r of rows) if (Number.isFinite(r.value)) stmt.run(projectId, source, r.metric, r.month, r.value); });
  return rows.length;
}

/* ---------- Google access ----------
 * Either "Sign in with Google" (an agency Google account connected once in
 * Admin; its refresh token is stored encrypted) or a service account key. */

db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getSetting = (k) => parseJSON(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(k)?.value, null);
const putSetting = (k, v) => db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
const dropSetting = (k) => db.prepare('DELETE FROM app_settings WHERE key = ?').run(k);

const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

let sealKey = null;
function setSecret(secret) { sealKey = crypto.createHash('sha256').update(`google-oauth:${secret}`).digest(); }
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function unseal(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function oauthClient() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id: id.trim(), secret: secret.trim() } : null;
}

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = parseJSON(text, null);
  if (!json || !json.client_email || !json.private_key) return null;
  return json;
}

// Who the portal reads Google data as: { mode: 'oauth' | 'service' | null, email }.
function googleIdentity() {
  const conn = getSetting('google_oauth');
  if (conn && oauthClient()) return { mode: 'oauth', email: conn.email, connectedAt: conn.connectedAt };
  const sa = serviceAccount();
  return sa ? { mode: 'service', email: sa.client_email } : { mode: null, email: null };
}

function googleAuthUrl(redirectUri, state) {
  const c = oauthClient();
  if (!c) throw new Error('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway first.');
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: c.id, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  })}`;
}

const tokenCache = new Map();

async function connectGoogle(code, redirectUri, fetchImpl = fetch) {
  const c = oauthClient();
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  if (!data.refresh_token) throw new Error('Google did not return a long-term token. Remove the portal under myaccount.google.com → Security → Third-party access, then connect again.');
  const granted = String(data.scope || '').split(' ');
  const missing = GOOGLE_SCOPES.slice(2).filter((s) => !granted.includes(s));
  if (missing.length) throw new Error('Please tick both Search Console and Analytics on the Google permission screen.');
  // The id_token comes straight from Google over TLS, so its payload can be read as is.
  const claims = parseJSON(Buffer.from(String(data.id_token || '').split('.')[1] || '', 'base64url').toString('utf8'), {});
  putSetting('google_oauth', { email: claims.email || '', refresh: seal(data.refresh_token), connectedAt: new Date().toISOString() });
  tokenCache.clear();
  tokenCache.set('oauth', { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return claims.email || '';
}

async function disconnectGoogle(fetchImpl = fetch) {
  const conn = getSetting('google_oauth');
  dropSetting('google_oauth');
  tokenCache.clear();
  if (!conn) return;
  try {
    await fetchImpl(`https://oauth2.googleapis.com/revoke?${new URLSearchParams({ token: unseal(conn.refresh) })}`, { method: 'POST' });
  } catch { /* already revoked or unreadable; the local copy is gone either way */ }
}

async function oauthToken(conn, fetchImpl) {
  const cached = tokenCache.get('oauth');
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const c = oauthClient();
  let refresh;
  try { refresh = unseal(conn.refresh); } catch { throw new Error('The Google connection can no longer be read (the admin password or SESSION_SECRET changed). Connect Google again in Admin → Performance.'); }
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new Error('The Google connection has expired or was removed. Connect Google again in Admin → Performance.');
    throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  tokenCache.set('oauth', { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function googleToken(scopes, fetchImpl = fetch) {
  const conn = getSetting('google_oauth');
  if (conn && oauthClient()) return oauthToken(conn, fetchImpl);
  const sa = serviceAccount();
  if (!sa) throw new Error('Google is not connected yet. Click “Connect Google account” in Admin → Performance.');
  const key = scopes.join(' ');
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: key, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key.replace(/\\n/g, '\n'), 'base64url');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  tokenCache.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

async function googleJSON(url, body, scopes, fetchImpl = fetch) {
  const token = await googleToken(scopes, fetchImpl);
  const opts = body === undefined
    ? { headers: { Authorization: `Bearer ${token}` } }
    : { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetchImpl(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    const who = googleIdentity().email;
    throw new Error(res.status === 403 && who ? `${msg} Make sure ${who} has access to this property.` : msg);
  }
  return data;
}

// The Search Console sites and GA4 properties the connected account can see, for the pickers.
async function googleProperties(fetchImpl = fetch) {
  const out = { gsc: [], ga4: [], errors: [] };
  const scopes = GOOGLE_SCOPES.slice(2);
  try {
    const r = await googleJSON('https://www.googleapis.com/webmasters/v3/sites', undefined, scopes, fetchImpl);
    out.gsc = (r.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => s.siteUrl).sort();
  } catch (err) { out.errors.push(`Search Console: ${err.message}`); }
  try {
    let pageToken = '';
    do {
      const r = await googleJSON(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, undefined, scopes, fetchImpl);
      for (const a of r.accountSummaries || []) {
        for (const p of a.propertySummaries || []) out.ga4.push({ id: String(p.property || '').replace('properties/', ''), name: `${p.displayName} (${a.displayName})` });
      }
      pageToken = r.nextPageToken || '';
    } while (pageToken);
  } catch (err) { out.errors.push(`GA4 list (enable the “Google Analytics Admin API” to pick from a list): ${err.message}`); }
  return out;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
function syncWindow(settings) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // Search Console data lags ~2 days
  const start = settings.start ? `${addMonths(settings.start, -12)}-01` : isoDay(new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), 1)));
  return { startDate: start, endDate: isoDay(end) };
}

/* Search Console: monthly clicks, impressions, CTR and average position, plus
 * the last 28 days per query (to show Google's own position for each keyword). */
function gscMonthly(rows) {
  const by = {};
  for (const r of rows || []) {
    const month = r.keys[0].slice(0, 7);
    const m = by[month] || (by[month] = { clicks: 0, impressions: 0, posW: 0 });
    m.clicks += r.clicks || 0;
    m.impressions += r.impressions || 0;
    m.posW += (r.position || 0) * (r.impressions || 0);
  }
  const out = [];
  for (const [month, m] of Object.entries(by)) {
    out.push({ metric: 'clicks', month, value: m.clicks });
    out.push({ metric: 'impressions', month, value: m.impressions });
    if (m.impressions) {
      out.push({ metric: 'ctr', month, value: (m.clicks / m.impressions) * 100 });
      out.push({ metric: 'position', month, value: m.posW / m.impressions });
    }
  }
  return out;
}

async function syncGSC(projectId, settings, fetchImpl = fetch) {
  const site = encodeURIComponent(settings.gscSite);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`;
  const scopes = ['https://www.googleapis.com/auth/webmasters.readonly'];
  const win = syncWindow(settings);
  const daily = await googleJSON(url, { ...win, dimensions: ['date'], rowLimit: 25000 }, scopes, fetchImpl);
  putMetrics(projectId, 'gsc', gscMonthly(daily.rows));
  const end = new Date(win.endDate);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 27);
  const queries = await googleJSON(url, { startDate: isoDay(start), endDate: win.endDate, dimensions: ['query'], rowLimit: 5000 }, scopes, fetchImpl);
  const stmt = db.prepare(`
    INSERT INTO live_ranks (project_id, source, keyword, position, clicks, impressions, fetched_at) VALUES (?, 'gsc', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (project_id, source, keyword) DO UPDATE SET position = excluded.position, clicks = excluded.clicks, impressions = excluded.impressions, fetched_at = excluded.fetched_at
  `);
  transaction(() => {
    db.prepare("DELETE FROM live_ranks WHERE project_id = ? AND source = 'gsc'").run(projectId);
    for (const r of queries.rows || []) stmt.run(projectId, normalizeKey(r.keys[0]), r.position, r.clicks, r.impressions);
  });
  return (daily.rows || []).length;
}

/* GA4: organic sessions, key events (enquiries, bookings…) and revenue, plus
 * visits referred by AI assistants. */
const AI_SOURCES = 'chatgpt|openai|perplexity|gemini|bard|copilot|claude|deepseek|you\\.com';
function ga4Rows(report) {
  return (report.rows || []).map((r) => ({
    dims: r.dimensionValues.map((d) => d.value),
    vals: r.metricValues.map((m) => Number(m.value) || 0),
  }));
}
const ymOf = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}`;
function ga4Monthly(organic, ai) {
  const out = [];
  for (const r of ga4Rows(organic)) {
    const month = ymOf(r.dims[0]);
    out.push({ metric: 'organic_sessions', month, value: r.vals[0] });
    out.push({ metric: 'organic_key_events', month, value: r.vals[1] });
    out.push({ metric: 'organic_revenue', month, value: r.vals[2] });
  }
  const aiBy = {};
  for (const r of ga4Rows(ai)) aiBy[ymOf(r.dims[0])] = (aiBy[ymOf(r.dims[0])] || 0) + r.vals[0];
  for (const [month, value] of Object.entries(aiBy)) out.push({ metric: 'ai_sessions', month, value });
  return out;
}

async function syncGA4(projectId, settings, fetchImpl = fetch) {
  const prop = String(settings.ga4Property).replace(/^properties\//, '').trim();
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`;
  const scopes = ['https://www.googleapis.com/auth/analytics.readonly'];
  const win = syncWindow(settings);
  const dateRanges = [{ startDate: win.startDate, endDate: 'today' }];
  const organic = await googleJSON(url, {
    dateRanges,
    dimensions: [{ name: 'yearMonth' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } } },
  }, scopes, fetchImpl);
  const ai = await googleJSON(url, {
    dateRanges,
    dimensions: [{ name: 'yearMonth' }, { name: 'sessionSource' }],
    metrics: [{ name: 'sessions' }],
    dimensionFilter: { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: AI_SOURCES, caseSensitive: false } } },
  }, scopes, fetchImpl);
  return putMetrics(projectId, 'ga4', ga4Monthly(organic, ai));
}

/* SEMrush: where the domain ranks today for its keywords (organic database). */
function parseSemrush(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (!lines.length || /^ERROR/i.test(lines[0])) throw new Error(`SEMrush: ${lines[0] || 'empty response'}`);
  const head = lines[0].split(';').map((h) => h.trim().toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ki = col(/keyword/); const pi = col(/^position$/); const vi = col(/volume/); const ui = col(/url/);
  return lines.slice(1).map((l) => l.split(';')).map((c) => ({
    keyword: normalizeKey(c[ki] || ''), position: Number(c[pi]) || null, volume: Number(c[vi]) || null, url: ui >= 0 ? c[ui] : '',
  })).filter((r) => r.keyword);
}

async function syncSemrush(projectId, settings, fetchImpl = fetch) {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) throw new Error('SEMrush is not set up (SEMRUSH_API_KEY).');
  const domain = String(settings.semrush?.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain) throw new Error('Add the website domain for SEMrush.');
  const params = new URLSearchParams({
    type: 'domain_organic', key, domain, database: settings.semrush?.database || 'sg',
    display_limit: '1000', export_columns: 'Ph,Po,Nq,Ur',
  });
  const res = await fetchImpl(`https://api.semrush.com/?${params}`);
  const rows = parseSemrush(await res.text());
  const stmt = db.prepare(`
    INSERT INTO live_ranks (project_id, source, keyword, position, url, volume, fetched_at) VALUES (?, 'semrush', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (project_id, source, keyword) DO UPDATE SET position = excluded.position, url = excluded.url, volume = excluded.volume, fetched_at = excluded.fetched_at
  `);
  transaction(() => {
    db.prepare("DELETE FROM live_ranks WHERE project_id = ? AND source = 'semrush'").run(projectId);
    for (const r of rows) stmt.run(projectId, r.keyword, r.position, r.url, r.volume);
  });
  return rows.length;
}

async function syncProject(projectId, { only, fetchImpl = fetch } = {}) {
  const settings = getSettings(projectId);
  const result = { synced: [], errors: [] };
  const run = async (name, cond, fn) => {
    if (!cond || (only && only !== name)) return;
    try { await fn(); result.synced.push(name); } catch (err) { result.errors.push(`${name.toUpperCase()}: ${err.message}`); }
  };
  await run('gsc', settings.gscSite, () => syncGSC(projectId, settings, fetchImpl));
  await run('ga4', settings.ga4Property, () => syncGA4(projectId, settings, fetchImpl));
  await run('semrush', settings.semrush && settings.semrush.enabled, () => syncSemrush(projectId, settings, fetchImpl));
  const fresh = getSettings(projectId);
  fresh.lastSync = new Date().toISOString();
  fresh.lastErrors = result.errors;
  saveSettings(projectId, fresh);
  return result;
}

/* Daily refresh for every project with a connection. */
function startScheduler() {
  const tick = async () => {
    for (const p of db.prepare("SELECT id, analytics FROM projects WHERE analytics != '{}'").all()) {
      const s = parseJSON(p.analytics, {});
      const due = !s.lastSync || Date.now() - Date.parse(s.lastSync) > 20 * 3600 * 1000;
      if (due && (s.gscSite || s.ga4Property || (s.semrush && s.semrush.enabled))) await syncProject(p.id).catch(() => {});
    }
  };
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 3600 * 1000).unref();
}

/* ---------- monthly numbers from Excel ---------- */

// A Search Console "Dates" export (Date, Clicks, Impressions, CTR, Position) or
// any sheet with a Month column and one column per business metric.
function importMetricSheets(projectId, sheets) {
  let count = 0;
  const found = [];
  for (const sh of sheets) {
    const cols = sh.columns.map((c) => c.toLowerCase());
    const di = cols.findIndex((c) => /^(month|date|period|top dates|dates)$/.test(c));
    if (di < 0 || !sh.rows.length) continue;
    const gsc = cols.includes('clicks') && cols.includes('impressions');
    if (gsc) {
      const rows = [];
      for (const r of sh.rows) {
        const month = toMonth(String(r[di] ?? '').slice(0, 10));
        if (!month) continue;
        rows.push({
          keys: [`${month}-01`],
          clicks: Number(r[cols.indexOf('clicks')]) || 0,
          impressions: Number(r[cols.indexOf('impressions')]) || 0,
          position: Number(r[cols.indexOf('position')]) || 0,
        });
      }
      count += putMetrics(projectId, 'gsc', gscMonthly(rows));
      found.push(`${sh.name}: Search Console clicks and impressions`);
      continue;
    }
    const rows = [];
    for (const r of sh.rows) {
      const month = toMonth(r[di]);
      if (!month) continue;
      sh.columns.forEach((c, i) => {
        if (i === di) return;
        const v = typeof r[i] === 'number' ? r[i] : Number(String(r[i] ?? '').replace(/[$,%\s]|S\$/g, ''));
        if (r[i] !== null && r[i] !== '' && Number.isFinite(v)) rows.push({ metric: c.trim().slice(0, 60), month, value: v });
      });
    }
    if (rows.length) {
      count += putMetrics(projectId, 'manual', rows);
      found.push(`${sh.name}: ${[...new Set(rows.map((r) => r.metric))].join(', ')}`);
    }
  }
  return { count, found };
}

/* ---------- SEO / AEO timelines from the ranking sheets ---------- */

const ACTUAL_RE = /(actual|current|existing|latest).*(rank|position)|^(rank|ranking|position|google rank(ing)?|current position)$/i;
const AI_COL_RE = /(ai overview|chatgpt|gemini|perplexity|copilot|ai mode)/i;
const rankNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (/^\s*>\s*\d+/.test(String(v))) return 101;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
const buckets = (vals) => ({
  top3: vals.filter((r) => r !== null && r <= 3).length,
  top10: vals.filter((r) => r !== null && r <= 10).length,
  top30: vals.filter((r) => r !== null && r <= 30).length,
  top100: vals.filter((r) => r !== null && r <= 100).length,
  total: vals.length,
});

function rankingTimelines(projectId) {
  const sets = db.prepare("SELECT id, name, period, columns, created_at FROM datasets WHERE project_id = ? AND tab = 'keywords' AND kind = 'table' ORDER BY id").all(projectId);
  const points = new Map(); // label -> { order, buckets }
  const ai = new Map();
  const add = (map, key, order, label, value) => {
    if (!map.has(key) || map.get(key).order <= order) map.set(key, { order, label, ...value });
  };
  for (const d of sets) {
    const cols = parseJSON(d.columns, []);
    const rows = db.prepare('SELECT data FROM items WHERE dataset_id = ?').all(d.id).map((r) => parseJSON(r.data, []));
    if (!rows.length) continue;
    const engineCols = cols.map((c, i) => (AI_COL_RE.test(c) && /rank|position|mention|cited/i.test(c) ? i : -1)).filter((i) => i >= 0);
    const googleCols = cols.map((c, i) => (ACTUAL_RE.test(c) && !engineCols.includes(i) ? i : -1)).filter((i) => i >= 0);
    for (const c of googleCols) {
      const vals = rows.map((r) => rankNum(r[c]));
      if (!vals.some((v) => v !== null)) continue;
      const m = cols[c].match(/month\s*(\d+)/i);
      const key = m ? `m${m[1]}` : (/existing|baseline|start/i.test(cols[c]) ? 'm0' : `v:${d.period || d.created_at}`);
      const order = m ? Number(m[1]) : key === 'm0' ? 0 : 1000 + d.id;
      add(points, key, order, m ? `Month ${m[1]}` : key === 'm0' ? 'Start' : (d.period || 'Latest'), buckets(vals));
    }
    for (const c of engineCols) {
      const appear = rows.filter((r) => { const v = r[c]; return v !== null && v !== undefined && v !== '' && !/^(na|n\/a|no|-|–|>\s*\d+)$/i.test(String(v).trim()); }).length;
      const engine = (cols[c].match(AI_COL_RE) || [''])[0].replace(/^./, (x) => x.toUpperCase());
      const label = d.period || 'Latest';
      add(ai, `${engine}|${label}`, d.id, label, { engine, appear, total: rows.length });
    }
  }
  return {
    seo: [...points.values()].sort((a, b) => a.order - b.order),
    aeo: [...ai.values()].sort((a, b) => a.order - b.order),
  };
}

/* ---------- what the client dashboard needs ---------- */

function dashboard(projectId, { forAdmin = false } = {}) {
  const settings = getSettings(projectId);
  const series = {};
  for (const r of db.prepare('SELECT source, metric, month, value FROM metrics WHERE project_id = ? ORDER BY month').all(projectId)) {
    ((series[r.source] ||= {})[r.metric] ||= {})[r.month] = r.value;
  }
  // Tracked keywords with Google's own position (GSC) and, when switched on, SEMrush.
  const latestKw = db.prepare(`
    SELECT d.id, d.columns FROM datasets d WHERE d.project_id = ? AND d.tab = 'keywords' AND d.kind = 'table' ORDER BY d.id DESC LIMIT 1
  `).get(projectId);
  let keywords = [];
  if (latestKw) {
    const cols = parseJSON(latestKw.columns, []);
    const pi = primaryColumn(cols, 'keywords');
    const seen = new Set();
    keywords = db.prepare('SELECT data FROM items WHERE dataset_id = ? ORDER BY position').all(latestKw.id)
      .map((r) => String(parseJSON(r.data, [])[pi] ?? '').trim()).filter((k) => k && !seen.has(normalizeKey(k)) && seen.add(normalizeKey(k)));
  }
  const live = {};
  for (const r of db.prepare('SELECT source, keyword, position, url, volume, clicks, impressions, fetched_at FROM live_ranks WHERE project_id = ?').all(projectId)) {
    (live[r.source] ||= {})[r.keyword] = r;
  }
  const kwRows = keywords.map((k) => {
    const n = normalizeKey(k);
    return { keyword: k, gsc: live.gsc?.[n] || null, semrush: live.semrush?.[n] || null };
  });
  const showSemrush = Boolean(settings.semrush && settings.semrush.enabled && (forAdmin || settings.semrush.clientToggle));
  return {
    start: settings.start || null,
    sources: {
      gsc: Boolean(series.gsc), ga4: Boolean(series.ga4), manual: Boolean(series.manual),
      semrush: showSemrush && Boolean(live.semrush),
    },
    lastSync: settings.lastSync || null,
    series,
    timelines: rankingTimelines(projectId),
    keywords: kwRows.map((r) => ({
      keyword: r.keyword,
      gscPosition: r.gsc ? r.gsc.position : null,
      gscClicks: r.gsc ? r.gsc.clicks : null,
      semrushPosition: showSemrush && r.semrush ? r.semrush.position : null,
      semrushUrl: showSemrush && r.semrush ? r.semrush.url : null,
    })),
    liveFetchedAt: {
      gsc: live.gsc ? Object.values(live.gsc)[0]?.fetched_at : null,
      semrush: showSemrush && live.semrush ? Object.values(live.semrush)[0]?.fetched_at : null,
    },
  };
}

module.exports = {
  getSettings, saveSettings, serviceAccount, syncProject,
  setSecret, oauthClient, googleIdentity, googleAuthUrl, connectGoogle, disconnectGoogle, googleProperties, startScheduler, importMetricSheets, dashboard,
  // exported for tests
  toMonth, monthLabel, gscMonthly, ga4Monthly, parseSemrush, rankingTimelines,
};
