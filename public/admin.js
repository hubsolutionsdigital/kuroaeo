/* Agency admin: create projects, upload Excel sheets and blog docs, answer feedback. */

const app = document.getElementById('app');
const A = { agency: '', projects: [], current: null, view: 'content', fbFilter: { status: 'action', tab: 'all' } };

const clientUrl = (p) => `${location.origin}/p/${p.token}`;

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Link copied — send it to your client.'), () => window.prompt('Copy this link:', text));
}

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  closeDrawer();
  closePopover();
  if (parts[0] === 'project' && parts[1]) {
    A.view = parts[2] || 'content';
    return showProject(Number(parts[1]));
  }
  return showProjects();
}

function topbar(admin) {
  document.getElementById('agency').textContent = `${A.agency || 'Review Portal'} · Admin`;
  const bar = document.getElementById('adminbar');
  bar.replaceChildren(admin
    ? h('div', { class: 'row-flex' },
      h('a', { class: 'btn sm', href: '#/' }, 'All projects'),
      h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/admin/logout'); location.reload(); } }, 'Log out'))
    : '');
}

/* ---------- login ---------- */

function showLogin() {
  topbar(false);
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Admin password', autocomplete: 'current-password' });
  const form = h('form', { class: 'card login' },
    h('h2', { style: { marginTop: 0 } }, 'Team login'),
    h('p', { class: 'muted' }, 'Sign in to manage projects and client reviews.'),
    h('div', { class: 'pop-fields' }, pw, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/admin/login', { password: pw.value }); A.authed = true; route(); } catch (err) { toast(err.message, true); }
  });
  app.replaceChildren(form);
  pw.focus();
}

/* ---------- projects list ---------- */

async function showProjects() {
  topbar(true);
  app.replaceChildren(h('div', { class: 'spinner' }));
  const { projects } = await api('GET', '/api/admin/projects');
  A.projects = projects;

  const name = h('input', { class: 'input', placeholder: 'Project name, e.g. Dot Chambers LLC — SEO & AEO', maxlength: 120, required: true });
  const client = h('input', { class: 'input', placeholder: 'Client name (optional)', maxlength: 120 });
  const site = h('input', { class: 'input', placeholder: 'Website, e.g. dotchambers.com (optional)', maxlength: 300 });
  const form = h('form', { class: 'card card-pad hidden', style: { marginBottom: '20px' } },
    h('h3', { style: { marginTop: 0 } }, 'New project'),
    h('div', { class: 'two-col' }, name, client, site,
      h('div', { class: 'row-flex', style: { justifyContent: 'flex-end' } },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => form.classList.add('hidden') }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Create project'))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { project } = await api('POST', '/api/admin/projects', { name: name.value, client_name: client.value, website: site.value });
      location.hash = `#/project/${project.id}/upload`;
    } catch (err) { toast(err.message, true); }
  });

  app.replaceChildren(
    h('div', { class: 'hero' },
      h('div', null, h('h1', null, 'Client projects'), h('div', { class: 'sub muted' }, 'Each project has one private review link. Clients need no account — they just open the link.')),
      h('button', { class: 'btn primary', onclick: () => { form.classList.remove('hidden'); name.focus(); } }, '+ New project')),
    form,
    projects.length
      ? h('div', { class: 'grid-cards' }, projects.map((p) => h('div', {
        class: 'card proj-card', role: 'link', tabindex: 0,
        onclick: () => { location.hash = `#/project/${p.id}`; },
        onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#/project/${p.id}`; },
      },
      h('div', { class: 'between' }, h('h3', null, p.name), p.open_count ? h('span', { class: 'chip warn' }, `${p.open_count} to answer`) : null),
      h('div', { class: 'muted small' }, [p.client_name, p.website].filter(Boolean).join(' · ') || 'No client details'),
      h('div', { class: 'row-flex small muted' },
        h('span', null, `${p.dataset_count} uploads`), '·',
        h('span', null, `${p.feedback_count} client responses`),
        p.last_feedback_at ? ['·', h('span', null, `last ${timeAgo(p.last_feedback_at)}`)] : null),
      h('div', { class: 'row-flex' },
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); copy(clientUrl(p)); } }, '🔗 Copy client link'),
        h('a', { class: 'btn sm ghost', href: clientUrl(p), target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'Open ↗')))))
      : h('div', { class: 'card empty' }, h('div', { class: 'big' }, '📁'), h('strong', null, 'No projects yet'), h('div', { class: 'muted' }, 'Create one to upload keywords, on-page SEO, backlinks, prompts and blogs.')));
}

