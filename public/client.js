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
  selected: {}, // dataset id -> Set of selected item keys
  peek: {}, // tabs the client chose to open before finishing earlier steps
  rankPhase: {}, // dataset id -> 'all' | phase number shown in a ranking sheet
  tabPhase: {}, // tab -> 'all' | phase number of uploads shown (e.g. blogs per phase)
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
  if (S.view === 'home') { renderHome(document.getElementById('homebody')); return; }
  renderTabs();
  await renderTabBody(true);
}

async function sendFeedback(item, datasetId, { type, name, comment }, quote, area) {
  await api('POST', `/api/c/${encodeURIComponent(token)}/feedback`, {
    item_key: item.item_key, dataset_id: datasetId, type, name, comment, quote: quote || '', area: area || '',
  });
  setName(name);
  toast(type === 'approve' ? `Approved — thank you, ${name}!` : `Thanks, ${name}! Your feedback was sent to the team.`);
  await refreshFeedback();
}

// Blogs and landing pages are edited directly, so their feedback has no reactions.
const DOC_TYPES = ['approve', 'change', 'question'];

function feedbackPopover(anchor, item, datasetId, { title, quote, preselect, area, types } = {}) {
  const noun = TAB_META[S.tab].noun;
  openFeedbackPopover({
    anchor,
    types: types || (INDEPENDENT_STEPS.has(S.tab) ? DOC_TYPES : null),
    title: title || `What do you think of this ${noun}?`,
    context: area ? `${item.label} · ${area}` : item.label,
    quote,
    preselect,
    getName,
    onSubmit: (v) => sendFeedback(item, datasetId, v, quote, area),
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

  app.replaceChildren(
    h('div', { class: 'hero' },
      h('div', null,
        h('h1', null, p.name),
        h('div', { class: 'sub' },
          p.client_name ? h('span', null, p.client_name) : null,
          site,
          h('span', { class: 'muted' }, `Prepared by ${S.agency}`))),
      h('div', { class: 'row-flex' },
        h('button', { class: 'btn', id: 'tour-btn', onclick: () => startTour() }, '❔ How to use'),
        h('button', { class: 'btn', id: 'all-feedback-btn', onclick: openActivity }, '🗂️ All feedback'))),
    h('div', { class: 'view-switch', role: 'tablist', 'aria-label': 'View' },
      h('button', { role: 'tab', 'data-view': 'home', onclick: () => setView('home') }, '🏠 Home'),
      h('button', { role: 'tab', 'data-view': 'review', onclick: () => setView('review') }, '✅ Review'),
      h('button', { role: 'tab', 'data-view': 'performance', onclick: () => setView('performance') }, '📈 Performance')),
    h('nav', { class: 'tabs', id: 'tabs', role: 'tablist' }),
    h('section', { id: 'homebody', hidden: true }),
    h('section', { id: 'tabbody' }),
    h('section', { id: 'perfbody', hidden: true }));
  setView(S.view || 'home', true);
}

function setView(view, initial) {
  flushEdits();
  S.view = view;
  document.querySelectorAll('.view-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-selected', String(b.dataset.view === view));
  });
  const perf = view === 'performance';
  const home = view === 'home';
  document.getElementById('tabs').hidden = perf || home;
  document.getElementById('tabbody').hidden = perf || home;
  document.getElementById('perfbody').hidden = !perf;
  document.getElementById('homebody').hidden = !home;
  if (!initial) history.replaceState(null, '', home ? location.pathname : `#${perf ? 'performance' : S.tab}`);
  if (perf) renderPerformance(document.getElementById('perfbody'));
  else if (home) renderHome(document.getElementById('homebody'));
  else { renderTabs(); renderTabBody(); }
}

/* ---------- home: what there is to review, and what is inside ---------- */

const STEP_ABOUT = {
  keywords: 'The Google searches we will rank you for, with projected and actual monthly rankings. Approve the list, or tell us which keywords to change.',
  onpage: 'Recommended page titles, meta descriptions and on-page changes for your website.',
  prompts: 'The questions people ask AI assistants such as ChatGPT and Gemini that we want your business to appear in.',
  backlinks: 'Websites we plan to get links to your site from, which builds Google’s trust in your website.',
  blogs: 'Articles written for your website. Read each one, comment on any paragraph, then approve it.',
  landing: 'Pages written to turn visitors into enquiries. Read each one, comment on any part, then approve it.',
};

function openItem(tab, content, key) {
  S.tabPhase[tab] = content.phase || 'all';
  S.sel[tab] = { name: content.name, id: content.id };
  if (key && content.kind === 'doc') S.docSection[content.id] = key;
  S.view = 'review';
  S.tab = tab;
  S.filter = { q: '', status: 'all' };
  setView('review');
  window.scrollTo({ top: 0 });
}

function renderHome(root) {
  const fb = fbByKey();
  const list = steps();
  const contents = S.contents || [];
  const statusOf = (key) => itemStatus(fb.get(key)).key;
  const totals = list.filter((x) => x.has).reduce((a, x) => ({ items: a.items + x.items, reviewed: a.reviewed + x.reviewed }), { items: 0, reviewed: 0 });
  const next = list.find((x) => x.has && !x.complete && !x.locked);
  const name = getName();
  const pct = totals.items ? Math.round((totals.reviewed / totals.items) * 100) : 0;

  const welcome = h('div', { class: 'card card-pad home-welcome' },
    h('div', null,
      h('h2', null, `${name ? `Hi ${name.split(' ')[0]}, here` : 'Here'} is what is ready for your review`),
      h('p', { class: 'muted' }, totals.items
        ? `${totals.items} items across ${list.filter((x) => x.has).length} sections. You have reviewed ${totals.reviewed} so far. Work through the sections in order, or jump to any blog or landing page below.`
        : `${S.agency} will add your keywords and content here soon.`),
      totals.items ? h('div', { class: 'home-progress' },
        h('div', { class: 'meter', role: 'img', 'aria-label': `${pct}% reviewed` }, h('div', { style: { width: `${pct}%` } })),
        h('span', { class: 'small muted' }, `${pct}% reviewed`)) : null),
    next ? h('button', { class: 'btn primary', onclick: () => goStep(next.t) }, `${next.reviewed ? 'Continue' : 'Start'} with ${TAB_META[next.t].label} →`)
      : totals.items ? h('span', { class: 'chip', style: { background: 'var(--ok)', color: 'var(--ok-ink)' } }, '✓ All reviewed, thank you') : null);

  const card = (st, i) => {
    const meta = TAB_META[st.t];
    const here = contents.filter((c) => c.tab === st.t);
    const items = here.flatMap((c) => c.items.map((it) => ({ ...it, content: c })));
    const checks = here.reduce((n, c) => n + c.checks, 0);
    const state = st.complete ? h('span', { class: 'chip home-done' }, '✓ Done')
      : st.locked ? h('span', { class: 'chip' }, '🔒 Opens after the previous step')
        : h('span', { class: 'chip home-todo' }, `${st.reviewed} of ${st.items} reviewed`);
    const what = `${items.length} ${items.length === 1 ? meta.noun : `${meta.noun}s`}${checks ? ` and ${checks} points to confirm` : ''}${here.length > 1 ? `, in ${here.length} ${here.some((c) => c.kind === 'doc') ? 'documents' : 'sheets'}` : ''}`;

    let inside;
    if (here.some((c) => c.kind === 'doc')) {
      // Articles and pages: every title, each opens straight away.
      inside = h('ol', { class: 'home-list' }, items.map((it) => {
        const k = statusOf(it.key);
        return h('li', null,
          h('button', { class: 'linklike', onclick: () => openItem(st.t, it.content, it.key) }, h('span', { class: `home-dot ${k}`, 'aria-hidden': 'true' }), h('span', null, it.label)),
          k === 'approved' ? h('span', { class: 'home-st ok' }, '✓ Approved') : k === 'changes' ? h('span', { class: 'home-st' }, '✏️ Changes') : k === 'question' ? h('span', { class: 'home-st' }, '❓ Question') : null);
      }));
    } else {
      // Sheets: which sheets and phases, and the first few names.
      inside = h('div', null,
        here.length > 1 ? h('div', { class: 'small muted', style: { marginBottom: '8px' } }, here.map((c) => `${c.name}${c.phase ? ` (Phase ${c.phase})` : ''}: ${c.items.length}`).join(' · ')) : null,
        h('div', { class: 'home-chips' }, items.slice(0, 12).map((it) => h('span', { class: 'chip' }, it.label)),
          items.length > 12 ? h('span', { class: 'small muted' }, `+${items.length - 12} more`) : null));
    }
    return h('div', { class: 'card card-pad home-card' },
      h('div', { class: 'home-head' },
        h('div', { class: 'home-title' }, h('span', { class: `step-num${st.complete ? ' done' : ''}`, 'aria-hidden': 'true' }, st.complete ? '✓' : String(i + 1)),
          h('div', null, h('strong', null, `${meta.icon} ${meta.label}`), h('div', { class: 'muted small' }, STEP_ABOUT[st.t]))),
        h('div', { class: 'home-actions' }, state,
          h('button', { class: `btn${next && next.t === st.t ? ' primary' : ''}`, onclick: () => goStep(st.t) },
            st.complete ? 'View again' : st.locked ? 'Have a look' : st.reviewed ? 'Continue →' : 'Start reviewing →'))),
      h('div', { class: 'home-label' }, `What’s inside: ${what}`),
      inside);
  };
  const ready = list.map((st, i) => (st.has ? card(st, i) : null)).filter(Boolean);
  const soon = list.map((st, i) => ({ st, i })).filter(({ st }) => !st.has);

  const later = h('div', { class: 'home-later' },
    soon.length ? h('div', { class: 'card card-pad' },
      h('div', { class: 'home-label' }, 'Coming next'),
      h('div', { class: 'home-soon' }, soon.map(({ st, i }) => h('div', { class: 'home-soon-item', title: STEP_ABOUT[st.t] },
        h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('div', null, h('strong', null, `${TAB_META[st.t].icon} ${TAB_META[st.t].label}`), h('div', { class: 'small muted' }, COMING[st.t] || 'Coming soon')))))) : null,
    h('div', { class: 'card card-pad home-perf' },
      h('div', null, h('strong', null, '📈 Performance'),
        h('div', { class: 'muted small' }, 'How your Google rankings, website visits and enquiries are growing.')),
      h('button', { class: 'btn', onclick: () => setView('performance') }, 'View performance →')));

  root.replaceChildren(welcome, ...ready, later);
}

