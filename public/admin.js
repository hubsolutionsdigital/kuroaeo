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
  const views = [['content', 'Content'], ['upload', 'Upload'], ['performance', 'Performance'], ['feedback', `Feedback${open ? ` (${open})` : ''}`], ['settings', 'Settings']];
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
  ({ content: renderContent, upload: renderUpload, performance: renderPerformanceAdmin, feedback: renderFeedback, settings: renderSettings }[A.view] || renderContent)(body);
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
      d.kind === 'doc' ? h('button', { class: 'btn sm ghost', onclick: () => editOverview(d, p) }, 'Edit overview') : null,
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
    // Word documents can move between Blogs and Landing Pages; sheets can go to any tab.
    const tabChoices = d.kind === 'doc' ? ['blogs', 'gbp', 'landing'] : TAB_ORDER;
    const tab = h('select', { class: 'select' }, tabChoices.map((t) => h('option', { value: t, selected: t === d.tab }, TAB_META[t].label)));
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

// Edit the overview text of a blog or landing page document in place, e.g. to
// remove a question that no longer applies. The review points stay as they are.
async function editOverview(d, p) {
  let payload;
  try { payload = await api('GET', `/api/admin/projects/${p.id}/datasets/${d.id}`); } catch (err) { toast(err.message, true); return; }
  const SLOT = '<div data-checklist="" contenteditable="false" class="ck-slot">☐ The review points go here (clients confirm them one by one)</div>';
  const editor = h('div', { class: 'prose overview-editor', contenteditable: 'true', spellcheck: 'true',
    html: (payload.dataset.meta.introHtml || '').replace(/<div data-checklist(="")?><\/div>/g, SLOT) });
  editor.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  const save = h('button', { class: 'btn primary' }, 'Save overview');
  save.addEventListener('click', async () => {
    const copy = editor.cloneNode(true);
    copy.querySelectorAll('.ck-slot').forEach((el) => { const slot = document.createElement('div'); slot.setAttribute('data-checklist', ''); el.replaceWith(slot); });
    save.disabled = true;
    try {
      await api('PATCH', `/api/admin/datasets/${d.id}`, { introHtml: copy.innerHTML });
      toast('Overview saved. The client sees the change straight away.');
      closeDrawer();
    } catch (err) { toast(err.message, true); save.disabled = false; }
  });
  openDrawer('Edit overview', `${d.name}: click into the text to change or delete it, like in Word.`,
    [h('div', { class: 'muted small', style: { marginBottom: '10px' } }, 'To remove a line, select it and press Delete. Your edits here are not highlighted to the client.'), editor],
    [h('button', { class: 'btn ghost', onclick: closeDrawer }, 'Cancel'), save]);
  editor.focus();
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

/* ---------- pick a Google Sheet instead of uploading an .xlsx ---------- */

// purpose: 'upload' (sheets for the review tabs) or 'metrics' (monthly numbers).
function googleSheetPicker(p, purpose, onPick) {
  const box = h('div', { class: 'gsheet' }, h('div', { class: 'muted small' }, 'Checking Google…'));
  const back = purpose === 'upload' ? 'upload' : 'performance';
  Promise.all([api('GET', '/api/admin/google/status'), api('GET', `/api/admin/projects/${p.id}/gsheet`)]).then(([g, saved]) => {
    const head = h('div', { class: 'gsheet-head' }, h('strong', null, '🟩 From Google Sheets'));
    if (g.mode !== 'oauth') {
      box.replaceChildren(head, h('div', { class: 'muted small' }, g.oauthConfigured
        ? h('span', null, 'Connect your Google account to pick a spreadsheet instead of downloading it. ', h('a', { href: `/api/admin/google/connect?project=${p.id}&back=${back}` }, 'Connect Google account'))
        : h('span', null, 'Set up “Connect Google account” on the Performance tab to pick spreadsheets from Google Sheets.')));
      return;
    }
    if (!g.sheets) {
      box.replaceChildren(head, h('div', { class: 'small row-flex' },
        h('span', { class: 'muted' }, `Connected as ${g.email}, but without access to Google Sheets.`),
        h('a', { class: 'btn sm', href: `/api/admin/google/connect?project=${p.id}&back=${back}` }, 'Reconnect Google'),
        h('span', { class: 'muted' }, 'and tick the Google Drive box.')));
      return;
    }
    const last = (saved.sheets || {})[purpose];
    const search = h('input', { class: 'input', placeholder: 'Search your spreadsheets…', style: { maxWidth: '260px' } });
    const select = h('select', { class: 'select', 'aria-label': 'Spreadsheet' }, h('option', { value: '' }, 'Loading your spreadsheets…'));
    const go = h('button', { class: 'btn primary' }, purpose === 'upload' ? 'Read this sheet' : 'Import numbers');
    const load = async (q) => {
      try {
        const { files } = await api('GET', `/api/admin/google/sheets?q=${encodeURIComponent(q || '')}`);
        const opts = files.map((f) => h('option', { value: f.id, selected: last && last.id === f.id },
          `${f.name}${f.isGoogleSheet ? '' : ' (.xlsx)'} · edited ${new Date(f.modifiedTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`));
        if (last && !files.some((f) => f.id === last.id) && !q) opts.unshift(h('option', { value: last.id, selected: true }, `${last.name} (last used)`));
        select.replaceChildren(...(opts.length ? opts : [h('option', { value: '' }, q ? 'No spreadsheets match' : 'No spreadsheets found')]));
      } catch (err) { select.replaceChildren(h('option', { value: '' }, err.message)); }
    };
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(search.value.trim()), 300); });
    const run = async (id) => {
      if (!id) { toast('Choose a spreadsheet.', true); return; }
      go.disabled = true;
      try { await onPick(id); } catch (err) { toast(err.message, true); } finally { go.disabled = false; }
    };
    go.addEventListener('click', () => run(select.value));
    box.replaceChildren(head,
      last ? h('div', { class: 'small row-flex', style: { marginBottom: '8px' } },
        h('span', { class: 'muted' }, 'Last used: ', h('strong', null, last.name)),
        h('button', { class: 'btn sm', onclick: (e) => { e.currentTarget.disabled = true; run(last.id); } }, '↻ Get the latest')) : null,
      h('div', { class: 'row-flex' }, search, select, go),
      h('div', { class: 'muted small', style: { marginTop: '6px' } }, `Reads the sheet as it is right now from ${g.email}’s Google Drive. Nothing is changed in Google Sheets.`));
    load('');
  }, (err) => box.replaceChildren(h('div', { class: 'muted small' }, err.message)));
  return box;
}