/* ---------- project ---------- */

async function loadProject(id) {
  A.current = await api('GET', `/api/admin/projects/${id}`);
  return A.current;
}

async function showProject(id) {
  topbar(true);
  if (!A.current || A.current.project.id !== id) app.replaceChildren(h('div', { class: 'spinner' }));
  try { await loadProject(id); } catch (err) {
    app.replaceChildren(h('div', { class: 'card empty' }, err.message, h('div', null, h('a', { href: '#/' }, 'Back to projects'))));
    return;
  }
  renderProject();
}

function renderProject() {
  const { project: p, feedback } = A.current;
  const open = feedback.filter((f) => f.status === 'open').length;
  const views = [['content', 'Content'], ['upload', 'Upload'], ['feedback', `Feedback${open ? ` (${open})` : ''}`], ['settings', 'Settings']];
  const body = h('section');
  app.replaceChildren(
    h('div', { class: 'hero' },
      h('div', null,
        h('div', { class: 'small' }, h('a', { href: '#/' }, '← All projects')),
        h('h1', null, p.name),
        h('div', { class: 'sub' }, p.client_name ? h('span', null, p.client_name) : null, p.website ? h('span', { class: 'muted' }, p.website) : null)),
      h('div', { style: { minWidth: 'min(520px, 100%)' } },
        h('div', { class: 'small muted', style: { marginBottom: '6px', fontWeight: 600 } }, 'Client review link (no login needed)'),
        h('div', { class: 'linkbox' }, h('code', null, clientUrl(p)),
          h('button', { class: 'btn sm', onclick: () => copy(clientUrl(p)) }, 'Copy'),
          h('a', { class: 'btn sm', href: clientUrl(p), target: '_blank', rel: 'noopener' }, 'Open ↗')))),
    h('nav', { class: 'tabs' }, views.map(([k, label]) => h('a', {
      class: `tab${A.view === k ? ' active' : ''}`, href: `#/project/${p.id}/${k}`, style: { textDecoration: 'none' },
    }, label))),
    body);
  ({ content: renderContent, upload: renderUpload, feedback: renderFeedback, settings: renderSettings }[A.view] || renderContent)(body);
}

const refresh = async () => { await loadProject(A.current.project.id); renderProject(); };

// Campaign phase an upload belongs to (blank = all phases).
function phaseSelect(value) {
  return h('select', { class: 'select', 'aria-label': 'Phase', style: { width: 'auto' } },
    h('option', { value: '' }, 'All phases'),
    [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n, selected: Number(value) === n }, `Phase ${n}`)));
}

/* ---------- content ---------- */

