/* ==========================================================================
   docs.js — every sales, purchase and cash-book document, driven by ONE
   registry: list page (search / status / period filters / sort / paging /
   CSV), detail drawer (lines, totals, linked documents, next steps, print)
   and the void / delete / approve actions. The composer (create + revise)
   lives in composer.js and reads the same registry.
   ========================================================================== */
import { $, $$, html, raw, esc, str, api, ref, cached, invalidate, emit, user, num, fmt, rm, qty, fmtDate, today, addDays, monthStart, yearStart, dayDiff, title, badge, isDead, tone,
  openDrawer, confirmDialog, toast, empty, skeleton, errorNote, setHTML, downloadCSV, navigate, debounce } from './core.js';
import { ico } from './icons.js';
import { moduleTabs } from './nav.js';

export const REG = {};
const def = (mod, key, c) => { REG[`${mod}/${key}`] = { mod, key, route: `${mod}/${key}`, ...c }; };
const link = (href, text) => html`<a href="${href}">${text}</a>`;
const pct = (r) => (num(r) ? `${fmt(r, 0)}%` : '—');

/* ---- shared view helpers ---- */
const itemRows = (lines, extra = []) => lines.map((l, i) => [i + 1, l.item_code || '—', l.description, qty(l.quantity), fmt(l.unit_price), pct(l.tax_rate), fmt(l.line_total ?? num(l.quantity) * num(l.unit_price)), ...extra.map((f) => f(l))]);
const itemCols = (extra = []) => [{ h: '#' }, { h: 'Item' }, { h: 'Description' }, { h: 'Qty', num: 1 }, { h: 'Unit price', num: 1 }, { h: 'Tax', num: 1 }, { h: 'Amount', num: 1 }, ...extra];
const totalsStd = (h) => [['Subtotal', rm(h.subtotal)], ['Tax', rm(h.tax_amount)], ['Total', rm(h.total_amount), true]];
const partyName = (d, row) => (row && row.partner) || d.partner_name || null;

