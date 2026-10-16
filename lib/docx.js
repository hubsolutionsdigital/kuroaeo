const crypto = require('crypto');
const mammoth = require('mammoth');
const sanitizeHtml = require('sanitize-html');

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'span', 'a', 'img',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'id', 'target', 'rel'],
    img: ['src', 'alt'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data', 'http', 'https'] },
  transformTags: {
    a: (tagName, attribs) => {
      const attrs = { ...attribs };
      if (attrs.href && /^https?:/i.test(attrs.href)) {
        attrs.target = '_blank';
        attrs.rel = 'noopener noreferrer';
      }
      return { tagName, attribs: attrs };
    },
  },
};

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// Key/value tables such as "SEO details" (Field | Value), or meta tag tables
// with Field | Current | Recommended: the recommended value is used, and a
// current value worth comparing is kept as "<field> (current)".
function parseKeyValueTable(tableHtml) {
  const pairs = [];
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let valueCol = null;
  let currentCol = null;
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length < 2) continue;
    if (/^(field|item|element)$/i.test(cells[0]) && cells.slice(1).some((c) => /^(value|current|recommended|proposed|new)$/i.test(c))) {
      const vi = cells.findIndex((c, i) => i > 0 && /^(recommended|proposed|new|value)$/i.test(c));
      const ci = cells.findIndex((c, i) => i > 0 && /^current$/i.test(c));
      valueCol = vi > 0 ? vi : null;
      currentCol = ci > 0 ? ci : null;
      continue;
    }
    if (valueCol === null) { pairs.push([cells[0], cells.slice(1).join(' ')]); continue; }
    pairs.push([cells[0], cells[valueCol] || '']);
    const cur = currentCol !== null ? cells[currentCol] : '';
    if (cur && !/^(new page|none|n\/a|-|–|—)$/i.test(cur) && cur !== cells[valueCol]) pairs.push([`${cells[0]} (current)`, cur]);
  }
  return pairs;
}

function extractSeoDetails(html) {
  const label = String.raw`(?:<[^>]+>\s*)*(?:SEO details?|(?:recommended\s+)?meta(?:\s+tags|\s+data|data)?)\s*:?\s*(?:<\/[^>]+>\s*)*`;
  const re = new RegExp(String.raw`(?:<h[2-4][^>]*>\s*${label}<\/h[2-4]>|<p>\s*<strong>\s*${label}<\/strong>\s*<\/p>)\s*(<table[\s\S]*?<\/table>)`, 'i');
  const m = html.match(re);
  if (!m) return { seo: [], html };
  return { seo: parseKeyValueTable(m[1]), html: html.replace(m[0], '') };
}