function renderContent(body) {
  const { project: p, datasets, progress } = A.current;
  if (!datasets.length) {
    body.append(h('div', { class: 'card empty' }, h('div', { class: 'big' }, '📤'), h('strong', null, 'Nothing uploaded yet'),
      h('div', { class: 'muted', style: { margin: '6px 0 14px' } }, 'Upload your keyword Excel file or blog document to get started.'),
      h('a', { class: 'btn primary', href: `#/project/${p.id}/upload` }, 'Upload files')));
    return;
  }
  for (const tab of TAB_ORDER) {
    const list = datasets.filter((d) => d.tab === tab);
    const pr = progress[tab] || { items: 0, reviewed: 0 };
    body.append(h('div', { class: 'between section-title' },
      h('h3', { style: { margin: 0 } }, `${TAB_META[tab].icon} ${TAB_META[tab].label}`),
      pr.items ? h('span', { class: 'muted small' }, `${pr.reviewed} of ${pr.items} reviewed by client`) : null));
    if (!list.length) {
      body.append(h('div', { class: 'card card-pad muted small' }, 'Nothing in this tab yet — the client sees an empty “coming soon” state.'));
      continue;
    }
    body.append(h('div', { class: 'card', style: { overflowX: 'auto' } }, h('table', { class: 'plain' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Report month'), h('th', null, 'Phase'), h('th', null, 'Items'), h('th', null, 'Uploaded'), h('th', null, 'Source file'), h('th', null, ''))),
      h('tbody', null, list.map((d) => datasetRow(d, p))))));
  }
}

function datasetRow(d, p) {
  const tr = h('tr');
  const show = () => tr.replaceChildren(
    h('td', null, h('strong', null, d.name), d.kind === 'doc' ? h('span', { class: 'chip', style: { marginLeft: '8px' } }, 'Document') : null),
    h('td', null, d.period || h('span', { class: 'muted' }, '—')),
    h('td', null, d.phase ? `Phase ${d.phase}` : h('span', { class: 'muted' }, 'All')),
    h('td', null, d.item_count),
    h('td', { class: 'muted small nowrap', title: fullDate(d.created_at) }, timeAgo(d.created_at)),
    h('td', { class: 'muted small' }, d.source_file),
    h('td', { class: 'nowrap', style: { textAlign: 'right' } },
      h('a', { class: 'btn sm ghost', href: `${clientUrl(p)}#${d.tab}`, target: '_blank', rel: 'noopener' }, 'View'),
      h('button', { class: 'btn sm ghost', onclick: edit }, 'Edit'),
      h('button', {
        class: 'btn sm ghost danger',
        onclick: async () => {
          if (!confirm(`Delete “${d.name}” (${d.period || 'undated'})? Client feedback is kept.`)) return;
          await api('DELETE', `/api/admin/datasets/${d.id}`);
          toast('Deleted.');
          refresh();
        },
      }, 'Delete')));
  const edit = () => {
    const name = h('input', { class: 'input', value: d.name });
    const period = h('input', { class: 'input', value: d.period, placeholder: 'e.g. Oct 2026' });
    const phase = phaseSelect(d.phase);
    const tab = h('select', { class: 'select', disabled: d.kind === 'doc' }, TAB_ORDER.map((t) => h('option', { value: t, selected: t === d.tab }, TAB_META[t].label)));
    tr.replaceChildren(
      h('td', null, name), h('td', null, period), h('td', null, phase), h('td', { colspan: 3 }, tab),
      h('td', { class: 'nowrap', style: { textAlign: 'right' } },
        h('button', { class: 'btn sm ghost', onclick: show }, 'Cancel'),
        h('button', {
          class: 'btn sm primary',
          onclick: async () => {
            try {
              await api('PATCH', `/api/admin/datasets/${d.id}`, { name: name.value, period: period.value, phase: phase.value, tab: tab.value });
              toast('Saved.');
              refresh();
            } catch (err) { toast(err.message, true); }
          },
        }, 'Save')));
  };
  show();
  return tr;
}

/* ---------- upload ---------- */

function dropzone(accept, label, hint, onFile) {
  const input = h('input', { type: 'file', accept });
  const zone = h('label', { class: 'dropzone' }, input,
    h('div', { style: { fontSize: '30px' } }, '📤'),
    h('strong', null, label),
    h('div', { class: 'muted small' }, hint));
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  return zone;
}

function renderUpload(body) {
  const p = A.current.project;
  const excelArea = h('div');
  const excel = h('div', { class: 'card card-pad' },
    h('h3', { style: { marginTop: 0 } }, '📊 Excel workbook'),
    h('p', { class: 'muted small', style: { marginTop: 0 } },
      'Keyword lists, ranking reports, on-page SEO, backlinks, prompts and article plans. Every sheet is detected and you choose which tab it goes to. ',
      'Upload the updated ranking sheet each month with the same name — it becomes a new report month and the client sees movement.'),
    excelArea);

  const showDrop = () => excelArea.replaceChildren(dropzone('.xlsx', 'Drop an .xlsx file or click to choose', 'Columns are kept exactly as in your sheet.', async (file) => {
    excelArea.replaceChildren(h('div', { class: 'spinner' }));
    const fd = new FormData();
    fd.append('file', file);
    try {
      const prev = await api('POST', `/api/admin/projects/${p.id}/excel/preview`, fd);
      showMapping(prev);
    } catch (err) { toast(err.message, true); showDrop(); }
  }));

  const showMapping = (prev) => {
    const rows = prev.sheets.map((s) => {
      const tab = h('select', { class: 'select' },
        h('option', { value: 'skip', selected: s.suggestedTab === 'skip' }, '— Skip —'),
        TAB_ORDER.map((t) => h('option', { value: t, selected: t === s.suggestedTab }, TAB_META[t].label)));
      const name = h('input', { class: 'input', value: s.name, maxlength: 120 });
      const period = h('input', { class: 'input', value: prev.period, maxlength: 60, style: { maxWidth: '130px' } });
      const phase = phaseSelect('');
      return {
        s, tab, name, period, phase,
        tr: h('tr', null,
          h('td', null, h('strong', null, s.name), s.title ? h('div', { class: 'muted small' }, s.title) : null,
            s.existingVersion ? h('div', { class: 'small', style: { color: 'var(--mint-ink)' } }, '↻ New month for an existing sheet') : null),
          h('td', null, s.rowCount),
          h('td', { class: 'cols-preview' }, s.columns.slice(0, 8).join(' · '), s.columns.length > 8 ? ` · +${s.columns.length - 8} more` : ''),
          h('td', null, tab), h('td', null, name), h('td', null, period), h('td', null, phase)),
      };
    });
    const importBtn = h('button', { class: 'btn primary' }, 'Import selected sheets');
    importBtn.addEventListener('click', async () => {
      const sheets = rows.filter((r) => r.tab.value !== 'skip').map((r) => ({ index: r.s.index, tab: r.tab.value, name: r.name.value, period: r.period.value, phase: r.phase.value }));
      if (!sheets.length) { toast('Choose a tab for at least one sheet.', true); return; }
      importBtn.disabled = true;
      try {
        const r = await api('POST', `/api/admin/projects/${p.id}/excel/import`, { uploadId: prev.uploadId, sheets });
        toast(`Imported ${r.created.length} ${r.created.length === 1 ? 'sheet' : 'sheets'}.`);
        location.hash = `#/project/${p.id}/content`;
      } catch (err) { toast(err.message, true); importBtn.disabled = false; }
    });
    excelArea.replaceChildren(
      h('div', { class: 'muted small', style: { marginBottom: '8px' } }, `File: ${prev.filename}`),
      h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'plain' },
        h('thead', null, h('tr', null, h('th', null, 'Sheet'), h('th', null, 'Rows'), h('th', null, 'Columns'), h('th', null, 'Show in tab'), h('th', null, 'Name shown to client'), h('th', null, 'Report month'), h('th', null, 'Phase'))),
        h('tbody', null, rows.map((r) => r.tr)))),
      h('div', { class: 'row-flex', style: { justifyContent: 'flex-end', marginTop: '14px' } },
        h('button', { class: 'btn ghost', onclick: showDrop }, 'Choose another file'), importBtn));
  };
  showDrop();

  const docArea = h('div');
  const period = h('input', { class: 'input', placeholder: 'Report month, e.g. Oct 2026', value: new Date().toLocaleString('en-GB', { month: 'short', year: 'numeric' }) });
  const docName = h('input', { class: 'input', placeholder: 'Name shown to client (defaults to the document title)' });
  const docPhase = phaseSelect('');
  const showDocDrop = () => docArea.replaceChildren(dropzone('.docx', 'Drop a .docx file or click to choose', 'Same format as “Blog Articles for Review”.', async (file) => {
    docArea.replaceChildren(h('div', { class: 'spinner' }));
    const fd = new FormData();
    fd.append('file', file);
    fd.append('period', period.value);
    fd.append('phase', docPhase.value);
    fd.append('name', docName.value);
    try {
      const r = await api('POST', `/api/admin/projects/${p.id}/docx`, fd);
      toast(`Uploaded ${r.articles} ${r.articles === 1 ? 'article' : 'articles'}${r.checks ? ` and ${r.checks} review points` : ''}.`);
      location.hash = `#/project/${p.id}/content`;
    } catch (err) { toast(err.message, true); showDocDrop(); }
  }));
  showDocDrop();
  const doc = h('div', { class: 'card card-pad' },
    h('h3', { style: { marginTop: 0 } }, '✍️ Blog articles (Word)'),
    h('p', { class: 'muted small', style: { marginTop: 0 } },
      'Each “Article 1: …”, “Article 2: …” heading becomes its own article with its SEO details table. ',
      '“For your review” checkbox items (☐) become points the client confirms one by one. Images and keyword highlights are kept.'),
    h('div', { class: 'two-col', style: { marginBottom: '12px' } }, docName, h('div', { class: 'row-flex', style: { flexWrap: 'nowrap' } }, period, docPhase)),
    docArea);

  body.append(h('div', { style: { display: 'grid', gap: '18px' } }, excel, doc));
}