/* ---------- review steps ---------- */

function stepInfo(t) {
  const pr = S.progress[t] || { items: 0, reviewed: 0 };
  const has = S.datasets.some((d) => d.tab === t);
  const open = S.feedback.filter((f) => !f.parent_id && f.tab === t && f.status === 'open').length;
  const complete = has && pr.items > 0 && pr.reviewed >= pr.items && open === 0;
  return { t, has, items: pr.items, reviewed: pr.reviewed, open, complete };
}

// Blogs often have their own approver, so they are never locked and never
// hold up the other steps.
const INDEPENDENT_STEPS = new Set(['blogs', 'landing']);
// Shown on steps that have nothing uploaded yet.
const COMING = { prompts: 'Coming soon', backlinks: 'Coming in Month 2' };

function steps() {
  const list = TAB_ORDER.map(stepInfo);
  let blocked = false;
  for (const st of list) {
    if (INDEPENDENT_STEPS.has(st.t)) { st.locked = false; continue; }
    st.locked = st.has && blocked;
    if (st.has && !st.complete) blocked = true;
  }
  return list;
}

// The step to open by default: the first one that still needs the client.
function currentStep() {
  const list = steps().filter((x) => x.has && !INDEPENDENT_STEPS.has(x.t));
  if (!list.length) return (steps().find((x) => x.has) || { t: TAB_ORDER[0] }).t;
  return (list.find((x) => !x.complete) || list[list.length - 1] || { t: TAB_ORDER[0] }).t;
}

function goStep(t) {
  flushEdits();
  if (S.view !== 'review') { S.view = 'review'; S.tab = t; setView('review'); return; }
  S.tab = t;
  S.filter = { q: '', status: 'all' };
  history.replaceState(null, '', `#${t}`);
  renderTabs();
  renderTabBody();
  const nav = document.getElementById('tabs');
  if (nav && nav.getBoundingClientRect().top < 0) window.scrollTo({ top: nav.offsetTop - 8 });
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  const list = steps();
  nav.className = 'steps';
  nav.replaceChildren(...list.map((st, i) => {
    const sub = !st.has ? (COMING[st.t] || 'Coming soon')
      : st.complete ? 'Done'
        : st.locked ? 'After the previous step'
          : st.open ? `${st.open} open ${st.open === 1 ? 'question' : 'questions'}`
            : `${st.reviewed} of ${st.items} reviewed`;
    const state = st.complete ? 'done' : !st.has ? 'soon' : st.locked ? 'locked' : 'todo';
    return h('button', {
      class: `tab step ${state}${S.tab === st.t ? ' active' : ''}`, role: 'tab', 'data-tab': st.t,
      'aria-selected': String(S.tab === st.t), onclick: () => goStep(st.t),
    },
    h('span', { class: 'step-num', 'aria-hidden': 'true' }, st.complete ? '✓' : String(i + 1)),
    h('span', { class: 'step-text' }, h('span', { class: 'step-label' }, TAB_META[st.t].label), h('span', { class: 'step-sub' }, sub)));
  }));
}

function stepFooter() {
  const list = steps();
  const idx = list.findIndex((x) => x.t === S.tab);
  const st = list[idx];
  if (!st || !st.has) return null;
  const next = list.slice(idx + 1).find((x) => x.has && !INDEPENDENT_STEPS.has(x.t));
  const nextSoon = list.slice(idx + 1).find((x) => !x.has && !INDEPENDENT_STEPS.has(x.t));
  const noun = TAB_META[st.t].noun;
  if (!st.complete) {
    const left = st.items - st.reviewed;
    const parts = [];
    if (left > 0) parts.push(`review ${left} more ${left === 1 ? noun : `${noun}s`}`);
    if (st.open) parts.push(`we still owe you a reply on ${st.open} ${st.open === 1 ? 'item' : 'items'}`);
    return h('div', { class: 'step-footer' },
      h('div', null, h('strong', null, `To finish ${TAB_META[st.t].label}: `), left > 0 ? parts.join(', and ') : `${parts.join('')}. We will reply here soon.`),
      next ? h('button', { class: 'btn', onclick: () => goStep(next.t) }, `Skip to ${TAB_META[next.t].label} →`) : null);
  }
  return h('div', { class: 'step-footer done' },
    h('div', null, h('strong', null, `✓ ${TAB_META[st.t].label} is done. `),
      next ? `Next up: ${TAB_META[next.t].label}.` : nextSoon ? `That is everything for now. ${COMING[nextSoon.t] ? `${TAB_META[nextSoon.t].label} is ${COMING[nextSoon.t].toLowerCase()}.` : `We will add ${TAB_META[nextSoon.t].label} next and let you know.`}` : 'Thank you, everything has been reviewed.'),
    next ? h('button', { class: 'btn primary', onclick: () => goStep(next.t) }, `Next step: ${TAB_META[next.t].label} →`) : null);
}

