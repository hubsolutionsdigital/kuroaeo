/* Client review portal: /p/:token — no login, the link is the key. */

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const NAME_KEY = `reviewer:${token}`;
const app = document.getElementById('app');

const S = {
  agency: '',
  project: null,
  datasets: [],
  feedback: [],
  progress: {},
  tab: 'keywords',
  sel: {}, // tab -> { name, id }
  cache: {}, // dataset id -> payload
  filter: { q: '', status: 'all' },
  docSection: {}, // dataset id -> 'overview' | item_key
};

function getName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function setName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
  renderReviewer();
}
function askName() {
  const n = (window.prompt('Your name (so the team knows who is reviewing):', getName()) || '').trim();
  if (n) setName(n.slice(0, 80));
  return n;
}

function renderReviewer() {
  const el = document.getElementById('reviewer');
  const n = getName();
  el.replaceChildren(n
    ? h('span', null, 'Reviewing as ', h('strong', null, n), ' · ', h('button', { onclick: askName }, 'change'))
    : h('button', { onclick: askName }, 'Set your name'));
}

function fbByKey() {
  const m = new Map();
  for (const f of S.feedback) {
    if (!m.has(f.item_key)) m.set(f.item_key, []);
    m.get(f.item_key).push(f);
  }
  return m;
}

async function refreshFeedback() {
  const d = await api('GET', `/api/c/${encodeURIComponent(token)}/feedback`);
  S.feedback = d.feedback;
  S.progress = d.progress;
  renderTabs();
  await renderTabBody(true);
}

async function sendFeedback(item, datasetId, { type, name, comment }, quote) {
  await api('POST', `/api/c/${encodeURIComponent(token)}/feedback`, {
    item_key: item.item_key, dataset_id: datasetId, type, name, comment, quote: quote || '',
  });
  setName(name);
  toast(type === 'approve' ? `Approved — thank you, ${name}!` : `Thanks, ${name}! Your feedback was sent to the team.`);
  await refreshFeedback();
}

function feedbackPopover(anchor, item, datasetId, { title, quote, preselect } = {}) {
  const noun = TAB_META[S.tab].noun;
  openFeedbackPopover({
    anchor,
    title: title || `What do you think of this ${noun}?`,
    context: item.label,
    quote,
    preselect,
    getName,
    onSubmit: (v) => sendFeedback(item, datasetId, v, quote),
  });
}

async function sendReply(root, text) {
  const name = getName() || askName();
  if (!name) throw new Error('Please add your name first.');
  await api('POST', `/api/c/${encodeURIComponent(token)}/feedback`, { type: 'reply', parent_id: root.id, name, comment: text });
  toast('Reply sent.');
  await refreshFeedback();
}

function openItemDrawer(item, datasetId) {
  const list = fbByKey().get(item.item_key) || [];
  const threads = threadsOf(list).reverse();
  const addBtn = h('button', { class: 'btn primary', style: { width: '100%' } }, '+ Add feedback');
  addBtn.addEventListener('click', () => { closeDrawer(); feedbackPopover(null, item, datasetId); });
  openDrawer(item.label, `${TAB_META[S.tab].label} · ${threads.length} ${threads.length === 1 ? 'comment' : 'comments'}`,
    threads.length
      ? threads.map((t) => renderThread(t, { onReply: async (root, text) => { await sendReply(root, text); openItemDrawer(item, datasetId); } }))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '💬'), 'No feedback yet. Be the first!'),
    addBtn);
}

function openActivity() {
  const threads = threadsOf(S.feedback).reverse();
  openDrawer('All feedback', `${threads.length} ${threads.length === 1 ? 'item' : 'items'} · newest first`,
    threads.length
      ? threads.map((t) => renderThread(t, { showItem: true, onReply: async (root, text) => { await sendReply(root, text); openActivity(); } }))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '🗂️'), 'No feedback yet.'));
}

/* ---------- page skeleton ---------- */