/* ---------- feedback inbox ---------- */

function renderFeedback(body) {
  const { project: p, feedback } = A.current;
  const f = A.fbFilter;
  const threads = threadsOf(feedback).reverse().filter((t) => {
    if (f.tab !== 'all' && t.root.tab !== f.tab) return false;
    if (f.status === 'action') return t.root.status === 'open';
    if (f.status === 'resolved') return t.root.status === 'resolved';
    if (f.status === 'approvals') return t.root.type === 'approve';
    return true;
  });
  const statusSeg = h('div', { class: 'seg' }, [['action', 'Needs answer'], ['all', 'All activity'], ['approvals', 'Approvals'], ['resolved', 'Resolved']].map(([k, l]) => h('button', {
    class: f.status === k ? 'active' : '', onclick: () => { f.status = k; renderProject(); },
  }, l)));
  const tabSel = h('select', { class: 'select', style: { width: 'auto' } },
    h('option', { value: 'all' }, 'All tabs'), TAB_ORDER.map((t) => h('option', { value: t, selected: f.tab === t }, TAB_META[t].label)));
  tabSel.addEventListener('change', () => { f.tab = tabSel.value; renderProject(); });

  body.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'left' }, statusSeg, tabSel),
      h('div', { class: 'right' }, h('a', { class: 'btn', href: `/api/admin/projects/${p.id}/feedback.csv` }, '⬇ Export CSV'))),
    threads.length
      ? h('div', { style: { display: 'grid', gap: '12px', maxWidth: '860px' } }, threads.map((t) => renderThread(t, {
        showItem: true,
        onReply: async (root, text) => {
          await api('POST', `/api/admin/feedback/${root.id}/reply`, { comment: text, resolve: root.status === 'open' });
          toast('Reply posted — the client sees it on their link.');
          refresh();
        },
        actions: (root) => [
          root.status === 'open'
            ? h('button', { class: 'btn ghost sm', onclick: () => setStatus(root.id, 'resolved') }, '✓ Mark resolved')
            : (root.type === 'change' || root.type === 'question') ? h('button', { class: 'btn ghost sm', onclick: () => setStatus(root.id, 'open') }, 'Reopen') : null,
          h('button', { class: 'btn ghost sm danger', onclick: () => removeFeedback(root.id) }, 'Delete'),
        ].filter(Boolean),
        replyActions: (r) => h('button', { class: 'btn ghost sm danger', style: { padding: '0 6px' }, onclick: () => removeFeedback(r.id) }, '✕'),
      })))
      : h('div', { class: 'card empty' }, h('div', { class: 'big' }, f.status === 'action' ? '🎉' : '📭'), f.status === 'action' ? 'All caught up — no open questions or change requests.' : 'Nothing here yet.'));
}