/* =========================== SALES =========================== */
def('sales', 'quotations', {
  label: 'Quotation', plural: 'Quotations', icon: 'file', party: 'Customer', list: '/quotations', resId: 'quotationId', act: 'QUOTATION', revisable: true, partnerType: 'CUSTOMER',
  norm: (r) => ({ id: r.quotation_id, no: r.quotation_no, date: r.quotation_date, partner: r.partner_name, partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: r.valid_until ? `Valid until ${fmtDate(r.valid_until)}` : '' }),
  detail: (id) => api.get(`/quotations/${id}`),
  view: (d) => ({ meta: [['Quotation date', fmtDate(d.quotation_date)], ['Valid until', fmtDate(d.valid_until)], ['Prepared by', d.created_by || '—']], cols: itemCols(), rows: itemRows(d.lines), totals: totalsStd(d) }),
  next: (d) => (d.status === 'OPEN' ? [{ label: 'Convert to sales order', href: `#/sales/orders/new?quotation=${d.quotation_id}`, icon: 'arrowR', primary: 1 }] : []),
});
def('sales', 'orders', {
  label: 'Sales order', plural: 'Sales orders', icon: 'clipboard', party: 'Customer', list: '/sales-orders', resId: 'salesOrderId', act: 'SALES_ORDER', revisable: true, partnerType: 'CUSTOMER',
  norm: (r) => ({ id: r.sales_order_id, no: r.order_no, date: r.order_date, partner: r.partner_name, partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: r.expected_date ? `Expected ${fmtDate(r.expected_date)}` : '' }),
  detail: (id) => api.get(`/sales-orders/${id}`),
  view: (d) => ({ meta: [['Order date', fmtDate(d.order_date)], ['Expected delivery', fmtDate(d.expected_date)], ['From quotation', d.quotation_id ? link(`#/sales/quotations?view=${d.quotation_id}`, 'View quotation') : '—']],
    cols: itemCols([{ h: 'Delivered', num: 1 }]), rows: itemRows(d.lines, [(l) => qty(l.quantity_delivered)]), totals: totalsStd(d) }),
  next: (d) => (['OPEN', 'PARTIALLY_DELIVERED'].includes(d.status) ? [{ label: 'Create delivery order', href: `#/sales/deliveries/new?so=${d.sales_order_id}`, icon: 'suppliers', primary: 1 }] : []),
});
def('sales', 'deliveries', {
  label: 'Delivery order', plural: 'Delivery orders', icon: 'suppliers', party: 'Customer', list: '/delivery-orders', resId: 'deliveryOrderId', act: 'DELIVERY_ORDER', revisable: false, partnerType: 'CUSTOMER',
  norm: (r) => ({ id: r.delivery_order_id, no: r.delivery_no, date: r.delivery_date, partner: r.partner_name, partnerId: r.partner_id, total: r.subtotal, status: r.status, sub: r.order_no ? `Order ${r.order_no}` : '', invoiced: r.is_fully_invoiced }),
  cols: [{ h: 'Invoicing', cell: (r) => (r.status === 'VOID' ? '—' : r.invoiced ? badge('PAID', 'Invoiced') : badge('PENDING_APPROVAL', 'To invoice')) }],
  detail: (id) => api.get(`/delivery-orders/${id}`),
  view: (d) => ({ meta: [['Delivery date', fmtDate(d.delivery_date)], ['Sales order', d.sales_order_id ? link(`#/sales/orders?view=${d.sales_order_id}`, d.order_no || 'View order') : '—'], ['Invoicing', d.is_fully_invoiced ? 'Fully invoiced' : 'Not yet invoiced'], ['Notes', d.notes || '—']],
    cols: itemCols(), rows: itemRows(d.lines), totals: totalsStd(d) }),
  next: (d) => (d.status === 'POSTED' && !d.is_fully_invoiced ? [{ label: 'Create invoice', href: `#/sales/invoices/new?do=${d.delivery_order_id}`, icon: 'sales', primary: 1 }] : []),
});
def('sales', 'invoices', {
  label: 'Invoice', plural: 'Invoices', icon: 'sales', party: 'Customer', list: '/invoices', resId: 'invoiceId', act: 'INVOICE', revisable: (d) => !d.delivery_order_id, partnerType: 'CUSTOMER',
  norm: (r) => { const od = r.due_date && num(r.outstanding) > 0.005 && ['POSTED', 'PARTIALLY_PAID'].includes(r.status) ? dayDiff(today(), r.due_date) : 0;
    return { id: r.invoice_id, no: r.invoice_no, date: r.invoice_date, partner: r.partner_name, partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: r.due_date ? (od > 0 ? `Overdue ${od} day${od > 1 ? 's' : ''}` : `Due ${fmtDate(r.due_date)}`) : '', subBad: od > 0, paid: r.paid_amount, out: r.outstanding }; },
  cols: [{ h: 'Paid', num: 1, cell: (r) => fmt(r.paid) }, { h: 'Balance', num: 1, cell: (r) => (num(r.out) > 0.005 && !isDead(r.status) ? html`<b>${fmt(r.out)}</b>` : '—'), sort: (r) => num(r.out) }],
  detail: (id) => api.get(`/invoices/${id}`),
  view: (d) => { const out = num(d.total_amount) + num(d.debited_amount) - num(d.credited_amount) - num(d.paid_amount);
    return { meta: [['Invoice date', fmtDate(d.invoice_date)], ['Due date', fmtDate(d.due_date)], ['Delivery order', d.delivery_order_id ? link(`#/sales/deliveries?view=${d.delivery_order_id}`, 'View delivery order') : '—'], ['e-Invoice (MyInvois)', d.myinvois_uuid || 'Not submitted']],
      cols: itemCols(), rows: itemRows(d.lines), totals: [...totalsStd(d).slice(0, 2), ['Total', rm(d.total_amount), true], ...(num(d.debited_amount) ? [['Debit notes', rm(d.debited_amount)]] : []), ...(num(d.credited_amount) ? [['Credit notes', `- ${rm(d.credited_amount)}`]] : []), ['Paid', `- ${rm(d.paid_amount)}`], ['Balance due', rm(d.status === 'VOID' ? 0 : out), true]] }; },
  next: (d) => { const out = num(d.total_amount) + num(d.debited_amount) - num(d.credited_amount) - num(d.paid_amount); const live = !isDead(d.status);
    return [...(live && out > 0.005 ? [{ label: 'Receive payment', href: `#/sales/receipts/new?invoice=${d.invoice_id}`, icon: 'wallet', primary: 1 }] : []), ...(live ? [{ label: 'Credit note', href: `#/sales/credit-notes/new?invoice=${d.invoice_id}`, icon: 'arrowDown' }, { label: 'Debit note', href: `#/sales/debit-notes/new?invoice=${d.invoice_id}`, icon: 'arrowUp' }] : [])]; },
});
def('sales', 'cash-sales', {
  label: 'Cash sale', plural: 'Cash sales', icon: 'banknote', party: 'Customer', list: '/cash-sales', resId: 'cashSaleId', act: 'CASH_SALE', revisable: true, partnerType: 'CUSTOMER', optionalParty: 'Walk-in customer',
  norm: (r) => ({ id: r.cash_sale_id, no: r.cash_sale_no, date: r.sale_date, partner: r.partner_name || 'Walk-in customer', partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: title(r.payment_method) }),
  detail: (id) => api.get(`/cash-sales/${id}`),
  view: (d) => ({ meta: [['Sale date', fmtDate(d.sale_date)], ['Payment method', title(d.payment_method)]], cols: itemCols(), rows: itemRows(d.lines), totals: totalsStd(d) }),
  next: () => [],
});
const noteDef = (kind) => ({
  label: kind === 'credit' ? 'Credit note' : 'Debit note', plural: kind === 'credit' ? 'Credit notes' : 'Debit notes', icon: kind === 'credit' ? 'arrowDown' : 'arrowUp', party: 'Customer',
  list: `/sales-notes?type=${kind.toUpperCase()}`, resId: 'id', act: kind === 'credit' ? 'CREDIT_NOTE' : 'DEBIT_NOTE', revisable: false, partnerType: 'CUSTOMER', kind,
  norm: (r) => ({ id: r.note_id, no: r.note_no, date: r.note_date, partner: r.partner_name, partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: r.original_invoice_no ? `Against ${r.original_invoice_no}` : '' }),
  detail: (id) => api.get(`/sales-notes/${kind}/${id}`),
  view: (d) => ({ meta: [['Note date', fmtDate(d.note_date)], ['Original invoice', d.original_invoice_id ? link(`#/sales/invoices?view=${d.original_invoice_id}`, d.original_invoice_no || 'View invoice') : '—'], ...(kind === 'credit' ? [['Goods returned', d.return_goods ? 'Yes — stock returned' : 'No']] : [])],
    cols: [{ h: '#' }, { h: 'Description' }, { h: 'Qty', num: 1 }, { h: 'Unit price', num: 1 }, { h: 'Tax', num: 1 }, { h: 'Amount', num: 1 }],
    rows: d.lines.map((l, i) => [i + 1, l.description, qty(l.quantity), fmt(l.unit_price), pct(l.tax_rate), fmt(l.line_total)]), totals: totalsStd(d) }),
  next: () => [],
});
def('sales', 'debit-notes', noteDef('debit'));
def('sales', 'credit-notes', noteDef('credit'));
const settleView = (d, party, what) => ({ meta: [[`${what} date`, fmtDate(d.receipt_date || d.payment_date)], ['Method', title(d.payment_method)], ['Paid into / from', `${d.bank_account_code} · ${d.bank_account_name}`], [party, d.partner_name]],
  cols: [{ h: 'Invoice' }, { h: 'Invoice date' }, { h: 'Invoice total', num: 1 }, { h: 'Applied', num: 1 }],
  rows: d.allocations.map((a) => [a.invoice_no, fmtDate(a.invoice_date), fmt(a.total_amount), fmt(a.amount_applied)]), totals: [[`Total ${what.toLowerCase()}`, rm(d.amount), true]] });
