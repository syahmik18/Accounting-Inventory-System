/* ==========================================================================
   core.js — shared building blocks (no framework, no dependencies).
   html`` templating with auto-escaping, API client, preferences, reference
   caches, overlays (drawer / modal / confirm / toast), combo pickers, forms.
   ========================================================================== */
import { ico } from './icons.js';

/* ---------- escaping + tiny html`` template ---------- */
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s ?? ''));
const part = (v) => (v == null || v === false || v === true ? '' : v instanceof Safe ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}
export const str = (v) => part(v);

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
export const setHTML = (el, v) => { el.innerHTML = str(v); return el; };

/* ---------- numbers, money, dates ---------- */
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
export const fmt = (n, dp = 2) => num(n).toLocaleString('en-MY', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const rm = (n, dp = 2) => `${num(n) < 0 ? '-' : ''}RM ${fmt(Math.abs(num(n)), dp)}`;
export const qty = (n) => num(n).toLocaleString('en-MY', { maximumFractionDigits: 4 });
export const compact = (n) => {
  const v = Math.abs(num(n)); const s = num(n) < 0 ? '-' : '';
  if (v >= 1e6) return `${s}${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${s}${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `${s}${Math.round(v)}`;
};
const p2 = (x) => String(x).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** Local calendar date (never toISOString — that returns yesterday in UTC+8 before 08:00). */
export const today = () => ymd(new Date());
export const parseYMD = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYMD(s); d.setDate(d.getDate() + n); return ymd(d); };
export const monthStart = (s = today()) => `${s.slice(0, 7)}-01`;
export const yearStart = (s = today()) => `${s.slice(0, 4)}-01-01`;
export const fmtDate = (s) => (s ? parseYMD(s).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const monthLabel = (ym, long = false) => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleDateString('en-MY', long ? { month: 'long', year: 'numeric' } : { month: 'short' });
export const dayDiff = (a, b) => Math.round((parseYMD(a) - parseYMD(b)) / 864e5);
export const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
export const debounce = (fn, ms = 200) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };
export const pctChange = (cur, prev) => (Math.abs(prev) < 0.005 ? null : ((cur - prev) / Math.abs(prev)) * 100);
export const sum = (a, f = (x) => x) => a.reduce((s, x) => s + num(f(x)), 0);
export const title = (s) => { const t = String(s || '').replace(/_/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

/* ---------- preferences + company profiles (localStorage) ---------- */
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem('lg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lg.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const DEFAULT_CO = { id: 'main', name: 'My Company', short: 'MC', apiBase: '/api', address: '', phone: '', email: '', tin: '', brn: '', sst: '' };
export const companies = () => { const l = prefs.get('companies', null); return Array.isArray(l) && l.length ? l : [DEFAULT_CO]; };
export const company = () => companies().find((c) => c.id === prefs.get('company', 'main')) || companies()[0];
export const saveCompanies = (list) => prefs.set('companies', list);
export const user = () => prefs.get('user', 'Admin');

/* ---------- events ---------- */
export const bus = new EventTarget();
export const on = (evt, fn) => { bus.addEventListener(evt, fn); return () => bus.removeEventListener(evt, fn); };
export const emit = (evt, detail) => bus.dispatchEvent(new CustomEvent(evt, { detail }));

/* ---------- API client ---------- */
export async function req(method, path, body, opts = {}) {
  const res = await fetch(company().apiBase + path, {
    method, signal: opts.signal,
    headers: body !== undefined && body !== null ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { error: text.replace(/<[^>]+>/g, ' ').trim().slice(0, 160) }; } }
  // Session missing/expired (or another company was opened): back to the login page.
  if (res.status === 401 && !path.startsWith('/auth/') && !/login\.html$/.test(location.pathname)) { location.replace('/login.html'); }
  if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}
export const api = {
  get: (p, o) => req('GET', p, null, o),
  post: (p, b) => req('POST', p, b ?? {}),
  patch: (p, b) => req('PATCH', p, b ?? {}),
  del: (p) => req('DELETE', p),
};
export const qs = (o) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== '' && v != null) u.set(k, v); const s = u.toString(); return s ? `?${s}` : ''; };

/* stale-while-revalidate cache for read-heavy screens */
const memo = new Map();
export function cached(key, loader, ttl = 30000) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = loader();
  memo.set(key, { t: Date.now(), p });
  p.catch(() => memo.delete(key));
  return p;
}
export const invalidate = (prefix) => { for (const k of [...memo.keys()]) if (!prefix || k.startsWith(prefix)) memo.delete(k); };
export const peek = (key) => memo.get(key)?.p;

export const ref = {
  accounts: () => cached('ref:accounts', () => api.get('/accounts'), 120000),
  taxCodes: () => cached('ref:tax', () => api.get('/tax-codes'), 120000),
  partner: (id) => cached(`ref:partner:${id}`, () => api.get(`/partners/${id}`), 60000),
};
export const activeOnly = (a) => a.filter((x) => x.is_active !== false);
export const cashAccounts = (accts) => activeOnly(accts).filter((a) => a.is_cash_account === true || ['CASH', 'BANK'].includes(a.reporting_role));

/* ---------- statuses ---------- */
const TONES = {
  OPEN: 'info', POSTED: 'info', SENT: 'info', APPROVED: 'ok', PAID: 'ok', DELIVERED: 'ok', RECEIVED: 'ok', CONVERTED: 'muted', CLOSED: 'muted', CREDITED: 'muted', DRAFT: 'muted',
  PENDING_APPROVAL: 'warn', PARTIALLY_PAID: 'warn', PARTIALLY_DELIVERED: 'warn', PARTIALLY_RECEIVED: 'warn',
  VOID: 'bad', CANCELLED: 'bad', REJECTED: 'bad', EXPIRED: 'bad',
};
export const tone = (s) => TONES[String(s || '').toUpperCase()] || 'muted';
export const badge = (s, label) => html`<span class="badge tone-${tone(s)}">${label || title(s)}</span>`;
export const isDead = (s) => ['VOID', 'CANCELLED', 'REJECTED'].includes(String(s || '').toUpperCase());

/* ---------- toasts ---------- */
export function toast(msg, kind = 'ok', ms = 3800) {
  const host = $('#toasts'); if (!host) return;
  const el = document.createElement('div');
  el.className = `toast glass-float ${kind}`;
  el.innerHTML = `${ico(kind === 'ok' ? 'checkCircle' : kind === 'bad' ? 'alert' : kind === 'warn' ? 'alert' : 'info')}<span>${esc(msg)}</span>`;
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  setTimeout(kill, kind === 'bad' ? Math.max(ms, 6000) : ms);
  el.addEventListener('click', kill);
}

/* ---------- overlays ---------- */
const stack = [];
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); stack[stack.length - 1].close(); }
  if (e.key === 'Tab' && stack.length) trap(e, stack[stack.length - 1].el);
});
function trap(e, root) {
  const f = $$('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root).filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
export function makeLayer(cls, { label, onClose, backdrop = true }) {
  const host = $('#overlays');
  const prevFocus = document.activeElement;
  const shade = document.createElement('div'); shade.className = 'overlay';
  const el = document.createElement('div');
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', label || 'Dialog');
  el.className = cls;
  if (backdrop) host.appendChild(shade);
  host.appendChild(el);
  let closed = false;
  const layer = {
    el, shade,
    close() {
      if (closed) return; closed = true;
      const i = stack.indexOf(layer); if (i >= 0) stack.splice(i, 1);
      el.classList.remove('on'); shade.classList.remove('on');
      setTimeout(() => { el.remove(); shade.remove(); }, 320);
      try { prevFocus && prevFocus.focus && prevFocus.focus({ preventScroll: true }); } catch { /* element gone */ }
      onClose && onClose();
    },
  };
  shade.addEventListener('click', () => layer.close());
  stack.push(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.add('on'); shade.classList.add('on'); const f = $('[autofocus],input:not([type=hidden]),select,textarea', el); (f || $('.dr-h button,.icon-btn', el) || el).focus?.({ preventScroll: true }); }));
  return layer;
}
export function openDrawer({ title: t = '', subtitle = '', size = '', body = '', footer = '', onClose } = {}) {
  const layer = makeLayer(`drawer glass-float ${size}`, { label: t, onClose });
  layer.el.innerHTML = `<div class="dr-h"><div style="min-width:0"><h2></h2><div class="card-s sub"></div></div><button class="icon-btn sm" data-close aria-label="Close">${ico('x')}</button></div><div class="dr-b"></div><div class="dr-f" hidden></div>`;
  const q = (s) => $(s, layer.el);
  const api2 = Object.assign(layer, {
    body: q('.dr-b'), foot: q('.dr-f'),
    setTitle(x, s = '') { q('h2').textContent = x; q('.sub').innerHTML = str(s); },
    setBody(x) { q('.dr-b').innerHTML = str(x); },
    setFooter(x) { const f = q('.dr-f'); f.innerHTML = str(x); f.hidden = !str(x).trim(); },
  });
  api2.setTitle(t, subtitle); api2.setBody(body); api2.setFooter(footer);
  layer.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) layer.close(); });
  return api2;
}
export function openModal({ title: t = '', body = '', footer = '', size = '', onClose } = {}) {
  const layer = makeLayer(`modal glass-float ${size}`, { label: t, onClose });
  layer.el.innerHTML = `<div class="dr-h"><h2></h2><button class="icon-btn sm" data-close aria-label="Close">${ico('x')}</button></div><div class="md-b"></div><div class="dr-f" hidden></div>`;
  $('h2', layer.el).textContent = t;
  const b = $('.md-b', layer.el); b.innerHTML = str(body);
  const f = $('.dr-f', layer.el); f.innerHTML = str(footer); f.hidden = !str(footer).trim();
  layer.body = b; layer.foot = f;
  layer.setFooter = (x) => { f.innerHTML = str(x); f.hidden = !str(x).trim(); };
  layer.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) layer.close(); });
  return layer;
}
/** confirmDialog → resolves { ok, value } (value = optional reason text) */
export function confirmDialog({ title: t, message = '', confirm = 'Confirm', danger = false, input = null }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title: t, size: '',
      body: html`<p style="color:var(--ink-2)">${message}</p>${input ? html`<div class="field"><label for="cf-in">${input}</label><input class="inp" id="cf-in" autocomplete="off"></div>` : ''}`,
      footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${confirm}</button>`,
      onClose: () => { if (!done) { done = true; resolve({ ok: false }); } },
    });
    $('[data-ok]', m.el).addEventListener('click', () => { done = true; const v = $('#cf-in', m.el)?.value?.trim() || ''; m.close(); resolve({ ok: true, value: v }); });
  });
}

