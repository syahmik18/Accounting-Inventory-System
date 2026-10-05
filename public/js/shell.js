/* ==========================================================================
   shell.js — sidebar, floating top bar, command palette, notifications,
   company / profile menus, theme + sidebar preferences.
   ========================================================================== */
import { $, $$, html, raw, esc, str, api, cached, invalidate, on, prefs, company, companies, user, menu, makeLayer, openDrawer, rm, title, debounce, navigate, toast, fmtDate, skeleton } from './core.js';
import { ico } from './icons.js';
import { NAV, DOC_ROUTES, DOC_LABEL, DOC_ICON } from './nav.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/* ---------- theme ---------- */
export function applyTheme(t = prefs.get('theme', 'system')) {
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', eff);
  const b = $('[data-act="theme"]'); if (b) { b.innerHTML = ico(eff === 'dark' ? 'sun' : 'moon'); b.setAttribute('aria-label', eff === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'); }
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = eff === 'dark' ? '#08112a' : '#2563EB';
}
export function applyGlass(g = prefs.get('glass', 'balanced')) { document.documentElement.setAttribute('data-glass', g); }

/* ---------- alerts (drive the bell, and the AI insight cards) ---------- */
export const loadAlerts = () => cached('alerts', async () => {
  const [sales, purchases, inventory] = await Promise.all([api.get('/insights/sales'), api.get('/insights/purchases'), api.get('/insights/inventory')]);
  const items = [];
  if (sales.receivables.overdueCount) items.push({ tone: 'bad', icon: 'alert', title: `${sales.receivables.overdueCount} overdue customer invoice${sales.receivables.overdueCount > 1 ? 's' : ''}`, text: `${rm(sales.receivables.overdue)} is past its due date`, href: '#/reports/ar-aging' });
  if (purchases.payables.overdueCount) items.push({ tone: 'bad', icon: 'alert', title: `${purchases.payables.overdueCount} overdue supplier bill${purchases.payables.overdueCount > 1 ? 's' : ''}`, text: `${rm(purchases.payables.overdue)} to pay`, href: '#/reports/ap-aging' });
  if (purchases.payables.dueSoonCount) items.push({ tone: 'warn', icon: 'history', title: `${purchases.payables.dueSoonCount} supplier bill${purchases.payables.dueSoonCount > 1 ? 's' : ''} due within 7 days`, text: rm(purchases.payables.dueSoon), href: '#/purchases/invoices' });
  if (inventory.summary.outOfStock) items.push({ tone: 'bad', icon: 'inventory', title: `${inventory.summary.outOfStock} item${inventory.summary.outOfStock > 1 ? 's' : ''} out of stock`, text: 'Check the inventory overview', href: '#/inventory' });
  if (inventory.summary.lowStock) items.push({ tone: 'warn', icon: 'inventory', title: `${inventory.summary.lowStock} item${inventory.summary.lowStock > 1 ? 's' : ''} below minimum stock`, text: 'Reorder soon', href: '#/inventory' });
  if (purchases.pipeline.pendingRequests.count) items.push({ tone: 'info', icon: 'clipboard', title: `${purchases.pipeline.pendingRequests.count} purchase request${purchases.pipeline.pendingRequests.count > 1 ? 's' : ''} awaiting approval`, text: 'Review and approve', href: '#/purchases/requests' });
  if (sales.pipeline.deliveriesToInvoice.count) items.push({ tone: 'info', icon: 'suppliers', title: `${sales.pipeline.deliveriesToInvoice.count} delivered order${sales.pipeline.deliveriesToInvoice.count > 1 ? 's' : ''} not yet invoiced`, text: rm(sales.pipeline.deliveriesToInvoice.value), href: '#/sales/deliveries' });
  if (purchases.pipeline.receivedNotInvoiced.count) items.push({ tone: 'info', icon: 'inbox', title: `${purchases.pipeline.receivedNotInvoiced.count} goods receipt${purchases.pipeline.receivedNotInvoiced.count > 1 ? 's' : ''} without supplier invoice`, text: rm(purchases.pipeline.receivedNotInvoiced.value), href: '#/purchases/grn' });
  return { items, sales, purchases, inventory, at: Date.now() };
}, 45000);

/* ---------- sidebar / topbar markup ---------- */
function navItem(n) {
  if (!n.children) return `<a class="nav-item" href="${n.href}" data-nav="${n.id}" title="${n.label}"><span class="nav-ico">${ico(n.icon)}</span><span class="nav-lbl">${n.label}</span></a>`;
  return `<div class="nav-group" data-group="${n.id}"><a class="nav-item" href="${n.href}" data-nav="${n.id}" title="${n.label}"><span class="nav-ico">${ico(n.icon)}</span><span class="nav-lbl">${n.label}</span><span class="nav-chev" data-chev>${ico('chevR')}</span></a>
    <div class="nav-sub"><div>${n.children.map(([l, h, k]) => `<a href="${h}" data-child="${n.id}:${k}">${l}</a>`).join('')}</div></div></div>`;
}
export function mountShell(root) {
  const co = company();
  root.innerHTML = `
  <aside class="sidebar glass-chrome" aria-label="Main navigation">
    <div class="sb-brand"><div class="sb-logo">${ico('logo')}</div><div class="sb-title">Ledger<small>Accounting &amp; business</small></div></div>
    <nav class="sb-nav">${NAV.map(navItem).join('')}</nav>
    <div class="sb-foot"><button class="nav-item" data-act="collapse" title="Collapse sidebar"><span class="nav-ico">${ico('panel')}</span><span class="nav-lbl">Collapse</span></button></div>
  </aside>
  <div class="stage">
    <header class="topbar glass-chrome">
      <button class="icon-btn menu-btn" data-act="menu" aria-label="Open menu">${ico('menu')}</button>
      <button class="company-btn" data-act="company" aria-haspopup="menu"><span class="company-mark">${esc(co.short || co.name.slice(0, 2).toUpperCase())}</span><span class="t">${esc(co.name)}</span>${ico('chevD')}</button>
      <button class="tb-search" data-act="search" aria-label="Search"><span style="display:contents">${ico('search')}</span><span>Search documents, customers, items…</span><kbd class="kbd">${IS_MAC ? '⌘ K' : 'Ctrl K'}</kbd></button>
      <div class="tb-right">
        <button class="ai-btn" data-act="ai" aria-label="Open assistant">${ico('sparkles')}<span>Assistant</span></button>
        <button class="icon-btn" data-act="notif" aria-label="Notifications">${ico('bell')}<i class="dot" hidden></i></button>
        <button class="icon-btn" data-act="theme" aria-label="Toggle theme"></button>
        <button class="avatar" data-act="user" aria-label="Account menu" aria-haspopup="menu">${esc((user() || 'A').slice(0, 2).toUpperCase())}</button>
      </div>
    </header>
    <main id="page" class="page" tabindex="-1"></main>
  </div>`;
  root.classList.toggle('collapsed', !!prefs.get('collapsed', false) || window.innerWidth <= 1100);
  document.documentElement.removeAttribute('data-sb');
  applyTheme();
  root.addEventListener('click', onShellClick);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => prefs.get('theme', 'system') === 'system' && applyTheme());
  document.addEventListener('keydown', (e) => {
    const t = e.target; const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openPalette(); }
    else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openPalette(); }
  });
  on('changed', () => { invalidate('alerts'); refreshBell(); });
  refreshBell();
}

