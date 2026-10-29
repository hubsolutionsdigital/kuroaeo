/* Word (.docx) export of a blog, GBP post or landing page document, with the
 * client's edits applied, for the developer who publishes it. Written as
 * plain WordprocessingML with JSZip: headings, bold/italic/underline,
 * links, bullet and numbered lists, tables and images. */

const JSZip = require('jszip');
const { parseDocument } = require('htmlparser2');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Characters XML 1.0 does not allow.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const isTag = (n) => n && (n.type === 'tag' || n.type === 'script' || n.type === 'style');

/* ---------- the client's edits, paragraph by paragraph ---------- */

// The same blocks the client page makes editable (public/client.js
// editBlocks): top-level elements, each list item, each table cell.
function editBlocks(nodes) {
  const out = [];
  const cells = (n) => (isTag(n) ? [...(/^(th|td)$/.test(n.name) ? [n] : []), ...n.children.flatMap(cells)] : []);
  for (const el of nodes.filter(isTag)) {
    if (el.name === 'ul' || el.name === 'ol') out.push(...el.children.filter((c) => isTag(c) && c.name === 'li'));
    else if (el.name === 'table') out.push(...el.children.flatMap(cells));
    else out.push(el);
  }
  return out;
}

// The article's HTML as nodes, with each edited paragraph replaced by the
// client's wording.
function withEdits(html, edits) {
  const doc = parseDocument(String(html || ''));
  const blocks = editBlocks(doc.children);
  for (const e of edits || []) {
    const el = blocks[e.block];
    if (!el) continue;
    const kids = parseDocument(String(e.html || '')).children;
    for (const k of kids) k.parent = el;
    el.children = kids;
  }
  return doc.children;
}

/* ---------- images ---------- */