async function setStatus(id, status) {
  await api('PATCH', `/api/admin/feedback/${id}`, { status });
  toast(status === 'resolved' ? 'Marked as resolved.' : 'Reopened.');
  refresh();
}

async function removeFeedback(id) {
  if (!confirm('Delete this comment permanently?')) return;
  await api('DELETE', `/api/admin/feedback/${id}`);
  refresh();
}

/* ---------- settings ---------- */

function renderSettings(body) {
  const p = A.current.project;
  const name = h('input', { class: 'input', value: p.name, maxlength: 120 });
  const client = h('input', { class: 'input', value: p.client_name, maxlength: 120 });
  const site = h('input', { class: 'input', value: p.website, maxlength: 300 });
  const form = h('form', { class: 'card card-pad', style: { maxWidth: '640px', display: 'grid', gap: '12px' } },
    h('h3', { style: { margin: 0 } }, 'Project details'),
    h('label', { class: 'field' }, 'Project name', name),
    h('label', { class: 'field' }, 'Client name', client),
    h('label', { class: 'field' }, 'Website', site),
    h('div', null, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/admin/projects/${p.id}`, { name: name.value, client_name: client.value, website: site.value });
      toast('Saved.');
      refresh();
    } catch (err) { toast(err.message, true); }
  });

  body.append(form,
    h('div', { class: 'card card-pad', style: { maxWidth: '640px', marginTop: '16px', display: 'grid', gap: '10px' } },
      h('h3', { style: { margin: 0 } }, 'Review link'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Anyone with the link can view and comment. If it was shared with the wrong person, make a new one — the old link stops working immediately.'),
      h('div', null, h('button', {
        class: 'btn',
        onclick: async () => {
          if (!confirm('Create a new link? The current link will stop working.')) return;
          await api('PATCH', `/api/admin/projects/${p.id}`, { regenerate_token: true });
          toast('New link created.');
          refresh();
        },
      }, '↻ Create a new link'))),
    h('div', { class: 'card card-pad', style: { maxWidth: '640px', marginTop: '16px', display: 'grid', gap: '10px' } },
      h('h3', { style: { margin: 0, color: 'var(--red-ink)' } }, 'Delete project'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Removes all uploads and client feedback for this project.'),
      h('div', null, h('button', {
        class: 'btn danger',
        onclick: async () => {
          const typed = window.prompt(`Type the project name to delete it:\n${p.name}`);
          if (typed !== p.name) { if (typed !== null) toast('Name did not match.', true); return; }
          await api('DELETE', `/api/admin/projects/${p.id}`);
          location.hash = '#/';
        },
      }, 'Delete project'))));
}

/* ---------- boot ---------- */

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.status === 401) { A.authed = false; showLogin(); } else if (e.reason) toast(e.reason.message, true);
});
window.addEventListener('hashchange', () => { if (A.authed) route(); });
(async function init() {
  const me = await api('GET', '/api/admin/me');
  A.agency = me.agency;
  A.authed = me.admin;
  if (!me.admin) showLogin();
  else route();
})();