function render() {
  document.title = `${S.project.name} · SEO & AEO Review`;
  document.getElementById('agency').textContent = `${S.agency} · SEO & AEO Review`;
  renderReviewer();

  const p = S.project;
  let site = null;
  if (p.website) {
    const href = /^https?:\/\//i.test(p.website) ? p.website : `https://${p.website}`;
    site = h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, p.website.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  }

  let intro = null;
  let dismissed = false;
  try { dismissed = localStorage.getItem(`intro:${token}`) === '1'; } catch { /* ignore */ }
  if (!dismissed) {
    intro = h('div', { class: 'card card-pad', style: { marginBottom: '18px', display: 'flex', gap: '14px', alignItems: 'flex-start' } },
      h('div', { style: { fontSize: '26px' } }, '👋'),
      h('div', { style: { flex: 1 } },
        h('strong', null, 'Welcome! Here is how to review'),
        h('div', { class: 'muted', style: { marginTop: '4px' } },
          'Open each tab to see what we have prepared. Press ', h('strong', null, 'Review'), ' on any row to tell us you love it, approve it, suggest a change or ask a question. ',
          'In blog articles, highlight any sentence to comment on it. No account needed — just add your name.')),
      h('button', {
        class: 'btn ghost sm',
        onclick: (e) => { try { localStorage.setItem(`intro:${token}`, '1'); } catch { /* ignore */ } e.currentTarget.parentElement.remove(); },
      }, 'Got it'));
  }

  app.replaceChildren(
    h('div', { class: 'hero' },
      h('div', null,
        h('h1', null, p.name),
        h('div', { class: 'sub' },
          p.client_name ? h('span', null, p.client_name) : null,
          site,
          h('span', { class: 'muted' }, `Prepared by ${S.agency}`))),
      h('div', { class: 'row-flex' },
        h('button', { class: 'btn', onclick: openActivity }, '🗂️ All feedback'))),
    intro,
    h('nav', { class: 'tabs', id: 'tabs', role: 'tablist' }),
    h('section', { id: 'tabbody' }));
  renderTabs();
  renderTabBody();
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...TAB_ORDER.map((t) => {
    const pr = S.progress[t] || { items: 0, reviewed: 0 };
    return h('button', {
      class: `tab${S.tab === t ? ' active' : ''}`, role: 'tab', 'aria-selected': String(S.tab === t),
      onclick: () => { S.tab = t; S.filter = { q: '', status: 'all' }; history.replaceState(null, '', `#${t}`); renderTabs(); renderTabBody(); },
    }, `${TAB_META[t].icon} ${TAB_META[t].label}`, pr.items ? h('span', { class: 'count', title: `${pr.reviewed} of ${pr.items} reviewed` }, `${pr.reviewed}/${pr.items}`) : null);
  }));
}

function groupsFor(tab) {
  const list = S.datasets.filter((x) => x.tab === tab);
  // Sheets appear in the order they were first uploaded; versions newest first.
  const firstId = {};
  for (const d of list) firstId[d.name] = Math.min(firstId[d.name] ?? Infinity, d.id);
  list.sort((a, b) => firstId[a.name] - firstId[b.name] || b.id - a.id);
  const groups = new Map();
  for (const d of list) {
    if (!groups.has(d.name)) groups.set(d.name, []);
    groups.get(d.name).push(d);
  }
  return groups;
}

async function renderTabBody(keepScroll) {
  const body = document.getElementById('tabbody');
  const scroll = keepScroll ? { y: window.scrollY, ...tableScroll() } : null;
  const groups = groupsFor(S.tab);
  if (!groups.size) {
    body.replaceChildren(h('div', { class: 'card empty' },
      h('div', { class: 'big' }, TAB_META[S.tab].icon),
      h('strong', null, 'Nothing to review here yet'),
      h('div', { class: 'muted', style: { marginTop: '4px' } }, TAB_META[S.tab].empty)));
    return;
  }

  let sel = S.sel[S.tab];
  if (!sel || !groups.has(sel.name)) {
    const [name, versions] = groups.entries().next().value;
    sel = S.sel[S.tab] = { name, id: versions[0].id };
  }
  const versions = groups.get(sel.name);
  if (!versions.some((v) => v.id === sel.id)) sel.id = versions[0].id;

  const head = h('div', { class: 'toolbar' },
    h('div', { class: 'left' },
      groups.size > 1
        ? h('div', { class: 'seg' }, [...groups.keys()].map((name) => h('button', {
          class: name === sel.name ? 'active' : '',
          onclick: () => { S.sel[S.tab] = { name, id: groups.get(name)[0].id }; renderTabBody(); },
        }, name)))
        : h('strong', { style: { fontSize: '17px' } }, sel.name)),
    h('div', { class: 'right' },
      versions.length > 1
        ? h('label', { class: 'row-flex small muted' }, 'Version',
          (() => {
            const s = h('select', { class: 'select', style: { width: 'auto' } }, versions.map((v) => h('option', { value: v.id, selected: v.id === sel.id }, `${v.period || 'Undated'} · uploaded ${parseUTC(v.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${v === versions[0] ? ' (latest)' : ''}`)));
            s.addEventListener('change', () => { sel.id = Number(s.value); renderTabBody(); });
            return s;
          })())
        : (versions[0].period ? h('span', { class: 'chip' }, `📅 ${versions[0].period}`) : null)));

  let payload = S.cache[sel.id];
  if (!payload) {
    body.replaceChildren(head, h('div', { class: 'spinner' }));
    try {
      payload = S.cache[sel.id] = await api('GET', `/api/c/${encodeURIComponent(token)}/datasets/${sel.id}`);
    } catch (err) {
      body.replaceChildren(head, h('div', { class: 'card empty' }, err.message));
      return;
    }
  }
  const content = payload.dataset.kind === 'doc' ? renderDoc(payload) : renderTable(payload);
  body.replaceChildren(head, content);
  if (scroll) {
    window.scrollTo(0, scroll.y);
    const wrap = document.querySelector('.table-wrap');
    if (wrap) { wrap.scrollTop = scroll.top; wrap.scrollLeft = scroll.left; }
  }
}