// Notifications are computed live from the ledger (no persisted read state on the
// server), so "read" is tracked client-side: we remember a signature of the alert
// set the user last dismissed, and only light the dot when the current set differs
// from that signature (i.e. something changed since they last checked).
const notifSig = (items) => items.map((i) => `${i.tone}:${i.title}`).join('|');
const readNotifSig = () => prefs.get('notif-read-sig', '');
const markNotifsRead = (items) => prefs.set('notif-read-sig', notifSig(items));

let bellTimer;
async function refreshBell() {
  clearTimeout(bellTimer);
  try {
    const a = await loadAlerts();
    const d = $('[data-act="notif"] .dot');
    if (d) d.hidden = !a.items.some((i) => i.tone === 'bad' || i.tone === 'warn') || notifSig(a.items) === readNotifSig();
  } catch { /* offline: keep silent */ }
  bellTimer = setTimeout(refreshBell, 90000);
}

function onShellClick(e) {
  const app = $('#app');
  const chev = e.target.closest('[data-chev]');
  if (chev) { e.preventDefault(); chev.closest('.nav-group').classList.toggle('open'); return; }
  const navLink = e.target.closest('.nav-item[href], .nav-sub a');
  if (navLink) { const g = navLink.closest('.nav-group') || navLink.parentElement?.closest?.('.nav-group'); if (g && navLink.classList.contains('nav-item')) g.classList.add('open'); app.classList.remove('mnav-open'); return; }
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'collapse') { const c = app.classList.toggle('collapsed'); prefs.set('collapsed', c); }
  else if (act === 'menu') app.classList.toggle('mnav-open');
  else if (act === 'search') openPalette();
  else if (act === 'theme') { const cur = document.documentElement.getAttribute('data-theme'); const n = cur === 'dark' ? 'light' : 'dark'; prefs.set('theme', n); applyTheme(n); }
  else if (act === 'ai') import('./assistant.js').then((m) => m.openAssistant());
  else if (act === 'notif') openNotifications();
  else if (act === 'company') companyMenu(btn);
  else if (act === 'user') userMenu(btn);
}