def('sales', 'receipts', {
  label: 'Receipt', plural: 'Receipts', icon: 'wallet', party: 'Customer', list: '/receipts', resId: 'receiptId', act: 'RECEIPT', revisable: false, partnerType: 'CUSTOMER', noDelete: false,
  norm: (r) => ({ id: r.receipt_id, no: r.receipt_no, date: r.receipt_date, partner: r.partner_name, partnerId: r.partner_id, total: r.amount, status: r.status, sub: r.applied_to ? `Applied to ${r.applied_to}` : '', bank: r.bank_account_name }),
  cols: [{ h: 'Deposited to', cell: (r) => r.bank || '—' }],
  detail: (id) => api.get(`/receipts/${id}`), view: (d) => settleView(d, 'Customer', 'Receipt'), next: () => [],
});

/* =========================== PURCHASES =========================== */
def('purchases', 'requests', {
  label: 'Purchase request', plural: 'Purchase requests', icon: 'clipboard', party: 'Requested by', list: '/purchase-requests', resId: 'prId', act: 'PURCHASE_REQUEST', revisable: true, noAmount: true,
  norm: (r) => ({ id: r.pr_id, no: r.pr_no, date: r.request_date, partner: r.requested_by || '—', total: null, status: r.status, sub: r.notes || '' }),
  detail: (id) => api.get(`/purchase-requests/${id}`),
  view: (d) => ({ meta: [['Request date', fmtDate(d.request_date)], ['Requested by', d.requested_by || '—'], ['Approved by', d.approved_by ? `${d.approved_by} · ${fmtDate(String(d.approved_at).slice(0, 10))}` : '—'], ['Notes', d.notes || '—']],
    cols: [{ h: '#' }, { h: 'Item' }, { h: 'Description' }, { h: 'Qty', num: 1 }, { h: 'Est. unit price', num: 1 }, { h: 'Est. amount', num: 1 }],
    rows: d.lines.map((l, i) => [i + 1, l.item_code || '—', l.description, qty(l.quantity), fmt(l.estimated_unit_price), fmt(num(l.quantity) * num(l.estimated_unit_price))]),
    totals: [['Estimated total', rm(d.lines.reduce((s, l) => s + num(l.quantity) * num(l.estimated_unit_price), 0)), true]] }),
  next: (d) => (d.status === 'APPROVED' ? [{ label: 'Create purchase order', href: `#/purchases/orders/new?pr=${d.pr_id}`, icon: 'cart', primary: 1 }] : []),
  extra: (d) => (d.status === 'PENDING_APPROVAL' ? [{ do: 'approve', label: 'Approve', icon: 'check', primary: 1 }, { do: 'reject', label: 'Reject', icon: 'x', danger: 1 }] : []),
});
def('purchases', 'orders', {
  label: 'Purchase order', plural: 'Purchase orders', icon: 'cart', party: 'Supplier', list: '/purchase-orders', resId: 'poId', act: 'PURCHASE_ORDER', revisable: true, partnerType: 'VENDOR',
  norm: (r) => ({ id: r.po_id, no: r.po_no, date: r.order_date, partner: r.partner_name, partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: r.expected_date ? `Expected ${fmtDate(r.expected_date)}` : '' }),
  detail: (id) => api.get(`/purchase-orders/${id}`),
  view: (d) => ({ meta: [['Order date', fmtDate(d.order_date)], ['Expected', fmtDate(d.expected_date)], ['From request', d.pr_id ? link(`#/purchases/requests?view=${d.pr_id}`, 'View request') : '—']],
    cols: itemCols([{ h: 'Received', num: 1 }]), rows: itemRows(d.lines, [(l) => qty(l.quantity_received)]), totals: totalsStd(d) }),
  next: (d) => (['SENT', 'PARTIALLY_RECEIVED'].includes(d.status) ? [{ label: 'Receive goods', href: `#/purchases/grn/new?po=${d.po_id}`, icon: 'inbox', primary: 1 }] : []),
});
def('purchases', 'grn', {
  label: 'Goods received note', plural: 'Goods received', icon: 'inbox', party: 'Supplier', list: '/goods-received-notes', resId: 'grnId', act: 'GRN', revisable: false, partnerType: 'VENDOR',
  norm: (r) => ({ id: r.grn_id, no: r.grn_no, date: r.received_date, partner: r.partner_name, total: r.total_value, status: r.status, sub: r.po_no ? `Order ${r.po_no}` : '', invoiced: r.is_fully_invoiced }),
  cols: [{ h: 'Invoicing', cell: (r) => (r.status === 'VOID' ? '—' : r.invoiced ? badge('PAID', 'Invoiced') : badge('PENDING_APPROVAL', 'To invoice')) }],
  detail: (id) => api.get(`/goods-received-notes/${id}`),
  view: (d) => ({ meta: [['Received date', fmtDate(d.received_date)], ['Purchase order', d.po_id ? link(`#/purchases/orders?view=${d.po_id}`, 'View purchase order') : '—'], ['Invoicing', d.is_fully_invoiced ? 'Fully invoiced' : 'Awaiting supplier invoice']],
    cols: [{ h: '#' }, { h: 'Item' }, { h: 'Description' }, { h: 'Qty received', num: 1 }, { h: 'Unit price', num: 1 }, { h: 'Amount', num: 1 }],
    rows: d.lines.map((l, i) => [i + 1, l.item_code || '—', l.description, qty(l.quantity_received), fmt(l.unit_price), fmt(l.line_total)]), totals: [['Total received value', rm(d.total_value), true]] }),
  next: (d) => (d.status === 'POSTED' && !d.is_fully_invoiced ? [{ label: 'Create supplier invoice', href: `#/purchases/invoices/new?grn=${d.grn_id}`, icon: 'purchases', primary: 1 }] : []),
});
def('purchases', 'invoices', {
  label: 'Supplier invoice', plural: 'Supplier invoices', icon: 'purchases', party: 'Supplier', list: '/purchase-invoices', resId: 'purchaseInvoiceId', act: 'PURCHASE_INVOICE', revisable: (d) => !d.grn_id, partnerType: 'VENDOR',
  norm: (r) => { const out = num(r.total_amount) - num(r.paid_amount); const od = r.due_date && out > 0.005 && ['POSTED', 'PARTIALLY_PAID'].includes(r.status) ? dayDiff(today(), r.due_date) : 0;
    return { id: r.purchase_invoice_id, no: r.invoice_no, date: r.invoice_date, partner: r.partner_name, partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: r.due_date ? (od > 0 ? `Overdue ${od} day${od > 1 ? 's' : ''}` : `Due ${fmtDate(r.due_date)}`) : '', subBad: od > 0, paid: r.paid_amount, out }; },
  cols: [{ h: 'Paid', num: 1, cell: (r) => fmt(r.paid) }, { h: 'Balance', num: 1, cell: (r) => (num(r.out) > 0.005 && !isDead(r.status) ? html`<b>${fmt(r.out)}</b>` : '—'), sort: (r) => num(r.out) }],
  detail: (id) => api.get(`/purchase-invoices/${id}`),
  view: (d) => ({ meta: [['Invoice date', fmtDate(d.invoice_date)], ['Due date', fmtDate(d.due_date)], ['Goods received note', d.grn_id ? link(`#/purchases/grn?view=${d.grn_id}`, 'View GRN') : '—']],
    cols: itemCols(), rows: itemRows(d.lines), totals: [...totalsStd(d), ['Paid', `- ${rm(d.paid_amount)}`], ['Balance due', rm(d.status === 'VOID' ? 0 : num(d.total_amount) - num(d.paid_amount)), true]] }),
  next: (d) => (['POSTED', 'PARTIALLY_PAID'].includes(d.status) && num(d.total_amount) - num(d.paid_amount) > 0.005 ? [{ label: 'Pay supplier', href: `#/purchases/payments/new?invoice=${d.purchase_invoice_id}`, icon: 'card', primary: 1 }] : []),
});
def('purchases', 'cash-purchases', {
  label: 'Cash purchase', plural: 'Cash purchases', icon: 'banknote', party: 'Supplier', list: '/cash-purchases', resId: 'cashPurchaseId', act: 'CASH_PURCHASE', revisable: true, partnerType: 'VENDOR', optionalParty: 'Unregistered vendor',
  norm: (r) => ({ id: r.cash_purchase_id, no: r.cash_purchase_no, date: r.purchase_date, partner: r.partner_name || 'Unregistered vendor', partnerId: r.partner_id, total: r.total_amount, status: r.status, sub: title(r.payment_method) }),
  detail: (id) => api.get(`/cash-purchases/${id}`),
  view: (d) => ({ meta: [['Purchase date', fmtDate(d.purchase_date)], ['Payment method', title(d.payment_method)]], cols: itemCols(), rows: itemRows(d.lines), totals: totalsStd(d) }), next: () => [],
});
def('purchases', 'payments', {
  label: 'Supplier payment', plural: 'Payments', icon: 'card', party: 'Supplier', list: '/payments', resId: 'paymentId', act: 'PAYMENT', revisable: false, partnerType: 'VENDOR',
  norm: (r) => ({ id: r.payment_id, no: r.payment_no, date: r.payment_date, partner: r.partner_name, partnerId: r.partner_id, total: r.amount, status: r.status, sub: r.applied_to ? `Applied to ${r.applied_to}` : '', bank: r.bank_account_name }),
  cols: [{ h: 'Paid from', cell: (r) => r.bank || '—' }],
  detail: (id) => api.get(`/payments/${id}`), view: (d) => settleView(d, 'Supplier', 'Payment'), next: () => [],
});

