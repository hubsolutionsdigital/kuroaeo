/* Client "Performance" view: how the SEO & AEO work is growing the business.
   Charts are plain SVG: one measure per chart, thin columns with rounded tops,
   hover tooltips and a table view for every chart. */

const COUNTRY_NAMES = { sgp: 'Singapore', mys: 'Malaysia', aus: 'Australia', gbr: 'the UK', usa: 'the US', hkg: 'Hong Kong' };

const VIZ = {
  series: '#2a78d6', // categorical slot 1 (single-series charts)
  ordinal: ['#184f95', '#2a78d6', '#5598e7', '#86b6ef'], // top 3 / 4-10 / 11-30 / 31-100, validated ordinal ramp
  grid: '#e7eaf0',
  axis: '#7d869c',
};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymLabel = (ym, long) => { const [y, m] = ym.split('-'); return long ? `${MON[Number(m) - 1]} ${y}` : MON[Number(m) - 1]; };
function compact(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e6) return `${parseFloat((n / 1e6).toFixed(1))}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (a >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(1)));
}
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
const nowYM = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// Round axis: a 1/2/5 step (whole numbers for counts) and a top that is a multiple of it.
function niceScale(v) {
  if (!(v > 0)) return { max: 4, step: 1 };
  const rough = v / 4;
  const p = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 5, 10].map((m) => m * p).find((x) => x >= rough);
  if (step < 1) step = 1;
  return { max: Math.ceil(v / step) * step, step };
}

let vizTip = null;
function tip(e, html) {
  if (!vizTip) { vizTip = h('div', { class: 'viz-tip', role: 'status' }); document.body.append(vizTip); }
  vizTip.innerHTML = html;
  vizTip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - vizTip.offsetWidth - 8);
  const y = Math.max(8, e.clientY - vizTip.offsetHeight - 12);
  vizTip.style.left = `${x}px`;
  vizTip.style.top = `${y}px`;
}
function hideTip() { if (vizTip) vizTip.hidden = true; }
const escHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Column chart. series: [{ name, color, values: [] }] — one series, or several stacked. */
function columnChart({ labels, series, format = compact, unit = '', partialLast = false }) {
  const W = 560; const H = 210; const L = 40; const R = 12; const T = 16; const B = 28;
  const stacked = series.length > 1;
  const totals = labels.map((_, i) => series.reduce((s, se) => s + (se.values[i] || 0), 0));
  const scale = niceScale(Math.max(...totals, 0));
  const max = scale.max;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz', role: 'img' });
  const plotW = W - L - R; const plotH = H - T - B;
  const y = (v) => T + plotH - (v / max) * plotH;
  for (let v = 0; v <= max + 1e-9; v += scale.step) {
    svg.append(el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: VIZ.grid, 'stroke-width': 1 }));
    const t = el('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'viz-axis' });
    t.textContent = compact(v);
    svg.append(t);
  }
  const band = plotW / labels.length;
  const bw = Math.min(24, band * 0.6);
  const lastIdx = totals.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0).pop();
  labels.forEach((lab, i) => {
    const cx = L + band * i + band / 2;
    let base = 0;
    series.forEach((se, si) => {
      const v = se.values[i] || 0;
      if (v <= 0) return;
      const top = base + v;
      const y0 = y(base); const y1 = y(top);
      const gap = base > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const hgt = Math.max(0, y0 - y1 - gap);
      const isTop = si === series.length - 1 || series.slice(si + 1).every((s2) => !(s2.values[i] > 0));
      const r = isTop ? Math.min(4, hgt, bw / 2) : 0;
      const x0 = cx - bw / 2; const yt = y1; const yb = y1 + hgt;
      const d = `M${x0},${yb} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x0 + bw - r},${yt} Q${x0 + bw},${yt} ${x0 + bw},${yt + r} L${x0 + bw},${yb} Z`;
      svg.append(el('path', { d, fill: se.color, 'fill-opacity': partialLast && i === labels.length - 1 ? 0.45 : 1 }));
      base = top;
    });
    const t = el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'viz-axis' });
    t.textContent = partialLast && i === labels.length - 1 ? `${lab}*` : lab;
    svg.append(t);
    if (i === lastIdx) {
      const v = el('text', { x: cx, y: y(totals[i]) - 6, 'text-anchor': 'middle', class: 'viz-value' });
      v.textContent = format(totals[i]);
      svg.append(v);
    }
    const hit = el('rect', { x: L + band * i, y: T, width: band, height: plotH, fill: 'transparent', class: 'viz-hit' });
    hit.addEventListener('mousemove', (e) => {
      const lines = stacked
        ? series.map((se) => `<div><span class="sw" style="background:${se.color}"></span>${escHTML(se.name)}: <b>${format(se.values[i] || 0)}</b></div>`).join('')
        : `<b>${format(series[0].values[i])}</b>${unit ? ` ${escHTML(unit)}` : ''}`;
      tip(e, `<div class="tt-h">${escHTML(lab)}${partialLast && i === labels.length - 1 ? ' (so far)' : ''}</div>${lines}`);
    });
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit);
  });
  return svg;
}

function chartCard({ title, sub, labels, longLabels, series, format, unit, legend, partialLast }) {
  const card = h('div', { class: 'card viz-card' });
  const body = h('div', { class: 'viz-body' });
  let asTable = false;
  const toggle = h('button', { class: 'btn ghost sm', type: 'button' }, 'Table');
  const draw = () => {
    toggle.textContent = asTable ? 'Chart' : 'Table';
    if (asTable) {
      body.replaceChildren(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'plain' },
        h('thead', null, h('tr', null, h('th', null, ''), series.map((s) => h('th', { style: { textAlign: 'right' } }, s.name)))),
        h('tbody', null, labels.map((_, i) => h('tr', null, h('td', null, (longLabels || labels)[i]),
          series.map((s) => h('td', { style: { textAlign: 'right' }, class: 'nowrap' }, (format || compact)(s.values[i] ?? null)))))))));
    } else {
      body.replaceChildren(columnChart({ labels, series, format, unit, partialLast }));
      if (partialLast) body.append(h('div', { class: 'muted small', style: { marginTop: '4px' } }, `* ${(longLabels || labels)[labels.length - 1]} so far. The month is still in progress.`));
    }
  };
  toggle.addEventListener('click', () => { asTable = !asTable; draw(); });
  card.append(...[
    h('div', { class: 'viz-head' },
      h('div', null, h('h3', null, title), sub ? h('div', { class: 'muted small' }, sub) : null),
      toggle),
    legend && series.length > 1 ? h('div', { class: 'viz-legend' }, series.map((s) => h('span', null, h('span', { class: 'sw', style: { background: s.color } }), s.name))) : null,
    body].filter(Boolean));
  draw();
  return card;
}

function monthsOf(...maps) {
  const set = new Set();
  for (const m of maps) if (m) Object.keys(m).forEach((k) => set.add(k));
  return [...set].sort();
}

// Compare the last complete month with the one before and with the first month.
function growth(map) {
  if (!map) return null;
  const cur = nowYM();
  const ms = Object.keys(map).sort();
  const full = ms.filter((m) => m < cur);
  const use = full.length ? full : ms;
  if (!use.length) return null;
  const last = use[use.length - 1];
  const prev = use.length > 1 ? use[use.length - 2] : null;
  return { last, value: map[last], prev, prevValue: prev ? map[prev] : null, first: use[0], firstValue: map[use[0]], partial: !full.length };
}

function stat(label, g, { format = compact, sinceLabel } = {}) {
  if (!g) return null;
  const d = g.prev ? pct(g.value, g.prevValue) : null;
  const since = g.first !== g.last ? pct(g.value, g.firstValue) : null;
  return h('div', { class: 'stat' },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, format(g.value), h('small', null, ymLabel(g.last, true))),
    h('div', { class: 'stat-deltas' },
      d !== null ? h('span', { class: `delta ${d >= 0 ? 'up' : 'down'}` }, `${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}% vs ${ymLabel(g.prev)}`) : null,
      since !== null ? h('span', { class: 'muted' }, `${since >= 0 ? '+' : ''}${since}% since ${sinceLabel || ymLabel(g.first, true)}`) : null));
}

// Where each tracked keyword ranks now: the better of Google's best day in
// the last 28 days (Search Console) and our latest month-end report.
function rankWins(data) {
  const kws = data.keywords || [];
  if (!kws.length) return null;
  const rows = kws.map((k) => {
    const cands = [k.gscBest, k.reported, k.livePosition].filter((v) => v !== null && v !== undefined);
    return { keyword: k.keyword, now: cands.length ? Math.round(Math.min(...cands)) : null, start: k.start };
  });
  if (!rows.some((r) => r.now !== null)) return null;
  const count = (key, max) => rows.filter((r) => r[key] !== null && r[key] <= max).length;
  const hasStart = rows.some((r) => r.start !== null);
  const improved = rows.filter((r) => r.now !== null && r.now < (r.start ?? 101));
  const climb = hasStart ? rows.filter((r) => r.now !== null && r.start !== null && r.now < r.start)
    .sort((a, b) => (b.start - b.now) - (a.start - a.now))[0] : null;
  return {
    total: rows.length, hasStart,
    page1: count('now', 10), page1Start: count('start', 10),
    top3: count('now', 3), top3Start: count('start', 3),
    improved: improved.length, climb,
  };
}

// How often the business appears in AI answers, from the ranking sheet's AI
// columns (latest month per engine).
function aiWins(rep) {
  if (!rep || !rep.ai || !rep.ai.length) return [];
  return rep.ai.map((a, j) => {
    const places = rep.rows.map((r) => ({ keyword: r.keyword, p: r.ai[j] })).filter((x) => x.p !== null);
    const first = places.filter((x) => x.p.pos === 1);
    return {
      engine: a.engine, label: a.label, total: rep.rows.length, checked: places.length,
      shown: places.filter((x) => x.p.shown).length, first: first.length, firstExample: first[0] ? first[0].keyword : null,
    };
  }).filter((w) => w.checked);
}

function rankTile(label, value, small, note, up) {
  return h('div', { class: 'stat' },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, value, small ? h('small', null, small) : null),
    note ? h('div', { class: 'stat-deltas' }, h('span', { class: up ? 'delta up' : 'muted' }, note)) : null);
}

function aiTiles(list) {
  const tiles = [];
  const lead = [...list].sort((a, b) => b.first - a.first || b.shown - a.shown)[0];
  if (lead && lead.first) tiles.push(h('div', { class: 'stat ai-stat' },
    h('div', { class: 'k' }, `✨ #1 in ${lead.engine}`),
    h('div', { class: 'v' }, String(lead.first), h('small', null, lead.first === 1 ? 'keyword' : 'keywords')),
    lead.firstExample ? h('div', { class: 'stat-deltas' }, h('span', { class: 'muted' }, `incl. “${lead.firstExample}”`)) : null));
  for (const w of list.slice(0, 3)) {
    tiles.push(h('div', { class: 'stat ai-stat' },
      h('div', { class: 'k' }, `✨ Shown in ${w.engine}`),
      h('div', { class: 'v' }, String(w.shown), h('small', null, `of ${w.total} keywords`)),
      h('div', { class: 'stat-deltas' }, h('span', { class: 'muted' }, w.label))));
  }
  return tiles;
}

