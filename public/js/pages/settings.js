/* ==========================================================================
   pages/settings.js — company profile(s), tax codes and appearance.
   ========================================================================== */
import { $, $$, html, raw, esc, str, api, prefs, company, companies, saveCompanies, user, toast, formHtml, readForm, openModal, confirmDialog, setHTML, num, fmt, fmtDate } from '../core.js';
import { ico } from '../icons.js';
import { applyTheme, applyGlass } from '../shell.js';

const TABS = [['company', 'Company'], ['tax-codes', 'Tax codes'], ['fiscal-periods', 'Fiscal periods'], ['security', 'Security'], ['appearance', 'Appearance']];
export default async function render(ctx) {
  const which = ctx.segs[1] || 'company';
  ctx.root.innerHTML = str(html`<div class="page-head"><div><h1>Settings</h1><div class="sub">Company details, taxes and how the app looks.</div></div></div>
    <div class="chips">${TABS.map(([k, l]) => html`<a class="chip ${k === which ? 'on' : ''}" href="#/settings/${k}" style="text-decoration:none">${l}</a>`)}</div><div data-pane class="stack"></div>`);
  const pane = $('[data-pane]', ctx.root);
  if (which === 'tax-codes') return (await import('./masters.js')).taxPanel(pane);
  if (which === 'fiscal-periods') return fiscalPane(pane);
  if (which === 'security') return securityPane(pane);
  if (which === 'appearance') return appearance(pane);
  return companyPane(pane);
}