/* =========================== CASH BOOK =========================== */
const cbDef = (key, label, plural, path, idk, nok, dk, who, icon, resId) => def('accounting', key, {
  label, plural, icon, party: who, list: `/cash-book/${path}`, resId, cb: `/cash-book/${path}`, revisable: false, noDelete: false,
  norm: (r) => ({ id: r[idk], no: r[nok], date: r[dk], partner: r[who === 'Payee' ? 'payee' : 'payer'] || '—', total: r.total_amount, status: r.status, sub: r.cash_account_name || '' }),
  detail: (id) => api.get(`/cash-book/${path}/${id}`),
  view: (d) => ({ meta: [[`${label} date`, fmtDate(d[dk])], [who, d[who === 'Payee' ? 'payee' : 'payer'] || '—'], [key === 'payment-vouchers' ? 'Paid from' : 'Received into', `${d.cash_account_code} · ${d.cash_account_name}`], ['Description', d.description || '—']],
    cols: [{ h: '#' }, { h: 'Account' }, { h: 'Description' }, { h: 'Amount', num: 1 }], rows: d.lines.map((l, i) => [i + 1, `${l.account_code} · ${l.account_name}`, l.description || '—', fmt(l.amount)]), totals: [['Total', rm(d.total_amount), true]] }),
  next: () => [],
});
cbDef('payment-vouchers', 'Payment voucher', 'Payment vouchers', 'payment-vouchers', 'pv_id', 'pv_no', 'pv_date', 'Payee', 'card', 'pvId');
cbDef('official-receipts', 'Official receipt', 'Official receipts', 'official-receipts', 'or_id', 'or_no', 'or_date', 'Payer', 'wallet', 'orId');