export function setActive(segs) {
  const [g, c] = segs;
  const def = { sales: 'overview', purchases: 'overview', inventory: 'overview', accounting: 'overview', reports: 'register', settings: 'company' };
  const child = c && c !== 'new' ? c : def[g];
  $$('.nav-item.on, .nav-sub a.on').forEach((n) => n.classList.remove('on'));
  const head = $(`.nav-item[data-nav="${g}"]`); if (head) head.classList.add('on');
  const grp = $(`.nav-group[data-group="${g}"]`); if (grp) { grp.classList.add('open'); $$('.nav-group.open').forEach((x) => x !== grp && x.classList.remove('open')); const a = $(`.nav-sub a[data-child="${g}:${child}"]`); if (a) a.classList.add('on'); }
  else $$('.nav-group.open').forEach((x) => x.classList.remove('open'));
}

function companyMenu(btn) {
  const cur = company();
  menu(btn, [{ title: 'Company' }, { label: cur.name, hint: 'Currently open', icon: 'checkCircle' }, '-',
    { label: 'Switch company or set up databases…', hint: 'Logs you out first', icon: 'building', onClick: () => logout() }]);
}
export async function logout(companyId) {
  try { await api.post('/auth/logout'); } catch { /* already logged out */ }
  location.replace(companyId ? `/login.html?company=${encodeURIComponent(companyId)}` : '/login.html');
}
function userMenu(btn) {
  menu(btn, [{ title: `Signed in as ${user()}` }, { label: 'Settings', icon: 'settings', onClick: () => navigate('#/settings') },
    { label: 'Toggle light / dark', icon: 'moon', onClick: () => $('[data-act="theme"]').click() }, '-',
    { label: 'Log out', icon: 'arrowR', onClick: () => logout() }]);
}

/* ---------- notifications ---------- */
async function openNotifications() {
  const d = openDrawer({ title: 'Notifications', subtitle: 'Computed live from your ledger', size: 'narrow', body: skeleton(3) });
  try {
    const { items } = await loadAlerts();
    d.setBody(items.length ? html`<div class="stack" style="gap:10px">${items.map((i) => html`<a class="notif" href="${i.href}" data-close><span class="ni tone-${i.tone}">${raw(ico(i.icon))}</span><span><b>${i.title}</b><small>${i.text}</small></span></a>`)}</div>` : html`<div class="empty"><div class="ico">${raw(ico('checkCircle'))}</div><h3>You're all caught up</h3><p>No overdue items, low stock or approvals waiting.</p></div>`);
    if (items.length) {
      d.setFooter(html`<button class="btn" data-mark-read>${raw(ico('checkCircle'))} Mark all as read</button>`);
      $('[data-mark-read]', d.foot).addEventListener('click', () => {
        markNotifsRead(items);
        const dot = $('[data-act="notif"] .dot'); if (dot) dot.hidden = true;
        d.close();
      });
    }
  } catch (e) { d.setBody(html`<div class="note bad">${raw(ico('alert'))}<div>${e.message}</div></div>`); }
}

