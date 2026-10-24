/* Shared helpers for the client portal and the admin dashboard. */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: `toast${isError ? ' error' : ''}`, role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

function parseUTC(s) {
  return new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
}

function timeAgo(s) {
  const d = parseUTC(s);
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fullDate(s) {
  return parseUTC(s).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const TAB_META = {
  keywords: { label: 'Keywords', noun: 'keyword', icon: '🔑', empty: 'Your keyword list and monthly rankings will appear here.' },
  onpage: { label: 'On-Page SEO', noun: 'page', icon: '📄', empty: 'Page titles, meta descriptions and on-page recommendations will appear here.' },
  backlinks: { label: 'Backlinks', noun: 'backlink', icon: '🔗', empty: 'Backlink opportunities for your review will appear here.' },
  prompts: { label: 'Prompts', noun: 'prompt', icon: '💬', empty: 'AI search prompts (AEO) we are tracking for you will appear here.' },
  blogs: { label: 'Blogs', noun: 'article', icon: '✍️', empty: 'Blog articles ready for your review will appear here.' },
  landing: { label: 'Landing Pages', noun: 'landing page', icon: '🧭', empty: 'Landing pages ready for your review will appear here.' },
};
// Also the order of the client's review steps.
const TAB_ORDER = ['keywords', 'onpage', 'prompts', 'backlinks', 'blogs', 'landing'];

const FB_TYPES = {
  love: { emoji: '❤️', label: 'Love it', pos: true },
  like: { emoji: '👍', label: 'Like this', pos: true },
  great: { emoji: '🎉', label: 'This is great', pos: true },
  approve: { emoji: '✅', label: 'Approve', past: 'Approved' },
  change: { emoji: '✏️', label: 'Suggest a change', past: 'Suggested a change' },
  question: { emoji: '❓', label: 'Ask a question', past: 'Asked a question' },
  reply: { emoji: '↩️', label: 'Reply', past: 'Replied' },
};

function fbTypeLabel(t) {
  const m = FB_TYPES[t];
  return m ? `${m.emoji} ${m.past || m.label}` : t;
}

/* Overall review status of one item from its top-level feedback. */
function itemStatus(list) {
  const top = (list || []).filter((f) => !f.parent_id && f.author_role === 'client');
  const reactions = {};
  for (const f of top) if (FB_TYPES[f.type] && FB_TYPES[f.type].pos) reactions[f.type] = (reactions[f.type] || 0) + 1;
  const openChange = top.some((f) => f.type === 'change' && f.status === 'open');
  const openQ = top.some((f) => f.type === 'question' && f.status === 'open');
  const approvals = top.filter((f) => f.type === 'approve');
  const lastApproval = approvals[approvals.length - 1];
  let key = 'pending';
  if (openChange) key = 'changes';
  else if (openQ) key = 'question';
  else if (lastApproval) key = 'approved';
  else if (Object.keys(reactions).length) key = 'liked';
  const comments = (list || []).filter((f) => f.comment).length;
  return { key, reactions, lastApproval, comments, count: top.length };
}

const STATUS_CHIP = {
  pending: ['chip', 'Awaiting review'],
  liked: ['chip ok', 'Liked'],
  approved: ['chip ok', '✓ Approved'],
  changes: ['chip warn', 'Changes requested'],
  question: ['chip info', 'Question asked'],
};

function statusChip(st) {
  const [cls, label] = STATUS_CHIP[st.key];
  const title = st.key === 'approved' && st.lastApproval ? `Approved by ${st.lastApproval.name} · ${fullDate(st.lastApproval.created_at)}` : null;
  return h('span', { class: cls, title }, label);
}

function reactionsRow(st) {
  const r = Object.entries(st.reactions);
  if (!r.length) return null;
  return h('div', { class: 'reactions' }, r.map(([t, n]) => h('span', { title: FB_TYPES[t].label }, `${FB_TYPES[t].emoji} ${n}`)));
}

/* ---------- feedback popover ---------- */

let activePopover = null;
function closePopover() {
  if (activePopover) { activePopover.remove(); activePopover = null; }
}

/**
 * opts: { anchor: DOMRect|Element, title, context, quote, preselect, getName, onSubmit({type,name,comment}) }
 */
function openFeedbackPopover(opts) {
  closePopover();
  let selected = opts.preselect || null;
  const nameInput = h('input', { class: 'input', placeholder: 'Your name', maxlength: 80, value: opts.getName() || '', autocomplete: 'name' });
  const comment = h('textarea', { class: 'textarea', maxlength: 5000, rows: 3 });
  const post = h('button', { class: 'btn primary', type: 'submit' }, 'Post comment');

  const choiceBtns = {};
  const mkChoice = (t) => {
    const m = FB_TYPES[t];
    const b = h('button', { type: 'button', class: `choice${m.pos ? ' pos' : ''}`, 'aria-pressed': 'false', onclick: () => { selected = t; refresh(); comment.focus(); } },
      h('span', { class: 'emo' }, m.emoji), m.label);
    choiceBtns[t] = b;
    return b;
  };

  function refresh() {
    for (const [t, b] of Object.entries(choiceBtns)) {
      b.classList.toggle('selected', t === selected);
      b.setAttribute('aria-pressed', String(t === selected));
    }
    const needs = selected === 'change' || selected === 'question';
    comment.placeholder = selected === 'change' ? 'What would you like us to change?'
      : selected === 'question' ? 'What would you like to know?'
        : selected === 'approve' ? 'Any notes with your approval? (optional)'
          : 'Add a comment (optional)';
    post.disabled = !selected || !nameInput.value.trim() || (needs && !comment.value.trim());
    post.textContent = selected === 'approve' ? 'Approve' : 'Post comment';
  }
  nameInput.addEventListener('input', refresh);
  comment.addEventListener('input', refresh);

  const form = h('form', { class: 'popover', role: 'dialog', 'aria-label': opts.title },
    h('h3', null, opts.title),
    opts.context ? h('div', { class: 'ctx' }, opts.context) : null,
    opts.quote ? h('div', { class: 'quote' }, `“${opts.quote}”`) : null,
    h('div', { class: 'choices' },
      opts.types
        ? opts.types.map((t, i) => [i ? h('span', { class: 'choice-break' }) : null, mkChoice(t)])
        : [mkChoice('love'), mkChoice('like'), mkChoice('great'),
          h('span', { class: 'choice-break' }),
          mkChoice('approve'),
          h('span', { class: 'choice-break' }),
          mkChoice('change'),
          h('span', { class: 'choice-break' }),
          mkChoice('question')]),
    h('div', { class: 'pop-fields' }, nameInput, comment),
    h('div', { class: 'pop-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: closePopover }, 'Cancel'),
      post));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (post.disabled) return;
    post.disabled = true;
    try {
      await opts.onSubmit({ type: selected, name: nameInput.value.trim(), comment: comment.value.trim() });
      closePopover();
    } catch (err) {
      toast(err.message, true);
      refresh();
    }
  });

  const backdrop = h('div', { class: 'pop-backdrop', onclick: closePopover });
  const wrap = h('div', null, backdrop, form);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  document.body.append(wrap);
  activePopover = wrap;
  refresh();

  // Position next to the anchor, kept inside the viewport.
  const rect = opts.anchor instanceof Element ? opts.anchor.getBoundingClientRect() : opts.anchor;
  if (window.innerWidth > 640 && rect) {
    const pw = form.offsetWidth;
    const ph = form.offsetHeight;
    let left = Math.min(Math.max(12, rect.left + rect.width / 2 - pw / 2), window.innerWidth - pw - 12);
    let top = rect.bottom + 10;
    if (top + ph > window.innerHeight - 12) top = rect.top - ph - 10;
    top = Math.min(Math.max(12, top), Math.max(12, window.innerHeight - ph - 12));
    if (rect.left - pw - 16 > 0 && rect.right > window.innerWidth - 80) left = rect.left - pw - 16;
    form.style.left = `${left}px`;
    form.style.top = `${top}px`;
  }
  (nameInput.value ? form.querySelector('.choice') : nameInput).focus();
}

/* ---------- drawer ---------- */

let activeDrawer = null;
function closeDrawer() {
  if (activeDrawer) { activeDrawer.remove(); activeDrawer = null; }
}
function openDrawer(title, subtitle, bodyNodes, footerNodes) {
  closeDrawer();
  const wrap = h('div', null,
    h('div', { class: 'drawer-backdrop', onclick: closeDrawer }),
    h('aside', { class: 'drawer', role: 'dialog', 'aria-label': title },
      h('header', null,
        h('div', null, h('h3', null, title), subtitle ? h('div', { class: 'muted small', style: { marginTop: '4px' } }, subtitle) : null),
        h('button', { class: 'btn ghost sm', onclick: closeDrawer, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'body' }, bodyNodes),
      footerNodes ? h('footer', null, footerNodes) : null));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  document.body.append(wrap);
  activeDrawer = wrap;
  return wrap;
}

/* Group a flat feedback list into threads: [{ root, replies }] */
function threadsOf(list) {
  const roots = list.filter((f) => !f.parent_id);
  return roots.map((root) => ({ root, replies: list.filter((f) => f.parent_id === root.id) }));
}

/**
 * Render one feedback thread.
 * opts: { onReply(root, text) -> Promise, replyName: () => string, actions: (root) => Node[], onQuoteClick(root), showItem }
 */
function renderThread({ root, replies }, opts = {}) {
  const needs = root.type === 'change' || root.type === 'question';
  const head = h('div', { class: 'fb-head' },
    h('span', { class: 'who' }, root.name),
    root.author_role === 'agency' ? h('span', { class: 'chip agency' }, 'Team') : null,
    h('span', { class: root.type === 'approve' ? 'chip ok' : root.type === 'change' ? 'chip warn' : root.type === 'question' ? 'chip info' : 'chip' }, fbTypeLabel(root.type)),
    needs && root.status === 'resolved' ? h('span', { class: 'chip ok' }, 'Resolved') : null,
    h('span', { class: 'when', title: fullDate(root.created_at) }, timeAgo(root.created_at)));

  const card = h('div', { class: `fb${needs && root.status === 'open' ? ' open' : ''}` },
    opts.showItem ? h('div', { class: 'fb-item-label' }, `${TAB_META[root.tab] ? TAB_META[root.tab].label : root.tab} · ${root.item_label}`) : null,
    head,
    root.area ? h('div', { class: 'fb-area' }, `📍 ${root.area}`) : null,
    root.quote ? h('div', { class: 'fb-quote', title: 'Show in text', onclick: () => opts.onQuoteClick && opts.onQuoteClick(root) }, `“${root.quote.length > 220 ? `${root.quote.slice(0, 220)}…` : root.quote}”`) : null,
    root.comment ? h('div', { class: 'fb-body' }, root.comment) : null);

  if (replies.length) {
    card.append(h('div', { class: 'fb-replies' }, replies.map((r) => h('div', { class: 'fb-reply' },
      h('div', { class: 'fb-head' },
        h('span', { class: 'who' }, r.name),
        r.author_role === 'agency' ? h('span', { class: 'chip agency' }, 'Team') : null,
        h('span', { class: 'when', title: fullDate(r.created_at) }, timeAgo(r.created_at)),
        opts.replyActions ? opts.replyActions(r) : null),
      h('div', { class: 'fb-body' }, r.comment)))));
  }

  const actions = opts.actions ? opts.actions(root) : [];
  if (opts.onReply) {
    const ta = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Write a reply…', maxlength: 5000 });
    const form = h('form', { class: 'fb-reply-form hidden' }, ta,
      h('div', { class: 'row-flex', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', class: 'btn ghost sm', onclick: () => form.classList.add('hidden') }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary sm' }, 'Reply')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      try { await opts.onReply(root, ta.value.trim()); } catch (err) { toast(err.message, true); }
    });
    actions.unshift(h('button', { class: 'btn ghost sm', onclick: () => { form.classList.remove('hidden'); ta.focus(); } }, '↩ Reply'));
    card.append(h('div', { class: 'fb-actions', style: { marginTop: '8px' } }, actions), form);
  } else if (actions.length) {
    card.append(h('div', { class: 'fb-actions', style: { marginTop: '8px' } }, actions));
  }
  return card;
}

/* ---------- table cell formatting ---------- */

const COLS = {
  numbering: /^(no\.?|s\/?n|#|sn|sr\.?\s*no\.?|serial)$/i,
  actualRank: /(actual|current|existing|latest).*(rank|position)|^(rank|ranking|position|google rank(ing)?|current position)$/i,
  projected: /phase|projected|forecast|target\s*(rank|position|range)|^month\s*\d+$/i,
  volume: /volume|search vol|traffic|searches/i,
};

function rankValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^>\s*\d+/.test(s)) return 101;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

function rankBadge(v) {
  const n = rankValue(v);
  if (n === null) return h('span', { class: 'rank rnone' }, v === null || v === undefined ? '–' : String(v));
  const cls = n <= 3 ? 'r3' : n <= 12 ? 'r10' : n <= 30 ? 'r30' : n <= 100 ? 'r100' : 'rnone';
  return h('span', { class: `rank ${cls}`, title: n > 100 ? 'Not in the top 100 yet' : `Position ${n}` }, n > 100 ? '>100' : String(n));
}

function isUrlish(s) {
  return typeof s === 'string' && !/\s/.test(s) && (/^https?:\/\//i.test(s) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s));
}

function formatNumber(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  return String(parseFloat(v.toFixed(4)));
}

/* ---------- tracked changes: words the client edited in an article ---------- */

// Show an edited paragraph with added words highlighted and removed words
// struck through, keeping the formatting (bold, links) of the edited version.
function diffHtml(originalHtml, editedHtml) {
  const tok = (html) => String(html || '').match(/<[^>]+>|[^<\s]+\s*|\s+/g) || [];
  const isWord = (t) => t[0] !== '<' && t.trim() !== '';
  const a = tok(originalHtml).filter(isWord);
  const bt = tok(editedHtml);
  const b = bt.filter(isWord);
  const key = (t) => t.trim();
  const n = a.length; const m = b.length;
  const ops = []; // per edited word: 'eq' | 'ins'; deletions are queued before the next edited word
  const dels = Array.from({ length: m + 1 }, () => []);
  if (n * m > 4e6) {
    for (let j = 0; j < m; j++) ops.push('ins');
    dels[0] = a;
  } else {
    const L = new Uint16Array((n + 1) * (m + 1));
    const at = (i, j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[at(i, j)] = key(a[i]) === key(b[j]) ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
      }
    }
    let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && key(a[i]) === key(b[j])) { ops.push('eq'); i++; j++; }
      else if (i < n && (j >= m || L[at(i + 1, j)] >= L[at(i, j + 1)])) { dels[j].push(a[i]); i++; }
      else { ops.push('ins'); j++; }
    }
  }
  const delHtml = (list) => (list.length ? `<del class="ed-del" contenteditable="false">${list.join('').trim()}</del> ` : '');
  let out = '';
  let w = 0;
  for (const t of bt) {
    if (!isWord(t)) { out += t; continue; }
    out += delHtml(dels[w]);
    out += ops[w] === 'ins' ? `<ins class="ed-ins">${t.trimEnd()}</ins>${t.slice(t.trimEnd().length)}` : t;
    w++;
  }
  // One highlight for neighbouring added words rather than one per word.
  return (out + delHtml(dels[m])).replace(/<\/ins>(\s+)<ins class="ed-ins">/g, '$1');
}

// What was added and removed, as short plain text for the changes log.
function diffSummary(originalHtml, editedHtml) {
  const box = document.createElement('div');
  box.innerHTML = diffHtml(originalHtml, editedHtml);
  const grab = (sel) => [...box.querySelectorAll(sel)].map((e) => e.textContent.trim()).join(' ').replace(/\s+/g, ' ');
  return { added: grab('ins'), removed: grab('del') };
}
