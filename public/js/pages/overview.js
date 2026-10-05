/* ==========================================================================
   pages/overview.js — Sales, Purchases and Inventory workspace dashboards.
   Each shows the document flow (with live counts), KPIs, charts and the
   work that needs attention, so every document is one click away.
   ========================================================================== */
import { $, html, raw, str, api, cached, on, invalidate, num, fmt, rm, qty, compact, today, yearStart, monthLabel, sum, title, fmtDate, dayDiff, badge, errorNote, setHTML, empty, navigate } from '../core.js';
import { ico } from '../icons.js';
import { bars, donut, hbar, legend, disposeChart } from '../charts.js';
import { moduleTabs } from '../nav.js';

const step = (icon, label, value, sub, href, tone = '') => html`<a class="flow-step" href="${href}"><div class="k">${raw(ico(icon))}${label}</div><div class="v ${tone}">${value}</div><div class="s">${sub}</div></a>`;
const arrow = html`<span class="flow-arrow">${raw(ico('chevR'))}</span>`;
const tile = (k, v, s = '', cls = '') => html`<div class="metric bare"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
const STATUS_COL = { POSTED: 'var(--blue)', PARTIALLY_PAID: 'var(--amber)', PAID: 'var(--green)', CREDITED: 'var(--violet)', VOID: 'var(--red)' };

export default async function render(ctx) {
  const which = ctx.segs[0];
  const fn = { sales, purchases, inventory }[which];
  const off = on('changed', () => { invalidate('ov:'); ctx.isCurrent() && fn(ctx).catch(() => {}); });
  ctx.onCleanup(() => { off(); ctx.root.querySelectorAll('.chart').forEach(disposeChart); });
  return fn(ctx);
}

/* ------------------------------------------------------------ SALES */
async function sales(ctx) {
  const { root } = ctx;
  let s, top, open;
  try {
    [s, top, open] = await Promise.all([cached('ov:sales', () => api.get('/insights/sales'), 15000), cached('ov:top-ytd', () => api.get(`/insights/breakdown?from=${yearStart()}&to=${today()}`), 30000), cached('ov:inv', () => api.get('/invoices'), 15000)]);
  } catch (e) { setHTML(root, errorNote(e)); return; }
  const m = s.monthly, cur = m[m.length - 1], prev = m[m.length - 2] || cur;
  const soldNow = cur.invoices + cur.cashSales - cur.credits;
  const outstanding = open.filter((i) => ['POSTED', 'PARTIALLY_PAID'].includes(i.status) && num(i.outstanding) > 0.005).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))).slice(0, 8);
  setHTML(root, html`
    ${moduleTabs('sales', 'overview')}
    <div class="page-head"><div><h1>Sales</h1><div class="sub">From quotation to cash — everything in one flow.</div></div><div class="actions"><a class="btn" href="#/sales/quotations/new">${raw(ico('file'))}Quotation</a><a class="btn" href="#/sales/cash-sales/new">${raw(ico('banknote'))}Cash sale</a><a class="btn primary" href="#/sales/invoices/new">${raw(ico('plus'))}New invoice</a></div></div>
    <div class="card"><div class="card-h"><div><div class="card-t">Document flow</div><div class="card-s">Click any step to open its list.</div></div></div><div class="card-b"><div class="flow">
      ${step('file', 'Quotations', s.pipeline.openQuotations.count, `${rm(s.pipeline.openQuotations.value, 0)} open`, '#/sales/quotations?status=OPEN')}${arrow}
      ${step('clipboard', 'Sales orders', s.pipeline.openOrders.count, `${rm(s.pipeline.openOrders.value, 0)} to deliver`, '#/sales/orders')}${arrow}
      ${step('suppliers', 'Deliveries', s.pipeline.deliveriesToInvoice.count, `${rm(s.pipeline.deliveriesToInvoice.value, 0)} to invoice`, '#/sales/deliveries')}${arrow}
      ${step('sales', 'Invoices', s.receivables.openCount, `${rm(s.receivables.outstanding, 0)} outstanding`, '#/sales/invoices')}${arrow}
      ${step('wallet', 'Receipts', s.receivables.overdueCount ? `${s.receivables.overdueCount} overdue` : 'Up to date', s.receivables.overdueCount ? rm(s.receivables.overdue, 0) : 'Nothing past due', '#/sales/receipts', s.receivables.overdueCount ? 'neg' : '')}</div></div></div>
    <div class="grid g4">${[
      tile('Sold this month', rm(soldNow, 0), `${prev.invoices + prev.cashSales - prev.credits ? `${(((soldNow / (prev.invoices + prev.cashSales - prev.credits)) - 1) * 100).toFixed(0)}% vs last month` : 'First month of data'}`),
      tile('Invoices issued', cur.invoiceCount, `${cur.cashSaleCount} cash sales`), tile('Outstanding', rm(s.receivables.outstanding, 0), `${s.receivables.openCount} open invoices`), tile('Overdue', rm(s.receivables.overdue, 0), `${s.receivables.overdueCount} invoices`, s.receivables.overdue > 0 ? 'neg' : '')].map((t) => html`<div class="card pad">${t}</div>`)}</div>
    <div class="grid g-main">
      <div class="card"><div class="card-h"><div><div class="card-t">Sales trend</div><div class="card-s">Invoiced and cash sales, excluding tax</div></div>${legend([{ label: 'Invoices', color: 'var(--blue)' }, { label: 'Cash sales', color: 'var(--cyan)' }])}</div><div class="card-b"><div class="chart" data-tr></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Invoice status</div><div class="card-s">By value, all time</div></div></div><div class="card-b" data-st></div></div>
    </div>
    <div class="grid g-main">
      <div class="card"><div class="card-h"><div><div class="card-t">Outstanding invoices</div><div class="card-s">Oldest due first</div></div><a class="btn sm" href="#/reports/ar-aging">Ageing report</a></div>
        ${outstanding.length ? html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th class="num">Balance</th></tr></thead><tbody>${outstanding.map((i) => { const od = dayDiff(today(), i.due_date); return html`<tr class="click" data-go="#/sales/invoices?view=${i.invoice_id}"><td class="main">${i.invoice_no}</td><td>${i.partner_name}</td><td>${od > 0 ? html`<span class="badge tone-bad">${od}d overdue</span>` : fmtDate(i.due_date)}</td><td class="num"><b>${fmt(i.outstanding)}</b></td></tr>`; })}</tbody></table></div>` : empty('checkCircle', 'Nothing outstanding', 'Every invoice has been paid.')}</div>
      <div class="card"><div class="card-h"><div><div class="card-t">Customer analysis</div><div class="card-s">Top customers, year to date</div></div><a class="btn sm" href="#/customers">All customers</a></div><div class="card-b">${hbar(top.topCustomers.map((c) => ({ label: c.name, value: c.amount })), { empty: 'No sales yet this year.' })}</div></div>
    </div>`);
  bars($('[data-tr]', root), { labels: m.map((x) => monthLabel(x.month)), stacked: true, series: [{ name: 'Invoices', values: m.map((x) => x.invoices), color: 'var(--blue)' }, { name: 'Cash sales', values: m.map((x) => x.cashSales), color: 'var(--cyan)' }], fmtVal: (v) => rm(v, 0) });
  donut($('[data-st]', root), { items: s.invoiceStatuses.map((x) => ({ label: title(x.status), value: x.value, color: STATUS_COL[x.status] })), center: { label: 'Invoiced', value: compact(sum(s.invoiceStatuses, (x) => x.value)) } });
  root.addEventListener('click', (e) => { const r = e.target.closest('[data-go]'); if (r) navigate(r.dataset.go); });
}