export const closeOverlays = () => [...stack].forEach((l) => l.close());

/* ---------- combo (typeahead) ---------- */
export function combo(input, { search, render, onPick, footer, minChars = 0, wait = 160, keepOpen = false }) {
  let pop = null, items = [], hl = 0, seq = 0, ctl = null;
  input.setAttribute('autocomplete', 'off'); input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false');
  const place = () => {
    if (!pop) return;
    const r = input.getBoundingClientRect();
    const h = Math.min(pop.scrollHeight, 320);
    const below = window.innerHeight - r.bottom;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 300) - 8))}px`;
    pop.style.minWidth = `${Math.max(r.width, 300)}px`;
    if (below < h + 20 && r.top > below) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 6}px`; pop.style.transformOrigin = 'bottom'; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 6}px`; pop.style.transformOrigin = 'top'; }
  };
  const close = () => { if (!pop) return; const p = pop; pop = null; p.classList.remove('on'); setTimeout(() => p.remove(), 160); input.setAttribute('aria-expanded', 'false'); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  const paint = () => {
    if (!pop) { pop = document.createElement('div'); pop.className = 'pop glass-float'; pop.setAttribute('role', 'listbox'); document.body.appendChild(pop);
      pop.addEventListener('mousedown', (e) => e.preventDefault());
      pop.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(+b.dataset.i); else if (e.target.closest('[data-foot]')) { close(); footer.onClick(input); } });
      window.addEventListener('scroll', place, true); window.addEventListener('resize', place); requestAnimationFrame(() => pop && pop.classList.add('on')); }
    pop.innerHTML = (items.length ? items.map((it, i) => `<button type="button" role="option" class="pop-item ${i === hl ? 'hl' : ''}" data-i="${i}">${str(render(it))}</button>`).join('') : '<div class="pop-empty">No matches</div>')
      + (footer ? `<div class="pop-sep"></div><button type="button" class="pop-item" data-foot>${ico('plus', 'width="16" height="16"')}<span class="t"><b>${esc(footer.label)}</b></span></button>` : '');
    input.setAttribute('aria-expanded', 'true'); place();
  };
  const run = async () => {
    const q = input.value.trim(); if (q.length < minChars) { items = []; return close(); }
    const my = ++seq; ctl?.abort(); ctl = new AbortController();
    try { const r = await search(q, ctl.signal); if (my !== seq) return; items = r || []; hl = 0; paint(); } catch (e) { if (e.name !== 'AbortError' && my === seq) { items = []; paint(); } }
  };
  const runD = debounce(run, wait);
  const pick = (i) => { const it = items[i]; if (!it) return; if (!keepOpen) close(); onPick(it, input); };
  input.addEventListener('focus', () => { input.select?.(); run(); });
  input.addEventListener('input', runD);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!pop) { run(); return; } e.preventDefault(); hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + Math.max(items.length, 1)) % Math.max(items.length, 1); paint(); pop.querySelector('.hl')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && pop && items.length) { e.preventDefault(); pick(hl); }
    else if (e.key === 'Escape' && pop) { e.stopPropagation(); close(); }
  });
  return { close, refresh: run };
}

/* ---------- simple menus (popover of actions) ---------- */
export function menu(anchor, entries) {
  document.querySelectorAll('.pop.menu').forEach((p) => p.remove());
  const pop = document.createElement('div'); pop.className = 'pop menu glass-float';
  pop.innerHTML = entries.map((e, i) => e === '-' ? '<div class="pop-sep"></div>' : e.title ? `<div class="pop-title">${esc(e.title)}</div>` : `<button class="pop-item" data-i="${i}" ${e.disabled ? 'disabled' : ''}>${e.icon ? ico(e.icon, 'width="17" height="17"') : ''}<span class="t"><b>${esc(e.label)}</b>${e.hint ? `<small>${esc(e.hint)}</small>` : ''}</span></button>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  requestAnimationFrame(() => pop.classList.add('on'));
  const off = () => { pop.classList.remove('on'); setTimeout(() => pop.remove(), 160); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc2, true); };
  const away = (e) => { if (!pop.contains(e.target)) off(); };
  const esc2 = (e) => { if (e.key === 'Escape') { e.stopPropagation(); off(); } };
  document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc2, true);
  pop.addEventListener('click', (ev) => { const b = ev.target.closest('[data-i]'); if (!b) return; off(); entries[+b.dataset.i].onClick?.(); });
  return off;
}