function tableScroll() {
  const wrap = document.querySelector('.table-wrap');
  return wrap ? { top: wrap.scrollTop, left: wrap.scrollLeft } : { top: 0, left: 0 };
}

/* ---------- approve all ---------- */

function openApproveAll(anchor, payload, count) {
  closePopover();
  const name = h('input', { class: 'input', placeholder: 'Your name', value: getName(), maxlength: 80 });
  const comment = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Any notes with your approval? (optional)', maxlength: 5000 });
  const go = h('button', { class: 'btn primary', type: 'submit' }, `Approve ${count}`);
  const sync = () => { go.disabled = !name.value.trim(); };
  name.addEventListener('input', sync);
  const form = h('form', { class: 'popover' },
    h('h3', null, `Approve everything in “${payload.dataset.name}”?`),
    h('div', { class: 'ctx' }, `${count} ${count === 1 ? 'item' : 'items'} not yet approved will be marked as approved by you. You can still comment on any item afterwards.`),
    h('div', { class: 'pop-fields' }, name, comment),
    h('div', { class: 'pop-actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: closePopover }, 'Cancel'), go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      const r = await api('POST', `/api/c/${encodeURIComponent(token)}/datasets/${payload.dataset.id}/approve-all`, { name: name.value.trim(), comment: comment.value.trim() });
      setName(name.value.trim());
      closePopover();
      toast(`Approved ${r.approved} ${r.approved === 1 ? 'item' : 'items'}. Thank you!`);
      await refreshFeedback();
    } catch (err) { toast(err.message, true); sync(); }
  });
  const wrap = h('div', null, h('div', { class: 'pop-backdrop', onclick: closePopover }), form);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  document.body.append(wrap);
  activePopover = wrap;
  sync();
  if (window.innerWidth > 640) {
    const r = anchor.getBoundingClientRect();
    form.style.left = `${Math.max(12, Math.min(r.right - form.offsetWidth, window.innerWidth - form.offsetWidth - 12))}px`;
    form.style.top = `${Math.min(r.bottom + 8, window.innerHeight - form.offsetHeight - 12)}px`;
  }
  name.value ? comment.focus() : name.focus();
}

/* ---------- tables (keywords, on-page, backlinks, prompts, content plans) ---------- */