/* -------------------------------------------------------- PURCHASES */
async function purchases(ctx) {
  const { root } = ctx;
  let p, top, bills;
  try { [p, top, bills] = await Promise.all([cached('ov:purch', () => api.get('/insights/purchases'), 15000), cached('ov:top-sup', () => api.get(`/insights/breakdown?from=${yearStart()}&to=${today()}`), 30000), cached('ov:bills', () => api.get('/purchase-invoices/open'), 15000)]); }
  catch (e) { setHTML(root, errorNote(e)); return; }
  const m = p.monthly, cur = m[m.length - 1], prev = m[m.length - 2] || cur;
  setHTML(root, html`
    ${moduleTabs('purchases', 'overview')}
    <div class="page-head"><div><h1>Purchases</h1><div class="sub">From request to payment — buy, receive, match and pay.</div></div><div class="actions"><a class="btn" href="#/purchases/requests/new">${raw(ico('clipboard'))}Request</a><a class="btn" href="#/purchases/grn/new">${raw(ico('inbox'))}Receive goods</a><a class="btn primary" href="#/purchases/orders/new">${raw(ico('plus'))}New purchase order</a></div></div>
    <div class="card"><div class="card-h"><div><div class="card-t">Document flow</div><div class="card-s">Click any step to open its list.</div></div></div><div class="card-b"><div class="flow">
      ${step('clipboard', 'Requests', p.pipeline.pendingRequests.count, 'awaiting approval', '#/purchases/requests?status=PENDING_APPROVAL')}${arrow}
      ${step('cart', 'Purchase orders', p.pipeline.openOrders.count, `${rm(p.pipeline.openOrders.value, 0)} on order`, '#/purchases/orders')}${arrow}
      ${step('inbox', 'Goods received', p.pipeline.receivedNotInvoiced.count, `${rm(p.pipeline.receivedNotInvoiced.value, 0)} not invoiced`, '#/purchases/grn')}${arrow}
      ${step('purchases', 'Supplier invoices', p.payables.openCount, `${rm(p.payables.outstanding, 0)} to pay`, '#/purchases/invoices')}${arrow}
      ${step('card', 'Payments', p.payables.dueSoonCount, `${rm(p.payables.dueSoon, 0)} due in 7 days`, '#/purchases/payments')}</div></div></div>
    <div class="grid g4">${[tile('Bought this month', rm(cur.invoices + cur.cashPurchases, 0), prev.invoices + prev.cashPurchases ? `${(((cur.invoices + cur.cashPurchases) / (prev.invoices + prev.cashPurchases) - 1) * 100).toFixed(0)}% vs last month` : 'First month of data'), tile('Payable', rm(p.payables.outstanding, 0), `${p.payables.openCount} open bills`), tile('Overdue', rm(p.payables.overdue, 0), `${p.payables.overdueCount} bills`, p.payables.overdue > 0 ? 'neg' : ''), tile('Due in 7 days', rm(p.payables.dueSoon, 0), `${p.payables.dueSoonCount} bills`)].map((t) => html`<div class="card pad">${t}</div>`)}</div>
    <div class="grid g-main">
      <div class="card"><div class="card-h"><div><div class="card-t">Purchasing trend</div><div class="card-s">Supplier invoices and cash purchases, excluding tax</div></div>${legend([{ label: 'Supplier invoices', color: 'var(--violet)' }, { label: 'Cash purchases', color: 'var(--amber)' }])}</div><div class="card-b"><div class="chart" data-tr></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Top suppliers</div><div class="card-s">Year to date</div></div><a class="btn sm" href="#/suppliers">All suppliers</a></div><div class="card-b">${hbar(top.topSuppliers.map((c) => ({ label: c.name, value: c.amount })), { empty: 'No purchases yet this year.' })}</div></div>
    </div>
    <div class="card"><div class="card-h"><div><div class="card-t">Bills to pay</div><div class="card-s">Soonest due first</div></div><a class="btn sm primary" href="#/purchases/payments/new">Pay suppliers</a></div>
      ${bills.length ? html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Invoice</th><th>Supplier</th><th>Due</th><th class="num">Balance</th></tr></thead><tbody>${bills.slice(0, 8).map((b) => { const od = dayDiff(today(), b.due_date); return html`<tr class="click" data-go="#/purchases/invoices?view=${b.purchase_invoice_id}"><td class="main">${b.invoice_no}</td><td>${b.partner_name}</td><td>${od > 0 ? html`<span class="badge tone-bad">${od}d overdue</span>` : fmtDate(b.due_date)}</td><td class="num"><b>${fmt(b.outstanding)}</b></td></tr>`; })}</tbody></table></div>` : empty('checkCircle', 'No bills to pay', 'You are fully paid up with suppliers.')}</div>`);
  bars($('[data-tr]', root), { labels: m.map((x) => monthLabel(x.month)), stacked: true, series: [{ name: 'Supplier invoices', values: m.map((x) => x.invoices), color: 'var(--violet)' }, { name: 'Cash purchases', values: m.map((x) => x.cashPurchases), color: 'var(--amber)' }] });
  root.addEventListener('click', (e) => { const r = e.target.closest('[data-go]'); if (r) navigate(r.dataset.go); });
}

/* -------------------------------------------------------- INVENTORY */
async function inventory(ctx) {
  const { root } = ctx; let v;
  try { v = await cached('ov:inv-ins', () => api.get('/insights/inventory'), 15000); } catch (e) { setHTML(root, errorNote(e)); return; }
  const s = v.summary;
  setHTML(root, html`
    <div class="page-head"><div><h1>Inventory</h1><div class="sub">Stock on hand, valuation and what needs reordering.</div></div><div class="actions"><a class="btn" href="#/inventory/items">${raw(ico('list'))}All items</a><a class="btn" href="#/purchases/requests/new">${raw(ico('clipboard'))}Purchase request</a><a class="btn primary" href="#/inventory/items?new=1">${raw(ico('plus'))}New item</a></div></div>
    <div class="grid g4">${[tile('Stock valuation', rm(s.valuation, 0), `${qty(s.units)} units on hand`), tile('Active items', s.items, 'in the item master'), tile('Low stock', s.lowStock, 'at or below minimum', s.lowStock ? 'neg' : ''), tile('Out of stock', s.outOfStock, 'zero or negative balance', s.outOfStock ? 'neg' : '')].map((t) => html`<div class="card pad">${t}</div>`)}</div>
    <div class="grid g-main">
      <div class="card"><div class="card-h"><div><div class="card-t">Inventory movement</div><div class="card-s">Units in vs out, last 6 months</div></div>${legend([{ label: 'Stock in', color: 'var(--green)' }, { label: 'Stock out', color: 'var(--red)' }])}</div><div class="card-b"><div class="chart" data-mv></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Top-selling items</div><div class="card-s">Last 90 days, by sales value</div></div></div><div class="card-b">${hbar(v.topSelling.slice(0, 6).map((x) => ({ label: `${x.code} · ${x.name}`, value: x.amount })), { empty: 'No item sales in the last 90 days.' })}</div></div>
    </div>
    <div class="grid g-main">
      <div class="card"><div class="card-h"><div><div class="card-t">Low stock alerts</div><div class="card-s">Set a minimum quantity on an item to be alerted before it runs out.</div></div></div>
        ${v.lowStock.length ? html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Minimum</th><th class="num">Value</th></tr></thead><tbody>${v.lowStock.map((i) => html`<tr class="click" data-go="#/inventory/items?view=${i.id}"><td><div class="main">${i.code}</div><div class="sub">${i.name}</div></td><td class="num ${i.qty <= 0 ? 'neg' : ''}"><b>${qty(i.qty)}</b> ${i.unit || ''}</td><td class="num">${i.minQty ? qty(i.minQty) : '—'}</td><td class="num">${fmt(i.value)}</td></tr>`)}</tbody></table></div>` : empty('checkCircle', 'Stock levels look healthy', 'No items are at or below their minimum.')}</div>
      <div class="card"><div class="card-h"><div><div class="card-t">Recent movements</div><div class="card-s">Latest stock transactions</div></div></div><div class="card-b">${v.recent.length ? html`<div class="tl">${v.recent.map((r) => html`<a class="tl-item" href="#/inventory/items?view=${r.itemId}"><span class="tl-dot tone-${r.qtyIn > 0 ? 'ok' : 'bad'}">${raw(ico(r.qtyIn > 0 ? 'arrowDown' : 'arrowUp'))}</span><div class="tl-body"><b>${r.code}</b><div class="s">${title(r.type)} · ${r.docNo || ''} · ${fmtDate(r.date)}</div></div><div class="tl-amt">${r.qtyIn > 0 ? `+${qty(r.qtyIn)}` : `−${qty(r.qtyOut)}`}<div class="s muted" style="font-weight:500;font-size:12px">bal ${qty(r.balance)}</div></div></a>`)}</div>` : empty('history', 'No movements yet', '')}</div></div>
    </div>`);
  bars($('[data-mv]', root), { labels: v.movement.map((x) => monthLabel(x.month)), series: [{ name: 'Stock in', values: v.movement.map((x) => x.qtyIn), color: 'var(--green)' }, { name: 'Stock out', values: v.movement.map((x) => x.qtyOut), color: 'var(--red)' }], fmtVal: (x) => `${fmt(x, 0)} units` });
  root.addEventListener('click', (e) => { const r = e.target.closest('[data-go]'); if (r) navigate(r.dataset.go); });
}