function renderUpload(body) {
  const p = A.current.project;
  const excelArea = h('div');
  const excel = h('div', { class: 'card card-pad' },
    h('h3', { style: { marginTop: 0 } }, '📊 Excel workbook'),
    h('p', { class: 'muted small', style: { marginTop: 0 } },
      'Keyword lists, ranking reports, on-page SEO, backlinks, prompts and article plans. Every sheet is detected and you choose which tab it goes to. ',
      'Upload the updated ranking sheet each month with the same name — it becomes a new report month and the client sees movement. ',
      'For AI rankings, add columns such as “AI Overview (Month 4)”, “AI Mode (Month 4)” or “ChatGPT (Month 4)”: 1 = named first, 2, 3… = position, Yes = shown, blank or No = not shown.'),
    excelArea,
    h('div', { class: 'or-line' }, h('span', null, 'or')),
    googleSheetPicker(p, 'upload', async (fileId) => {
      excelArea.replaceChildren(h('div', { class: 'spinner' }));
      try {
        showMapping(await api('POST', `/api/admin/projects/${p.id}/gsheet/preview`, { fileId }));
        excelArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { showDrop(); throw err; }
    }));

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
  const docTab = h('select', { class: 'select', 'aria-label': 'Section', style: { width: 'auto' } },
    h('option', { value: 'blogs' }, '✍️ Blogs'), h('option', { value: 'gbp' }, '📍 GBP Posts'), h('option', { value: 'landing' }, '🧭 Landing Pages'));
  const showDocDrop = () => docArea.replaceChildren(dropzone('.docx', 'Drop a .docx file or click to choose', 'Same format as “Blog Articles for Review”.', async (file) => {
    docArea.replaceChildren(h('div', { class: 'spinner' }));
    const fd = new FormData();
    fd.append('file', file);
    fd.append('period', period.value);
    fd.append('phase', docPhase.value);
    fd.append('tab', docTab.value);
    fd.append('name', docName.value);
    try {
      const r = await api('POST', `/api/admin/projects/${p.id}/docx`, fd);
      const noun = TAB_META[docTab.value].noun;
      toast(`Uploaded ${r.articles} ${r.articles === 1 ? noun : `${noun}s`}${r.checks ? ` and ${r.checks} review points` : ''}.`);
      location.hash = `#/project/${p.id}/content`;
    } catch (err) { toast(err.message, true); showDocDrop(); }
  }));
  showDocDrop();
  const doc = h('div', { class: 'card card-pad' },
    h('h3', { style: { marginTop: 0 } }, '✍️ Blogs, 📍 GBP Posts & 🧭 Landing Pages (Word)'),
    h('p', { class: 'muted small', style: { marginTop: 0 } },
      'Choose the section, then upload. Each “Article 1: …”, “Post 1 · …” or “Landing Page 1: …” heading (or numbered heading) becomes its own page with its SEO or post details. ',
      '“For your review” checkbox items (☐) become points the client confirms one by one. Images and keyword highlights are kept.'),
    h('div', { class: 'two-col', style: { marginBottom: '12px' } }, docName, h('div', { class: 'row-flex', style: { flexWrap: 'nowrap' } }, docTab, period, docPhase)),
    docArea);

  body.append(h('div', { style: { display: 'grid', gap: '18px' } }, excel, doc));
}

/* ---------- performance (GA4, Search Console, SEMrush, monthly numbers) ---------- */

const METRIC_NAMES = {
  'gsc:clicks': 'Search Console clicks', 'gsc:impressions': 'Search Console impressions', 'gsc:ctr': 'Search Console CTR', 'gsc:position': 'Search Console average position',
  'ga4:organic_sessions': 'GA4 organic sessions', 'ga4:organic_key_events': 'GA4 organic key events', 'ga4:organic_revenue': 'GA4 organic revenue', 'ga4:ai_sessions': 'GA4 visits from AI assistants',
};

async function renderPerformanceAdmin(body) {
  const p = A.current.project;
  body.append(h('div', { class: 'spinner' }));
  let data;
  try { data = await api('GET', `/api/admin/projects/${p.id}/analytics`); } catch (err) { body.replaceChildren(h('div', { class: 'card empty' }, err.message)); return; }
  const s = data.settings || {};
  const sem = s.semrush || {};

  const ga4 = h('input', { class: 'input', id: 'pf-ga4', value: s.ga4Property || '', placeholder: 'e.g. 412345678', inputmode: 'numeric' });
  const gsc = h('input', { class: 'input', id: 'pf-gsc', value: s.gscSite || '', placeholder: 'sc-domain:example.com or https://www.example.com/' });
  const start = h('input', { class: 'input', id: 'pf-start', type: 'month', value: s.start || '' });
  const country = h('select', { class: 'select', id: 'pf-country' }, [['sgp', 'Singapore'], ['mys', 'Malaysia'], ['aus', 'Australia'], ['gbr', 'United Kingdom'], ['usa', 'United States'], ['hkg', 'Hong Kong'], ['', 'All countries']]
    .map(([v, l]) => h('option', { value: v, selected: (s.country ?? 'sgp') === v }, l)));
  const semOn = h('input', { type: 'checkbox', id: 'pf-sem-on', checked: Boolean(sem.enabled) });
  const semClient = h('input', { type: 'checkbox', id: 'pf-sem-client', checked: Boolean(sem.clientToggle) });
  const semDomain = h('input', { class: 'input', id: 'pf-sem-domain', value: sem.domain || p.website || '', placeholder: 'example.com' });
  const semDb = h('select', { class: 'select', id: 'pf-sem-db' }, [['sg', 'Singapore'], ['my', 'Malaysia'], ['au', 'Australia'], ['uk', 'United Kingdom'], ['us', 'United States'], ['hk', 'Hong Kong']]
    .map(([v, l]) => h('option', { value: v, selected: (sem.database || 'sg') === v }, l)));

  const dfs = data.dashboard.dataforseo || {};
  const dfsOn = h('input', { type: 'checkbox', id: 'pf-dfs-on', checked: Boolean(dfs.enabled) });
  const dfsDomain = h('input', { class: 'input', value: dfs.domain || (p.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''), placeholder: 'thehearingroom.com.sg' });
  const dfsBrand = h('input', { class: 'input', value: dfs.brand || p.client_name || p.name, placeholder: 'The Hearing Room' });
  const dfsFreq = h('select', { class: 'select' }, [['weekly', 'Every week'], ['daily', 'Every day']].map(([v, l]) => h('option', { value: v, selected: (dfs.frequency || 'weekly') === v }, l)));
  const dfsDevice = h('select', { class: 'select' }, [['desktop', 'Desktop'], ['mobile', 'Mobile']].map(([v, l]) => h('option', { value: v, selected: (dfs.device || 'desktop') === v }, l)));
  const dfsLocation = h('input', { class: 'input', value: dfs.location || 'Singapore', placeholder: 'Singapore' });

  const save = async () => {
    await api('PUT', `/api/admin/projects/${p.id}/analytics`, {
      ga4Property: ga4.value, gscSite: gsc.value, start: start.value, country: country.value,
      semrush: { enabled: semOn.checked, clientToggle: semClient.checked, domain: semDomain.value, database: semDb.value },
      dataforseo: { enabled: dfsOn.checked, domain: dfsDomain.value, brand: dfsBrand.value, frequency: dfsFreq.value, device: dfsDevice.value, location: dfsLocation.value },
    });
  };
  const sync = async (btn, only) => {
    btn.disabled = true;
    try {
      await save();
      const r = await api('POST', `/api/admin/projects/${p.id}/analytics/sync`, { only });
      if (r.errors.length) toast(r.errors[0], true);
      else if (!r.synced.length) toast('Nothing to sync yet. Add a property first.', true);
      else toast(`Synced ${r.synced.map((x) => x.toUpperCase()).join(', ')}.`);
      refresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  };

  const saveBtn = h('button', { class: 'btn primary', onclick: async () => { try { await save(); toast('Saved.'); refresh(); } catch (err) { toast(err.message, true); } } }, 'Save');
  const syncBtn = h('button', { class: 'btn' }, '↻ Sync Google now');
  syncBtn.addEventListener('click', () => sync(syncBtn));
  const semBtn = h('button', { class: 'btn' }, '↻ Fetch SEMrush rankings');
  semBtn.addEventListener('click', () => sync(semBtn, 'semrush'));

  const g = data.google || {};
  const note = (...kids) => h('div', { class: 'small', style: { background: 'var(--amber)', color: 'var(--amber-ink)', padding: '10px 12px', borderRadius: '10px', display: 'grid', gap: '6px' } }, ...kids);
  const copyBox = (text) => h('div', { class: 'linkbox' }, h('code', null, text), h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => {}) }, 'Copy'));
  let access;
  if (g.mode === 'oauth') {
    access = h('div', { class: 'small', style: { display: 'grid', gap: '8px' } },
      h('div', { class: 'row-flex' },
        h('span', { class: 'chip', style: { background: 'var(--ok)', color: 'var(--ok-ink)' } }, '✓ Connected'),
        h('span', null, 'Reading data as ', h('strong', null, g.email || 'your Google account')),
        h('button', {
          class: 'btn sm ghost danger',
          onclick: async () => {
            if (!confirm('Disconnect Google? Dashboards keep the numbers already synced, but daily updates stop until you connect again.')) return;
            await api('POST', '/api/admin/google/disconnect'); toast('Google disconnected.'); refresh();
          },
        }, 'Disconnect')),
      h('div', { class: 'muted' }, 'This account needs access to the client’s GA4 property (Viewer) and Search Console property. Ask the client to add ', h('strong', null, g.email || 'it'), ' if it is not listed below.'),
      g.sheets ? null : h('div', { class: 'row-flex' }, h('span', { class: 'muted' }, 'To pick Google Sheets instead of uploading .xlsx files, enable the “Google Drive API” in Google Cloud, then'),
        h('a', { class: 'btn sm', href: `/api/admin/google/connect?project=${p.id}` }, 'Reconnect Google')));
  } else if (g.oauthConfigured) {
    access = h('div', { class: 'row-flex' },
      h('a', { class: 'btn primary', href: `/api/admin/google/connect?project=${p.id}` }, 'Connect Google account'),
      h('span', { class: 'muted small' }, 'Sign in once with the Google account that can see your clients’ GA4 and Search Console.'),
      g.mode === 'service' ? h('span', { class: 'muted small' }, `Currently using the service account ${g.email}.`) : null);
  } else if (g.mode === 'service') {
    access = h('div', { class: 'small', style: { display: 'grid', gap: '6px' } },
      h('div', null, 'Ask the client to add this email as a ', h('strong', null, 'Viewer'), ' in GA4 (Admin → Property access management) and as a ', h('strong', null, 'Restricted user'), ' in Search Console (Settings → Users and permissions):'),
      copyBox(g.email));
  } else {
    access = note(
      h('div', null, h('strong', null, 'Google is not connected yet.'), ' One-time setup in Google Cloud (console.cloud.google.com):'),
      h('ol', { style: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' } },
        h('li', null, 'APIs & Services → Library: enable “Google Analytics Data API”, “Google Search Console API”, “Google Analytics Admin API” and “Google Drive API” (for picking Google Sheets).'),
        h('li', null, 'OAuth consent screen (Google Auth Platform): choose ', h('strong', null, 'Internal'), ', app name “Review Portal”, your email as support contact.'),
        h('li', null, 'Clients → Create client → ', h('strong', null, 'Web application'), '. Under “Authorised redirect URIs” add:'),
        copyBox(g.redirectUri || `${location.origin}/api/admin/google/callback`),
        h('li', null, 'Copy the Client ID and Client secret into Railway → Variables as ', h('code', null, 'GOOGLE_CLIENT_ID'), ' and ', h('code', null, 'GOOGLE_CLIENT_SECRET'), '. After Railway redeploys, a “Connect Google account” button appears here.')));
  }

  const ga4List = h('datalist', { id: 'pf-ga4-list' });
  const gscList = h('datalist', { id: 'pf-gsc-list' });
  ga4.setAttribute('list', 'pf-ga4-list');
  gsc.setAttribute('list', 'pf-gsc-list');
  const pickNote = h('div', { class: 'muted small' });
  if (g.mode === 'oauth') {
    pickNote.textContent = 'Loading the properties this account can see…';
    api('GET', '/api/admin/google/properties').then((r) => {
      ga4List.replaceChildren(...r.ga4.map((x) => h('option', { value: x.id }, x.name)));
      gscList.replaceChildren(...r.gsc.map((x) => h('option', { value: x })));
      const parts = [];
      if (r.gsc.length || r.ga4.length) parts.push(`Found ${r.gsc.length} Search Console and ${r.ga4.length} GA4 ${r.ga4.length === 1 ? 'property' : 'properties'}. Click a box to pick from the list.`);
      else parts.push('This account cannot see any GA4 or Search Console properties yet.');
      pickNote.textContent = [...parts, ...r.errors].join(' ');
    }, (err) => { pickNote.textContent = err.message; });
  }

  const googleCard = h('div', { class: 'card card-pad', style: { display: 'grid', gap: '12px' } },
    h('h3', { style: { margin: 0 } }, '📊 Google Analytics 4 & Search Console'),
    access, ga4List, gscList,
    h('div', { class: 'two-col' },
      h('label', { class: 'field' }, 'GA4 property ID', ga4),
      h('label', { class: 'field' }, 'Search Console property', gsc),
      h('label', { class: 'field' }, 'Campaign start month (for “since we started” growth)', start),
      h('label', { class: 'field' }, 'Keyword positions for searches from', country)),
    g.mode === 'oauth' ? pickNote : null,
    h('div', { class: 'row-flex' }, saveBtn, syncBtn,
      s.lastSync ? h('span', { class: 'muted small' }, `Last synced ${timeAgo(s.lastSync.replace('T', ' ').slice(0, 19))}. Data refreshes daily.`) : null),
    (s.lastErrors || []).length ? h('div', { class: 'small', style: { color: 'var(--red-ink)' } }, s.lastErrors.join(' · ')) : null);

  const dfsBtn = h('button', { class: 'btn primary' }, '↻ Check all keywords now');
  dfsBtn.addEventListener('click', () => sync(dfsBtn, 'dataforseo'));
  const estimate = h('span', { class: 'muted small' });
  const updateEstimate = () => {
    const runs = dfsFreq.value === 'daily' ? 30 : 4.3;
    const monthly = (dfs.keywords || 0) * runs * (dfs.costPerCheck || 0.0026);
    estimate.textContent = dfs.keywords
      ? `${dfs.keywords} keywords × ${dfsFreq.value === 'daily' ? 'every day' : 'every week'} ≈ US$${monthly < 1 ? monthly.toFixed(2) : monthly.toFixed(1)} a month.`
      : 'Upload the keyword sheet first: every keyword in it is checked.';
  };
  dfsFreq.addEventListener('change', updateEstimate);
  updateEstimate();
  const dfsCard = h('div', { class: 'card card-pad', style: { display: 'grid', gap: '12px' } },
    h('h3', { style: { margin: 0 } }, '✨ Google AI Overview & live rankings (DataForSEO)'),
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Checks Google for every tracked keyword: whether the business is named in the AI Overview (and in which place), and the exact position of the website. Clients see it as “✨ Google AI Overview” on their Performance page, replacing the AI Overview column in the ranking sheet.'),
    dfs.configured ? null : h('div', { class: 'small', style: { background: 'var(--amber)', color: 'var(--amber-ink)', padding: '10px 12px', borderRadius: '10px' } },
      'Create an account at dataforseo.com (US$50 minimum top-up, lasts a long time at this volume), then add ', h('code', null, 'DATAFORSEO_LOGIN'), ' and ', h('code', null, 'DATAFORSEO_PASSWORD'), ' (the API password from the dashboard) in Railway → Variables.'),
    h('div', { class: 'two-col' },
      h('label', { class: 'field' }, 'Website domain (to find in Google)', dfsDomain),
      h('label', { class: 'field' }, 'Business name (as it appears on Google)', dfsBrand),
      h('label', { class: 'field' }, 'How often', dfsFreq),
      h('label', { class: 'field' }, 'Searches from', dfsLocation),
      h('label', { class: 'field' }, 'Device', dfsDevice)),
    h('label', { class: 'row-flex small' }, dfsOn, 'Check this project’s keywords automatically'),
    h('div', { class: 'row-flex' }, dfsBtn, estimate),
    dfsStatus(dfs, s), dfsTestBox(p));

  const semCard = h('div', { class: 'card card-pad', style: { display: 'grid', gap: '12px' } },
    h('h3', { style: { margin: 0 } }, '📡 Live rankings (SEMrush), optional'),
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Daily positions from SEMrush, so clients can check our numbers against a tool they know. Clients see a “Live rankings” switch that is off by default, so nobody is overwhelmed.'),
    data.semrushConfigured ? null : h('div', { class: 'small', style: { background: 'var(--amber)', color: 'var(--amber-ink)', padding: '10px 12px', borderRadius: '10px' } },
      'Add your SEMrush API key as a Railway variable named ', h('code', null, 'SEMRUSH_API_KEY'), '. Each daily fetch uses SEMrush API units.'),
    h('div', { class: 'two-col' },
      h('label', { class: 'field' }, 'Website domain', semDomain),
      h('label', { class: 'field' }, 'Google database', semDb)),
    h('label', { class: 'row-flex small' }, semOn, 'Fetch SEMrush rankings for this project'),
    h('label', { class: 'row-flex small' }, semClient, 'Let the client switch on live rankings in their dashboard'),
    h('div', { class: 'row-flex' }, semBtn,
      data.dashboard.liveFetchedAt.semrush ? h('span', { class: 'muted small' }, `Last fetched ${timeAgo(data.dashboard.liveFetchedAt.semrush)}`) : null));

  const series = data.dashboard.series;
  const rows = [];
  for (const [src, metrics] of Object.entries(series)) {
    for (const [metric, months] of Object.entries(metrics)) {
      const ms = Object.keys(months).sort();
      rows.push(h('tr', null,
        h('td', null, METRIC_NAMES[`${src}:${metric}`] || metric, src === 'manual' ? h('span', { class: 'chip', style: { marginLeft: '8px' } }, 'Uploaded') : null),
        h('td', { class: 'muted small' }, `${ms.length} ${ms.length === 1 ? 'month' : 'months'} · ${ms[0]} to ${ms[ms.length - 1]}`),
        h('td', { style: { textAlign: 'right' } }, h('button', {
          class: 'btn sm ghost danger',
          onclick: async () => { if (!confirm('Delete these numbers?')) return; await api('DELETE', `/api/admin/projects/${p.id}/analytics/metrics`, { source: src, metric }); refresh(); },
        }, 'Delete'))));
    }
  }
  const uploadArea = h('div');
  const showDrop = () => uploadArea.replaceChildren(dropzone('.xlsx', 'Drop an .xlsx file with monthly numbers', 'Columns: Month, then one column per number (e.g. Enquiries, Revenue). A Search Console “Dates” export also works.', async (file) => {
    uploadArea.replaceChildren(h('div', { class: 'spinner' }));
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api('POST', `/api/admin/projects/${p.id}/analytics/upload`, fd);
      toast(`Imported ${r.found.join('; ')}.`);
      refresh();
    } catch (err) { toast(err.message, true); showDrop(); }
  }));
  showDrop();
  const dataCard = h('div', { class: 'card card-pad', style: { display: 'grid', gap: '12px' } },
    h('h3', { style: { margin: 0 } }, '📈 Monthly numbers'),
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Everything the client dashboard draws from. Upload business results the client tracks elsewhere (enquiries, bookings, revenue), or Search Console data before access is granted.'),
    rows.length ? h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'plain' }, h('tbody', null, rows))) : h('div', { class: 'muted small' }, 'No numbers yet.'),
    uploadArea,
    h('div', { class: 'or-line' }, h('span', null, 'or')),
    googleSheetPicker(p, 'metrics', async (fileId) => {
      const r = await api('POST', `/api/admin/projects/${p.id}/analytics/gsheet`, { fileId });
      toast(`Imported ${r.found.join('; ')}.`);
      refresh();
    }));

  body.replaceChildren(h('div', { style: { display: 'grid', gap: '16px', maxWidth: '980px' } },
    h('div', { class: 'between' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Connect the client’s data to show how the SEO and AEO work is growing their business.'),
      h('a', { class: 'btn', href: `${clientUrl(p)}#performance`, target: '_blank', rel: 'noopener' }, 'View client dashboard ↗')),
    googleCard, dfsCard, semCard, dataCard));
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

  // Words the client changed directly in blogs and landing pages.
  const editsBox = h('div');
  api('GET', `/api/admin/projects/${p.id}/edits`).then(({ edits }) => {
    const shown = edits.filter((e) => f.tab === 'all' || e.tab === f.tab);
    if (!shown.length) return;
    const byItem = new Map();
    for (const e of shown) {
      const k = `${e.dataset_id}|${e.item_key}`;
      if (!byItem.has(k)) byItem.set(k, []);
      byItem.get(k).push(e);
    }
    editsBox.replaceChildren(h('div', { class: 'card card-pad', style: { maxWidth: '860px', marginBottom: '16px' } },
      h('h3', { style: { margin: '0 0 4px' } }, `✏️ Text edited by the client (${shown.length})`),
      h('div', { class: 'muted small', style: { marginBottom: '12px' } }, h('ins', { class: 'ed-ins' }, 'Added words'), ' are highlighted and ', h('del', { class: 'ed-del' }, 'removed words'), ' struck through. Copy the new wording into the article, then upload the updated document.'),
      [...byItem.values()].map((list) => h('div', { style: { marginBottom: '14px' } },
        h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, `${TAB_META[list[0].tab].icon} ${list[0].item_label || list[0].item_key}`, h('span', { class: 'muted small', style: { fontWeight: 400 } }, ` · ${list[0].dataset_name}`)),
        list.map((e) => h('div', { class: 'edit-diff' },
          h('div', { class: 'prose', html: diffHtml(e.original_html, e.html) }),
          h('div', { class: 'between', style: { marginTop: '6px' } },
            h('span', { class: 'muted small' }, `${e.name} · ${timeAgo(e.updated_at)}`),
            h('button', { class: 'btn sm ghost', onclick: () => navigator.clipboard.writeText(new DOMParser().parseFromString(e.html, 'text/html').body.textContent.trim()).then(() => toast('New wording copied.'), () => {}) }, 'Copy new wording'))))))));
  }, () => {});

  body.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'left' }, statusSeg, tabSel),
      h('div', { class: 'right' }, h('a', { class: 'btn', href: `/api/admin/projects/${p.id}/feedback.csv` }, '⬇ Export CSV'))),
    editsBox,
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

