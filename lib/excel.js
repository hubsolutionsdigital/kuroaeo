const ExcelJS = require('exceljs');

const TABS = ['keywords', 'onpage', 'backlinks', 'prompts', 'blogs'];

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
    if (RANGE_COL_RE.test(header)) return `${v.getUTCDate()}-${v.getUTCMonth() + 1}`;
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
  const needed = Math.max(2, Math.ceil(max * 0.6));
  for (let i = 0; i < scan.length; i++) {
    const row = scan[i];
    const filled = row.filter((v) => !isEmpty(v));
    if (filled.length >= needed && filled.every((v) => typeof v === 'string')) return i;
  }
  return counts.indexOf(max);
}

function guessTab(sheetName, headers) {
  const name = sheetName.toLowerCase();
  const hay = `${name} ${headers.join(' ').toLowerCase()}`;
  if (/prompt/.test(name)) return 'prompts';
  if (/on.?page/.test(name)) return 'onpage';
  if (/backlink|link.?building|outreach|citation/.test(name)) return 'backlinks';
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
  const columns = keep.map((c, i) => rawHeaders[c] || `Column ${i + 1}`);
  const numberingIdx = columns.findIndex((h) => NUMBERING_RE.test(h));

  const rows = [];
  for (const row of body) {
    const values = keep.map((c, i) => finalizeValue(row[c], columns[i]));
    const meaningful = values.some((v, i) => i !== numberingIdx && !isEmpty(v));
    if (meaningful) rows.push(values.map((v) => (isEmpty(v) ? null : v)));
  }

  return { name: ws.name, title, columns, rows };
}

async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
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
