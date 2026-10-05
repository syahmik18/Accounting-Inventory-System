/* ==========================================================================
   composer.js — create / revise documents.
   Entry point + shared frame + the item-based editor. The other editors
   (delivery, GRN, notes, receipts/payments, cash-book vouchers) live in
   composer-kinds.js and use the same frame.
   ========================================================================== */
import { $, html, raw, esc, str, api, ref, cached, invalidate, emit, user, num, round2, fmt, rm, today, addDays, fmtDate, title, activeOnly, cashAccounts, toast, navigate, errorNote, setHTML, empty } from './core.js';
import { ico } from './icons.js';
import { moduleTabs } from './nav.js';
import { lineGrid, partnerField } from './lines.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const METHODS = [['BANK_TRANSFER', 'Bank transfer'], ['CASH', 'Cash'], ['CARD', 'Card'], ['CHEQUE', 'Cheque'], ['EWALLET', 'E-wallet']];

const K = (o) => ({ type: 'item', posts: true, tax: 'code', account: true, ...o });
const KIND = {
  'sales/quotations': K({ side: 'SALES', partner: 'CUSTOMER', req: true, posts: false, account: false, noKey: 'quotationNo', dateKey: 'quotationDate', ep: '/quotations', extra: { key: 'validUntil', label: 'Valid until', def: () => addDays(today(), 30) } }),
  'sales/orders': K({ side: 'SALES', partner: 'CUSTOMER', req: true, posts: false, account: false, noKey: 'orderNo', dateKey: 'orderDate', ep: '/sales-orders', source: 'quotation', extra: { key: 'expectedDate', label: 'Expected delivery', def: () => addDays(today(), 7) } }),
  'sales/invoices': K({ side: 'SALES', partner: 'CUSTOMER', req: true, stockOut: true, noKey: 'invoiceNo', dateKey: 'invoiceDate', ep: '/invoices', source: 'do', due: true }),
  'sales/cash-sales': K({ side: 'SALES', partner: 'CUSTOMER', pay: 'Received into', stockOut: true, noKey: 'cashSaleNo', dateKey: 'saleDate', ep: '/cash-sales' }),
  'purchases/requests': K({ side: 'PURCHASE', pr: true, posts: false, tax: 'none', account: false, noKey: 'prNo', dateKey: 'requestDate', ep: '/purchase-requests', priceLabel: 'Est. unit price' }),
  'purchases/orders': K({ side: 'PURCHASE', partner: 'VENDOR', req: true, posts: false, tax: 'rate', noKey: 'poNo', dateKey: 'orderDate', ep: '/purchase-orders', source: 'pr', extra: { key: 'expectedDate', label: 'Expected delivery', def: () => '' } }),
  'purchases/invoices': K({ side: 'PURCHASE', partner: 'VENDOR', req: true, noKey: 'invoiceNo', dateKey: 'invoiceDate', ep: '/purchase-invoices', source: 'grn', due: true, noLabel: "Supplier's invoice no." }),
  'purchases/cash-purchases': K({ side: 'PURCHASE', partner: 'VENDOR', pay: 'Paid from', noKey: 'cashPurchaseNo', dateKey: 'purchaseDate', ep: '/cash-purchases' }),
};
const OTHER = { 'sales/deliveries': 'delivery', 'purchases/grn': 'grn', 'sales/credit-notes': 'note', 'sales/debit-notes': 'note', 'sales/receipts': 'settle', 'purchases/payments': 'settle', 'accounting/payment-vouchers': 'gl', 'accounting/official-receipts': 'gl' };

/* source documents that can seed a new one */
const SRC = {
  quotation: { label: 'Create from quotation (optional)', list: async () => (await api.get('/quotations')).filter((q) => q.status === 'OPEN'), opt: (q) => `${q.quotation_no} · ${q.partner_name} · ${rm(q.total_amount)}`, id: 'quotation_id', detail: (id) => api.get(`/quotations/${id}`) },
  do: { label: 'Invoice a delivery order (optional)', list: async () => (await api.get('/delivery-orders')).filter((d) => d.status === 'POSTED' && !d.is_fully_invoiced), opt: (d) => `${d.delivery_no} · ${d.partner_name} · ${rm(d.subtotal)}`, id: 'delivery_order_id', detail: (id) => api.get(`/delivery-orders/${id}`) },
  pr: { label: 'Create from approved request (optional)', list: async () => (await api.get('/purchase-requests')).filter((p) => p.status === 'APPROVED'), opt: (p) => `${p.pr_no} · ${p.requested_by || ''}`, id: 'pr_id', detail: (id) => api.get(`/purchase-requests/${id}`) },
  grn: { label: 'Match to goods received note (optional)', list: async () => (await api.get('/goods-received-notes')).filter((g) => g.status === 'POSTED' && !g.is_fully_invoiced), opt: (g) => `${g.grn_no} · ${g.partner_name} · ${rm(g.total_value)}`, id: 'grn_id', detail: (id) => api.get(`/goods-received-notes/${id}`) },
};
const fullItem = (id) => cached(`ref:item:${id}`, () => api.get(`/stock-items/${id}`), 30000);
const hydrate = async (lines) => Promise.all(lines.map(async (l) => (l.stock_item_id ? { ...l, item: await fullItem(l.stock_item_id).catch(() => null) } : l)));
const stockOf = (l) => (l.item ? l.item : l.stock_item_id ? { stock_item_id: l.stock_item_id, item_code: l.item_code, item_name: l.description } : null);

