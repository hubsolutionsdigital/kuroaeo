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

// Key/value tables such as "SEO details" (Field | Value).
function parseKeyValueTable(tableHtml) {
  const pairs = [];
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length < 2) continue;
    if (/^field$/i.test(cells[0]) && /^value$/i.test(cells[1])) continue;
    pairs.push([cells[0], cells.slice(1).join(' ')]);
  }
  return pairs;
}

function extractSeoDetails(html) {
  const re = /<h[2-4][^>]*>\s*(?:<[^>]+>\s*)*SEO details?\s*(?:<\/[^>]+>\s*)*<\/h[2-4]>\s*(<table[\s\S]*?<\/table>)/i;
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

  const splits = [];
  // Article titles: "Article 1: …", "Blog 2 – …", "Article: …", as a heading
  // (any level) or as a paragraph that is entirely bold.
  const headRe = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>|<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/gi;
  let m;
  while ((m = headRe.exec(html))) {
    const text = stripTags(m[2] ?? m[3]);
    const am = text.match(/^(?:article|blog(?:\s*post)?|post)\s*(?:#|no\.?)?\s*(\d+)?\s*[:.\-–—]\s*(.+)$/i);
    if (am) splits.push({ start: m.index, end: m.index + m[0].length, number: am[1] ? Number(am[1]) : splits.length + 1, title: am[2].trim() });
  }

  let docTitle = '';
  const h1s = html.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) || [];
  for (const h of h1s) {
    const t = stripTags(h);
    if (t) { docTitle = t; break; }
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
      let section = html.slice(s.end, i + 1 < splits.length ? splits[i + 1].start : html.length);
      const { seo, html: rest } = extractSeoDetails(section);
      section = rest.replace(/<h[2-4][^>]*>\s*(?:<[^>]+>\s*)*Article\s*(?:<\/[^>]+>\s*)*<\/h[2-4]>/i, '');
      articles.push({ number: s.number, title: s.title, seo, html: section.trim() });
    });
  }

  const { checks, html: introHtml } = extractChecklist(intro);

  return {
    title: docTitle,
    introHtml: introHtml.trim(),
    checks: checks.map((text) => ({ key: `check:${hash(text)}`, text })),
    articles: articles.map((a) => {
      const slug = (a.seo.find(([k]) => /slug|url/i.test(k)) || [])[1];
      return { ...a, key: `article:${slugify(slug || a.title) || hash(a.title)}` };
    }),
  };
}

module.exports = { parseBlogDoc };