/* ---------- declarative forms (used by the master-data dialogs) ---------- */
export function fieldHtml(f, v = {}) {
  const val = v[f.name] ?? f.value ?? '';
  const id = `f-${f.name}`;
  let c;
  if (f.type === 'select') c = html`<select class="inp" id="${id}" name="${f.name}">${(f.options || []).map((o) => html`<option value="${o.value}" ${String(o.value) === String(val) ? raw('selected') : ''}>${o.label}</option>`)}</select>`;
  else if (f.type === 'textarea') c = html`<textarea class="inp" id="${id}" name="${f.name}" placeholder="${f.ph || ''}">${val}</textarea>`;
  else if (f.type === 'check') return html`<div class="field ${f.full ? 'full' : ''}"><label class="check"><input type="checkbox" name="${f.name}" ${val ? raw('checked') : ''}> ${f.label}</label></div>`;
  else c = html`<input class="inp ${f.type === 'number' ? 'num' : ''}" id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${val}" placeholder="${f.ph || ''}" ${f.step ? raw(`step="${f.step}"`) : ''} ${f.readonly ? raw('readonly') : ''} ${f.req ? raw('required') : ''} autocomplete="off">`;
  return html`<div class="field ${f.full ? 'full' : ''}"><label for="${id}" class="${f.req ? 'req' : ''}">${f.label}</label>${c}${f.hint ? html`<span class="hint">${f.hint}</span>` : ''}</div>`;
}
export const formHtml = (fields, values) => html`<div class="form-grid">${fields.map((f) => fieldHtml(f, values))}</div>`;
export function readForm(root) {
  const o = {};
  $$('[name]', root).forEach((el) => { o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
  return o;
}

/* ---------- misc ---------- */
export function downloadCSV(name, rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export const navigate = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
export const empty = (icon, h, p, action = '') => html`<div class="empty"><div class="ico">${raw(ico(icon))}</div><h3>${h}</h3><p>${p}</p>${action}</div>`;
export const skeleton = (rows = 6) => html`<div>${Array.from({ length: rows }, () => html`<div class="sk sk-row"></div>`)}</div>`;
export const errorNote = (e) => html`<div class="note bad">${raw(ico('alert'))}<div><b>Couldn't load this.</b> ${e.message || e}</div></div>`;

/* pointer-follow sheen for .sheen surfaces (one delegated, rAF-throttled listener) */
let raf = 0;
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest && e.target.closest('.sheen'); if (!t || raf) return;
  raf = requestAnimationFrame(() => { raf = 0; const r = t.getBoundingClientRect(); t.style.setProperty('--mx', `${e.clientX - r.left}px`); t.style.setProperty('--my', `${e.clientY - r.top}px`); });
}, { passive: true });