function rankTiles(w) {
  if (!w) return [];
  const from = (n, start) => (w.hasStart && n > start ? `▲ up from ${start} at the start` : null);
  const tiles = [
    rankTile('Keywords on Google page 1', String(w.page1), `of ${w.total} keywords`, from(w.page1, w.page1Start), w.page1 > w.page1Start),
    rankTile('Keywords in the top 3', String(w.top3), `of ${w.total} keywords`, from(w.top3, w.top3Start), w.top3 > w.top3Start),
  ];
  if (w.hasStart && w.improved) tiles.push(rankTile('Keywords moved up', String(w.improved), `of ${w.total}, since we started`, null));
  if (w.climb) {
    const fmt = (v) => (v > 100 ? 'not ranked' : `#${v}`);
    tiles.push(rankTile('Biggest climb', `#${w.climb.now}`, w.climb.keyword, `▲ from ${fmt(w.climb.start)}`, true));
  }
  return tiles;
}

function perfSummary(data) {
  const out = [];
  const w = rankWins(data);
  if (w && (w.page1 || w.improved)) {
    let t = `${w.page1} of your ${w.total} keywords ${w.page1 === 1 ? 'is' : 'are'} on Google’s first page`;
    if (w.hasStart && w.page1 > w.page1Start) t += `, up from ${w.page1Start} when we started`;
    if (w.climb) t += `. The biggest climb: “${w.climb.keyword}” moved from ${w.climb.start > 100 ? 'outside the top 100' : `#${w.climb.start}`} to #${w.climb.now}`;
    out.push(`${t}.`);
  }
  const gsc = data.series.gsc || {};
  const ga4 = data.series.ga4 || {};
  const c = growth(gsc.clicks);
  if (c) {
    let t = `In ${ymLabel(c.last, true)}${c.partial ? ' so far' : ''}, ${compact(c.value)} people clicked through to your website from Google search`;
    if (c.first !== c.last) {
      const g = pct(c.value, c.firstValue);
      t += `, ${g >= 0 ? `up ${g}%` : `down ${Math.abs(g)}%`} from ${compact(c.firstValue)} in ${ymLabel(c.first, true)}`;
    }
    out.push(`${t}.`);
  }
  const aiAnswers = aiWins(data.rankingReport);
  const lead = [...aiAnswers].sort((a, b) => b.first - a.first || b.shown - a.shown)[0];
  if (lead && lead.shown) {
    out.push(lead.first
      ? `In ${lead.engine}, you are the first business named for ${lead.first} ${lead.first === 1 ? 'keyword' : 'keywords'}${lead.firstExample ? `, including “${lead.firstExample}”` : ''}, and you appear for ${lead.shown} of ${lead.total} keywords we track.`
      : `You appear in ${lead.engine} for ${lead.shown} of the ${lead.total} keywords we track.`);
  }
  const s = growth(ga4.organic_sessions);
  const k = growth(ga4.organic_key_events);
  if (s || k) {
    const parts = [];
    if (s) parts.push(`${compact(s.value)} visits from organic search`);
    if (k) parts.push(`${compact(k.value)} enquiries and other key actions from those visitors`);
    out.push(`Google Analytics recorded ${parts.join(' and ')} in ${ymLabel((s || k).last, true)}.`);
  }
  const seo = data.timelines.seo;
  if (seo.length >= 1 && !(w && (w.page1 || w.improved))) {
    const a = seo[0]; const b = seo[seo.length - 1];
    // Report the first band where there is something to see.
    const [key, name] = [['top10', 'on Google’s first page (top 10)'], ['top30', 'in Google’s top 30'], ['top100', 'in Google’s top 100']]
      .find(([k]) => a[k] || b[k]) || ['top100', 'in Google’s top 100'];
    const when = a.label.toLowerCase() === 'start' ? 'the start' : a.label;
    out.push(seo.length > 1
      ? `Keywords ${name} went from ${a[key]} at ${when} to ${b[key]} in ${b.label}, out of ${b.total} we track.`
      : `${b[key]} of the ${b.total} keywords we track are ${name}.`);
  }
  const ai = growth(ga4.ai_sessions);
  if (ai) out.push(`AI assistants such as ChatGPT and Perplexity sent ${compact(ai.value)} visits in ${ymLabel(ai.last, true)}, a sign you are being recommended in AI answers.`);
  return out;
}