function analyseColumns(payload) {
  const { dataset, items } = payload;
  const cols = dataset.columns;
  const hasData = (c) => items.some((it) => it.data[c] !== null && it.data[c] !== undefined && it.data[c] !== '');
  const numIdx = cols.findIndex((c) => COLS.numbering.test(c));
  const actual = cols.map((c, i) => (COLS.actualRank.test(c) ? i : -1)).filter((i) => i >= 0);
  const projected = cols.map((c, i) => (!actual.includes(i) && COLS.projected.test(c) ? i : -1)).filter((i) => i >= 0);
  const volume = cols.findIndex((c) => COLS.volume.test(c) && !/band/i.test(c));
  const withData = actual.filter(hasData);
  const latest = withData.length ? withData[withData.length - 1] : -1;
  // Only compare a ranking with an earlier one from the same series, so
  // "Google Ranking" is never compared with "ChatGPT Ranking".
  const series = (c) => rankSeries(cols[c]);
  const sameSeries = withData.filter((c) => c !== latest && c < latest && series(c) === series(latest));
  const prevCol = latest >= 0 && sameSeries.length ? sameSeries[sameSeries.length - 1] : -1;
  const visible = cols.map((_, i) => i).filter((i) => i === dataset.primary || i === numIdx || actual.includes(i) || projected.includes(i) || hasData(i));
  const userHidden = hiddenCols(dataset);
  const shownCols = visible.filter((c) => c === dataset.primary || c === numIdx || !userHidden.has(cols[c]));
  return { cols, numIdx, actual, projected, volume, latest, prevCol, visible: shownCols, allVisible: visible, hidden: cols.length - visible.length };
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
function rankSeries(header) {
  return header.toLowerCase()
    .replace(/\(?\s*month\s*\d+(\s*-\s*\d+)?\s*\)?/g, '')
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/g, '')
    .replace(new RegExp(`\\b(${MONTHS})[a-z]*\\.?(\\s+\\d{2,4})?\\b`, 'g'), '')
    .replace(/\b(actual|current|existing|latest)\b/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

function movementFor(item, A, payload) {
  if (A.latest < 0) return null;
  const cur = rankValue(item.data[A.latest]);
  let prev = null;
  if (A.prevCol >= 0) prev = rankValue(item.data[A.prevCol]);
  else if (payload.previous) {
    const pi = payload.previous.columns.indexOf(A.cols[A.latest]);
    const row = payload.previous.rows[item.item_key];
    if (pi >= 0 && row) prev = rankValue(row[pi]);
  }
  if (cur === null || prev === null || (cur > 100 && prev > 100)) return null;
  return Math.min(prev, 101) - Math.min(cur, 101);
}

function renderStats(payload, A, fb) {
  const { items } = payload;
  const cards = [];
  if (A.latest >= 0) {
    const ranks = items.map((it) => rankValue(it.data[A.latest]));
    const top = (n) => ranks.filter((r) => r !== null && r <= n).length;
    const improved = items.filter((it) => (movementFor(it, A, payload) || 0) > 0).length;
    cards.push(
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Top 3'), h('div', { class: 'v' }, top(3), h('small', null, `of ${items.length}`))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Page 1 (top 10)'), h('div', { class: 'v' }, top(10))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Top 30'), h('div', { class: 'v' }, top(30))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Top 100'), h('div', { class: 'v' }, top(100))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Moved up'), h('div', { class: 'v', style: { color: '#1f7a55' } }, improved ? `▲ ${improved}` : '0')),
    );
  }
  if (A.volume >= 0) {
    const total = items.reduce((s, it) => s + (typeof it.data[A.volume] === 'number' ? it.data[A.volume] : 0), 0);
    if (total) cards.push(h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Monthly searches'), h('div', { class: 'v' }, total.toLocaleString())));
  }
  const statuses = items.map((it) => itemStatus(fb.get(it.item_key)));
  const reviewed = statuses.filter((s) => s.count > 0).length;
  const approved = statuses.filter((s) => s.key === 'approved').length;
  const pct = items.length ? Math.round((reviewed / items.length) * 100) : 0;
  cards.push(h('div', { class: 'stat', style: { gridColumn: 'span 2' } },
    h('div', { class: 'k' }, 'Your review'),
    h('div', { class: 'v' }, `${reviewed}`, h('small', null, `of ${items.length} reviewed · ${approved} approved`)),
    h('div', { class: 'progress', style: { marginTop: '8px' } }, h('div', { style: { width: `${pct}%` } }))));
  const note = A.latest >= 0 ? h('div', { class: 'muted small', style: { margin: '-6px 0 14px' } },
    `Rankings from “${A.cols[A.latest]}”`, A.prevCol >= 0 ? `, compared with “${A.cols[A.prevCol]}”` : payload.previous ? `, compared with ${payload.previous.period || 'the previous report'}` : '', '.') : null;
  return [h('div', { class: 'stats' }, cards), note];
}

function renderCell(v, c, A, item, payload) {
  const td = h('td');
  if (c === A.numIdx) { td.className = 'idx'; td.textContent = v ?? payload.items.indexOf(item) + 1; return td; }
  if (c === payload.dataset.primary) {
    td.className = 'primary';
    if (isUrlish(v)) { td.classList.add('nowrap'); td.append(linkFor(v)); } else td.textContent = v ?? '';
    return td;
  }
  if (A.actual.includes(c)) {
    td.className = 'nowrap';
    td.append(v === null || v === undefined ? h('span', { class: 'muted' }, '–') : rankBadge(v));
    if (c === A.latest) {
      const mv = movementFor(item, A, payload);
      if (mv) td.append(h('span', { class: `move ${mv > 0 ? 'up' : 'down'}`, title: mv > 0 ? `Up ${mv} positions` : `Down ${-mv} positions` }, `${mv > 0 ? '▲' : '▼'}${Math.abs(mv)}`));
    }
    return td;
  }
  if (A.projected.includes(c)) {
    if (v === null || v === undefined) { td.append(h('span', { class: 'muted' }, '–')); return td; }
    const top = inTopRange(v);
    td.className = 'nowrap';
    td.append(h('span', { class: `range${top ? ' top' : ''}`, title: top ? 'Projected to rank within the top 12' : 'Projected range' }, String(v)));
    return td;
  }
  if (v === null || v === undefined) return td;
  if (typeof v === 'number') { td.className = 'num'; td.textContent = formatNumber(v); return td; }
  const s = String(v);
  if (isUrlish(s)) { td.className = 'linkcell'; td.append(linkIcon(s)); return td; }
  if (s.length > 40) {
    const d = h('div', { class: 'clamp', title: 'Click to expand' }, s);
    d.addEventListener('click', () => d.classList.toggle('open'));
    td.append(d);
    return td;
  }
  if (s.length <= 24) td.className = 'nowrap';
  td.textContent = s;
  return td;
}

// "5-12", "4 - 10", "8-3" or a single position: in the top 12 when every end is 12 or better.
function inTopRange(v) {
  const nums = String(v).match(/\d+/g);
  if (!nums || nums.length > 2 || /^\s*>/.test(String(v))) return false;
  return nums.every((n) => Number(n) >= 1 && Number(n) <= 12);
}

const LINK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

function linkIcon(s) {
  const href = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const short = s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '') || s;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'link-icon', title: short, 'aria-label': `Open ${short}`, html: LINK_SVG });
}

