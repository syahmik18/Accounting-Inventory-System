/* ==========================================================================
   main.js — boot + hash router. Every page is a lazily-imported module, so
   the first paint only pays for the shell (core + shell + nav + icons).
   ========================================================================== */
import { $, html, raw, closeOverlays, toast, empty, errorNote, setHTML, prefs } from './core.js';
import { mountShell, setActive, applyGlass } from './shell.js';
import { ico } from './icons.js';

const LOAD = {
  dashboard: () => import('./pages/dashboard.js'),
  overview: () => import('./pages/overview.js'),
  docs: () => import('./docs.js'),
  masters: () => import('./pages/masters.js'),
  accounting: () => import('./pages/accounting.js'),
  reports: () => import('./pages/reports.js'),
  settings: () => import('./pages/settings.js'),
};
function resolve(segs) {
  const [a, b] = segs;
  switch (a) {
    case 'dashboard': return 'dashboard';
    case 'sales': case 'purchases': return b ? 'docs' : 'overview';
    case 'inventory': return b ? (b === 'items' ? 'masters' : null) : 'overview';
    case 'customers': case 'suppliers': return 'masters';
    case 'accounting': return !b ? 'accounting' : b === 'accounts' ? 'masters' : (b === 'payment-vouchers' || b === 'official-receipts') ? 'docs' : null;
    case 'reports': return 'reports';
    case 'settings': return 'settings';
    default: return null;
  }
}
const parse = () => {
  const h = location.hash.replace(/^#\/?/, ''); const [p, q = ''] = h.split('?');
  return { segs: p.split('/').filter(Boolean).map(decodeURIComponent), query: Object.fromEntries(new URLSearchParams(q)) };
};

let token = 0, cleanup = null, lastKey = '';
async function route() {
  const my = ++token;
  if (cleanup) { try { cleanup(); } catch { /* page already gone */ } cleanup = null; }
  const { segs, query } = parse();
  if (!segs.length) { location.replace('#/dashboard'); return; }
  closeOverlays();
  // A fresh page element per navigation: listeners attached by the previous page are discarded with it,
  // and any late async work from that page can only write into a detached node.
  const old = $('#page'); const root = old.cloneNode(false); old.replaceWith(root);
  const key = segs.join('/');
  const name = resolve(segs);
  setActive(segs);
  if (!name) { setHTML(root, empty('search', 'Page not found', 'That address does not exist. Use the sidebar or press / to search.', html`<a class="btn primary" href="#/dashboard">Go to dashboard</a>`)); return; }
  setHTML(root, html`<div class="page-head"><div><div class="sk" style="width:220px;height:34px"></div></div></div><div class="grid g4">${[1, 2, 3, 4].map(() => html`<div class="sk" style="height:170px;border-radius:26px"></div>`)}</div>`);
  try {
    const mod = await LOAD[name]();
    if (my !== token) return;
    root.innerHTML = '';
    const ctx = { root, segs, query, module: segs[0], isCurrent: () => my === token, onCleanup: (fn) => { cleanup = fn; } };
    await mod.default(ctx);
    if (my === token && key !== lastKey) { window.scrollTo({ top: 0 }); }
    lastKey = key;
    document.title = `${(root.querySelector('h1')?.textContent || 'Ledger').trim()} · Ledger`;
  } catch (e) {
    if (my !== token) return;
    console.error(e);
    setHTML(root, errorNote(e));
  }
}

window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); if (e.reason && e.reason.message && !/abort/i.test(e.reason.message)) toast(e.reason.message, 'bad'); });
window.addEventListener('hashchange', route);

mountShell($('#app'));
applyGlass();
route();
requestAnimationFrame(() => requestAnimationFrame(() => $('#app').classList.remove('no-anim')));

// warm the most-used chunks while the browser is idle (no impact on first paint)
const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
idle(() => { ['./docs.js', './composer.js', './pages/dashboard.js', './pages/overview.js'].forEach((m) => import(m).catch(() => {})); });