/* ---------- command palette ---------- */
const CREATE = [
  ['New quotation', 'sales/quotations/new', 'file'], ['New sales order', 'sales/orders/new', 'clipboard'], ['New delivery order', 'sales/deliveries/new', 'suppliers'], ['New invoice', 'sales/invoices/new', 'sales'],
  ['New cash sale', 'sales/cash-sales/new', 'banknote'], ['Receive customer payment', 'sales/receipts/new', 'wallet'], ['New credit note', 'sales/credit-notes/new', 'arrowDown'], ['New debit note', 'sales/debit-notes/new', 'arrowUp'],
  ['New purchase request', 'purchases/requests/new', 'clipboard'], ['New purchase order', 'purchases/orders/new', 'cart'], ['Receive goods (GRN)', 'purchases/grn/new', 'inbox'], ['New supplier invoice', 'purchases/invoices/new', 'purchases'],
  ['New cash purchase', 'purchases/cash-purchases/new', 'banknote'], ['Pay supplier', 'purchases/payments/new', 'card'], ['New payment voucher', 'accounting/payment-vouchers/new', 'card'], ['New official receipt', 'accounting/official-receipts/new', 'wallet'],
];
function staticCommands() {
  const go = NAV.flatMap((n) => (n.children ? n.children.map(([l, h]) => ({ g: 'Go to', t: n.id === 'dashboard' ? l : `${n.label} · ${l}`, i: n.icon, h })) : [{ g: 'Go to', t: n.label, i: n.icon, h: n.href }]));
  return [...CREATE.map(([t, r, i]) => ({ g: 'Create', t, i, h: `#/${r}` })), { g: 'Create', t: 'New customer', i: 'customers', h: '#/customers?new=1' }, { g: 'Create', t: 'New supplier', i: 'suppliers', h: '#/suppliers?new=1' }, { g: 'Create', t: 'New stock item', i: 'inventory', h: '#/inventory/items?new=1' }, ...go];
}
let cmds;
export function openPalette() {
  if ($('.cmdk')) return;
  cmds = cmds || staticCommands();
  const layer = makeLayer('cmdk glass-float', { label: 'Search and commands' });
  layer.el.innerHTML = `<div class="cmdk-in">${ico('search')}<input placeholder="Search documents, customers, items — or type a command" aria-label="Search" autocomplete="off"><kbd class="kbd">Esc</kbd></div><div class="cmdk-list" role="listbox"></div><div class="cmdk-foot"><span>↑↓ navigate</span><span>↵ open</span><span>Try “invoice”, a customer name, an item code or a document number</span></div>`;
  const input = $('input', layer.el), list = $('.cmdk-list', layer.el);
  let rows = [], hl = 0, seq = 0;
  const paint = () => {
    let last = '';
    list.innerHTML = rows.length ? rows.map((r, i) => { const head = r.g !== last ? `<div class="pop-title">${r.g}</div>` : ''; last = r.g; return `${head}<button class="pop-item ${i === hl ? 'hl' : ''}" data-i="${i}" role="option">${ico(r.i || 'file', 'width="18" height="18"')}<span class="t"><b>${esc(r.t)}</b>${r.s ? `<small>${esc(r.s)}</small>` : ''}</span>${r.r ? `<span class="r">${esc(r.r)}</span>` : ''}</button>`; }).join('') : '<div class="pop-empty">No results</div>';
    list.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  };
  const local = (q) => (q ? cmds.filter((c) => (c.g + ' ' + c.t).toLowerCase().includes(q)) : cmds.filter((c) => c.g === 'Create').slice(0, 8).concat(cmds.filter((c) => c.g === 'Go to').slice(0, 6)));
  const remote = debounce(async (q) => {
    const my = ++seq; if (q.length < 2) return;
    try {
      const [docs, partners, items] = await Promise.all([api.get(`/reports/document-history?q=${encodeURIComponent(q)}&pageSize=10`), api.get(`/partners/search?q=${encodeURIComponent(q)}&limit=5`), api.get(`/stock-items/search?q=${encodeURIComponent(q)}&limit=5`)]);
      if (my !== seq) return;
      const extra = [
        ...(docs.documents || []).slice(0, 6).map((d) => ({ g: 'Documents', t: `${d.doc_no}`, s: `${DOC_LABEL[d.doc_type] || title(d.doc_type)} · ${d.partner_name || ''}`, r: rm(d.total_amount), i: DOC_ICON[d.doc_type] || 'file', h: `#/${DOC_ROUTES[d.doc_type] || 'reports'}?view=${d.doc_id}` })),
        ...partners.map((p) => ({ g: 'Customers & suppliers', t: p.partner_name, s: `${p.partner_code} · ${title(p.partner_type)}`, i: p.partner_type === 'CUSTOMER' ? 'customers' : 'suppliers', h: `#/${p.partner_type === 'CUSTOMER' ? 'customers' : 'suppliers'}?view=${p.partner_id}` })),
        ...items.map((s) => ({ g: 'Stock items', t: `${s.item_code} — ${s.item_name}`, s: `${s.current_qty} ${s.unit || ''} on hand`, i: 'inventory', h: `#/inventory/items?view=${s.stock_item_id}` })),
      ];
      rows = extra.concat(local(q.toLowerCase()).slice(0, 6)); hl = 0; paint();
    } catch { /* keep local results */ }
  }, 200);
  const upd = () => { const q = input.value.trim(); rows = local(q.toLowerCase()); hl = 0; paint(); remote(q); };
  const go = (i) => { const r = rows[i]; if (!r) return; layer.close(); if (r.h) location.hash = r.h; };
  input.addEventListener('input', upd);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hl = (hl + 1) % Math.max(rows.length, 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl = (hl - 1 + rows.length) % Math.max(rows.length, 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(hl); }
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(+b.dataset.i); });
  list.addEventListener('mousemove', (e) => { const b = e.target.closest('[data-i]'); if (b && +b.dataset.i !== hl) { hl = +b.dataset.i; list.querySelectorAll('.pop-item').forEach((x, i) => x.classList.toggle('hl', i === hl)); } });
  upd();
}