/* ==========================================================================
   List page
   ========================================================================== */
const PAGE = 40;
export default async function render(ctx) {
  const cfg = REG[`${ctx.segs[0]}/${ctx.segs[1]}`];
  if (!cfg) { setHTML(ctx.root, empty('search', 'Unknown document type', 'Check the address or use the sidebar.')); return; }
  if (ctx.segs[2] === 'new') { const m = await import('./composer.js'); return m.default(ctx, cfg); }
  return listPage(ctx, cfg);
}

async function listPage(ctx, cfg) {
  const { root, query } = ctx;
  const S = { rows: [], q: '', status: query.status || '', period: 'all', from: '', to: '', sort: { k: 'date', dir: -1 }, page: 1 };
  root.innerHTML = str(html`
    ${moduleTabs(cfg.mod, cfg.key)}
    <div class="page-head"><div><h1>${cfg.plural}</h1><div class="sub" id="sub">Loading…</div></div>
      <div class="actions"><button class="btn" data-x="csv">${raw(ico('download'))}Export CSV</button><a class="btn primary" href="#/${cfg.route}/new">${raw(ico('plus'))}New ${cfg.label.toLowerCase()}</a></div></div>
    <div class="card"><div class="toolbar">
      <div class="search">${raw(ico('search'))}<input class="inp" data-f="q" placeholder="Search number, ${cfg.party.toLowerCase()} or notes…" aria-label="Search"></div>
      <select class="inp" data-f="period" style="width:150px" aria-label="Period"><option value="all">All time</option><option value="month">This month</option><option value="30">Last 30 days</option><option value="year">This year</option><option value="custom">Custom…</option></select>
      <span class="dates" data-dates hidden><input class="inp" type="date" data-f="from" aria-label="From"><span class="muted">to</span><input class="inp" type="date" data-f="to" aria-label="To"></span>
      <span class="spacer"></span><div class="chips" data-chips></div></div>
      <div class="tbl-wrap" data-tbl>${skeleton(7)}</div><div data-foot></div></div>`);

  const $t = $('[data-tbl]', root), $foot = $('[data-foot]', root), $chips = $('[data-chips]', root);
  const std = (r) => ({ ...cfg.norm(r), raw: r });

  const load = async () => {
    try { S.rows = (await api.get(cfg.list)).map(std); paint(); }
    catch (e) { setHTML($t, errorNote(e)); }
  };
  const filtered = () => {
    const q = S.q.toLowerCase(); let from = S.from, to = S.to; const t = today();
    if (S.period === 'month') { from = monthStart(); to = t; } else if (S.period === '30') { from = addDays(t, -30); to = t; } else if (S.period === 'year') { from = yearStart(); to = t; } else if (S.period === 'all') { from = ''; to = ''; }
    let r = S.rows.filter((x) => (!q || `${x.no} ${x.partner} ${x.sub}`.toLowerCase().includes(q)) && (!S.status || x.status === S.status) && (!from || String(x.date).slice(0, 10) >= from) && (!to || String(x.date).slice(0, 10) <= to));
    const k = S.sort.k, col = (cfg.cols || []).find((c) => c.h === k);
    const val = (x) => (col ? (col.sort ? col.sort(x) : String(col.cell(x))) : k === 'total' ? num(x.total) : k === 'no' ? x.no : k === 'partner' ? (x.partner || '').toLowerCase() : k === 'status' ? x.status : String(x.date).slice(0, 10) + x.no);
    return r.sort((a, b) => { const A = val(a), B = val(b); return (A < B ? -1 : A > B ? 1 : 0) * S.sort.dir; });
  };
  const th = (label, k, cls = '') => html`<th class="sortable ${cls}" data-sort="${k}" aria-sort="${S.sort.k === k ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}<span class="arr">${S.sort.k === k ? (S.sort.dir > 0 ? '↑' : '↓') : ''}</span></th>`;
  function paint() {
    const all = filtered(); const pages = Math.max(1, Math.ceil(all.length / PAGE)); S.page = Math.min(S.page, pages);
    const slice = all.slice((S.page - 1) * PAGE, S.page * PAGE);
    const counts = {}; S.rows.forEach((x) => { counts[x.status] = (counts[x.status] || 0) + 1; });
    setHTML($chips, html`${Object.keys(counts).sort().map((s) => html`<button class="chip ${S.status === s ? 'on' : ''}" data-status="${s}">${title(s)} <span class="n">${counts[s]}</span></button>`)}${S.status ? html`<button class="chip" data-status="">Clear</button>` : ''}`);
    $('#sub', root).textContent = `${S.rows.length} ${S.rows.length === 1 ? cfg.label.toLowerCase() : cfg.plural.toLowerCase()}${all.length !== S.rows.length ? ` · ${all.length} shown` : ''}`;
    if (!S.rows.length) { setHTML($t, empty(cfg.icon, `No ${cfg.plural.toLowerCase()} yet`, `Create your first ${cfg.label.toLowerCase()} to see it here.`, html`<a class="btn primary" href="#/${cfg.route}/new">${raw(ico('plus'))}New ${cfg.label.toLowerCase()}</a>`)); $foot.innerHTML = ''; return; }
    if (!all.length) { setHTML($t, empty('search', 'Nothing matches those filters', 'Try a different search, status or period.')); $foot.innerHTML = ''; return; }
    setHTML($t, html`<table class="tbl" aria-label="${cfg.plural}"><thead><tr>${th('Document', 'no')}${th('Date', 'date')}${th(cfg.party, 'partner')}${(cfg.cols || []).map((c) => th(c.h, c.h, c.num ? 'num' : ''))}${th('Status', 'status')}${cfg.noAmount ? '' : th('Amount', 'total', 'num')}</tr></thead>
      <tbody>${slice.map((x) => html`<tr class="click" tabindex="0" data-id="${x.id}"><td><div class="main">${x.no}</div>${x.sub ? html`<div class="sub" style="${x.subBad ? 'color:var(--bad);font-weight:600' : ''}">${x.sub}</div>` : ''}</td><td>${fmtDate(x.date)}</td><td>${x.partner || '—'}</td>${(cfg.cols || []).map((c) => html`<td class="${c.num ? 'num' : ''}">${c.cell(x)}</td>`)}<td>${badge(x.status)}</td>${cfg.noAmount ? '' : html`<td class="num ${isDead(x.status) ? 'muted' : ''}" style="${isDead(x.status) ? 'text-decoration:line-through' : ''}">${x.total == null ? '—' : fmt(x.total)}</td>`}</tr>`)}</tbody></table>`);
    const live = all.filter((x) => !isDead(x.status)); const total = live.reduce((s, x) => s + num(x.total), 0);
    setHTML($foot, html`${cfg.noAmount ? '' : html`<div class="sumbar"><span>Showing <b>${all.length}</b></span><span>Total (excl. void) <b>${rm(total)}</b></span>${live[0] && live[0].out != null ? html`<span>Outstanding <b>${rm(live.reduce((s, x) => s + Math.max(0, num(x.out)), 0))}</b></span>` : ''}</div>`}
      ${pages > 1 ? html`<div class="pager"><span>Page ${S.page} of ${pages}</span><div class="btns"><button class="btn sm" data-page="-1" ${S.page <= 1 ? raw('disabled') : ''}>Previous</button><button class="btn sm" data-page="1" ${S.page >= pages ? raw('disabled') : ''}>Next</button></div></div>` : ''}`);
  }

  root.addEventListener('input', debounce((e) => { const f = e.target.dataset.f; if (f === 'q') { S.q = e.target.value; S.page = 1; paint(); } else if (f === 'from' || f === 'to') { S[f] = e.target.value; S.page = 1; paint(); } }, 140));
  root.addEventListener('change', (e) => { if (e.target.dataset.f === 'period') { S.period = e.target.value; $('[data-dates]', root).hidden = S.period !== 'custom'; S.page = 1; paint(); } });
  root.addEventListener('click', (e) => {
    const st = e.target.closest('[data-status]'); if (st) { S.status = st.dataset.status; S.page = 1; paint(); return; }
    const so = e.target.closest('[data-sort]'); if (so) { const k = so.dataset.sort; S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : (k === 'date' || k === 'total' ? -1 : 1) }; paint(); return; }
    const pg = e.target.closest('[data-page]'); if (pg) { S.page += +pg.dataset.page; paint(); $('.toolbar', root).scrollIntoView({ block: 'nearest' }); return; }
    if (e.target.closest('[data-x="csv"]')) { const rows = filtered(); downloadCSV(`${cfg.key}-${today()}.csv`, [['Number', 'Date', cfg.party, 'Status', 'Amount'], ...rows.map((x) => [x.no, String(x.date).slice(0, 10), x.partner, x.status, x.total ?? ''])]); return; }
    const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) openViewer(cfg, tr.dataset.id, S.rows.find((x) => x.id === tr.dataset.id), { reload: load });
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-id]'); if (tr) openViewer(cfg, tr.dataset.id, S.rows.find((x) => x.id === tr.dataset.id), { reload: load }); } });

  await load();
  if (query.view) openViewer(cfg, query.view, S.rows.find((x) => x.id === query.view), { reload: load });
}