// Place in an AI answer: #1 (named first), Shown (named, place not noted), or –.
function aiBadge(p) {
  if (!p) return h('span', { class: 'muted' }, '–');
  if (!p.shown) return h('span', { class: 'muted small' }, 'Not shown');
  return p.pos ? h('span', { class: `ai-badge${p.pos === 1 ? ' first' : ''}`, title: p.pos === 1 ? 'Named first in the AI answer' : `Named in position ${p.pos}` }, `#${p.pos}`)
    : h('span', { class: 'ai-badge', title: 'Named in the AI answer' }, '✓ Shown');
}

// Our month-end ranking report for every keyword, read-only, so clients can
// follow their rankings after the keyword list is approved.
function rankingReportCard(rep) {
  if (!rep || !rep.rows.length) return null;
  const q = h('input', { class: 'input', type: 'search', placeholder: 'Find a keyword…', style: { maxWidth: '220px' } });
  const hasVol = rep.rows.some((r) => r.volume !== null && r.volume !== '');
  const hasStart = rep.startLabel && rep.rows.some((r) => r.start !== null && r.start !== '');
  const last = rep.months.length - 1;
  const onTarget = (c) => { const top = rangeTop(c.target); const r = rankValue(c.rank); return top !== null && r !== null && r <= top; };
  const hit = last >= 0 ? rep.rows.filter((r) => onTarget(r.months[last])).length : 0;
  const tbody = h('tbody');
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = rep.rows.filter((r) => !term || r.keyword.toLowerCase().includes(term));
    tbody.replaceChildren(...(rows.length ? rows.map((r) => h('tr', null,
      h('td', { class: 'primary' }, r.keyword),
      hasVol ? h('td', { class: 'num' }, r.volume === null || r.volume === '' ? '–' : typeof r.volume === 'number' ? formatNumber(r.volume) : String(r.volume)) : null,
      hasStart ? h('td', { class: 'nowrap' }, r.start === null || r.start === '' ? h('span', { class: 'muted' }, '–') : rankBadge(r.start)) : null,
      r.months.map((c) => h('td', { class: 'nowrap' },
        c.rank === null || c.rank === '' ? h('span', { class: 'muted' }, '–') : rankBadge(c.rank),
        onTarget(c) ? h('span', { class: 'on-target', title: `Within our projection of ${c.target}` }, '✓ on target') : null,
        c.target !== null && c.target !== '' ? h('div', { class: 'muted small' }, `target ${c.target}`) : null)),
      rep.next ? h('td', { class: 'nowrap' }, r.next === null || r.next === '' ? h('span', { class: 'muted' }, '–') : h('span', { class: `range${inTopRange(r.next) ? ' top' : ''}` }, String(r.next))) : null,
      (rep.ai || []).map((a, j) => h('td', { class: 'nowrap' }, aiBadge(r.ai[j])))))
      : [h('tr', null, h('td', { colspan: 99, class: 'muted' }, 'No keywords match.'))]));
  };
  q.addEventListener('input', draw);
  draw();
  return h('div', { class: 'card card-pad', style: { marginBottom: '16px' } },
    h('div', { class: 'between', style: { marginBottom: '4px' } },
      h('h3', { style: { margin: 0 } }, 'Keyword rankings, month by month'), q),
    h('div', { class: 'muted small', style: { marginBottom: '10px' } },
      last >= 0
        ? `From our month-end ranking reports (${rep.name}). In ${rep.months[last].label}, ${hit} of ${rep.rows.length} keywords ranked within or better than our projection (✓ on target).${rep.next ? ' “Projected” is our projection for the coming months.' : ''}${(rep.ai || []).length ? ' ✨ columns show where you are named in AI answers (#1 = named first).' : ''}`
        : `Your ${rep.rows.length} keywords and our projected rankings (${rep.name}). Actual rankings appear here after each month-end report.`),
    h('div', { class: 'table-wrap', style: { maxHeight: '460px' } }, h('table', { class: 'data' },
      h('thead', null, h('tr', null,
        h('th', null, 'Keyword'),
        hasVol ? h('th', null, 'Search vol.') : null,
        hasStart ? h('th', null, 'When we started') : null,
        rep.months.map((m) => h('th', null, `Actual · ${m.label}`)),
        rep.next ? h('th', { class: 'proj' }, `Projected · ${rep.next.label.replace(/^\s*phase\s*\d+\s*/i, '').replace(/[()]/g, '') || rep.next.label}`) : null,
        (rep.ai || []).map((a) => h('th', { class: 'ai-th' }, `✨ ${a.engine} · ${a.label}`)))),
      tbody)));
}