// Checklist items written as "☐ Confirm ..." become review points the client
// can confirm one by one. They are replaced by a placeholder in the intro.
function extractChecklist(html) {
  const checks = [];
  const out = html.replace(/<(ul|ol)>([\s\S]*?)<\/\1>/gi, (list, tag, inner) => {
    const lis = inner.match(/<li>[\s\S]*?<\/li>/gi) || [];
    const boxes = lis.filter((li) => /^\s*(☐|☑|☒|\[\s?\]|\[x\])/i.test(stripTags(li)));
    if (!boxes.length || boxes.length !== lis.length) return list;
    for (const li of boxes) {
      const text = stripTags(li).replace(/^(☐|☑|☒|\[\s?\]|\[x\])\s*/i, '');
      if (text) checks.push(text);
    }
    return '<div data-checklist></div>';
  });
  return { checks, html: out };
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function parseBlogDoc(buffer, filename) {
  const { value } = await mammoth.convertToHtml({ buffer }, { styleMap: ['highlight => mark'] });
  const html = sanitizeHtml(value, SANITIZE_OPTIONS);

  const blocks = [];
  // Article titles: "Article 1: …", "Blog 2 – …", "Article: …", as a heading
  // (any level) or as a paragraph that is entirely bold. The bold text may not
  // run past its own paragraph or bold run, or a bold lead-in like
  // "<strong>Visit us.</strong> <a>Book</a>" would swallow the next heading.
  const headRe = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>|<p>\s*<strong>((?:(?!<\/?p[\s>]|<\/?strong>)[\s\S])*)<\/strong>\s*<\/p>/gi;
  let m;
  while ((m = headRe.exec(html))) {
    blocks.push({ start: m.index, end: m.index + m[0].length, level: m[1] ? Number(m[1][1]) : 9, text: stripTags(m[2] ?? m[3]) });
  }

  let splits = [];
  for (const b of blocks) {
    const am = b.text.match(/^(?:article|blog(?:\s*post)?|post|landing\s*page|lp|page)\s*(?:#|no\.?)?\s*(\d+)?\s*[:.\-–—]\s*(.+)$/i);
    if (am) splits.push({ ...b, number: am[1] ? Number(am[1]) : splits.length + 1, title: am[2].trim() });
  }
  // Otherwise: numbered headings ("1. Divorce by Mutual Agreement…") at the
  // heading level used most for them. Headings above that level ("Part 1:
  // Divorce Articles", "Next Steps") divide sections and go in the overview.
  let articleLevel = null;
  if (!splits.length) {
    const numbered = blocks.filter((b) => b.level <= 3 && /^\d{1,2}[.)]\s+\S/.test(b.text));
    const count = {};
    for (const b of numbered) count[b.level] = (count[b.level] || 0) + 1;
    const best = Object.entries(count).sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
    if (best && best[1] >= 2) {
      articleLevel = Number(best[0]);
      splits = numbered.filter((b) => b.level === articleLevel).map((b) => {
        const nm = b.text.match(/^(\d{1,2})[.)]\s+(.+)$/);
        return { ...b, number: Number(nm[1]), title: nm[2].trim() };
      });
    }
  }
  const dividers = articleLevel ? blocks.filter((b) => b.level < articleLevel) : [];

  let docTitle = '';
  const firstSplit = splits.length ? splits[0].start : html.length;
  const titleBlock = blocks.find((b) => b.start < firstSplit && b.level === 1 && b.text && !dividers.includes(b))
    || (articleLevel ? blocks.find((b) => b.start < firstSplit && b.level === 9 && b.text) : null);
  if (titleBlock) docTitle = titleBlock.text;
  else {
    for (const h of html.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || []) {
      const t = stripTags(h);
      if (t) { docTitle = t; break; }
    }
  }
  if (!docTitle) docTitle = filename.replace(/\.docx$/i, '').replace(/[_]+/g, ' ').trim();

  const articles = [];
  let intro = '';
  if (!splits.length) {
    const { seo, html: body } = extractSeoDetails(html);
    articles.push({ number: 1, title: docTitle, seo, html: body });
  } else {
    intro = html.slice(0, splits[0].start);
    splits.forEach((s, i) => {
      const next = i + 1 < splits.length ? splits[i + 1].start : html.length;
      const divider = dividers.find((d) => d.start > s.end && d.start < next);
      let section = html.slice(s.end, divider ? divider.start : next);
      if (divider) intro += html.slice(divider.start, next);
      const { seo, html: rest } = extractSeoDetails(section);
      section = rest.replace(/<h[2-4][^>]*>\s*(?:<[^>]+>\s*)*(?:Article|Page|Landing page|Page content|Content|Copy)\s*(?:<\/[^>]+>\s*)*<\/h[2-4]>/i, '');
      articles.push({ number: s.number, title: s.title, seo, html: section.trim() });
    });
  }

  const { checks, html: introHtml } = extractChecklist(intro);

  return {
    title: docTitle,
    introHtml: introHtml.trim(),
    checks: checks.map((text) => ({ key: `check:${hash(text)}`, text })),
    articles: articles.map((a) => {
      // "/resources/divorce-by-mutual-agreement-singapore" -> its last segment.
      const url = (a.seo.find(([k]) => /slug|url/i.test(k) && !/current/i.test(k)) || [])[1] || '';
      const slug = url.split(/[?#]/)[0].split('/').filter(Boolean).pop();
      return { ...a, key: `article:${slugify(slug || a.title) || hash(a.title)}` };
    }),
  };
}

module.exports = { parseBlogDoc };