function linkFor(s) {
  const href = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'cell-link' }, s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '') || s);
}

// Columns each viewer has hidden, remembered per sheet in this browser.
function hiddenCols(dataset) {
  try { return new Set(JSON.parse(localStorage.getItem(`cols:${token}:${dataset.tab}:${dataset.name}`) || '[]')); } catch { return new Set(); }
}
function saveHiddenCols(dataset, set) {
  try { localStorage.setItem(`cols:${token}:${dataset.tab}:${dataset.name}`, JSON.stringify([...set])); } catch { /* private mode */ }
}

function columnsButton(payload, A) {
  const { dataset } = payload;
  const hidden = hiddenCols(dataset);
  const all = A.allVisible.filter((c) => c !== dataset.primary && c !== A.numIdx);
  const btn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'true' }, hidden.size ? `Columns (${hidden.size} hidden)` : 'Columns');
  btn.addEventListener('click', () => {
    closePopover();
    const boxes = all.map((c) => {
      const box = h('input', { type: 'checkbox', checked: !hidden.has(A.cols[c]) });
      box.addEventListener('change', () => {
        if (box.checked) hidden.delete(A.cols[c]); else hidden.add(A.cols[c]);
        saveHiddenCols(dataset, hidden);
        renderTabBody(true);
      });
      return h('label', { class: 'col-opt' }, box, A.cols[c]);
    });
    const form = h('div', { class: 'popover col-pop', role: 'dialog', 'aria-label': 'Choose columns' },
      h('h3', null, 'Columns'),
      h('div', { class: 'ctx' }, 'Hide columns you don’t need. This is remembered on this device.'),
      h('div', { class: 'col-list' }, boxes),
      h('div', { class: 'pop-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => { hidden.clear(); saveHiddenCols(dataset, hidden); closePopover(); renderTabBody(true); } }, 'Show all'),
        h('button', { type: 'button', class: 'btn primary', onclick: closePopover }, 'Done')));
    const wrapEl = h('div', null, h('div', { class: 'pop-backdrop', onclick: closePopover }), form);
    wrapEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
    document.body.append(wrapEl);
    activePopover = wrapEl;
    if (window.innerWidth > 640) {
      const r = btn.getBoundingClientRect();
      form.style.left = `${Math.max(12, Math.min(r.right - form.offsetWidth, window.innerWidth - form.offsetWidth - 12))}px`;
      form.style.top = `${Math.min(r.bottom + 8, window.innerHeight - form.offsetHeight - 12)}px`;
    }
  });
  return btn;
}