/* ---------- shared frame ---------- */
export function frame(env, { heading, sub = '', mainHtml, banner = '' }) {
  const { ctx, cfg, posts } = env;
  ctx.root.innerHTML = str(html`${moduleTabs(cfg.mod, cfg.key)}
    <div class="page-head"><div><div class="crumbs"><a href="#/${cfg.route}">${cfg.plural}</a> / ${heading.startsWith('Revise') ? 'Revise' : 'New'}</div><h1>${heading}</h1><div class="sub">${sub}</div></div><div class="actions"><a class="btn" href="#/${cfg.route}">Cancel</a></div></div>
    ${banner}
    <div class="composer"><div class="stack" data-main>${mainHtml}</div>
      <div class="side"><div class="card"><div class="tot" data-tot></div></div>
        <div class="card"><div class="actions-bar"><div data-err></div><button class="btn primary lg" data-save>${raw(ico('check'))}${posts ? 'Save & post' : 'Save'} ${cfg.label.toLowerCase()}</button><a class="btn" href="#/${cfg.route}">Cancel</a><span class="muted" style="font-size:12px;text-align:center">${IS_MAC ? '⌘' : 'Ctrl'} + Enter to save</span></div></div></div></div>`);
  const F = { root: ctx.root, main: $('[data-main]', ctx.root), tot: $('[data-tot]', ctx.root), err: $('[data-err]', ctx.root), save: $('[data-save]', ctx.root) };
  ctx.root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); F.save.click(); } });
  return F;
}
export const totalsHtml = (c, extra = '') => str(html`<div class="r"><span>Subtotal</span><span>${rm(c.subtotal)}</span></div>${(c.groups || []).map((g) => html`<div class="r"><span>${g.label}</span><span>${rm(g.amount)}</span></div>`)}${c.groups && c.groups.length ? '' : c.tax != null ? html`<div class="r"><span>Tax</span><span>${rm(c.tax)}</span></div>` : ''}<div class="r g"><span>Total</span><span>${rm(c.total)}</span></div>${raw(extra)}`);
export function showErr(F, errs) {
  const list = [].concat(errs).filter(Boolean);
  F.err.innerHTML = list.length ? str(html`<div class="note bad">${raw(ico('alert'))}<div>${list.length === 1 ? list[0] : html`<b>Please fix ${list.length} things</b><ul style="margin:4px 0 0;padding-left:18px">${list.slice(0, 6).map((e) => html`<li>${e}</li>`)}${list.length > 6 ? html`<li>…and ${list.length - 6} more</li>` : ''}</ul>`}</div></div>`) : '';
  if (list.length) F.err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
/** POST → success toast, optional void of the revised original, then open the new document */
export async function submitDoc(env, F, endpoint, payload, { reviseId = null, voidOriginal = false } = {}) {
  const { cfg } = env;
  F.save.disabled = true; const label = F.save.innerHTML; F.save.innerHTML = 'Saving…'; showErr(F, []);
  try {
    const res = await api.post(endpoint, payload);
    const newId = res[cfg.resId] ?? res.id ?? res[Object.keys(res).find((k) => /Id$/.test(k) && !/journal|original/i.test(k))];
    const docNo = res[Object.keys(res).find((k) => /No$/.test(k))] || '';
    toast(`${cfg.label} ${docNo} ${env.posts ? 'posted' : 'saved'}`);
    if (Array.isArray(res.stockWarnings) && res.stockWarnings.length) toast(res.stockWarnings.map((w) => (typeof w === 'string' ? w : w.message || JSON.stringify(w))).join(' · '), 'warn', 8000);
    if (reviseId && voidOriginal) {
      try { await api.post(`/document-actions/${cfg.act}/${reviseId}/void`, { reason: `Superseded by ${docNo}`, createdBy: user() }); toast('Original document voided'); }
      catch (e) { toast(`Saved, but the original could not be voided: ${e.message}`, 'warn', 9000); }
    }
    invalidate(); emit('changed');
    navigate(newId ? `#/${cfg.route}?view=${newId}` : `#/${cfg.route}`);
  } catch (e) { F.save.disabled = false; F.save.innerHTML = label; showErr(F, e.message); toast(e.message, 'bad'); }
}

export default async function composer(ctx, cfg) {
  const k = KIND[cfg.route];
  try {
    const [accounts, taxCodes] = await Promise.all([ref.accounts(), ref.taxCodes()]);
    const env = { ctx, cfg, accounts: activeOnly(accounts), allAccounts: accounts, taxCodes: activeOnly(taxCodes), cash: cashAccounts(accounts), posts: k ? k.posts : true };
    if (k) return await itemComposer(env, k);
    const kind = OTHER[cfg.route];
    if (!kind) return setHTML(ctx.root, empty('search', 'Not available', 'This document cannot be created here.'));
    const m = await import('./composer-kinds.js');
    return await m[kind](env);
  } catch (e) { console.error(e); setHTML(ctx.root, errorNote(e)); }
}

/* ==========================================================================
   Item-based editor
   ========================================================================== */
async function itemComposer(env, k) {
  const { ctx, cfg, accounts, taxCodes } = env; const q = ctx.query;
  const revise = q.revise || null;
  const srcKey = k.source && Object.keys(SRC).find((s) => q[s]) === k.source ? k.source : null;
  const isPR = !!k.pr;
  const cashDefault = (m) => (env.cash.find((a) => (m === 'CASH' ? /cash/i.test(a.account_name) : !/cash/i.test(a.account_name))) || env.cash[0] || {}).account_id;

  const F = frame(env, {
    heading: revise ? `Revise ${cfg.label.toLowerCase()}` : `New ${cfg.label.toLowerCase()}`,
    sub: revise ? 'Saving creates a new document based on this one.' : k.posts ? 'Posts to the ledger as soon as you save.' : 'No accounting entries until it is converted.',
    banner: revise ? html`<div class="note warn">${raw(ico('info'))}<div><b>Revising an existing ${cfg.label.toLowerCase()}.</b> A new number is issued. <label class="check" style="margin-left:8px"><input type="checkbox" data-void-orig checked> Void the original after saving</label></div></div>` : '',
    mainHtml: html`<div class="card pad"><div class="form-grid">
      ${isPR ? html`<div class="field"><label class="req" for="pr-by">Requested by</label><input class="inp" id="pr-by" data-by value="${user()}"></div>` : k.partner ? html`<div data-partner></div>` : ''}
      <div class="field"><label>${k.noLabel || 'Document no.'}</label><input class="inp" data-no placeholder="Auto-generated" autocomplete="off"></div>
      <div class="field"><label class="req">${title(k.dateKey.replace(/Date$/, '')) === 'Sale' ? 'Sale date' : 'Date'}</label><input class="inp" type="date" data-date value="${today()}"></div>
      ${k.extra ? html`<div class="field"><label>${k.extra.label}</label><input class="inp" type="date" data-extra value="${k.extra.def()}"></div>` : ''}
      ${k.due ? html`<div class="field"><label class="req">Due date</label><input class="inp" type="date" data-due value="${addDays(today(), 30)}"><span class="hint" data-terms></span></div>` : ''}
      ${k.pay ? html`<div class="field"><label>Payment method</label><select class="inp" data-method>${METHODS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div><div class="field"><label class="req">${k.pay}</label><select class="inp" data-cashacct>${env.cash.map((a) => html`<option value="${a.account_id}">${a.account_code} · ${a.account_name}</option>`)}</select></div>` : ''}
      ${k.source ? html`<div class="field full"><label>${SRC[k.source].label}</label><select class="inp" data-source><option value="">— none, enter lines manually —</option></select></div>` : ''}
      ${isPR ? html`<div class="field full"><label>Notes</label><textarea class="inp" data-notes placeholder="Why is this needed?"></textarea></div>` : ''}
    </div></div>
    <div class="card"><div class="card-h"><div><div class="card-t">Items</div><div class="card-s">${k.tax === 'none' ? 'Estimated prices are used for approval only.' : 'Tax and account for stock items come from the item master.'}</div></div></div><div data-grid style="padding-top:8px"></div></div>`,
  });
  env.F = F;

  /* ---- partner ---- */
  let dueTouched = false;
  const $due = $('[data-due]', F.root), $date = $('[data-date]', F.root);
  const syncDue = () => { if (!k.due || dueTouched) return; const p = pf && pf.get(); const t = p && p.credit_terms_days != null ? +p.credit_terms_days : 30; $due.value = addDays($date.value || today(), t); const h = $('[data-terms]', F.root); if (h) h.textContent = `${t}-day credit terms`; };
  const pf = k.partner ? partnerField($('[data-partner]', F.root), { type: k.partner, label: k.partner === 'CUSTOMER' ? 'Customer' : 'Supplier', req: k.req, placeholder: k.req ? '' : `Optional — leave empty for ${cfg.optionalParty || 'walk-in'}`, onPick: syncDue }) : null;
  if ($due) $due.addEventListener('input', () => { dueTouched = true; });
  $date.addEventListener('change', syncDue);

  /* ---- grid ---- */
  const base = { side: k.side, tax: k.tax, account: k.account, stockOut: k.stockOut, taxCodes, accounts, priceLabel: k.priceLabel, priceRequired: isPR };
  const gridHost = $('[data-grid]', F.root);
  let grid, source = null;
  const paint = (c) => { F.tot.innerHTML = totalsHtml(isPR ? { subtotal: c.subtotal, tax: null, total: c.subtotal } : c); if (isPR) F.tot.innerHTML = str(html`<div class="r g"><span>Estimated total</span><span>${rm(c.subtotal)}</span></div>`); };
  const makeGrid = (extra = {}) => { grid = lineGrid(gridHost, { ...base, ...extra, onChange: paint }); return grid; };
  makeGrid(); grid.add({}); paint(grid.calc());

  const lineInit = (l, h) => ({ stock: stockOf(h), description: l.description, quantity: num(l.quantity ?? l.quantity_received), unitPrice: num(l.unit_price ?? l.estimated_unit_price), taxCodeId: l.tax_code_id || null,
    ...(k.tax === 'rate' && !l.tax_code_id && l.tax_rate != null ? { taxCodeId: (taxCodes.find((t) => /^PUR/i.test(t.direction) && num(t.rate) === num(l.tax_rate)) || {}).tax_code_id || null } : {}) });

  async function applySource(type, id) {
    const S = SRC[type]; const d = await S.detail(id); source = { type, id };
    if (d.partner_id && pf) { pf.set(await ref.partner(d.partner_id)); syncDue(); }
    const lock = type === 'do' || type === 'grn';
    if (pf) pf.lock(lock, lock ? 'Set by the source document' : undefined);
    const rows = type === 'grn' ? [...d.lines].sort((a, b) => (a.line_id < b.line_id ? -1 : 1)) : d.lines;
    const h = await hydrate(rows);
    if (lock) { makeGrid({ taxSelect: type === 'grn' ? 'blank' : false }); grid.lock(true); } else makeGrid();
    grid.clear();
    rows.forEach((l, i) => grid.add({ ...lineInit(l, h[i]), locked: lock }));
    paint(grid.calc());
  }
  async function clearSource() { source = null; if (pf) { pf.lock(false); } makeGrid(); grid.add({}); paint(grid.calc()); }

  if (k.source) {
    const sel = $('[data-source]', F.root);
    try { const list = await SRC[k.source].list(); sel.innerHTML += list.map((s) => `<option value="${s[SRC[k.source].id]}">${esc(SRC[k.source].opt(s))}</option>`).join(''); } catch { /* list unavailable */ }
    sel.addEventListener('change', async () => { try { if (sel.value) await applySource(k.source, sel.value); else await clearSource(); } catch (e) { showErr(F, e.message); } });
    if (srcKey) { if (![...sel.options].some((o) => o.value === q[srcKey])) sel.innerHTML += `<option value="${esc(q[srcKey])}">Selected document</option>`; sel.value = q[srcKey]; try { await applySource(srcKey, q[srcKey]); } catch (e) { showErr(F, e.message); } }
  }

  /* ---- revise: prefill from the original ---- */
  if (revise) {
    try {
      const d = await cfg.detail(revise);
      if (pf && d.partner_id) { pf.set(await ref.partner(d.partner_id)); }
      if (isPR) { $('[data-by]', F.root).value = d.requested_by || user(); const n = $('[data-notes]', F.root); if (n) n.value = d.notes || ''; }
      const dateVal = d[Object.keys(d).find((x) => /(_date)$/.test(x) && !/valid|expected|due/.test(x))]; if (dateVal) $date.value = String(dateVal).slice(0, 10);
      if (k.extra && d[k.extra.key.replace(/([A-Z])/g, '_$1').toLowerCase()]) $('[data-extra]', F.root).value = String(d[k.extra.key.replace(/([A-Z])/g, '_$1').toLowerCase()]).slice(0, 10);
      if ($due && d.due_date) { $due.value = String(d.due_date).slice(0, 10); dueTouched = true; }
      if (k.pay) { $('[data-method]', F.root).value = d.payment_method; if (d.cash_account_id) $('[data-cashacct]', F.root).value = d.cash_account_id; }
      const h = await hydrate(d.lines); makeGrid(); grid.clear();
      d.lines.forEach((l, i) => grid.add({ ...lineInit(l, h[i]), accountId: l.revenue_account_id || l.expense_account_id || null })); paint(grid.calc());
    } catch (e) { showErr(F, `Could not load the original: ${e.message}`); }
  }
  if (k.pay) { const m = $('[data-method]', F.root), a = $('[data-cashacct]', F.root); if (!revise) a.value = cashDefault(m.value); m.addEventListener('change', () => { a.value = cashDefault(m.value) || a.value; }); }
  syncDue();

  /* ---- save ---- */
  F.save.addEventListener('click', () => {
    const { lines, errors } = grid.collect(); const errs = [...errors];
    const partner = pf ? pf.get() : null; if (k.req && !partner) errs.unshift(`Choose a ${k.partner === 'CUSTOMER' ? 'customer' : 'supplier'}`);
    if (isPR && !$('[data-by]', F.root).value.trim()) errs.unshift('Enter who is requesting');
    if (!$date.value) errs.unshift('Choose a date');
    if ($due && !$due.value) errs.unshift('Choose a due date');
    if (errs.length) { showErr(F, errs); return; }
    const p = { createdBy: user(), [k.dateKey]: $date.value };
    const no = $('[data-no]', F.root).value.trim(); if (no) p[k.noKey] = no;
    if (k.partner) p.partnerId = partner ? partner.partner_id : null;
    if (k.extra) { const v = $('[data-extra]', F.root).value; p[k.extra.key] = v || null; }
    if ($due) p.dueDate = $due.value;
    if (k.pay) { p.paymentMethod = $('[data-method]', F.root).value; p.cashAccountId = $('[data-cashacct]', F.root).value; }
    const acct = (l) => (l.isStock || !l.accountId ? {} : k.side === 'SALES' ? { revenueAccountId: l.accountId } : { expenseAccountId: l.accountId });
    const core = (l) => ({ stockItemId: l.stockItemId, itemCode: l.itemCode, description: l.description, quantity: l.quantity });
    switch (cfg.route) {
      case 'sales/quotations': case 'sales/orders': p.lines = lines.map((l) => ({ ...core(l), unitPrice: l.unitPrice, ...(l.isStock ? {} : { taxCodeId: l.taxCodeId }) })); if (source && source.type === 'quotation') p.quotationId = source.id; break;
      case 'sales/invoices': p.lines = lines.map((l) => ({ ...core(l), unitPrice: l.unitPrice, ...(l.isStock && !(source && source.type === 'do') ? {} : { taxCodeId: l.taxCodeId }), ...acct(l) })); if (source && source.type === 'do') p.deliveryOrderId = source.id; break;
      case 'sales/cash-sales': p.lines = lines.map((l) => ({ ...core(l), unitPrice: l.unitPrice, ...(l.isStock ? {} : { taxCodeId: l.taxCodeId }), ...acct(l) })); break;
      case 'purchases/requests': p.requestedBy = $('[data-by]', F.root).value.trim(); p.notes = $('[data-notes]', F.root).value.trim() || null; p.lines = lines.map((l) => ({ ...core(l), estimatedUnitPrice: l.unitPrice })); break;
      case 'purchases/orders': p.lines = lines.map((l) => ({ ...core(l), unitPrice: l.unitPrice, taxRate: l.taxRate, ...acct(l) })); if (source && source.type === 'pr') p.prId = source.id; break;
      case 'purchases/invoices': p.lines = lines.map((l) => ({ ...core(l), unitPrice: l.unitPrice, taxCodeId: l.taxCodeId, ...acct(l) })); if (source && source.type === 'grn') p.grnId = source.id; break;
      case 'purchases/cash-purchases': p.lines = lines.map((l) => ({ ...core(l), unitPrice: l.unitPrice, taxCodeId: l.taxCodeId, ...acct(l) })); break;
      default: break;
    }
    submitDoc(env, F, k.ep, p, { reviseId: revise, voidOriginal: !!(revise && $('[data-void-orig]', F.root)?.checked) });
  });
}