function groupsFor(tab, phase = 'all') {
  const list = S.datasets.filter((x) => x.tab === tab && (phase === 'all' || !x.phase || x.phase === phase));
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

function tabPhases(tab) {
  return [...new Set(S.datasets.filter((d) => d.tab === tab && d.phase).map((d) => d.phase))].sort((a, b) => a - b);
}

async function renderTabBody(keepScroll) {
  const body = document.getElementById('tabbody');
  const scroll = keepScroll ? { y: window.scrollY, ...tableScroll() } : null;
  const phasesHere = tabPhases(S.tab);
  if (phasesHere.length && S.tabPhase[S.tab] === undefined) S.tabPhase[S.tab] = phasesHere[phasesHere.length - 1];
  const tabPhaseSel = phasesHere.length ? S.tabPhase[S.tab] : 'all';
  const groups = groupsFor(S.tab, tabPhaseSel);
  const st = steps().find((x) => x.t === S.tab);
  if (!groups.size) {
    const prev = steps().filter((x) => x.has && TAB_ORDER.indexOf(x.t) < TAB_ORDER.indexOf(S.tab));
    body.replaceChildren(h('div', { class: 'card empty' },
      h('div', { class: 'big' }, TAB_META[S.tab].icon),
      h('strong', null, COMING[S.tab] ? `${TAB_META[S.tab].label}: ${COMING[S.tab].toLowerCase()}` : `${TAB_META[S.tab].label} is coming soon`),
      h('div', { class: 'muted', style: { marginTop: '4px' } }, /month 2/i.test(COMING[S.tab] || '')
        ? `We start on ${TAB_META[S.tab].label.toLowerCase()} in the second month of your campaign. ${TAB_META[S.tab].empty}`
        : prev.length
          ? `We will add this once ${prev.map((x) => TAB_META[x.t].label).join(' and ')} ${prev.length === 1 ? 'is' : 'are'} approved. ${TAB_META[S.tab].empty}`
          : TAB_META[S.tab].empty)));
    return;
  }
  if (st && st.locked && !S.peek[S.tab]) {
    const first = steps().find((x) => x.has && !x.complete && !INDEPENDENT_STEPS.has(x.t));
    body.replaceChildren(h('div', { class: 'card empty' },
      h('div', { class: 'big' }, '🔒'),
      h('strong', null, `Please finish ${TAB_META[first.t].label} first`),
      h('div', { class: 'muted', style: { margin: '6px auto 16px', maxWidth: '520px' } },
        `We review your project one step at a time so nothing gets missed. ${first.items - first.reviewed > 0 ? `${first.items - first.reviewed} ${TAB_META[first.t].noun}s still need your review.` : 'We are replying to your questions there.'}`),
      h('div', { class: 'row-flex', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary', onclick: () => goStep(first.t) }, `Go to ${TAB_META[first.t].label}`),
        h('button', { class: 'btn ghost', onclick: () => { S.peek[S.tab] = true; renderTabBody(); } }, 'Look anyway'))));
    return;
  }

  let sel = S.sel[S.tab];
  if (!sel || !groups.has(sel.name)) {
    const [name, versions] = groups.entries().next().value;
    sel = S.sel[S.tab] = { name, id: versions[0].id };
  }
  const versions = groups.get(sel.name);
  if (!versions.some((v) => v.id === sel.id)) sel.id = versions[0].id;

  const phaseSeg = phasesHere.length ? h('div', { class: 'phase-bar', style: { marginBottom: '12px' } },
    h('span', { class: 'phase-bar-label' }, 'Phase'),
    h('div', { class: 'seg' },
      phasesHere.map((n) => {
        return h('button', { class: tabPhaseSel === n ? 'active' : '', onclick: () => { S.tabPhase[S.tab] = n; S.sel[S.tab] = null; renderTabBody(); } }, `Phase ${n}`);
      }),
      h('button', { class: tabPhaseSel === 'all' ? 'active' : '', onclick: () => { S.tabPhase[S.tab] = 'all'; S.sel[S.tab] = null; renderTabBody(); } }, 'All phases'))) : null;
  const head = h('div', null, phaseSeg, h('div', { class: 'toolbar' },
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
        : (versions[0].period ? h('span', { class: 'chip' }, `📅 ${versions[0].period}`) : null))));

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
  body.replaceChildren(head, content, stepFooter() || '');
  if (payload.dataset.kind !== 'doc') freezeColumns();
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
  // Phase view: only the columns that belong to the chosen phase, plus the
  // baseline ranking. Actual-ranking columns appear once that month is reported.
  const P = rankPhases(cols, actual, projected);
  let phaseSel = 'all';
  if (P.phases.length >= 2) {
    const saved = S.rankPhase[dataset.id];
    const reported = P.phases.filter((ph) => ph.actualCols.some(hasData));
    phaseSel = saved !== undefined ? saved : (reported.length ? reported[reported.length - 1].n : 'all');
    if (phaseSel !== 'all' && !P.phases.some((ph) => ph.n === phaseSel)) phaseSel = 'all';
  }
  const inPhase = (c) => {
    if (P.baseline.includes(c)) return true;
    if (phaseSel === 'all') return true;
    const ph = P.phases.find((x) => x.n === phaseSel);
    return ph.projCols.includes(c) || ph.actualCols.includes(c);
  };
  const rankHidden = new Set([
    ...actual.filter((c) => !P.baseline.includes(c) && !hasData(c)),
    ...[...actual, ...projected].filter((c) => !inPhase(c)),
  ]);
  const shownActual = actual.filter((c) => !rankHidden.has(c));
  const shownProjected = projected.filter((c) => !rankHidden.has(c));
  const withData = shownActual.filter(hasData);
  const latest = withData.length ? withData[withData.length - 1] : -1;
  // Only compare a ranking with an earlier one from the same series, so
  // "Google Ranking" is never compared with "ChatGPT Ranking".
  const series = (c) => rankSeries(cols[c]);
  const sameSeries = withData.filter((c) => c !== latest && c < latest && series(c) === series(latest));
  const prevCol = latest >= 0 && sameSeries.length ? sameSeries[sameSeries.length - 1] : -1;
  const visible = cols.map((_, i) => i).filter((i) => !rankHidden.has(i)
    && (i === dataset.primary || i === numIdx || shownActual.includes(i) || shownProjected.includes(i) || hasData(i)));
  const userHidden = hiddenCols(dataset);
  const shownCols = visible.filter((c) => c === dataset.primary || c === numIdx || !userHidden.has(cols[c]));
  const emptyHidden = cols.filter((_, i) => !visible.includes(i) && !rankHidden.has(i)).length;
  return {
    cols, numIdx, actual: shownActual, projected: shownProjected, volume, latest, prevCol,
    visible: shownCols, allVisible: visible, hidden: emptyHidden, phases: P.phases, phaseSel, targetFor: P.targetFor, hasData,
  };
}

// Group ranking columns into campaign phases from their headers:
// "Phase 2 (Month 2-3)" is a projection for months 2-3, "Actual Ranking (Month 3)"
// is the month-3 report, and unlabelled "Month 6", "Month 7"… after the last
// phase form the next phase. "Existing Ranking" is the baseline shown everywhere.
function rankPhases(cols, actual, projected) {
  const monthsOf = (h) => {
    const m = h.match(/month\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);
    return m ? [Number(m[1]), Number(m[2] || m[1])] : null;
  };
  const phases = [];
  const extra = [];
  for (const c of projected) {
    const ph = cols[c].match(/phase\s*(\d+)/i);
    const months = monthsOf(cols[c]);
    if (ph) {
      let p = phases.find((x) => x.n === Number(ph[1]));
      if (!p) { p = { n: Number(ph[1]), from: months ? months[0] : null, to: months ? months[1] : null, projCols: [], actualCols: [] }; phases.push(p); }
      p.projCols.push(c);
    } else if (months) extra.push({ c, months });
  }
  for (const { c, months } of extra) {
    const home = phases.find((p) => p.from !== null && months[0] >= p.from && months[0] <= p.to);
    if (home) { home.projCols.push(c); continue; }
    let next = phases.find((p) => p.extra);
    if (!next) {
      next = { n: Math.max(0, ...phases.map((p) => p.n)) + 1, from: months[0], to: months[1], projCols: [], actualCols: [], extra: true };
      phases.push(next);
    }
    next.from = Math.min(next.from, months[0]);
    next.to = Math.max(next.to, months[1]);
    next.projCols.push(c);
  }
  phases.sort((a, b) => a.n - b.n);
  const baseline = [];
  const targetFor = {};
  for (const c of actual) {
    const months = monthsOf(cols[c]);
    const home = months && phases.find((p) => p.from !== null && months[0] >= p.from && months[0] <= p.to);
    if (home) {
      home.actualCols.push(c);
      const proj = home.projCols.find((pc) => { const pm = monthsOf(cols[pc]); return pm && months[0] >= pm[0] && months[0] <= pm[1]; }) ?? home.projCols[0];
      if (proj !== undefined) targetFor[c] = proj;
    } else baseline.push(c);
  }
  return { phases, baseline, targetFor };
}

function phaseLabel(ph) {
  if (ph.from === null) return `Phase ${ph.n}`;
  return `Phase ${ph.n} · ${ph.from === ph.to ? `Month ${ph.from}` : `Months ${ph.from}–${ph.to}`}`;
}

// Upper end of a projected range: "12-25" -> 25, "8" -> 8.
function rangeTop(v) {
  const nums = String(v ?? '').match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : null;
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
    const target = A.targetFor[c] !== undefined ? rangeTop(item.data[A.targetFor[c]]) : null;
    const r = rankValue(v);
    if (target !== null && r !== null && r <= target) td.append(h('span', { class: 'on-target', title: `Within our projection of ${item.data[A.targetFor[c]]}` }, '✓ on target'));
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
// Keyword sheets carry working columns clients rarely need; they start hidden
// and can be shown again from the Columns menu.
const DEFAULT_HIDDEN = { keywords: [/^column \d+$/i, /^status$/i, /^tier$/i, /search intent/i, /^competition$/i] };
function hiddenCols(dataset) {
  let saved = null;
  try { saved = localStorage.getItem(`cols:${token}:${dataset.tab}:${dataset.name}`); } catch { /* private mode */ }
  if (saved !== null) { try { return new Set(JSON.parse(saved)); } catch { /* fall through */ } }
  const rules = DEFAULT_HIDDEN[dataset.tab] || [];
  return new Set((dataset.columns || []).filter((c) => rules.some((re) => re.test(c))));
}
function saveHiddenCols(dataset, set) {
  try { localStorage.setItem(`cols:${token}:${dataset.tab}:${dataset.name}`, JSON.stringify([...set])); } catch { /* private mode */ }
}

function columnsButton(payload, A) {
  const { dataset } = payload;
  const hidden = hiddenCols(dataset);
  const all = A.allVisible.filter((c) => c !== dataset.primary && c !== A.numIdx);
  const btn = h('button', { class: 'btn columns-btn', type: 'button', 'aria-haspopup': 'true' }, hidden.size ? `Columns (${hidden.size} hidden)` : 'Columns');
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
  if (A.phases.length >= 2) {
    const reported = (ph) => ph.actualCols.some(A.hasData);
    wrap.append(h('div', { class: 'phase-bar' },
      h('span', { class: 'phase-bar-label' }, 'View'),
      h('div', { class: 'seg' },
        h('button', { class: A.phaseSel === 'all' ? 'active' : '', onclick: () => { S.rankPhase[dataset.id] = 'all'; renderTabBody(); } }, 'Overview'),
        A.phases.map((ph) => h('button', {
          class: A.phaseSel === ph.n ? 'active' : '',
          title: reported(ph) ? 'Month-end rankings reported' : 'Projection only',
          onclick: () => { S.rankPhase[dataset.id] = ph.n; renderTabBody(); },
        }, phaseLabel(ph), reported(ph) ? h('span', { class: 'phase-dot', 'aria-label': 'reported' }) : null)))));
  }
  const summary = summaryFor(payload, A, fb);
  if (summary.length) {
    wrap.append(h('div', { class: 'card summary' },
      h('div', { class: 'summary-label' }, 'Summary'),
      summary.map((para) => h('p', null, para))));
  }
  wrap.append(...renderStats(payload, A, fb).filter(Boolean));

  const pendingApproval = items.filter((it) => itemStatus(fb.get(it.item_key)).key !== 'approved').length;
  const search = h('input', { class: 'input', type: 'search', placeholder: `Search ${TAB_META[S.tab].noun}s…`, value: S.filter.q });
  const statusOpts = [['all', 'All'], ['pending', 'Awaiting review'], ['approved', 'Approved'], ['changes', 'Changes requested'], ['question', 'Questions']];
  const seg = h('div', { class: 'seg' }, statusOpts.map(([k, label]) => h('button', {
    class: S.filter.status === k ? 'active' : '',
    onclick: () => { S.filter.status = k; renderTabBody(); },
  }, label)));
  const approveAllBtn = h('button', { class: 'btn brand approve-all-btn', disabled: !pendingApproval }, pendingApproval ? `✓ Approve all (${pendingApproval})` : '✓ All approved');
  approveAllBtn.addEventListener('click', () => openApproveAll(approveAllBtn, payload, pendingApproval));

  wrap.append(h('div', { class: 'toolbar' },
    h('div', { class: 'left' },
      h('div', { class: 'search' },
        h('span', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }).firstChild,
        search),
      seg),
    h('div', { class: 'right' }, columnsButton(payload, A), approveAllBtn)));

  // The keyword (or page, prompt…) column sits right after No. and stays frozen.
  const order = [A.numIdx, dataset.primary].filter((c) => c >= 0 && A.visible.includes(c));
  const cols = [...new Set([...order, ...A.visible])];
  const frozen = new Set(order);
  const selected = S.selected[dataset.id] || (S.selected[dataset.id] = new Set());
  const rowsShown = [];
  const allBox = h('input', { type: 'checkbox', 'aria-label': `Select all ${TAB_META[S.tab].noun}s` });
  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'selcol freeze' }, allBox),
    cols.map((c) => h('th', {
      class: [A.projected.includes(c) ? 'proj' : '', frozen.has(c) ? 'freeze' : '', c === A.numIdx ? 'idx' : ''].join(' ').trim() || null,
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
    rowsShown.push(item);
    const box = h('input', { type: 'checkbox', checked: selected.has(item.item_key), 'aria-label': `Select ${item.label}` });
    const tr = h('tr', { class: selected.has(item.item_key) ? 'picked' : null });
    box.addEventListener('change', () => {
      if (box.checked) selected.add(item.item_key); else selected.delete(item.item_key);
      tr.classList.toggle('picked', box.checked);
      syncSelection();
    });
    tr.append(h('td', { class: 'selcol freeze' }, box));
    for (const c of cols) {
      const td = renderCell(item.data[c], c, A, item, payload);
      if (frozen.has(c)) td.classList.add('freeze');
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

  // Selection bar: act on several rows at once.
  const selBar = h('div', { class: 'select-bar', hidden: true });
  function syncSelection() {
    for (const k of [...selected]) if (!items.some((it) => it.item_key === k)) selected.delete(k);
    const n = selected.size;
    const shownSel = rowsShown.filter((it) => selected.has(it.item_key)).length;
    allBox.checked = rowsShown.length > 0 && shownSel === rowsShown.length;
    allBox.indeterminate = shownSel > 0 && shownSel < rowsShown.length;
    selBar.hidden = n === 0;
    if (!n) return;
    const noun = n === 1 ? TAB_META[S.tab].noun : `${TAB_META[S.tab].noun}s`;
    const picked = items.filter((it) => selected.has(it.item_key));
    const approve = h('button', { class: 'btn brand' }, `✓ Approve ${n}`);
    approve.addEventListener('click', () => bulkPopover(approve, picked, dataset.id, 'approve'));
    const other = h('button', { class: 'btn' }, '★ Feedback on selected');
    other.addEventListener('click', () => bulkPopover(other, picked, dataset.id));
    selBar.replaceChildren(
      h('strong', null, `${n} ${noun} selected`),
      h('div', { class: 'row-flex' },
        approve, other,
        h('button', { class: 'btn ghost', onclick: () => { selected.clear(); renderTabBody(true); } }, 'Clear')));
  }
  allBox.addEventListener('change', () => {
    for (const it of rowsShown) { if (allBox.checked) selected.add(it.item_key); else selected.delete(it.item_key); }
    renderTabBody(true);
  });

  const table = h('div', { class: 'card table-wrap' }, h('table', { class: 'data' }, thead, tbody));
  wrap.append(selBar, table);
  syncSelection();
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

function bulkPopover(anchor, picked, datasetId, preselect) {
  const n = picked.length;
  const noun = n === 1 ? TAB_META[S.tab].noun : `${TAB_META[S.tab].noun}s`;
  const names = picked.slice(0, 4).map((it) => it.label).join(', ') + (n > 4 ? ` and ${n - 4} more` : '');
  openFeedbackPopover({
    anchor,
    title: preselect === 'approve' ? `Approve ${n} ${noun}?` : `What do you think of these ${n} ${noun}?`,
    context: names,
    preselect,
    getName,
    onSubmit: async ({ type, name, comment }) => {
      await api('POST', `/api/c/${encodeURIComponent(token)}/feedback/bulk`, {
        item_keys: picked.map((it) => it.item_key), dataset_id: datasetId, type, name, comment,
      });
      setName(name);
      S.selected[datasetId] = new Set();
      toast(type === 'approve' ? `Approved ${n} ${noun}. Thank you, ${name}!` : `Thanks, ${name}! Feedback sent for ${n} ${noun}.`);
      await refreshFeedback();
    },
  });
}

// Pins No., the selection box and the keyword column while the rest scrolls.
function freezeColumns() {
  const table = document.querySelector('table.data');
  if (!table) return;
  const head = [...table.querySelectorAll('thead th.freeze')];
  let left = 0;
  const offsets = head.map((th) => { const l = left; left += th.getBoundingClientRect().width; return l; });
  for (const row of table.querySelectorAll('tr')) {
    const cells = [...row.children].filter((c) => c.classList.contains('freeze'));
    cells.forEach((cell, i) => {
      cell.style.left = `${offsets[i]}px`;
      cell.classList.toggle('freeze-edge', i === cells.length - 1);
    });
  }
}
window.addEventListener('resize', () => freezeColumns());

/* ---------- plain-English summary ---------- */

const fmt = (n) => Number(n).toLocaleString();
const joinAnd = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
const quoteList = (arr) => joinAnd(arr.map((x) => `“${x}”`));

function summaryFor(payload, A, fb) {
  const { dataset, items } = payload;
  if (!items.length) return [];
  const cols = dataset.columns;
  const pi = dataset.primary;
  const find = (re) => cols.findIndex((c) => re.test(c));
  const label = (it) => String(it.data[pi] ?? it.label);
  const out = [];
  const n = items.length;

  if (dataset.tab === 'keywords') {
    const loc = find(/location|country|market/i);
    const locs = loc >= 0 ? [...new Set(items.map((it) => it.data[loc]).filter(Boolean))] : [];
    const where = locs.length === 1 ? ` in ${locs[0]}` : '';
    const vol = A.volume;
    const withVol = vol >= 0 ? items.filter((it) => typeof it.data[vol] === 'number') : [];
    const total = withVol.reduce((sum, it) => sum + it.data[vol], 0);
    let p1 = `We have picked ${n} keywords for ${S.project.name}`;
    if (total) p1 += `, searched about ${fmt(total)} times a month${where} in total`;
    p1 += '.';
    if (withVol.length >= 3) {
      const top = [...withVol].sort((a, b) => b.data[vol] - a.data[vol]).slice(0, 3);
      p1 += ` The biggest opportunities are ${joinAnd(top.map((it) => `“${label(it)}” (${fmt(it.data[vol])}/month)`))}.`;
    }
    const intent = find(/intent/i);
    if (intent >= 0) {
      const counts = {};
      for (const it of items) {
        const v = String(it.data[intent] || '').trim();
        if (v) counts[v] = (counts[v] || 0) + 1;
      }
      const [topIntent, c] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
      if (topIntent && topIntent.length > 2 && c >= n / 3) {
        const why = /transaction|commercial/i.test(topIntent) ? ', made by people ready to choose a provider'
          : /informational/i.test(topIntent) ? ', made by people researching a topic, a chance to reach them early'
            : '';
        p1 += ` Most are ${topIntent.toLowerCase()} searches (${c} of ${n})${why}.`;
      }
    }
    out.push(p1);

    if (A.latest >= 0) {
      const ranked = items.map((it) => ({ it, r: rankValue(it.data[A.latest]) })).filter((x) => x.r !== null && x.r <= 100).sort((a, b) => a.r - b.r);
      const top12 = ranked.filter((x) => x.r <= 12);
      let p2;
      if (!ranked.length) p2 = `Right now none of these keywords rank in Google’s top 100 (${A.cols[A.latest]}), so there is plenty of room to grow.`;
      else {
        p2 = `Right now ${ranked.length} of ${n} keywords rank in Google’s top 100${top12.length ? `, and ${top12.length} ${top12.length === 1 ? 'is' : 'are'} already in the top 12` : ''}. Your best position is #${ranked[0].r} for “${label(ranked[0].it)}”.`;
      }
      const moves = items.map((it) => movementFor(it, A, payload) || 0);
      const up = moves.filter((m) => m > 0).length;
      const down = moves.filter((m) => m < 0).length;
      if (up || down) p2 += ` Since the last check, ${up} moved up and ${down} moved down.`;
      out.push(p2);
    }

    const ph = A.phaseSel !== 'all' ? A.phases.find((x) => x.n === A.phaseSel) : null;
    if (ph) {
      const proj = ph.projCols[ph.projCols.length - 1];
      const reach = proj !== undefined ? items.filter((it) => inTopRange(it.data[proj])).length : 0;
      let p3 = `You are looking at ${phaseLabel(ph).replace(' · ', ' (')}). `;
      p3 += proj !== undefined ? `Our projection for this phase is in “${A.cols[proj]}”${reach ? `, with ${reach} keywords expected in the top 12` : ''}.` : '';
      const reported = ph.actualCols.filter(A.hasData);
      if (reported.length) {
        const last = reported[reported.length - 1];
        const t = A.targetFor[last];
        const measured = items.filter((it) => rankValue(it.data[last]) !== null);
        const onTarget = t !== undefined ? measured.filter((it) => { const top = rangeTop(it.data[t]); const r = rankValue(it.data[last]); return top !== null && r <= top; }).length : 0;
        p3 += ` In “${A.cols[last]}”, ${onTarget} of ${measured.length} keywords ranked within or better than our projection (marked ✓ on target).`;
      } else {
        p3 += ' Month-end rankings for this phase will appear here once we report them.';
      }
      out.push(p3);
    }
    const projWithData = ph ? [] : A.projected.filter((c) => items.some((it) => it.data[c] != null));
    if (projWithData.length) {
      const lastCol = projWithData[projWithData.length - 1];
      const firstTop = projWithData.find((c) => items.some((it) => inTopRange(it.data[c])));
      const reach = items.filter((it) => inTopRange(it.data[lastCol]));
      if (reach.length) {
        out.push(`By ${A.cols[lastCol]} we project ${reach.length} of ${n} keywords to reach the top 12 (highlighted green), including ${quoteList(reach.slice(0, 3).map(label))}.${firstTop && firstTop !== lastCol ? ` The first could get there as early as ${A.cols[firstTop]}.` : ''}`);
      } else {
        out.push(`The dashed ranges show where we expect each keyword to rank month by month, up to ${A.cols[lastCol]}.`);
      }
    }
  } else if (dataset.tab === 'onpage') {
    const kw = find(/target keyword|keyword/i);
    const ex = kw >= 0 ? items.find((it) => it.data[kw]) : null;
    out.push(`We have rewritten the page title, meta description and main heading for ${n} pages of your website${ex ? `, each built around one main keyword (for example “${ex.data[kw]}” for ${label(ex)})` : ''}.`);
    const remarks = find(/remark|note|comment/i);
    if (remarks >= 0 && items.some((it) => it.data[remarks])) out.push('The Remarks column explains what we change on each page and why.');
    out.push('Please check that each title and description describes the page accurately and uses the names and terms your customers know.');
  } else if (dataset.tab === 'prompts') {
    const ex = items.slice(0, 2).map(label);
    out.push(`These are ${n} questions people ask AI assistants such as ChatGPT and Google’s AI Overviews, for example ${quoteList(ex)}.`);
    out.push(`We will shape your pages so these assistants mention ${S.project.client_name || S.project.name} in their answers. Tell us if any of these don’t sound like your customers, or if we have missed an important one.`);
  } else if (dataset.tab === 'backlinks') {
    const type = find(/^title$|type|category/i);
    const counts = {};
    if (type >= 0) for (const it of items) { const v = String(it.data[type] || '').trim(); if (v) counts[v] = (counts[v] || 0) + 1; }
    const kinds = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k.toLowerCase());
    out.push(`We have found ${n} websites where we plan to list or mention your business${kinds.length ? `, mostly ${joinAnd(kinds)}` : ''}.`);
    out.push('Links from trusted, relevant sites help Google and AI assistants trust your website. Let us know if there are any sites you would rather not appear on.');
  } else if (dataset.tab === 'landing') {
    out.push(`This is our plan of ${n} landing pages. Each one is built to turn visitors searching for a specific service into enquiries.`);
  } else if (dataset.tab === 'blogs') {
    const status = find(/status/i);
    const counts = {};
    if (status >= 0) for (const it of items) { const v = String(it.data[status] || '').trim(); if (v) counts[v] = (counts[v] || 0) + 1; }
    const parts = Object.entries(counts).map(([k, c]) => `${c} ${k.toLowerCase()}`);
    out.push(`This is our plan of ${n} articles${parts.length ? `: ${parts.join(', ')}` : ''}. Each one answers a question your customers search for and links back to your service pages.`);
  }

  const reviewed = items.filter((it) => itemStatus(fb.get(it.item_key)).count > 0).length;
  const open = items.filter((it) => ['changes', 'question'].includes(itemStatus(fb.get(it.item_key)).key)).length;
  const noun = TAB_META[dataset.tab].noun;
  out.push(reviewed === 0
    ? `What to do: look through the list and approve the ${noun}s you are happy with. Tick several to approve them together, or press ★ Review to comment on one.`
    : `You have reviewed ${reviewed} of ${n}${open ? `, and ${open} ${open === 1 ? 'is' : 'are'} waiting for our reply` : ''}.${reviewed < n ? ` ${n - reviewed} still need your review.` : ''}`);
  return out;
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

// Article blocks (paragraphs, headings, lists, images) and the section each sits in.
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE']);
function blockOf(container, node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== container) {
    if (el.classList && el.classList.contains('blk')) return el;
    el = el.parentElement;
  }
  return null;
}
function areaOf(block) {
  if (!block) return '';
  if (block.classList.contains('seo-card')) return 'SEO details';
  if (block.tagName === 'H1') return 'Title';
  let el = block;
  while (el) {
    if (/^H[2-4]$/.test(el.tagName)) return el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    el = el.previousElementSibling;
  }
  return 'Introduction';
}
function blockQuote(block) {
  const text = block.textContent.replace(/\s+/g, ' ').trim();
  const img = block.querySelector('img');
  if (img && text.length < 3) return `Image: ${img.getAttribute('alt') || 'picture'}`.replace(/\s+/g, ' ').slice(0, 300);
  return text.slice(0, 1000);
}

// One-click feedback on a whole block: a 💬 button appears beside the block
// under the pointer (or the block tapped on a phone).
function setupBlocks(container, prose, item, datasetId) {
  const blocks = [...prose.children].filter((el) => BLOCK_TAGS.has(el.tagName) && (el.textContent.trim() || el.querySelector('img')));
  const seo = container.querySelector('.seo-card');
  if (seo) blocks.unshift(seo);
  blocks.forEach((b) => b.classList.add('blk'));
  const btn = h('button', { class: 'blk-btn', type: 'button', title: 'Give feedback on this part', 'aria-label': 'Give feedback on this part', hidden: true }, '💬');
  container.append(btn);
  let current = null;
  const show = (block) => {
    current = block;
    container.querySelectorAll('.blk.hover').forEach((x) => x.classList.remove('hover'));
    block.classList.add('hover');
    const cr = container.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    btn.style.top = `${br.top - cr.top}px`;
    btn.hidden = false;
  };
  for (const b of blocks) {
    b.addEventListener('mouseenter', () => show(b));
    b.addEventListener('click', () => { const sel = window.getSelection(); if (!sel || sel.isCollapsed) show(b); });
  }
  container.addEventListener('mouseleave', () => { btn.hidden = true; container.querySelectorAll('.blk.hover').forEach((x) => x.classList.remove('hover')); });
  btn.addEventListener('click', () => {
    if (!current) return;
    feedbackPopover(btn, item, datasetId, { title: 'What do you think of this part?', quote: blockQuote(current), area: areaOf(current) });
  });
}

/* Feedback log beside an article: every comment with its section, filterable. */
const LOG_FILTERS = [
  ['all', 'All', () => true],
  ['loved', '❤️ Loved', (f) => FB_TYPES[f.type] && FB_TYPES[f.type].pos],
  ['approve', '✅ Approved', (f) => f.type === 'approve'],
  ['change', '✏️ Changes', (f) => f.type === 'change'],
  ['question', '❓ Questions', (f) => f.type === 'question'],
  ['open', 'Waiting for reply', (f) => f.status === 'open'],
];
function feedbackLog(side, title, entries, opts = {}) {
  const key = opts.key || 'log';
  const filterNow = S.logFilter && S.logFilter[key] ? S.logFilter[key] : 'all';
  const list = h('div', { class: 'log-list' });
  const counts = Object.fromEntries(LOG_FILTERS.map(([k, , fn]) => [k, entries.filter((e) => fn(e.t.root)).length]));
  const seg = h('div', { class: 'log-filters' });
  const draw = (k) => {
    S.logFilter = { ...(S.logFilter || {}), [key]: k };
    seg.replaceChildren(...LOG_FILTERS.filter(([fk]) => fk === 'all' || counts[fk]).map(([fk, label]) => h('button', {
      class: fk === k ? 'active' : '', onclick: () => draw(fk),
    }, label, h('span', { class: 'n' }, counts[fk]))));
    const fn = LOG_FILTERS.find(([fk]) => fk === k)[2];
    const shown = entries.filter((e) => fn(e.t.root));
    list.replaceChildren(...(shown.length ? shown.map((e) => {
      const card = renderThread(e.t, { onReply: sendReply, showItem: opts.showItem, onQuoteClick: (root) => scrollToMark(root.id) });
      card.dataset.fid = e.t.root.id;
      return card;
    }) : [h('div', { class: 'muted small' }, entries.length ? 'Nothing in this filter.' : opts.empty || 'No feedback yet.')]));
  };
  side.append(h('div', { class: 'log-head' }, h('h4', null, `${title} (${entries.length})`)), seg, list);
  draw(counts[filterNow] || filterNow === 'all' ? filterNow : 'all');
}

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
    const area = areaOf(blockOf(container, range.startContainer));
    selBtn.addEventListener('click', () => {
      hideSelBtn();
      feedbackPopover(saved.getBoundingClientRect(), item, datasetId, { title: 'What do you think of this part?', quote, area });
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
  const go = (s) => { flushEdits(); S.docSection[dataset.id] = s; renderTabBody(); window.scrollTo({ top: document.getElementById('tabs').offsetTop - 8 }); };

  const checksDone = checks.filter((c) => itemStatus(fb.get(c.item_key)).key === 'approved').length;
  const nav = h('nav', { class: 'doc-nav' },
    hasOverview ? h('button', { class: section === 'overview' ? 'active' : '', onclick: () => go('overview') },
      h('span', { class: 't' }, '📋 Overview'),
      checks.length ? h('span', { class: 'muted small' }, `${checksDone} of ${checks.length} points confirmed`) : null) : null,
    articles.map((a) => {
      const st = itemStatus(fb.get(a.item_key));
      const nEdits = (payload.edits || []).filter((e) => e.item_key === a.item_key).length;
      return h('button', { class: section === a.item_key ? 'active' : '', onclick: () => go(a.item_key) },
        h('span', { class: 't' }, a.data.number ? `${a.data.number}. ${a.data.title}` : a.data.title),
        h('span', null, statusChip(st), nEdits ? h('span', { class: 'chip edits-chip' }, `✏️ ${nEdits} ${nEdits === 1 ? 'edit' : 'edits'}`) : null));
    }));

  const main = h('article', { class: 'card doc-main' });
  const side = h('aside', { class: 'doc-side' });

  if (section === 'overview') {
    const prose = h('div', { class: 'prose', html: dataset.meta.introHtml || '' });
    const list = h('div', { class: 'checklist' }, checks.map((c) => {
      const st = itemStatus(fb.get(c.item_key));
      const confirm = h('button', { class: 'btn sm' }, '✓ Confirm');
      confirm.addEventListener('click', () => feedbackPopover(confirm, c, dataset.id, { title: 'Confirm this point?', preselect: 'approve' }));
      const comment = h('button', { class: 'btn ghost sm' }, '💬 Comment');
      comment.addEventListener('click', () => feedbackPopover(comment, c, dataset.id, { title: 'Comment on this point', types: ['change', 'question'] }));
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
    const all = [...checks, ...articles].flatMap((c) => threadsOf(fb.get(c.item_key) || [])).reverse().map((t) => ({ t }));
    feedbackLog(side, `Feedback log: all ${TAB_META[dataset.tab].noun}s`, all, { key: `doc:${dataset.id}`, showItem: true });
  } else {
    const a = articles.find((x) => x.item_key === section);
    const st = itemStatus(fb.get(a.item_key));
    const noun = TAB_META[dataset.tab].noun;
    const approve = () => {
      const b = h('button', { class: 'btn brand' }, st.key === 'approved' ? '✓ Approved' : `✓ Approve ${noun}`);
      b.addEventListener('click', () => { flushEdits(); feedbackPopover(b, a, dataset.id, { title: `Approve this ${noun}?`, preselect: 'approve', types: ['approve'] }); });
      return b;
    };
    const fbBtn = h('button', { class: 'btn' }, '💬 Comment or question');
    fbBtn.addEventListener('click', () => feedbackPopover(fbBtn, a, dataset.id, { title: `Comment on this ${noun}`, types: ['change', 'question'] }));
    const editCount = h('span');
    main.append(h('div', { class: 'approve-bar' },
      h('div', { class: 'row-flex' }, statusChip(st), editCount,
        st.lastApproval ? h('span', { class: 'muted small' }, `by ${st.lastApproval.name}, ${timeAgo(st.lastApproval.created_at)}`) : null),
      h('div', { class: 'row-flex' },
        h('button', { class: 'btn ghost', onclick: () => openEditGuide(noun) }, '❔ How to edit'), fbBtn, approve())));
    main.append(h('div', { class: 'select-hint', style: { marginBottom: '16px' } },
      '✏️ Click any text to edit it, just like in Word. Your changes save automatically and are highlighted, so our team can see exactly what you changed.'));

    if (a.data.seo && a.data.seo.length) {
      main.append(h('div', { class: 'seo-card' },
        h('div', { class: 'seo-head', style: { paddingTop: '12px' } }, h('h4', null, 'SEO details')),
        a.data.seo.map(([k, v]) => h('div', { class: 'row' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)))));
    }
    const prose = h('div', { class: 'prose editable-doc', html: a.data.html });
    main.append(prose);
    const changes = h('div');
    const comments = h('div', { style: { marginTop: '22px' } });
    side.append(changes, comments);
    makeEditable(prose, payload, a, { changes, editCount });
    // First article this reviewer opens: show how editing works.
    let guided = false;
    try { guided = localStorage.getItem(`editguide:${token}`) === '1'; } catch { /* ignore */ }
    if (!guided && !tourEl) setTimeout(() => openEditGuide(noun), 400);

    const idx = articles.indexOf(a);
    main.append(h('div', { class: 'between', style: { marginTop: '28px', paddingTop: '18px', borderTop: '1px solid var(--line)' } },
      idx > 0 ? h('button', { class: 'btn', onclick: () => go(articles[idx - 1].item_key) }, '← Previous') : (hasOverview ? h('button', { class: 'btn', onclick: () => go('overview') }, '← Overview') : h('span')),
      h('div', { class: 'row-flex' }, approve(),
        idx < articles.length - 1 ? h('button', { class: 'btn primary', onclick: () => go(articles[idx + 1].item_key) }, `Next ${noun} →`) : null)));

    const threads = threadsOf(fb.get(a.item_key) || []).reverse().map((t) => ({ t }));
    if (threads.length) feedbackLog(comments, 'Comments and approvals', threads, { key: a.item_key });
  }

  return h('div', { class: 'doc-layout' }, nav, main, side);
}

/* ---------- how to edit a blog or landing page ---------- */

function openEditGuide(noun = 'article') {
  try { localStorage.setItem(`editguide:${token}`, '1'); } catch { /* ignore */ }
  const step = (n, title, ...body) => h('li', { class: 'eg-step' },
    h('span', { class: 'eg-num', 'aria-hidden': 'true' }, String(n)),
    h('div', null, h('strong', null, title), h('div', { class: 'muted small' }, ...body)));
  const example = h('div', { class: 'eg-example', 'aria-label': 'Example of a change' },
    h('div', { class: 'eg-label' }, 'What your changes look like'),
    h('p', null, 'We offer ', h('del', { class: 'ed-del' }, 'free'), ' ', h('ins', { class: 'ed-ins' }, 'affordable'), ' hearing tests ', h('ins', { class: 'ed-ins' }, 'at City Hall'), ' in Singapore.'),
    h('div', { class: 'muted small' }, h('ins', { class: 'ed-ins' }, 'Green'), ' = words you added. ', h('del', { class: 'ed-del' }, 'Red'), ' = words you removed. Our team sees exactly the same.'));
  openDrawer(`How to edit this ${noun}`, 'It works like a Word document, with track changes switched on.', [
    h('ol', { class: 'eg-steps' },
      step(1, 'Click any text to edit it', `Headings, paragraphs, bullet points and table cells can all be changed. Just click and type, or select words and type over them.`),
      step(2, 'Your changes save by themselves', 'There is no save button. Changes are kept a moment after you stop typing, and when you click somewhere else. Your name is added to each change.'),
      step(3, 'See and undo your changes', 'Everything you change is highlighted in the article and listed under “Your changes” on the right. Press Show to find a change, or Undo to put the original words back.'),
      step(4, 'Ask us instead, if you prefer', 'For bigger changes (a new section, different images, a change of angle), press 💬 Comment or question and tell us what you would like. We will make the change for you.'),
      step(5, `Approve the ${noun}`, `When you are happy, press ✓ Approve ${noun}. You can approve with your edits; we will update the ${noun} with your wording before it goes live.`)),
    example,
    h('div', { class: 'muted small', style: { marginTop: '12px' } }, 'Tips: pasted text comes in as plain words. Press Esc to stop editing. To open a link while editing, hold Ctrl (or ⌘ on a Mac) and click it.'),
  ], [h('button', { class: 'btn primary', onclick: closeDrawer }, 'Got it, start editing')]);
}

/* ---------- direct editing of blog and landing page text ---------- */

// The paragraphs, headings, list items and table cells a client can edit,
// numbered in the order they appear in the uploaded article.
function editBlocks(root) {
  const out = [];
  for (const el of root.children) {
    if (/^(UL|OL)$/.test(el.tagName)) out.push(...el.querySelectorAll(':scope > li'));
    else if (el.tagName === 'TABLE') out.push(...el.querySelectorAll('th, td'));
    else out.push(el);
  }
  return out;
}

// The edited words without the change highlighting.
function cleanEdited(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('del.ed-del').forEach((x) => x.remove());
  c.querySelectorAll('ins.ed-ins').forEach((x) => x.replaceWith(...x.childNodes));
  return c.innerHTML;
}
const plainWords = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); };

// Saves whichever paragraph is being edited, e.g. before moving to another article.
function flushEdits() {
  const el = document.activeElement;
  if (el && el.isContentEditable && el.closest('.editable-doc')) el.blur();
}
window.addEventListener('beforeunload', (e) => {
  const el = document.activeElement;
  if (el && el.isContentEditable && el.dataset.dirty === '1') { flushEdits(); e.preventDefault(); }
});

function makeEditable(prose, payload, article, { changes, editCount }) {
  const dataset = payload.dataset;
  const blocks = editBlocks(prose);
  const originals = blocks.map((el) => el.innerHTML);
  const editsMap = () => new Map((payload.edits || []).filter((e) => e.item_key === article.item_key).map((e) => [e.block, e]));
  const paint = (el, i) => {
    const e = editsMap().get(i);
    el.innerHTML = e ? diffHtml(originals[i], e.html) : originals[i];
    el.classList.toggle('edited', Boolean(e));
  };

  const drawLog = () => {
    const list = [...editsMap().values()];
    editCount.replaceChildren(list.length ? h('span', { class: 'chip edits-chip' }, `✏️ ${list.length} ${list.length === 1 ? 'edit' : 'edits'}`) : '');
    changes.replaceChildren(
      h('div', { class: 'log-head' }, h('h4', null, `Your changes (${list.length})`)),
      h('div', { class: 'muted small', style: { marginBottom: '10px' } }, list.length
        ? h('span', null, 'In the article, ', h('ins', { class: 'ed-ins' }, 'added words'), ' are highlighted and ', h('del', { class: 'ed-del' }, 'removed words'), ' are struck through.')
        : 'No changes yet. Click any text in the article to edit it.'),
      h('div', { class: 'log-list' }, list.map((e) => {
        const d = diffSummary(e.original_html, e.html);
        const where = plainWords(originals[e.block]).slice(0, 60);
        return h('div', { class: 'thread edit-card' },
          h('div', { class: 'muted small' }, `“${where}${where.length >= 60 ? '…' : ''}”`),
          d.removed ? h('div', { class: 'small' }, h('del', { class: 'ed-del' }, d.removed)) : null,
          d.added ? h('div', { class: 'small' }, h('ins', { class: 'ed-ins' }, d.added)) : null,
          h('div', { class: 'between', style: { marginTop: '6px' } },
            h('span', { class: 'muted small' }, `${e.name} · ${timeAgo(e.updated_at)}`),
            h('span', { class: 'row-flex' },
              h('button', { class: 'btn ghost sm', onclick: () => { const el = blocks[e.block]; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); } }, 'Show'),
              h('button', { class: 'btn ghost sm', onclick: () => undo(e.block) }, 'Undo'))));
      })));
  };

  const save = async (el, i, { repaint }) => {
    const html = cleanEdited(el);
    const prev = editsMap().get(i);
    const same = plainWords(html) === plainWords(prev ? prev.html : originals[i]);
    el.dataset.dirty = '';
    if (same) { if (repaint) paint(el, i); return; }
    const name = getName() || askName();
    if (!name) { toast('Please add your name so our team knows who made the change.', true); el.dataset.dirty = '1'; return; }
    try {
      const r = await api('PUT', `/api/c/${encodeURIComponent(token)}/edits`, {
        dataset_id: dataset.id, item_key: article.item_key, block: i, html, original_html: originals[i], name,
      });
      payload.edits = r.edits;
      if (repaint && document.activeElement !== el) paint(el, i);
      drawLog();
    } catch (err) { el.dataset.dirty = '1'; toast(err.message, true); }
  };

  const undo = async (i) => {
    const r = await api('DELETE', `/api/c/${encodeURIComponent(token)}/edits`, { dataset_id: dataset.id, item_key: article.item_key, block: i });
    payload.edits = r.edits;
    paint(blocks[i], i);
    drawLog();
    toast('Change undone.');
  };

  blocks.forEach((el, i) => {
    el.dataset.block = i;
    el.setAttribute('contenteditable', 'true');
    el.spellcheck = true;
    paint(el, i);
    let timer = null;
    el.addEventListener('input', () => {
      el.dataset.dirty = '1';
      clearTimeout(timer);
      timer = setTimeout(() => save(el, i, { repaint: false }), 2000);
    });
    el.addEventListener('blur', () => { clearTimeout(timer); save(el, i, { repaint: true }); });
    // Paste as plain words, so formatting from other documents does not come along.
    el.addEventListener('paste', (ev) => {
      ev.preventDefault();
      document.execCommand('insertText', false, (ev.clipboardData || window.clipboardData).getData('text/plain'));
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); document.execCommand('insertLineBreak'); }
      if (ev.key === 'Escape') el.blur();
    });
    // Links open only with Ctrl/Cmd-click while editing.
    el.addEventListener('click', (ev) => { const link = ev.target.closest('a'); if (link && !(ev.metaKey || ev.ctrlKey)) ev.preventDefault(); });
  });
  drawLog();
}

function scrollToMark(id) {
  const marks = document.querySelectorAll(`mark.hl[data-fid="${id}"], .img-fb[data-fid="${id}"]`);
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

/* ---------- guided tour ---------- */

const TOUR_STEPS = [
  {
    title: 'Welcome to your review portal 👋',
    body: [
      `This is where you check and approve the SEO & AEO work ${'${AGENCY}'} has prepared for you.`,
      'There is nothing to install and no account to create. Just add your name when you leave feedback.',
      'This short guide takes about a minute. You can open it again any time with “❔ How to use”.',
    ],
  },
  {
    target: '#tabs',
    title: 'We review in steps',
    body: [
      'Your project is reviewed one step at a time. When a step is done, the next one opens.',
      '1 Keywords: the searches we will rank you for, with monthly rankings.',
      '2 On-Page SEO · 3 Prompts · 4 Backlinks follow as the work progresses. Backlinks start in Month 2, and Prompts are coming soon.',
      '5 Blogs and 6 Landing Pages can be reviewed at any time, so a colleague who approves content can go straight there.',
    ],
  },
  {
    target: '.stats',
    tab: 'keywords',
    title: 'Reading your rankings',
    body: [
      'Ranking badges show where you appear on Google today. Green means you are in the top 12.',
      'Dashed ranges such as 12-25 are our projections for each month. Green ranges are projected to reach the top 12.',
      'Use View to look at one phase at a time. Each phase shows our projection and, once we report the month-end results, your actual rankings, marked ✓ on target when you meet or beat the projection.',
    ],
  },
  {
    target: '.review-btn',
    title: 'Give feedback on any row',
    body: [
      'Press ★ Review to tell us what you think: ❤️ Love it, 👍 Like this, 🎉 This is great, ✅ Approve, ✏️ Suggest a change or ❓ Ask a question.',
      'Add your name and an optional comment. Your status then appears next to the row.',
    ],
  },
  {
    target: '.summary',
    title: 'Start with the summary',
    body: ['Each step opens with a short summary of what is in the table and what we need from you.'],
  },
  {
    target: 'th.selcol',
    title: 'Select several at once',
    body: [
      'Tick the boxes next to the keywords you want, or the box at the top to select them all.',
      'Then approve them together, or send one comment or question about all of them.',
    ],
  },
  {
    target: '.approve-all-btn',
    title: 'Approve a whole list at once',
    body: [
      'Happy with everything in this list? Approve all signs off every item you have not approved yet.',
      'You can still comment on any single item afterwards.',
    ],
  },
  {
    target: '.columns-btn',
    title: 'Show only what you need',
    body: ['Some working columns are hidden to keep the table short. Use Columns to show or hide them. Your choice is remembered on this device.'],
  },
  {
    target: '.tab[data-tab="blogs"]',
    title: 'Reviewing blogs and landing pages',
    body: [
      'Open an article or landing page and read it as it will appear on your site.',
      'Click any text and edit it directly, just like in Word. Changes save automatically.',
      'Your changes are highlighted, and listed under “Your changes” beside the article, where you can undo any of them.',
      'Use 💬 Comment or question for anything you would rather we changed for you.',
      'Press ❔ How to edit beside any article for a short guide.',
      'Confirm the review points in the Overview, then press ✓ Approve when you are happy.',
    ],
  },
  {
    title: 'What we need from you',
    checklist: [
      ['Keywords', 'Are these the services and areas you want to be found for? Remove or question anything that does not fit.'],
      ['On-Page SEO', 'Are the page titles and descriptions accurate for your business?'],
      ['Backlinks', 'Are you happy to be listed on these sites?'],
      ['Prompts', 'Are these the questions your customers really ask?'],
      ['Blogs', 'Check facts, prices, offers, team names and credentials. We cannot verify these for you.'],
      ['Landing Pages', 'Check the offer, prices, calls to action and contact details on each page.'],
    ],
    body: ['When everything in a section looks right, approve it. Questions are welcome, and we reply right here.'],
  },
  {
    target: '.view-switch',
    title: 'See how your SEO is performing',
    body: [
      'Switch to 📈 Performance for monthly charts of your Google clicks, organic visits, enquiries, rankings and visits from AI assistants.',
      'Switch back to ✅ Review to keep reviewing.',
    ],
  },
  {
    target: '#all-feedback-btn',
    title: 'Track your feedback and our replies',
    body: [
      'All feedback lists everything you and your colleagues have sent, with our replies.',
      'You can share this link with colleagues, and everyone who opens it can review too.',
    ],
  },
];

let tourEl = null;
function endTour() {
  if (tourEl) { tourEl.remove(); tourEl = null; }
  try { localStorage.setItem(`tour:${token}`, '1'); } catch { /* ignore */ }
  document.removeEventListener('keydown', tourKeys);
}
function tourKeys(e) {
  if (!tourEl) return;
  if (e.key === 'Escape') endTour();
  if (e.key === 'ArrowRight') tourEl.querySelector('.tour-next')?.click();
  if (e.key === 'ArrowLeft') tourEl.querySelector('.tour-back')?.click();
}

async function startTour(i = 0) {
  closePopover();
  closeDrawer();
  if (tourEl) tourEl.remove();
  document.removeEventListener('keydown', tourKeys);
  document.addEventListener('keydown', tourKeys);
  const step = TOUR_STEPS[i];
  if (step.target && S.view === 'home' && !step.target.startsWith('.view-switch')) setView('review');
  if (step.tab && S.tab !== step.tab && S.datasets.some((d) => d.tab === step.tab)) {
    S.tab = step.tab;
    history.replaceState(null, '', `#${step.tab}`);
    renderTabs();
    await renderTabBody();
  }
  const target = step.target ? document.querySelector(step.target) : null;
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  const rect = target ? target.getBoundingClientRect() : null;
  const visible = rect && rect.width > 0 && rect.height > 0;

  const last = i === TOUR_STEPS.length - 1;
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': step.title },
    h('div', { class: 'tour-count' }, `Step ${i + 1} of ${TOUR_STEPS.length}`),
    h('h3', null, step.title),
    step.checklist ? h('ul', { class: 'tour-check' }, step.checklist.map(([k, v]) => h('li', null, h('strong', null, k), ' ', v))) : null,
    h('div', { class: 'tour-body' }, step.body.map((t) => h('p', null, t.replace('${AGENCY}', S.agency)))),
    h('div', { class: 'tour-dots', 'aria-hidden': 'true' }, TOUR_STEPS.map((_, n) => h('span', { class: n === i ? 'on' : null }))),
    h('div', { class: 'tour-actions' },
      h('button', { class: 'btn ghost', onclick: endTour }, last ? 'Close' : 'Skip guide'),
      h('div', { class: 'row-flex' },
        i > 0 ? h('button', { class: 'btn tour-back', onclick: () => startTour(i - 1) }, '← Back') : null,
        h('button', { class: 'btn primary tour-next', onclick: () => (last ? endTour() : startTour(i + 1)) }, last ? 'Start reviewing' : 'Next →'))));

  const hole = visible ? h('div', { class: 'tour-hole' }) : null;
  tourEl = h('div', { class: 'tour' }, h('div', { class: `tour-shade${visible ? ' clear' : ''}` }), hole, card);
  document.body.append(tourEl);

  if (visible) {
    const pad = 8;
    Object.assign(hole.style, { left: `${rect.left - pad}px`, top: `${rect.top - pad}px`, width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px` });
    if (window.innerWidth > 640) {
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      let top = rect.bottom + 16;
      if (top + ch > window.innerHeight - 12) top = rect.top - ch - 16;
      top = Math.min(Math.max(12, top), window.innerHeight - ch - 12);
      const left = Math.min(Math.max(12, rect.left + rect.width / 2 - cw / 2), window.innerWidth - cw - 12);
      Object.assign(card.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
    }
  }
  card.querySelector('.tour-next').focus();
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
  S.tab = TAB_ORDER.includes(hash) ? hash : currentStep();
  S.view = hash === 'performance' ? 'performance' : TAB_ORDER.includes(hash) ? 'review' : 'home';
  render();
  let seen = false;
  try { seen = localStorage.getItem(`tour:${token}`) === '1'; } catch { /* ignore */ }
  if (!seen) setTimeout(() => startTour(), 600);
})();