function renderTable(payload) {
  const { dataset, items } = payload;
  const A = analyseColumns(payload);
  const fb = fbByKey();
  const wrap = h('div');

  if (dataset.meta && dataset.meta.title) wrap.append(h('div', { class: 'muted', style: { margin: '-4px 0 12px', fontWeight: 600 } }, dataset.meta.title));
  wrap.append(...renderStats(payload, A, fb).filter(Boolean));

  const pendingApproval = items.filter((it) => itemStatus(fb.get(it.item_key)).key !== 'approved').length;
  const search = h('input', { class: 'input', type: 'search', placeholder: `Search ${TAB_META[S.tab].noun}s…`, value: S.filter.q });
  const statusOpts = [['all', 'All'], ['pending', 'Awaiting review'], ['approved', 'Approved'], ['changes', 'Changes requested'], ['question', 'Questions']];
  const seg = h('div', { class: 'seg' }, statusOpts.map(([k, label]) => h('button', {
    class: S.filter.status === k ? 'active' : '',
    onclick: () => { S.filter.status = k; renderTabBody(); },
  }, label)));
  const approveAllBtn = h('button', { class: 'btn brand', disabled: !pendingApproval }, pendingApproval ? `✓ Approve all (${pendingApproval})` : '✓ All approved');
  approveAllBtn.addEventListener('click', () => openApproveAll(approveAllBtn, payload, pendingApproval));

  wrap.append(h('div', { class: 'toolbar' },
    h('div', { class: 'left' },
      h('div', { class: 'search' },
        h('span', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }).firstChild,
        search),
      seg),
    h('div', { class: 'right' }, columnsButton(payload, A), approveAllBtn)));

  const stickyPrimary = A.numIdx === 0 && dataset.primary === 1 ? 1 : dataset.primary === 0 ? 0 : -1;
  const thead = h('thead', null, h('tr', null,
    A.visible.map((c) => h('th', {
      class: [A.projected.includes(c) ? 'proj' : '', c === 0 && stickyPrimary >= 0 ? 'sticky-l' : '', c === stickyPrimary && c !== 0 ? 'sticky-l' : ''].join(' ').trim() || null,
      style: c === stickyPrimary && c !== 0 ? { left: '48px' } : c === 0 && stickyPrimary >= 0 ? { minWidth: stickyPrimary === 1 ? '48px' : null, width: stickyPrimary === 1 ? '48px' : null } : null,
      title: A.projected.includes(c) ? 'Projected ranking range' : null,
    }, A.cols[c])),
    h('th', { class: 'sticky-r' }, 'Your feedback')));

  const tbody = h('tbody');
  const q = S.filter.q.toLowerCase();
  let shown = 0;
  for (const item of items) {
    const st = itemStatus(fb.get(item.item_key));
    if (S.filter.status !== 'all') {
      if (S.filter.status === 'pending' ? st.count > 0 : st.key !== S.filter.status) continue;
    }
    if (q && !item.data.some((v) => v !== null && String(v).toLowerCase().includes(q))) continue;
    shown++;
    const tr = h('tr');
    for (const c of A.visible) {
      const td = renderCell(item.data[c], c, A, item, payload);
      if (c === 0 && stickyPrimary >= 0) td.classList.add('sticky-l');
      if (c === stickyPrimary && c !== 0) { td.classList.add('sticky-l'); td.style.left = '48px'; }
      tr.append(td);
    }
    const reviewBtn = h('button', { class: 'btn sm review-btn' }, '★ Review');
    reviewBtn.addEventListener('click', () => feedbackPopover(reviewBtn, item, dataset.id));
    tr.append(h('td', { class: 'fbcell sticky-r' },
      h('div', { class: 'fb-actions' },
        reviewBtn,
        statusChip(st),
        reactionsRow(st),
        st.count || st.comments ? h('button', { class: 'btn ghost sm', title: 'Open comments', onclick: () => openItemDrawer(item, dataset.id) }, `💬 ${(fb.get(item.item_key) || []).length}`) : null)));
    tbody.append(tr);
  }

  const table = h('div', { class: 'card table-wrap' }, h('table', { class: 'data' }, thead, tbody));
  wrap.append(table);
  if (!shown) table.append(h('div', { class: 'empty' }, 'Nothing matches this filter.'));
  if (A.hidden) wrap.append(h('div', { class: 'muted small', style: { marginTop: '8px' } }, `${A.hidden} empty ${A.hidden === 1 ? 'column is' : 'columns are'} hidden.`));

  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      S.filter.q = search.value;
      const pos = search.selectionStart;
      renderTabBody(true).then(() => {
        const s = document.querySelector('.search input');
        if (s) { s.focus(); s.setSelectionRange(pos, pos); }
      });
    }, 200);
  });
  return wrap;
}

/* ---------- blog documents ---------- */

function highlightQuote(root, quote, id) {
  const q = quote.replace(/\s+/g, '');
  if (!q) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  let compact = '';
  const map = [];
  for (const node of nodes) {
    const t = node.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (!/\s/.test(t[i])) { compact += t[i]; map.push([node, i]); }
    }
  }
  const idx = compact.indexOf(q);
  if (idx < 0) return [];
  const [startNode, startOff] = map[idx];
  const [endNode, endOff] = map[idx + q.length - 1];
  const segs = [];
  let inRange = false;
  for (const node of nodes) {
    if (node === startNode) inRange = true;
    if (!inRange) continue;
    const s = node === startNode ? startOff : 0;
    const e = node === endNode ? endOff + 1 : node.nodeValue.length;
    segs.push([node, s, e]);
    if (node === endNode) break;
  }
  const marks = [];
  for (const [node, s, e] of segs) {
    if (e <= s || !node.nodeValue.slice(s, e).trim()) continue;
    const r = document.createRange();
    r.setStart(node, s);
    r.setEnd(node, e);
    const m = h('mark', { class: 'hl', 'data-fid': id });
    r.surroundContents(m);
    marks.push(m);
  }
  return marks;
}

let selBtn = null;
function hideSelBtn() { if (selBtn) { selBtn.remove(); selBtn = null; } }

function setupSelection(container, item, datasetId) {
  const check = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideSelBtn(); return; }
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (quote.length < 2) { hideSelBtn(); return; }
    const rect = range.getBoundingClientRect();
    hideSelBtn();
    selBtn = h('button', { class: 'sel-btn', type: 'button' }, '💬 Comment');
    selBtn.style.left = `${Math.max(8, rect.left + window.scrollX + rect.width / 2 - 55)}px`;
    selBtn.style.top = `${rect.top + window.scrollY - 46}px`;
    selBtn.addEventListener('mousedown', (e) => e.preventDefault());
    const saved = range.cloneRange();
    selBtn.addEventListener('click', () => {
      hideSelBtn();
      feedbackPopover(saved.getBoundingClientRect(), item, datasetId, { title: 'What do you think of this part?', quote });
      window.getSelection().removeAllRanges();
    });
    document.body.append(selBtn);
  };
  container.addEventListener('mouseup', () => setTimeout(check, 0));
  container.addEventListener('keyup', () => setTimeout(check, 0));
  container.addEventListener('touchend', () => setTimeout(check, 300));
  activeSelCheck = check;
}

