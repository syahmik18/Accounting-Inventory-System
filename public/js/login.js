/* login.js — the landing page: choose a company, log on, and manage databases
   (create / backup / restore) before entering the app, like SQL Account. */
import { $, html, esc, api, toast, openModal, formHtml, readForm, prefs, companies, saveCompanies, company } from './core.js';

const sel = $('#company'), remarkEl = $('#remark'), errEl = $('#err'), form = $('#lf');
let list = [], active = null;

const showErr = (m) => { errEl.innerHTML = m ? `<div class="note bad">${esc(m)}</div>` : ''; };
const paintRemark = () => { const c = list.find((x) => x.company_id === sel.value); remarkEl.textContent = c && c.remark ? c.remark : ''; };

async function loadCompanies(pick) {
  try { const d = await api.get('/system/companies'); list = d.companies; active = d.active; }
  catch (e) { showErr(`Cannot reach the server: ${e.message}`); return; }
  sel.innerHTML = list.length
    ? list.map((c) => `<option value="${esc(c.company_id)}">${esc(c.company_name)}</option>`).join('')
    : '<option value="">No company yet — create a new database</option>';
  const want = pick || new URLSearchParams(location.search).get('company') || prefs.get('company', null);
  const fallback = (list.find((c) => c.db_name === active) || list[0] || {}).company_id;
  sel.value = list.some((c) => c.company_id === want) ? want : (fallback || '');
  paintRemark();
}
sel.addEventListener('change', paintRemark);

// The app keeps each company's profile (address, TIN, …) in the browser, keyed by company id.
// Make sure an entry exists for the company we just logged in to, and select it.
function adopt(r) {
  const meta = list.find((c) => c.company_id === r.companyId) || {};
  const all = companies();
  const short = r.companyName.slice(0, 2).toUpperCase();
  if (all.some((c) => c.id === r.companyId)) {
    saveCompanies(all.map((c) => (c.id === r.companyId ? { ...c, name: r.companyName, apiBase: '/api' } : c)));
  } else {
    // the database this server started with keeps the profile that was set up before login existed
    const seed = meta.remark === 'Existing database' ? (all.find((c) => c.id === 'main') || {}) : {};
    saveCompanies([...all, { address: '', phone: '', email: '', tin: '', brn: '', sst: '', ...seed, id: r.companyId, name: r.companyName, short, apiBase: '/api' }]);
  }
  prefs.set('company', r.companyId);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault(); showErr('');
  if (!sel.value) { showErr('Create a database first'); return; }
  const btn = $('[type="submit"]', form); btn.disabled = true; btn.textContent = 'Logging on…';
  try {
    const r = await api.post('/auth/login', { companyId: sel.value, user: $('#user').value, password: $('#pw').value });
    adopt(r);
    location.replace('/');
  } catch (err) {
    showErr(err.message); btn.disabled = false; btn.textContent = 'Log on';
    const pw = $('#pw'); pw.value = ''; pw.focus();
  }
});

/* ---------- database setup ---------- */
$('[data-create]').addEventListener('click', () => {
  const m = openModal({
    title: 'New database',
    body: html`${formHtml([
      { name: 'companyName', label: 'Company name', req: true, full: true },
      { name: 'remark', label: 'Remark', ph: 'e.g. 2026' }, { name: 'country', label: 'Country' },
      { name: 'adminPassword', label: 'Admin password', type: 'password', full: true, value: 'ADMIN', hint: 'Used with the user ADMIN to log on to this company. You can change it later in Settings.' },
    ], {})}<div data-err></div>`,
    footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-ok>Create</button>`,
  });
  $('[data-ok]', m.el).addEventListener('click', async () => {
    const f = readForm(m.body); const err = $('[data-err]', m.body);
    if (!f.companyName) { err.innerHTML = '<div class="note bad">Company name is required</div>'; return; }
    const ok = $('[data-ok]', m.el); ok.disabled = true; ok.textContent = 'Creating…';
    try {
      const r = await api.post('/system/companies', { ...f, adminPassword: f.adminPassword || 'ADMIN' });
      m.close(); toast('Database created'); await loadCompanies(r.companyId); $('#pw').focus();
    } catch (x) { err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; ok.disabled = false; ok.textContent = 'Create'; }
  });
});

$('[data-backup]').addEventListener('click', async (e) => {
  if (!sel.value) { toast('Choose a company to back up', 'bad'); return; }
  const b = e.currentTarget; b.disabled = true;
  try {
    const res = await fetch(`${company().apiBase}/system/companies/${encodeURIComponent(sel.value)}/backup`);
    if (!res.ok) {
      let msg = `Backup failed (${res.status})`; try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${sel.value}.sql`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded');
  } catch (x) { toast(x.message, 'bad'); }
  b.disabled = false;
});

$('[data-restore]').addEventListener('click', () => {
  const m = openModal({
    title: 'Restore from backup',
    body: html`${formHtml([{ name: 'companyName', label: 'Company name', req: true, full: true }, { name: 'remark', label: 'Remark', ph: 'e.g. 2026' }], {})}<div class="field full"><label class="req">Backup file (.sql)</label><input class="inp" type="file" accept=".sql,.dump,.backup" data-file></div><span class="hint">Restoring creates a new company. Its admin password will be ADMIN.</span><div data-err></div>`,
    footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-ok>Restore</button>`,
  });
  $('[data-ok]', m.el).addEventListener('click', async () => {
    const f = readForm(m.body); const file = $('[data-file]', m.body).files[0]; const err = $('[data-err]', m.body);
    if (!f.companyName) { err.innerHTML = '<div class="note bad">Company name is required</div>'; return; }
    if (!file) { err.innerHTML = '<div class="note bad">Choose a backup file</div>'; return; }
    const ok = $('[data-ok]', m.el); ok.disabled = true; ok.textContent = 'Restoring…';
    try {
      const q = `companyName=${encodeURIComponent(f.companyName)}${f.remark ? `&remark=${encodeURIComponent(f.remark)}` : ''}`;
      const res = await fetch(`${company().apiBase}/system/companies/restore?${q}`, { method: 'POST', body: file });
      const text = await res.text(); let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) throw new Error((payload && payload.error) || `Restore failed (${res.status})`);
      m.close(); toast('Database restored'); await loadCompanies(payload.companyId); $('#pw').focus();
    } catch (x) { err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; ok.disabled = false; ok.textContent = 'Restore'; }
  });
});

loadCompanies().then(() => $('#pw').focus());