function imageSize(buf, ext) {
  try {
    if (ext === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (ext === 'gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (ext === 'jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return { w: 800, h: 450 };
}

/* ---------- the document writer ---------- */

class DocxWriter {
  constructor() {
    this.body = [];
    this.rels = [];
    this.media = [];
    this.numbers = []; // extra numbered-list instances, so each list starts at 1
    this.pics = 0;
  }

  rel(type, target, external) {
    const id = `rId${this.rels.length + 3}`; // rId1 styles, rId2 numbering
    this.rels.push({ id, type, target, external });
    return id;
  }

  picture(src, alt) {
    const m = String(src || '').match(/^data:image\/(png|jpe?g|gif);base64,(.+)$/i);
    if (!m) return null;
    const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    const name = `image${this.media.length + 1}.${ext === 'jpeg' ? 'jpg' : ext}`;
    this.media.push({ name, buf });
    const id = this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `media/${name}`);
    const { w, h } = imageSize(buf, ext);
    const maxW = 5486400; // 6 inches
    let cx = w * 9525; let cy = h * 9525;
    if (cx > maxW) { cy = Math.round(cy * (maxW / cx)); cx = maxW; }
    const n = ++this.pics;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${esc(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}" descr="${esc(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  // Runs for inline content, carrying bold/italic/… down the tree.
  runs(nodes, fmt = {}) {
    let out = '';
    for (const n of nodes) {
      if (n.type === 'text') {
        const text = n.data.replace(/\s+/g, ' ');
        if (!text) continue;
        const pr = [
          fmt.b ? '<w:b/>' : '', fmt.i ? '<w:i/>' : '', fmt.u || fmt.link ? '<w:u w:val="single"/>' : '', fmt.s ? '<w:strike/>' : '',
          fmt.link ? '<w:color w:val="0563C1"/>' : '', fmt.hl ? '<w:highlight w:val="yellow"/>' : '',
          fmt.sup ? '<w:vertAlign w:val="superscript"/>' : fmt.sub ? '<w:vertAlign w:val="subscript"/>' : '',
          fmt.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '', fmt.color ? `<w:color w:val="${fmt.color}"/>` : '', fmt.size ? `<w:sz w:val="${fmt.size}"/>` : '',
        ].join('');
        out += `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
        continue;
      }
      if (!isTag(n)) continue;
      const kids = n.children || [];
      switch (n.name) {
        case 'br': out += '<w:r><w:br/></w:r>'; break;
        case 'strong': case 'b': out += this.runs(kids, { ...fmt, b: true }); break;
        case 'em': case 'i': out += this.runs(kids, { ...fmt, i: true }); break;
        case 'u': out += this.runs(kids, { ...fmt, u: true }); break;
        case 's': case 'del': case 'strike': out += this.runs(kids, { ...fmt, s: true }); break;
        case 'sup': out += this.runs(kids, { ...fmt, sup: true }); break;
        case 'sub': out += this.runs(kids, { ...fmt, sub: true }); break;
        case 'mark': out += this.runs(kids, { ...fmt, hl: true }); break;
        case 'code': out += this.runs(kids, { ...fmt, code: true }); break;
        case 'img': {
          const pic = this.picture(n.attribs.src, n.attribs.alt);
          out += pic || this.runs([{ type: 'text', data: `[Image: ${n.attribs.alt || n.attribs.src || ''}]` }], fmt);
          break;
        }
        case 'a': {
          const href = n.attribs.href || '';
          if (/^(https?:|mailto:)/i.test(href)) {
            const id = this.rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', href, true);
            out += `<w:hyperlink r:id="${id}">${this.runs(kids, { ...fmt, link: true })}</w:hyperlink>`;
          } else out += this.runs(kids, fmt);
          break;
        }
        default: out += this.runs(kids, fmt);
      }
    }
    return out;
  }

  para(content, { style, numId, ilvl = 0, indent, spacingAfter, border, keepNext } = {}) {
    const pPr = [
      style ? `<w:pStyle w:val="${style}"/>` : '', keepNext ? '<w:keepNext/>' : '',
      numId ? `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>` : '',
      border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D7E2"/></w:pBdr>' : '',
      spacingAfter !== undefined ? `<w:spacing w:after="${spacingAfter}"/>` : '',
      indent ? `<w:ind w:left="${indent}"/>` : '',
    ].join('');
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
  }

  // Block-level HTML into paragraphs and tables.
  blocks(nodes, ctx = {}) {
    const out = [];
    let inline = [];
    const flush = () => {
      if (inline.some((n) => (n.type === 'text' ? n.data.trim() : isTag(n)))) out.push(this.para(this.runs(inline, ctx.fmt), ctx.para));
      inline = [];
    };
    for (const n of nodes) {
      if (n.type === 'text' || (isTag(n) && /^(strong|b|em|i|u|s|del|sup|sub|mark|code|a|span|img|br|ins|small|abbr)$/.test(n.name))) { inline.push(n); continue; }
      if (!isTag(n)) continue;
      flush();
      const kids = n.children || [];
      const hm = n.name.match(/^h([1-6])$/);
      if (hm) out.push(this.para(this.runs(kids, ctx.fmt), { style: `Heading${Math.min(4, Math.max(2, Number(hm[1])))}`, keepNext: true }));
      else if (n.name === 'p' || n.name === 'div') out.push(...this.blocks(kids, ctx));
      else if (n.name === 'ul' || n.name === 'ol') out.push(...this.list(n, ctx.level || 0));
      else if (n.name === 'table') out.push(this.table(n));
      else if (n.name === 'blockquote') out.push(...this.blocks(kids, { ...ctx, para: { style: 'Quote' } }));
      else if (n.name === 'hr') out.push(this.para('', { border: true }));
      else if (n.name === 'pre') out.push(this.para(this.runs(kids, { code: true })));
      else out.push(...this.blocks(kids, ctx));
    }
    flush();
    return out;
  }

  list(el, level) {
    let numId = 1; // bullets
    if (el.name === 'ol') { this.numbers.push(1); numId = 2 + this.numbers.length; }
    const out = [];
    for (const li of el.children.filter((c) => isTag(c) && c.name === 'li')) {
      const nested = li.children.filter((c) => isTag(c) && (c.name === 'ul' || c.name === 'ol'));
      // Paragraphs inside a list item join into one numbered line.
      const own = li.children.filter((c) => !nested.includes(c)).flatMap((c, i) => (isTag(c) && c.name === 'p' ? [...(i ? [{ type: 'tag', name: 'br', attribs: {}, children: [] }] : []), ...c.children] : [c]));
      out.push(this.para(this.runs(own), { numId, ilvl: Math.min(level, 4) }));
      for (const sub of nested) out.push(...this.list(sub, level + 1));
    }
    return out;
  }

  table(el) {
    const rows = [];
    const collect = (n) => { for (const c of n.children || []) { if (!isTag(c)) continue; if (c.name === 'tr') rows.push(c); else if (/^(thead|tbody|tfoot)$/.test(c.name)) collect(c); } };
    collect(el);
    const cellsOf = (tr) => tr.children.filter((c) => isTag(c) && (c.name === 'td' || c.name === 'th'));
    const cols = Math.max(1, ...rows.map((tr) => cellsOf(tr).reduce((n, c) => n + (Number(c.attribs.colspan) || 1), 0)));
    // A one-column table is a box around copy (Word marks its first row as a
    // header), not a header cell: keep its paragraphs as they are.
    // Only the first row and first column are shown as headings.
    const headerCell = (c, r, j) => c.name === 'th' && cols > 1 && (r === 0 || j === 0);
    const width = Math.floor(9000 / cols);
    const trs = rows.map((tr, r) => `<w:tr>${cellsOf(tr).map((c, j) => {
      const span = Number(c.attribs.colspan) || 1;
      const head = headerCell(c, r, j);
      const content = this.blocks(c.children, head ? { fmt: { b: true } } : {}).join('') || '<w:p/>';
      return `<w:tc><w:tcPr><w:tcW w:w="${width * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>' : ''}</w:tcPr>${content}</w:tc>`;
    }).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${trs}</w:tbl>`;
  }

  /* ---------- convenience for the export layout ---------- */
  title(text) { this.body.push(this.para(this.runs([{ type: 'text', data: text }]), { style: 'Title' })); }
  heading(text, level = 1) { this.body.push(this.para(this.runs([{ type: 'text', data: text }]), { style: `Heading${level}`, keepNext: true })); }
  note(text, color = '6B7280') { this.body.push(this.para(this.runs([{ type: 'text', data: text }], { i: true, color, size: 19 }), { spacingAfter: 120 })); }
  html(html) { this.body.push(...this.blocks(Array.isArray(html) ? html : parseDocument(String(html || '')).children)); }
  details(pairs, heading) {
    if (!pairs.length) return;
    this.body.push(this.para(this.runs([{ type: 'text', data: heading }], { b: true, color: '1D3A6B', size: 20 }), { spacingAfter: 60, keepNext: true }));
    const rows = pairs.map(([k, v]) => ({ type: 'tag', name: 'tr', attribs: {}, children: [
      { type: 'tag', name: 'th', attribs: {}, children: [{ type: 'text', data: String(k) }] },
      { type: 'tag', name: 'td', attribs: {}, children: [{ type: 'text', data: String(v) }] },
    ] }));
    this.body.push(this.table({ type: 'tag', name: 'table', attribs: {}, children: rows }));
    this.body.push(this.para('', { spacingAfter: 120 }));
  }
  bullets(lines) { for (const l of lines) this.body.push(this.para(this.runs([{ type: 'text', data: l }]), { numId: 1 })); }
  pageBreak() { this.body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); }

  async toBuffer({ title } = {}) {
    const zip = new JSZip();
    const hasJpg = this.media.some((m) => m.name.endsWith('.jpg'));
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${hasJpg ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : ''}<Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
    zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title || '')}</dc:title><dc:creator>Review portal</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`);
    for (const m of this.media) zip.file(`word/media/${m.name}`, m.buf);
    zip.file('word/styles.xml', STYLES);
    zip.file('word/numbering.xml', numberingXml(this.numbers.length));
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${this.body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}

const heading = (id, name, size, before, color = '1D3A6B') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-SG"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="17213A"/><w:sz w:val="40"/></w:rPr></w:style>${heading('Heading1', 'heading 1', 34, 240)}${heading('Heading2', 'heading 2', 28, 280)}${heading('Heading3', 'heading 3', 24, 220)}${heading('Heading4', 'heading 4', 22, 200)}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="4A5570"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D7E2"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

function numberingXml(orderedLists) {
  const lvls = (fmt) => Array.from({ length: 5 }, (_, i) => {
    const bullet = ['•', '◦', '▪', '•', '◦'][i];
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === 'bullet' ? bullet : `%${i + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>' : ''}</w:lvl>`;
  }).join('');
  const nums = [`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`, `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`];
  for (let i = 0; i < orderedLists; i++) {
    nums.push(`<w:num w:numId="${3 + i}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum>${nums.join('')}</w:numbering>`;
}

module.exports = { DocxWriter, withEdits, editBlocks };