/* ---------- DataForSEO status and one-keyword test ---------- */

// What the last check did, in plain words, so a failed or empty check is never silent.
function dfsStatus(dfs, s) {
  const box = (bg, ink, ...kids) => h('div', { class: 'small', style: { background: bg, color: ink, padding: '10px 12px', borderRadius: '10px', display: 'grid', gap: '4px' } }, ...kids);
  const otherErr = (s.lastErrors || []).find((e) => /^DATAFORSEO/i.test(e));
  if (!dfs.configured) return box('var(--amber)', 'var(--amber-ink)', h('strong', null, 'Not connected yet.'), 'DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set in Railway (or Railway has not redeployed since you added them).');
  if (dfs.lastError || (otherErr && !dfs.lastRun)) {
    return box('var(--red)', 'var(--red-ink)', h('strong', null, `⚠ The last check failed${dfs.lastErrorAt ? ` ${timeAgo(dfs.lastErrorAt.replace('T', ' ').slice(0, 19))}` : ''}:`), dfs.lastError || otherErr.replace(/^DATAFORSEO:\s*/i, ''));
  }
  if (!dfs.lastRun) return box('var(--blue)', 'var(--blue-ink)', h('strong', null, 'No check has run yet.'), 'Press “Check all keywords now”. Clients see the ✨ Google AI Overview column on their Performance page after the first check.');
  const sm = dfs.lastSummary || {};
  return box('var(--ok)', 'var(--ok-ink)',
    h('strong', null, `✓ Checked ${dfs.lastCount} keywords ${timeAgo(dfs.lastRun.replace('T', ' ').slice(0, 19))} for US$${dfs.lastCost}.`),
    sm.aiPresent !== undefined ? `Google showed an AI Overview for ${sm.aiPresent} of them. ${dfs.brand || 'The business'} is named in ${sm.shown}${sm.first ? ` (#1 in ${sm.first})` : ''}. The website ranks in the top ${dfs.depth || 20} for ${sm.ranked}.` : null,
    sm.aiPresent === 0 ? 'No AI Overview appeared for any keyword. Google does not show one for every search; try “Test one keyword” below to see what Google returned.' : null);
}

function dfsTestBox(p) {
  const kw = h('input', { class: 'input', placeholder: 'e.g. hearing aid specialist', style: { maxWidth: '320px' } });
  const out = h('div');
  const btn = h('button', { class: 'btn' }, '🔍 Test one keyword');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const r = await api('POST', `/api/admin/projects/${p.id}/dataforseo/test`, { keyword: kw.value });
      out.replaceChildren(h('div', { class: 'small dfs-test' },
        h('div', null, h('strong', null, `“${r.keyword}”`), ` · cost US$${r.cost}`),
        h('div', null, h('strong', null, 'AI Overview: '), r.aiOverview
          ? (r.ai.shown ? `✓ named${r.ai.pos ? `, #${r.ai.pos}` : ''}` : 'shown by Google, but the business is not named in it')
          : 'Google did not show an AI Overview for this search'),
        r.aiSources.length ? h('div', null, h('strong', null, 'Sources in the AI Overview: '), r.aiSources.join(' · ')) : null,
        h('div', null, h('strong', null, 'Website position: '), r.position ? `#${r.position}${r.url ? ` (${r.url})` : ''}` : 'not in the top 20'),
        r.topResults.length ? h('div', { class: 'muted' }, `Top results: ${r.topResults.join(' · ')}`) : null,
        h('div', { class: 'muted' }, `Result types: ${r.itemTypes.join(', ') || 'none'}`)));
    } catch (err) {
      out.replaceChildren(h('div', { class: 'small', style: { color: 'var(--red-ink)' } }, err.message));
    }
    btn.disabled = false;
  });
  return h('div', { style: { display: 'grid', gap: '8px', borderTop: '1px solid var(--line)', paddingTop: '12px' } },
    h('div', { class: 'muted small' }, 'Not sure it works? Test one keyword: it shows what Google returned, whether there was an AI Overview, and which sources it named (about US$0.006).'),
    h('div', { class: 'row-flex' }, kw, btn), out);
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

  // Who is emailed when the client submits feedback.
  const alertsCard = h('div', { class: 'card card-pad', style: { maxWidth: '640px', marginTop: '16px', display: 'grid', gap: '10px' } },
    h('h3', { style: { margin: 0 } }, '🔔 Feedback alerts'), h('div', { class: 'spinner' }));
  api('GET', `/api/admin/projects/${p.id}/alerts`).then((a) => {
    const emails = h('input', { class: 'input', value: a.projectEmails, placeholder: a.defaultEmails || 'you@hubsolutions.one, colleague@hubsolutions.one' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      try { await api('PATCH', `/api/admin/projects/${p.id}`, { alert_emails: emails.value }); toast('Saved.'); refresh(); } catch (err) { toast(err.message, true); }
    });
    const test = h('button', { class: 'btn', type: 'button', disabled: !a.emailReady || !a.recipients.length }, 'Send a test email');
    test.addEventListener('click', async () => {
      test.disabled = true;
      try { const r = await api('POST', `/api/admin/projects/${p.id}/alerts/test`); toast(`Test email sent to ${r.to.join(', ')}.`); } catch (err) { toast(err.message, true); }
      test.disabled = false;
    });
    alertsCard.replaceChildren(
      h('h3', { style: { margin: 0 } }, '🔔 Feedback alerts'),
      h('p', { class: 'muted small', style: { margin: 0 } }, `One email per review round, like “Dorothy submitted feedback · ${p.name} (12 comments)”, listing every approval, comment, question and text edit. It is sent when the client presses Submit feedback, or ${a.quietMinutes} minutes after their last comment.`),
      a.emailReady ? null : h('div', { class: 'small', style: { background: 'var(--amber)', color: 'var(--amber-ink)', padding: '10px 12px', borderRadius: '10px' } },
        'Email is not set up yet. In Railway → Variables add ', h('code', null, 'SMTP_HOST'), ' (smtp.zoho.com for Zoho Mail), ', h('code', null, 'SMTP_USER'), ' (the mailbox), ', h('code', null, 'SMTP_PASS'), ' (an app password) and ', h('code', null, 'ALERT_EMAIL'), ' (who gets alerts for every project).'),
      h('label', { class: 'field' }, `Send alerts for this project to${a.defaultEmails ? ` (leave empty for ${a.defaultEmails})` : ''}`, emails),
      h('div', { class: 'row-flex' }, save, test,
        a.recipients.length ? h('span', { class: 'muted small' }, `Alerts go to ${a.recipients.join(', ')}`) : h('span', { class: 'muted small' }, 'No one gets alerts yet.')));
  }, (err) => alertsCard.replaceChildren(h('div', { class: 'muted small' }, err.message)));

  body.append(form, alertsCard,
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
  // Coming back from "Connect Google account".
  const q = new URLSearchParams(location.search);
  if (q.get('google')) {
    if (q.get('google') === 'connected') toast(`Google connected${q.get('msg') ? ` as ${q.get('msg')}` : ''}.`);
    else toast(q.get('msg') || 'Google could not be connected.', true);
    history.replaceState(null, '', `/admin${location.hash}`);
  }
  const me = await api('GET', '/api/admin/me');
  A.agency = me.agency;
  A.authed = me.admin;
  if (!me.admin) showLogin();
  else route();
})();