/* ==========================================================================
   Detail drawer
   ========================================================================== */
export async function openViewer(cfg, id, row, { reload } = {}) {
  const base = `#/${cfg.route}`;
  history.replaceState(null, '', `${base}?view=${id}`);
  const d = openDrawer({ title: cfg.label, subtitle: row ? row.no : '', size: 'wide', body: skeleton(6), onClose: () => { if (location.hash === `${base}?view=${id}`) history.replaceState(null, '', base); } });
  const draw = async () => {
    let det;
    try { det = await cfg.detail(id); } catch (e) { d.setBody(errorNote(e)); return; }
    const no = det[Object.keys(det).find((k) => /(^|_)(no)$/.test(k) && !/^(myinvois)/.test(k))] || (row && row.no) || '';
    const status = det.status;
    const view = cfg.view(det);
    let party = null;
    if (det.partner_id) { try { party = await ref.partner(det.partner_id); } catch { /* partner removed */ } }
    const pname = (party && party.partner_name) || partyName(det, row) || det.payee || det.payer || det.requested_by || (cfg.optionalParty || '');
    d.setTitle(`${cfg.label} ${no}`, html`${badge(status)} <span class="muted" style="margin-left:6px">${pname}</span>`);
    const total = view.totals.find((t) => t[2]);
    const next = (cfg.next ? cfg.next(det) : []) || [], extra = (cfg.extra ? cfg.extra(det) : []) || [];
    const canRevise = typeof cfg.revisable === 'function' ? cfg.revisable(det) : cfg.revisable;
    const dead = isDead(status);
    d.setBody(html`
      ${dead ? html`<div class="note bad">${raw(ico('ban'))}<div><b>This document is ${title(status).toLowerCase()}.</b> Its accounting effect has been reversed.</div></div>` : ''}
      <div class="card pad" style="box-shadow:none;background:var(--field)"><div class="row wrap" style="align-items:flex-start;gap:24px">
        <div style="flex:1;min-width:200px"><div class="k muted" style="font-size:12px;font-weight:600">${cfg.party}</div><div style="font-weight:700;font-size:17px;letter-spacing:-.01em">${pname || '—'}</div>${party ? html`<div class="muted" style="font-size:13px;margin-top:2px">${[party.address, party.phone, party.email].filter(Boolean).join(' · ')}</div><div class="muted" style="font-size:12px;margin-top:2px">${[party.tax_id && `TIN ${party.tax_id}`, party.brn_no && `BRN ${party.brn_no}`, party.sst_no && `SST ${party.sst_no}`].filter(Boolean).join(' · ')}</div>` : ''}</div>
        ${total ? html`<div style="text-align:right"><div class="k muted" style="font-size:12px;font-weight:600">${total[0]}</div><div style="font-weight:720;font-size:28px;letter-spacing:-.03em" class="tnum">${total[1]}</div></div>` : ''}</div></div>
      <div class="kv">${view.meta.map(([k, v]) => html`<div><div class="k">${k}</div><div class="v">${v}</div></div>`)}</div>
      <div class="card" style="box-shadow:none"><div class="tbl-wrap"><table class="tbl compact"><thead><tr>${view.cols.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.h}</th>`)}</tr></thead><tbody>${view.rows.map((r) => html`<tr>${r.map((c, i) => html`<td class="${view.cols[i] && view.cols[i].num ? 'num' : ''}">${c}</td>`)}</tr>`)}</tbody></table></div>
        <div class="tot" style="margin-left:auto;max-width:340px">${view.totals.map(([k, v, s]) => html`<div class="r ${s ? 'g' : ''}"><span>${k}</span><span>${v}</span></div>`)}</div></div>`);
    d.setFooter(html`
      ${next.map((n) => html`<a class="btn ${n.primary ? 'primary' : ''}" href="${n.href}">${raw(ico(n.icon || 'arrowR'))}${n.label}</a>`)}
      ${extra.map((x) => html`<button class="btn ${x.primary ? 'primary' : ''} ${x.danger ? 'danger' : ''}" data-do="${x.do}">${raw(ico(x.icon))}${x.label}</button>`)}
      <button class="btn" data-do="print">${raw(ico('printer'))}Print</button>
      ${canRevise && !dead ? html`<a class="btn" href="#/${cfg.route}/new?revise=${id}">${raw(ico('edit'))}Revise</a>` : ''}
      <span class="spacer"></span>
      ${!dead && !cfg.noVoid ? html`<button class="btn danger" data-do="void">${raw(ico('ban'))}${cfg.mod === 'sales' && cfg.key === 'quotations' || cfg.key === 'orders' || cfg.key === 'requests' ? 'Cancel' : 'Void'}</button>` : ''}
      ${dead ? html`<button class="btn danger" data-do="delete">${raw(ico('trash'))}Delete permanently</button>` : ''}`);
    d._ctx = { det, view, party, pname, no };
  };
  d.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-do]'); if (!b || !d._ctx) return;
    const { det, view, party, pname, no } = d._ctx; const act = b.dataset.do;
    try {
      if (act === 'print') { const m = await import('./print.js'); m.printDocument({ cfg, det, view, party, pname, no }); return; }
      if (act === 'void') {
        const r = await confirmDialog({ title: `${b.textContent.trim()} ${cfg.label.toLowerCase()} ${no}?`, message: 'Postings are reversed in the ledger and stock is restored. The document stays on file marked as void.', confirm: b.textContent.trim(), danger: true, input: 'Reason (optional)' });
        if (!r.ok) return; b.disabled = true;
        await (cfg.cb ? api.post(`${cfg.cb}/${id}/void`, { reason: r.value || 'Voided by user', createdBy: user() }) : api.post(`/document-actions/${cfg.act}/${id}/void`, { reason: r.value || 'Voided by user', createdBy: user() }));
        toast(`${cfg.label} ${no} ${b.textContent.trim() === 'Cancel' ? 'cancelled' : 'voided'}`);
      } else if (act === 'delete') {
        const r = await confirmDialog({ title: `Delete ${cfg.label.toLowerCase()} ${no}?`, message: 'This permanently removes the record. Only voided documents can be deleted, and this cannot be undone.', confirm: 'Delete permanently', danger: true });
        if (!r.ok) return; b.disabled = true;
        await (cfg.cb ? api.del(`${cfg.cb}/${id}`) : api.del(`/document-actions/${cfg.act}/${id}`));
        toast(`${cfg.label} ${no} deleted`); invalidate(); emit('changed'); d.close(); reload && reload(); return;
      } else if (act === 'approve' || act === 'reject') {
        const r = await confirmDialog({ title: `${act === 'approve' ? 'Approve' : 'Reject'} ${no}?`, message: act === 'approve' ? 'The request can then be converted into a purchase order.' : 'The request will be marked as rejected.', confirm: act === 'approve' ? 'Approve' : 'Reject', danger: act === 'reject' });
        if (!r.ok) return; b.disabled = true;
        await api.post(`/purchase-requests/${id}/${act}`, { approvedBy: user() }); toast(`${no} ${act === 'approve' ? 'approved' : 'rejected'}`);
      }
      invalidate(); emit('changed'); reload && reload(); await draw();
    } catch (err) { b.disabled = false; toast(err.message, 'bad'); }
  });
  await draw();
}