let perfData = null;
let perfLoading = null;
async function loadPerformance(force) {
  if (perfData && !force) return perfData;
  if (!perfLoading) perfLoading = api('GET', `/api/c/${encodeURIComponent(token)}/analytics`).then((d) => { perfData = d; perfLoading = null; return d; });
  return perfLoading;
}

async function renderPerformance(root) {
  root.replaceChildren(h('div', { class: 'spinner' }));
  let data;
  try { data = await loadPerformance(); } catch (err) { root.replaceChildren(h('div', { class: 'card empty' }, err.message)); return; }
  const gsc = data.series.gsc || {};
  const ga4 = data.series.ga4 || {};
  const manual = data.series.manual || {};
  const hasAny = Object.keys(data.series).length || data.timelines.seo.length;
  if (!hasAny) {
    root.replaceChildren(h('div', { class: 'card empty' },
      h('div', { class: 'big' }, '📈'), h('strong', null, 'Your performance dashboard is on its way'),
      h('div', { class: 'muted', style: { margin: '6px auto 0', maxWidth: '520px' } },
        `Once we connect Google Analytics and Search Console, you will see how your search traffic, enquiries and rankings grow month by month. ${S.agency} will let you know when it is ready.`)));
    return;
  }

  const sources = [data.sources.gsc && 'Google Search Console', data.sources.ga4 && 'Google Analytics 4', data.sources.manual && 'numbers you shared with us', data.timelines.seo.length && 'our monthly ranking reports'].filter(Boolean);
  let liveOn = false;
  try { liveOn = localStorage.getItem(`live:${token}`) === '1'; } catch { /* ignore */ }

  const head = h('div', { class: 'between', style: { marginBottom: '14px' } },
    h('div', null,
      h('h2', { style: { margin: 0, fontSize: '22px' } }, 'How your SEO & AEO is performing'),
      h('div', { class: 'muted small', style: { marginTop: '4px' } }, `From ${sources.join(', ').replace(/, ([^,]*)$/, ' and $1')}${data.lastSync ? ` · updated ${timeAgo(data.lastSync.replace('T', ' ').slice(0, 19))}` : ''}.`)),
    data.sources.semrush ? (() => {
      const box = h('input', { type: 'checkbox', checked: liveOn, id: 'live-toggle' });
      box.addEventListener('change', () => { try { localStorage.setItem(`live:${token}`, box.checked ? '1' : '0'); } catch { /* ignore */ } renderPerformance(root); });
      return h('label', { class: 'switch', title: 'Show daily positions from SEMrush next to our reports' }, box, h('span', { class: 'switch-ui', 'aria-hidden': 'true' }), 'Live rankings (SEMrush)');
    })() : null);

  const summary = perfSummary(data);
  const rankRow = [...rankTiles(rankWins(data)), ...aiTiles(aiWins(data.rankingReport))];
  const tiles = [
    stat('Clicks from Google', growth(gsc.clicks)),
    stat('Organic visits', growth(ga4.organic_sessions)),
    stat('Enquiries from organic', growth(ga4.organic_key_events)),
    stat('Visits from AI assistants', growth(ga4.ai_sessions)),
    ...Object.entries(manual).slice(0, 2).map(([name, map]) => stat(name, growth(map))),
  ].filter(Boolean);

  const charts = [];
  const monthly = (title, sub, map, unit) => {
    if (!map) return;
    const ms = monthsOf(map).slice(-13);
    charts.push(chartCard({
      title, sub, unit, labels: ms.map((m) => ymLabel(m)), longLabels: ms.map((m) => ymLabel(m, true)),
      partialLast: ms[ms.length - 1] === nowYM(),
      series: [{ name: title, color: VIZ.series, values: ms.map((m) => map[m] ?? 0) }],
    }));
  };
  monthly('Clicks from Google search', 'People who clicked your site in Google results, per month (Search Console)', gsc.clicks, 'clicks');
  monthly('Times you appeared in Google', 'Impressions in Google results, per month (Search Console)', gsc.impressions, 'impressions');
  monthly('Visits from organic search', 'Sessions from unpaid search, per month (Google Analytics)', ga4.organic_sessions, 'visits');
  monthly('Enquiries from organic search', 'Key events such as enquiries and bookings by organic visitors (Google Analytics)', ga4.organic_key_events, 'key events');
  monthly('Visits from AI assistants', 'Visitors referred by ChatGPT, Perplexity, Gemini, Copilot and others (Google Analytics)', ga4.ai_sessions, 'visits');
  for (const [name, map] of Object.entries(manual)) monthly(name, 'Per month, from the numbers you shared with us', map);

  const seo = data.timelines.seo;
  if (seo.length) {
    charts.push(chartCard({
      title: 'Keywords ranking in Google',
      sub: `How many of the ${seo[seo.length - 1].total} keywords we track rank in each band (our monthly ranking reports)`,
      labels: seo.map((p) => p.label.replace('Month ', 'M')),
      longLabels: seo.map((p) => p.label),
      legend: true,
      format: (v) => String(v ?? '–'),
      series: [
        { name: 'Top 3', color: VIZ.ordinal[0], values: seo.map((p) => p.top3) },
        { name: 'Positions 4–10', color: VIZ.ordinal[1], values: seo.map((p) => p.top10 - p.top3) },
        { name: 'Positions 11–30', color: VIZ.ordinal[2], values: seo.map((p) => p.top30 - p.top10) },
        { name: 'Positions 31–100', color: VIZ.ordinal[3], values: seo.map((p) => p.top100 - p.top30) },
      ],
    }));
  }

  // AEO: keywords where the client appears in AI answers, per engine.
  let aeo = null;
  if (data.timelines.aeo.length) {
    const byEngine = {};
    for (const p of data.timelines.aeo) (byEngine[p.engine] ||= []).push(p);
    aeo = h('div', { class: 'card card-pad' },
      h('h3', { style: { margin: '0 0 4px' } }, 'Appearing in AI answers'),
      h('div', { class: 'muted small', style: { marginBottom: '12px' } }, 'Keywords where AI assistants mention or cite you, from our monthly reports'),
      h('div', { class: 'aeo-grid' }, Object.entries(byEngine).map(([engine, pts]) => {
        const last = pts[pts.length - 1];
        const first = pts[0];
        return h('div', { class: 'aeo-tile' },
          h('div', { class: 'k' }, engine),
          h('div', { class: 'v' }, String(last.appear), h('small', null, `of ${last.total} keywords`)),
          h('div', { class: 'meter', role: 'img', 'aria-label': `${last.appear} of ${last.total}` }, h('div', { style: { width: `${last.total ? (last.appear / last.total) * 100 : 0}%` } })),
          pts.length > 1 ? h('div', { class: 'muted small' }, `${first.appear} in ${first.label} → ${last.appear} in ${last.label}`) : h('div', { class: 'muted small' }, last.label));
      })));
  }

  // Keyword table: Google's own position (Search Console) in the client's
  // country: the last 7 days, and the best single day in the last 28.
  let kwTable = null;
  const withData = data.keywords.filter((k) => k.gscPosition !== null || k.gscBest !== null || k.semrushPosition !== null || k.livePosition !== null);
  if (data.keywords.length && (data.sources.gsc || data.sources.semrush || data.sources.dataforseo)) {
    const showLive = data.sources.semrush && liveOn;
    const exact = data.sources.dataforseo;
    const checked = exact && data.liveFetchedAt.dataforseo ? new Date(`${data.liveFetchedAt.dataforseo.replace(' ', 'T')}Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    const pos = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
    const sortKey = (k) => Math.min(...[k.gscBest, k.gscPosition, k.livePosition, showLive ? k.semrushPosition : null].filter((v) => v !== null && v !== undefined), 1000);
    const rows = [...data.keywords].sort((x, y) => sortKey(x) - sortKey(y));
    const page1 = data.keywords.filter((k) => Math.min(k.gscBest ?? 999, k.livePosition ?? 999) <= 10).length;
    const place = COUNTRY_NAMES[data.country] ? ` in ${COUNTRY_NAMES[data.country]}` : '';
    const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
    kwTable = h('div', { class: 'card card-pad' },
      h('h3', { style: { margin: '0 0 4px' } }, 'Your keywords in Google today'),
      h('div', { class: 'muted small', style: { marginBottom: '10px' } },
        page1 ? h('strong', { style: { color: 'var(--ok-ink)' } }, `${page1} ${page1 === 1 ? 'keyword has' : 'keywords have'} reached page 1 of Google this month. `) : null,
        `Google’s own numbers from Search Console, for searches${place}. “This week” is the average position over the last 7 days; “Best day” is the highest daily position in the last 28 days${exact ? `; “Exact position” is a live Google check on ${checked}` : ''}${showLive ? '; SEMrush shows today’s position' : ''}. ${withData.length} of ${data.keywords.length} keywords have data.`),
      h('div', { class: 'table-wrap', style: { maxHeight: '420px' } }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Keyword'), h('th', null, 'Best day (28 days)'), h('th', null, 'This week (avg.)'), h('th', null, 'Clicks (7 days)'), exact ? h('th', null, `Exact position · ${checked}`) : null, showLive ? h('th', null, 'SEMrush today') : null)),
        h('tbody', null, rows.map((k) => h('tr', null,
          h('td', { class: 'primary' }, k.keyword),
          h('td', null, k.gscBest !== null ? [rankBadge(pos(k.gscBest)), k.gscBestDate ? h('span', { class: 'muted small', style: { marginLeft: '6px' } }, day(k.gscBestDate)) : null] : h('span', { class: 'muted' }, 'Not yet')),
          h('td', null, k.gscPosition !== null ? rankBadge(pos(k.gscPosition)) : h('span', { class: 'muted' }, '–')),
          h('td', { class: 'num' }, k.gscClicks !== null ? compact(k.gscClicks) : '–'),
          exact ? h('td', { class: 'nowrap' }, k.livePosition !== null ? [rankBadge(k.livePosition), k.liveUrl ? linkIcon(k.liveUrl) : null] : h('span', { class: 'muted small' }, 'Not in top 100')) : null,
          showLive ? h('td', null, k.semrushPosition !== null ? rankBadge(k.semrushPosition) : h('span', { class: 'muted' }, 'Not in top 100'),
            k.semrushUrl ? linkIcon(k.semrushUrl) : null) : null))))),
      showLive && data.liveFetchedAt.semrush ? h('div', { class: 'muted small', style: { marginTop: '8px' } }, `SEMrush positions fetched ${timeAgo(data.liveFetchedAt.semrush)}. Tools measure differently, so small differences from Search Console are normal.`) : null);
  }

  const reportTable = rankingReportCard(data.rankingReport);

  root.replaceChildren(head,
    data.sample ? h('div', { class: 'chip warn', style: { marginBottom: '12px' } }, 'Sample numbers for this preview. Your real Google data appears once it is connected.') : '',
    summary.length ? h('div', { class: 'card summary' }, h('div', { class: 'summary-label' }, 'Summary'), summary.map((p) => h('p', null, p))) : '',
    rankRow.length ? h('div', { class: 'stats perf-stats' }, rankRow) : '',
    reportTable || '',
    tiles.length ? h('div', { class: 'stats perf-stats' }, tiles) : '',
    charts.length ? h('div', { class: 'viz-grid' }, charts) : '',
    aeo || '',
    kwTable || '');
}