// iPhone and iPad Safari change the selection with drag handles, which fire no
// mouse or touch events on the article, so also watch the selection itself.
let activeSelCheck = null;
let selTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => { if (activeSelCheck) activeSelCheck(); }, 350);
});
document.addEventListener('mousedown', (e) => { if (selBtn && !selBtn.contains(e.target)) hideSelBtn(); });
window.addEventListener('scroll', hideSelBtn, { passive: true });

function renderDoc(payload) {
  const { dataset, items } = payload;
  const fb = fbByKey();
  const checks = items.filter((i) => i.kind === 'check');
  const articles = items.filter((i) => i.kind === 'article');
  const hasOverview = Boolean((dataset.meta && dataset.meta.introHtml) || checks.length);
  let section = S.docSection[dataset.id];
  if (!section || (section !== 'overview' && !articles.some((a) => a.item_key === section))) {
    section = hasOverview ? 'overview' : (articles[0] && articles[0].item_key);
  }
  S.docSection[dataset.id] = section;
  const go = (s) => { S.docSection[dataset.id] = s; renderTabBody(); window.scrollTo({ top: document.getElementById('tabs').offsetTop - 8 }); };

  const checksDone = checks.filter((c) => itemStatus(fb.get(c.item_key)).key === 'approved').length;
  const nav = h('nav', { class: 'doc-nav' },
    hasOverview ? h('button', { class: section === 'overview' ? 'active' : '', onclick: () => go('overview') },
      h('span', { class: 't' }, '📋 Overview'),
      checks.length ? h('span', { class: 'muted small' }, `${checksDone} of ${checks.length} points confirmed`) : null) : null,
    articles.map((a) => {
      const st = itemStatus(fb.get(a.item_key));
      return h('button', { class: section === a.item_key ? 'active' : '', onclick: () => go(a.item_key) },
        h('span', { class: 't' }, a.data.number ? `${a.data.number}. ${a.data.title}` : a.data.title),
        h('span', null, statusChip(st)));
    }));

  const main = h('article', { class: 'card doc-main' });
  const side = h('aside', { class: 'doc-side' });

  if (section === 'overview') {
    const prose = h('div', { class: 'prose', html: dataset.meta.introHtml || '' });
    const list = h('div', { class: 'checklist' }, checks.map((c) => {
      const st = itemStatus(fb.get(c.item_key));
      const confirm = h('button', { class: 'btn sm' }, '✓ Confirm');
      confirm.addEventListener('click', () => feedbackPopover(confirm, c, dataset.id, { title: 'Confirm this point?', preselect: 'approve' }));
      const comment = h('button', { class: 'btn ghost sm' }, '★ Review');
      comment.addEventListener('click', () => feedbackPopover(comment, c, dataset.id, { title: 'What do you think of this point?' }));
      const n = (fb.get(c.item_key) || []).length;
      return h('div', { class: `check-item${st.key === 'approved' ? ' done' : ''}` },
        h('span', { class: 'box' }, st.key === 'approved' ? '✓' : ''),
        h('div', null, c.data.text,
          h('div', { class: 'row2' }, statusChip(st), reactionsRow(st), st.key !== 'approved' ? confirm : null, comment,
            n ? h('button', { class: 'btn ghost sm', onclick: () => openItemDrawer(c, dataset.id) }, `💬 ${n}`) : null)));
    }));
    const slot = prose.querySelector('[data-checklist]');
    if (slot) slot.replaceWith(list);
    else if (checks.length) prose.append(h('h2', null, 'For your review'), list);
    main.append(prose);
    if (articles.length) {
      main.append(h('div', { class: 'row-flex', style: { marginTop: '24px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn primary', onclick: () => go(articles[0].item_key) }, `Start reading: ${articles[0].data.title} →`)));
    }
    side.append(h('h4', null, 'Overview comments'));
    const threads = checks.flatMap((c) => threadsOf(fb.get(c.item_key) || []));
    side.append(...(threads.length ? threads.reverse().map((t) => renderThread(t, { showItem: true, onReply: sendReply })) : [h('div', { class: 'muted small' }, 'No comments yet.')]));
  } else {
    const a = articles.find((x) => x.item_key === section);
    const st = itemStatus(fb.get(a.item_key));
    const approveBtn = h('button', { class: 'btn brand' }, st.key === 'approved' ? '✓ Approved' : '✓ Approve article');
    approveBtn.addEventListener('click', () => feedbackPopover(approveBtn, a, dataset.id, { title: 'Approve this article?', preselect: 'approve' }));
    const fbBtn = h('button', { class: 'btn' }, '★ Overall feedback');
    fbBtn.addEventListener('click', () => feedbackPopover(fbBtn, a, dataset.id, { title: 'What do you think of this article?' }));
    const bar = () => h('div', { class: 'approve-bar' },
      h('div', { class: 'row-flex' }, statusChip(st), reactionsRow(st),
        st.lastApproval ? h('span', { class: 'muted small' }, `by ${st.lastApproval.name}, ${timeAgo(st.lastApproval.created_at)}`) : null),
      h('div', { class: 'row-flex' }, fbBtn, approveBtn));

    const selectable = h('div', { 'data-item-key': a.item_key });
    if (a.data.seo && a.data.seo.length) {
      selectable.append(h('div', { class: 'seo-card' },
        h('div', { class: 'seo-head', style: { paddingTop: '12px' } }, h('h4', null, 'SEO details')),
        a.data.seo.map(([k, v]) => h('div', { class: 'row' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)))));
    }
    const prose = h('div', { class: 'prose', html: a.data.html });
    selectable.append(prose);

    main.append(bar(),
      h('div', { class: 'select-hint', style: { marginBottom: '16px' } }, '💡 Tip: highlight any text in the article to comment on that part.'),
      selectable);

    const idx = articles.indexOf(a);
    main.append(h('div', { class: 'between', style: { marginTop: '28px', paddingTop: '18px', borderTop: '1px solid var(--line)' } },
      idx > 0 ? h('button', { class: 'btn', onclick: () => go(articles[idx - 1].item_key) }, '← Previous') : (hasOverview ? h('button', { class: 'btn', onclick: () => go('overview') }, '← Overview') : h('span')),
      h('div', { class: 'row-flex' },
        (() => { const b = h('button', { class: 'btn brand' }, st.key === 'approved' ? '✓ Approved' : '✓ Approve article'); b.addEventListener('click', () => feedbackPopover(b, a, dataset.id, { title: 'Approve this article?', preselect: 'approve' })); return b; })(),
        idx < articles.length - 1 ? h('button', { class: 'btn primary', onclick: () => go(articles[idx + 1].item_key) }, 'Next article →') : null)));

    const threads = threadsOf(fb.get(a.item_key) || []);
    side.append(h('h4', null, `Comments on this article (${threads.length})`));
    const cards = new Map();
    if (!threads.length) side.append(h('div', { class: 'muted small' }, 'No comments yet. Highlight any text to leave one.'));
    // Order comments by where their highlighted text sits in the article.
    setTimeout(() => {
      const order = [];
      for (const t of threads) {
        const marks = t.root.quote ? highlightQuote(selectable, t.root.quote, t.root.id) : [];
        for (const m of marks) m.addEventListener('click', () => focusThread(t.root.id));
        order.push({ t, pos: marks[0] ? marks[0].getBoundingClientRect().top + window.scrollY : (t.root.quote ? 1e9 : -1) });
      }
      order.sort((x, y) => x.pos - y.pos);
      for (const { t } of order) {
        const card = renderThread(t, { onReply: sendReply, onQuoteClick: (root) => scrollToMark(root.id) });
        card.dataset.fid = t.root.id;
        cards.set(t.root.id, card);
        side.append(card);
      }
    });
    setupSelection(selectable, a, dataset.id);
  }

  return h('div', { class: 'doc-layout' }, nav, main, side);
}

