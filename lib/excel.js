const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const TABS = ['keywords', 'onpage', 'backlinks', 'prompts', 'blogs', 'gbp', 'landing'];

const MAX_ROWS = 5000;
const MAX_COLS = 60;
const NUMBERING_RE = /^(no\.?|s\/?n|#|sn|sr\.?\s*no\.?|serial)$/i;
// Columns whose values are rankings / ranges like "12-25". Excel likes to turn
// "5-12" into a date (5 Dec), so dates in these columns are turned back.
const RANGE_COL_RE = /rank|phase|month|position|projected|target/i;

function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? parseFloat(v.toPrecision(12)) : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.replace(/\r\n?/g, '\n').trim();
    return s === '' ? null : s;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return normalizeValue(v.richText.map((r) => r.text).join(''));
    if ('error' in v) return null;
    if ('formula' in v || 'sharedFormula' in v) return normalizeValue(v.result);
    if ('text' in v) {
      const text = normalizeValue(v.text);
      return text === null && v.hyperlink ? normalizeValue(v.hyperlink) : text;
    }
    if ('hyperlink' in v) return normalizeValue(v.hyperlink);
  }
  return normalizeValue(String(v));
}

function finalizeValue(v, header) {
  if (v instanceof Date) {
    if (RANGE_COL_RE.test(header) && !/^(month|date|period|dates)$/i.test(header.trim())) return `${v.getUTCDate()}-${v.getUTCMonth() + 1}`;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

function findHeaderRow(grid) {
  const scan = grid.slice(0, 15);
  const counts = scan.map((row) => row.filter((v) => !isEmpty(v)).length);
  const max = Math.max(0, ...counts);
  if (max === 0) return -1;
  // The header is the fullest all-text row near the top (earliest on a tie), so a
  // title row or a label row above it ("Google Ranking", "Phase 3") is skipped.
  let best = -1;
  for (let i = 0; i < scan.length; i++) {
    const filled = scan[i].filter((v) => !isEmpty(v));
    if (filled.length >= 2 && filled.every((v) => typeof v === 'string') && (best < 0 || filled.length > counts[best])) best = i;
  }
  return best >= 0 ? best : counts.indexOf(max);
}

function guessTab(sheetName, headers) {
  const name = sheetName.toLowerCase();
  const hay = `${name} ${headers.join(' ').toLowerCase()}`;
  if (/prompt/.test(name)) return 'prompts';
  if (/on.?page/.test(name)) return 'onpage';
  if (/backlink|link.?building|outreach|citation/.test(name)) return 'backlinks';
  if (/landing/.test(name)) return 'landing';
  if (/\bgbp\b|google business|business profile/.test(name)) return 'gbp';
  if (/article|blog|content/.test(name)) return 'blogs';
  if (/keyword|rank/.test(name)) return 'keywords';
  if (/task|todo|checklist/.test(name)) return 'skip';
  if (/meta description|page title|\bh1\b/.test(hay)) return 'onpage';
  if (/backlink|anchor/.test(hay)) return 'backlinks';
  if (/prompt/.test(hay)) return 'prompts';
  if (/keyword|search vol/.test(hay)) return 'keywords';
  if (/title/.test(hay) && /url|status/.test(hay)) return 'blogs';
  return 'skip';
}

function parseSheet(ws) {
  const rowCount = Math.min(ws.rowCount, MAX_ROWS);
  const colCount = Math.min(ws.columnCount, MAX_COLS);
  const grid = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const values = [];
    for (let c = 1; c <= colCount; c++) values.push(normalizeValue(row.getCell(c).value));
    grid.push(values);
  }

  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) return { name: ws.name, title: '', columns: [], rows: [] };

  let title = '';
  for (let i = 0; i < headerIdx; i++) {
    const filled = grid[i].filter((v) => !isEmpty(v));
    if (filled.length === 1 && typeof filled[0] === 'string') { title = filled[0]; break; }
  }

  const rawHeaders = grid[headerIdx].map((v) => (isEmpty(v) ? '' : String(finalizeValue(v, '')).replace(/\s+/g, ' ').trim()));
  const body = grid.slice(headerIdx + 1);

  // Keep columns that have a header or any data, in their original order.
  const keep = [];
  for (let c = 0; c < colCount; c++) {
    if (rawHeaders[c] || body.some((row) => !isEmpty(row[c]))) keep.push(c);
  }
  // A label row above the header (e.g. "Google Ranking" over "Current Ranking")
  // names columns that would otherwise share the same header.
  const above = headerIdx > 0 ? grid[headerIdx - 1] : [];
  const aboveFilled = above.filter((v) => !isEmpty(v)).length;
  const groupOf = (c) => (aboveFilled >= 2 && typeof above[c] === 'string' ? above[c].replace(/\s+/g, ' ').trim() : '');
  const count = {};
  for (const c of keep) if (rawHeaders[c]) count[rawHeaders[c]] = (count[rawHeaders[c]] || 0) + 1;
  const used = new Set();
  const columns = keep.map((c, i) => {
    let name = rawHeaders[c] || groupOf(c) || `Column ${i + 1}`;
    if (rawHeaders[c] && count[rawHeaders[c]] > 1 && groupOf(c)) name = `${groupOf(c)} · ${rawHeaders[c]}`;
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name} (${n})`;
    used.add(unique);
    return unique;
  });
  const numberingIdx = columns.findIndex((h) => NUMBERING_RE.test(h));

  const rows = [];
  for (const row of body) {
    const values = keep.map((c, i) => finalizeValue(row[c], columns[i]));
    const meaningful = values.some((v, i) => i !== numberingIdx && !isEmpty(v));
    if (meaningful) rows.push(values.map((v) => (isEmpty(v) ? null : v)));
  }

  return { name: ws.name, title, columns, rows };
}

// Google Sheets exports write relationship targets as absolute paths
// ("/xl/comments/comment1.xml"), which ExcelJS cannot resolve. Rewrite them as
// paths relative to the part, the way Excel writes them. With `dropComments`,
// cell comments are removed entirely (the portal never shows them).
async function normalizeWorkbook(buffer, dropComments) {
  const zip = await JSZip.loadAsync(buffer);
  const relFiles = Object.keys(zip.files).filter((n) => /(^|\/)_rels\/[^/]+\.rels$/.test(n));
  for (const name of relFiles) {
    const partDir = name.replace(/(^|\/)_rels\/[^/]+$/, '').replace(/\/$/, '');
    let xml = await zip.file(name).async('string');
    xml = xml.replace(/Target="\/([^"]+)"/g, (m, target) => {
      const from = partDir ? partDir.split('/') : [];
      const to = target.split('/');
      while (from.length && to.length > 1 && from[0] === to[0]) { from.shift(); to.shift(); }
      return `Target="${[...from.map(() => '..'), ...to].join('/')}"`;
    });
    if (dropComments) xml = xml.replace(/<Relationship\b[^>]*relationships\/(comments|vmlDrawing|threadedComment)"[^>]*\/>/g, '');
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

async function loadWorkbook(buffer) {
  let lastErr;
  for (const attempt of [(b) => b, (b) => normalizeWorkbook(b, false), (b) => normalizeWorkbook(b, true)]) {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await attempt(buffer));
      return wb;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function parseWorkbook(buffer) {
  const wb = await loadWorkbook(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const parsed = parseSheet(ws);
    parsed.suggestedTab = parsed.rows.length ? guessTab(parsed.name, parsed.columns) : 'skip';
    sheets.push(parsed);
  });
  return sheets;
}

const PRIMARY_PATTERNS = {
  keywords: [/^keywords?$/i, /keyword/i, /query|term/i],
  onpage: [/^page$/i, /page name/i, /^url$/i, /url/i, /page/i, /keyword/i],
  backlinks: [/backlink url/i, /^(url|domain|website|site)$/i, /url|domain|website|site/i, /backlink/i],
  prompts: [/^prompts?$/i, /prompt/i, /question|query/i],
  blogs: [/^(title|article|blog)( title)?$/i, /title/i, /article|topic/i],
  landing: [/^(page|landing page|title)( name| title)?$/i, /landing page|page|title/i, /url/i],
  gbp: [/^(post|post title|title|topic)$/i, /post|title|topic/i],
};

function primaryColumn(columns, tab) {
  for (const re of PRIMARY_PATTERNS[tab] || []) {
    const idx = columns.findIndex((h) => re.test(h));
    if (idx >= 0) return idx;
  }
  const first = columns.findIndex((h) => !NUMBERING_RE.test(h));
  return first >= 0 ? first : 0;
}

function normalizeKey(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = { parseWorkbook, primaryColumn, normalizeKey, TABS, NUMBERING_RE };