function companyPane(pane) {
  const co = company();
  const F = [{ name: 'name', label: 'Company name', req: true, full: true }, { name: 'short', label: 'Short code (2–3 letters)' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address (printed on documents)', type: 'textarea', full: true }, { name: 'tin', label: 'TIN (LHDN)' }, { name: 'brn', label: 'BRN (SSM)' }, { name: 'sst', label: 'SST registration no.' }];
  const draw = () => {
    const list = companies(), cur = company();
    pane.innerHTML = str(html`<div class="card"><div class="card-h"><div><div class="card-t">Company profile</div><div class="card-s">Shown on the top bar and printed on every document.</div></div></div><div class="card-b">${formHtml(F, cur)}<div style="margin-top:16px;display:flex;gap:10px"><button class="btn primary" data-save>Save profile</button></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Companies</div><div class="card-s">Each company is its own Ledger server and database. Add its API address to switch between them from the top bar.</div></div><button class="btn" data-add>${raw(ico('plus'))}Add company</button></div>
        <div class="card-b"><div class="stack" style="gap:10px">${list.map((c) => html`<div class="row" style="padding:12px 14px;border-radius:14px;border:1px solid var(--stroke);background:var(--field)"><span class="company-mark">${c.short || c.name.slice(0, 2).toUpperCase()}</span><div style="flex:1"><b>${c.name}</b><div class="muted" style="font-size:13px">${c.apiBase}</div></div>${c.id === cur.id ? html`<span class="badge tone-ok">Active</span>` : html`<button class="btn sm" data-use="${c.id}">Switch</button>${c.id !== 'main' ? html`<button class="btn sm ghost danger" data-del="${c.id}">Remove</button>` : ''}`}</div>`)}</div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">You</div><div class="card-s">Recorded as the creator of documents you post.</div></div></div><div class="card-b"><div class="row"><input class="inp" style="max-width:280px" data-user value="${user()}" aria-label="Display name"><button class="btn" data-user-save>Save</button></div></div></div>`);
  };
  draw();
  pane.addEventListener('click', async (e) => {
    if (e.target.closest('[data-save]')) { const f = readForm(pane); if (!f.name) return toast('Company name is required', 'bad'); const cur = company(); saveCompanies(companies().map((c) => (c.id === cur.id ? { ...c, ...f, short: f.short || f.name.slice(0, 2).toUpperCase() } : c))); toast('Profile saved'); setTimeout(() => location.reload(), 350); }
    if (e.target.closest('[data-user-save]')) { prefs.set('user', $('[data-user]', pane).value.trim() || 'Admin'); toast('Saved'); setTimeout(() => location.reload(), 350); }
    const use = e.target.closest('[data-use]'); if (use) { prefs.set('company', use.dataset.use); location.reload(); }
    const del = e.target.closest('[data-del]'); if (del) { const r = await confirmDialog({ title: 'Remove this company from the list?', message: 'Only the shortcut is removed. The company\'s data is not touched.', confirm: 'Remove', danger: true }); if (r.ok) { saveCompanies(companies().filter((c) => c.id !== del.dataset.del)); draw(); } }
    if (e.target.closest('[data-add]')) {
      const m = openModal({ title: 'Add a company', body: html`${formHtml([{ name: 'name', label: 'Company name', req: true, full: true }, { name: 'apiBase', label: 'API address', full: true, ph: '/company2/api', hint: 'A path on this server (reverse proxy) or a full URL to another Ledger server that allows this origin.' }], { apiBase: '/api' })}<div data-err></div>`, footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-ok>Add</button>` });
      $('[data-ok]', m.el).addEventListener('click', async () => {
        const f = readForm(m.body); if (!f.name || !f.apiBase) return; try { const r = await fetch(`${f.apiBase.replace(/\/$/, '')}/tax-codes`); if (!r.ok) throw new Error(`HTTP ${r.status}`); } catch (x) { $('[data-err]', m.body).innerHTML = `<div class="note bad">Could not reach that API: ${esc(x.message)}</div>`; return; }
        saveCompanies([...companies(), { id: `c${Date.now().toString(36)}`, name: f.name, short: f.name.slice(0, 2).toUpperCase(), apiBase: f.apiBase.replace(/\/$/, '') }]); m.close(); draw();
      });
    }
  });
}

/* ---------- fiscal periods (which months can be posted into) ---------- */
async function fiscalPane(pane) {
  const draw = async () => {
    let rows;
    try { rows = await api.get('/fiscal-periods'); }
    catch (e) { pane.innerHTML = str(html`<div class="note bad">Could not load fiscal periods: ${e.message}</div>`); return; }
    const todayCovered = rows.some((p) => !p.is_closed && p.start_date <= fmtDate(new Date()) && fmtDate(new Date()) <= p.end_date);
    pane.innerHTML = str(html`<div class="card">
      <div class="card-h"><div><div class="card-t">Fiscal periods</div><div class="card-s">A document can only be posted into an open period that covers its date. Months are opened one at a time, in order.</div></div>
        <button class="btn primary" data-open-next>${raw(ico('plus'))}Open next period</button></div>
      ${todayCovered ? '' : html`<div class="note warn" style="margin:0 20px 16px">No open period covers today. Open the next period to continue posting.</div>`}
      <div class="card-b"><div class="stack" style="gap:8px">${rows.length ? rows.slice().reverse().map((p) => html`<div class="row" style="padding:10px 14px;border-radius:12px;border:1px solid var(--stroke);background:var(--field)">
          <b style="width:90px">${p.period_name}</b><span class="muted" style="flex:1">${fmtDate(p.start_date)} – ${fmtDate(p.end_date)}</span>
          <button class="btn sm ${p.is_closed ? '' : 'ghost'}" data-toggle="${p.period_id}" data-closed="${p.is_closed}">${p.is_closed ? 'Closed' : 'Open'}</button>
        </div>`) : html`<div class="empty"><h3>No fiscal periods yet</h3><p>Open the first period to start posting documents.</p></div>`}</div></div></div>`);
  };
  await draw();

  pane.addEventListener('click', async (e) => {
    const openBtn = e.target.closest('[data-open-next]');
    if (openBtn) {
      openBtn.disabled = true;
      try { const p = await api.post('/fiscal-periods/next', {}); toast(`Opened ${p.period_name}`); draw(); }
      catch (err) { toast(err.message, 'bad'); openBtn.disabled = false; }
      return;
    }
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const closed = t.dataset.closed === 'true';
      if (!closed) {
        const r = await confirmDialog({ title: 'Close this period?', message: 'No document can be posted into a closed period once this is saved.', confirm: 'Close period', danger: true });
        if (!r.ok) return;
      }
      try { await api.patch(`/fiscal-periods/${t.dataset.toggle}`, { is_closed: !closed }); draw(); }
      catch (err) { toast(err.message, 'bad'); }
    }
  });
}

/* ---------- security: admin password for the company that is logged in ---------- */
async function securityPane(pane) {
  let me = null;
  try { me = await api.get('/auth/me'); } catch { /* redirected to the login page if the session is gone */ }
  pane.innerHTML = str(html`<div class="card">
    <div class="card-h"><div><div class="card-t">Admin password</div><div class="card-s">${me ? html`Password for user <b>${me.user}</b> on <b>${me.companyName}</b>.` : 'Password for the company you are logged in to.'} Databases are created, backed up and restored from the login page.</div></div>
      <div class="row" style="gap:8px"><button class="btn primary" data-chpw>Change password</button></div></div></div>`);

  $('[data-chpw]', pane).addEventListener('click', () => {
    const m = openModal({
      title: 'Change admin password',
      body: html`${formHtml([
        { name: 'currentPassword', label: 'Current password', type: 'password', req: true, full: true },
        { name: 'newPassword', label: 'New password', type: 'password', req: true, full: true, hint: 'At least 4 characters.' },
        { name: 'confirm', label: 'Confirm new password', type: 'password', req: true, full: true },
      ], {})}<div data-err></div>`,
      footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-ok>Change</button>`,
    });
    $('[data-ok]', m.el).addEventListener('click', async () => {
      const f = readForm(m.body); const err = $('[data-err]', m.body);
      if (f.newPassword !== f.confirm) { err.innerHTML = '<div class="note bad">The new passwords do not match</div>'; return; }
      try { await api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword }); m.close(); toast('Password changed'); }
      catch (x) { err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; }
    });
  });
}

function appearance(pane) {
  const th = prefs.get('theme', 'system'), gl = prefs.get('glass', 'balanced');
  pane.innerHTML = str(html`<div class="card"><div class="card-h"><div><div class="card-t">Theme</div><div class="card-s">Light, dark, or follow your device.</div></div></div><div class="card-b"><div class="seg" data-theme>${[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([k, l]) => html`<button data-v="${k}" class="${k === th ? 'on' : ''}">${l}</button>`)}</div></div></div>
    <div class="card"><div class="card-h"><div><div class="card-t">Glass effect</div><div class="card-s">Balanced blurs the navigation, dialogs and menus and keeps the rest lightweight. Choose Solid on older computers.</div></div></div><div class="card-b"><div class="seg" data-glass>${[['balanced', 'Balanced'], ['full', 'Full glass'], ['solid', 'Solid (fastest)']].map(([k, l]) => html`<button data-v="${k}" class="${k === gl ? 'on' : ''}">${l}</button>`)}</div></div></div>
    <div class="card"><div class="card-h"><div><div class="card-t">Speed check</div><div class="card-s">Measures how quickly this browser gets answers from your Ledger server.</div></div><button class="btn" data-ping>${raw(ico('bolt'))}Run test</button></div><div class="card-b" data-res><span class="muted">Not run yet.</span></div></div>`);
  pane.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-v]');
    if (b) { const grp = b.parentElement; grp.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); if (grp.hasAttribute('data-theme')) { prefs.set('theme', b.dataset.v); applyTheme(b.dataset.v); } else { prefs.set('glass', b.dataset.v); applyGlass(b.dataset.v); } }
    if (e.target.closest('[data-ping]')) {
      const out = $('[data-res]', pane); out.textContent = 'Testing…'; const t = [];
      for (let i = 0; i < 8; i++) { const s = performance.now(); try { await api.get('/tax-codes'); } catch { /* ignore */ } t.push(performance.now() - s); }
      const avg = t.reduce((a, b2) => a + b2, 0) / t.length; const nav = performance.getEntriesByType('navigation')[0];
      out.innerHTML = `<div class="metrics"><div class="metric"><div class="k">API round trip (avg of 8)</div><div class="v">${avg.toFixed(0)} ms</div><div class="s">best ${Math.min(...t).toFixed(0)} ms</div></div>${nav ? `<div class="metric"><div class="k">This page loaded in</div><div class="v">${nav.duration.toFixed(0)} ms</div><div class="s">DOM ready ${nav.domContentLoadedEventEnd.toFixed(0)} ms</div></div>` : ''}</div>`;
    }
  });
}