function scrollToMark(id) {
  const marks = document.querySelectorAll(`mark.hl[data-fid="${id}"]`);
  if (!marks.length) { toast('That text has changed since the comment was made.'); return; }
  document.querySelectorAll('mark.hl.active').forEach((m) => m.classList.remove('active'));
  marks.forEach((m) => m.classList.add('active'));
  marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function focusThread(id) {
  scrollToMark(id);
  const card = document.querySelector(`.doc-side .fb[data-fid="${id}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.animate([{ boxShadow: '0 0 0 3px rgba(43,90,166,.45)' }, { boxShadow: '0 0 0 0 rgba(43,90,166,0)' }], { duration: 1400 });
  }
}

/* ---------- boot ---------- */

(async function init() {
  if (!token) { app.replaceChildren(h('div', { class: 'card empty' }, 'Missing review link.')); return; }
  try {
    const d = await api('GET', `/api/c/${encodeURIComponent(token)}`);
    Object.assign(S, d);
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '🔒'), h('strong', null, 'Link not found'), h('div', { class: 'muted', style: { marginTop: '6px' } }, err.message)));
    return;
  }
  const hash = location.hash.slice(1);
  if (TAB_ORDER.includes(hash)) S.tab = hash;
  else {
    const first = TAB_ORDER.find((t) => S.datasets.some((d) => d.tab === t));
    if (first) S.tab = first;
  }
  render();
})();
