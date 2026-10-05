/* ==========================================================================
   composer-kinds.js — the editors that are not free-form item grids.
   Each export receives the shared env from composer.js and uses the same
   frame / totals / submit helpers.
   ========================================================================== */
import { $, $$, html, raw, esc, str, api, ref, num, round2, fmt, rm, qty, today, fmtDate, title, user, setHTML, cached } from './core.js';
import { ico } from './icons.js';
import { frame, totalsHtml, showErr, submitDoc, METHODS } from './composer.js';
import { partnerField } from './lines.js';

const rowsHead = (cols, heads) => `<div class="ln-head" style="--cols:${cols}">${heads.map(([h, r]) => `<div class="${r ? 'r' : ''}">${h}</div>`).join('')}</div>`;
const fullItem = (id) => cached(`ref:item:${id}`, () => api.get(`/stock-items/${id}`), 30000);
const sortLines = (a) => [...a].sort((x, y) => (x.line_id < y.line_id ? -1 : 1));

/* ---------- shared "quantities against a source document" editor (delivery order, GRN) ---------- */
async function qtyComposer(env, S) {
  const { ctx, cfg } = env; const q = ctx.query;
  const F = frame(env, {
    heading: `New ${cfg.label.toLowerCase()}`, sub: S.sub,
    mainHtml: html`<div class="card pad"><div class="form-grid">
        <div class="field full"><label class="req">${S.srcLabel}</label><select class="inp" data-src><option value="">Choose…</option></select><span class="hint" data-hint></span></div>
        <div class="field"><label>Document no.</label><input class="inp" data-no placeholder="Auto-generated"></div>
        <div class="field"><label class="req">${S.dateLabel}</label><input class="inp" type="date" data-date value="${today()}"></div>
        ${S.notes ? html`<div class="field full"><label>Notes</label><input class="inp" data-notes placeholder="Vehicle, driver, remarks…"></div>` : ''}</div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">${S.linesTitle}</div><div class="card-s">${S.linesHint}</div></div></div><div class="lines" data-lines style="padding-top:8px"><div class="empty" style="padding:36px"><p>Choose a ${S.srcWord} above to load its lines.</p></div></div></div>` });
  const sel = $('[data-src]', F.root), hint = $('[data-hint]', F.root), box = $('[data-lines]', F.root);
  let doc = null, lines = [];
  const list = (await api.get(S.listUrl)).filter(S.filter);
  sel.innerHTML += list.map((s) => `<option value="${s[S.idKey]}">${esc(S.opt(s))}</option>`).join('');
  if (!list.length) hint.textContent = S.none;
  const cols = 'minmax(180px,1.4fr) minmax(160px,1.6fr) 90px 90px 90px 120px';
  const calc = () => { let val = 0, n = 0; $$('[data-row]', box).forEach((r, i) => { const v = num($('.ln-q', r).value); if (v > 0) { n++; val += v * num(lines[i].unit_price); } }); F.tot.innerHTML = str(html`<div class="r"><span>Lines</span><span>${n}</span></div><div class="r g"><span>${S.totalLabel}</span><span>${rm(val)}</span></div>`); return n; };
  const load = async (id) => {
    if (!id) { doc = null; box.innerHTML = '<div class="empty" style="padding:36px"><p>Choose a source document to load its lines.</p></div>'; calc(); return; }
    doc = await api.get(S.detailUrl(id)); lines = sortLines(doc.lines);
    const stock = await Promise.all(lines.map((l) => (l.stock_item_id ? fullItem(l.stock_item_id).catch(() => null) : null)));
    hint.textContent = S.hint(doc);
    box.innerHTML = `<div class="ln-grid" style="--cols:${cols}">${rowsHead(cols, [['Item'], ['Description'], [S.ordCol, 1], [S.doneCol, 1], ['Remaining', 1], [S.qtyCol, 1]])}${lines.map((l, i) => {
      const ord = num(l.quantity), done = num(l[S.doneKey]), rem = Math.max(0, ord - done);
      const on = stock[i] ? num(stock[i].current_qty) : null;
      return `<div class="ln" data-row style="--cols:${cols}"><div class="cell ro">${esc(l.item_code || 'Service')}${S.showStock && on != null ? `<div class="meta ${rem > on ? 'bad' : ''}">${qty(on)} on hand</div>` : ''}</div><div class="cell ro">${esc(l.description)}</div><div class="amt" style="padding-top:9px">${qty(ord)}</div><div class="amt" style="padding-top:9px">${qty(done)}</div><div class="amt" style="padding-top:9px">${qty(rem)}</div><div class="cell"><input class="inp num ln-q" type="number" min="0" max="${rem}" step="any" value="${rem}" ${rem <= 0 ? 'disabled' : ''} aria-label="Quantity"></div></div>`;
    }).join('')}</div>`;
    calc();
  };
  box.addEventListener('input', (e) => { if (e.target.matches('.ln-q')) { const mx = num(e.target.max); if (num(e.target.value) > mx) e.target.value = mx; calc(); } });
  sel.addEventListener('change', () => load(sel.value).catch((e) => showErr(F, e.message)));
  if (q[S.queryKey]) { if (![...sel.options].some((o) => o.value === q[S.queryKey])) sel.innerHTML += `<option value="${esc(q[S.queryKey])}">Selected document</option>`; sel.value = q[S.queryKey]; await load(sel.value).catch((e) => showErr(F, e.message)); }
  F.save.addEventListener('click', () => {
    const errs = []; if (!doc) errs.push(`Choose a ${S.srcWord}`); if (!$('[data-date]', F.root).value) errs.push('Choose a date');
    const out = []; $$('[data-row]', box).forEach((r, i) => { const v = num($('.ln-q', r).value); if (v > 0) out.push(S.line(lines[i], v)); });
    if (doc && !out.length) errs.push('Enter a quantity for at least one line');
    if (errs.length) return showErr(F, errs);
    const p = { createdBy: user(), [S.idPayload]: doc[S.docIdKey], [S.dateKey]: $('[data-date]', F.root).value, lines: out };
    const no = $('[data-no]', F.root).value.trim(); if (no) p[S.noKey] = no;
    if (S.notes) p.notes = $('[data-notes]', F.root).value.trim() || null;
    submitDoc(env, F, S.endpoint, p);
  });
}
export const delivery = (env) => qtyComposer(env, {
  sub: 'Posts stock out of the warehouse for the quantities you enter.', srcLabel: 'Sales order', srcWord: 'sales order', dateLabel: 'Delivery date', notes: true, linesTitle: 'Items to deliver', linesHint: 'Quantities default to what is still outstanding on the order.',
  listUrl: '/sales-orders', filter: (s) => ['OPEN', 'PARTIALLY_DELIVERED'].includes(s.status), idKey: 'sales_order_id', opt: (s) => `${s.order_no} · ${s.partner_name} · ${rm(s.total_amount)}`, none: 'There are no open sales orders to deliver.',
  detailUrl: (id) => `/sales-orders/${id}`, hint: (d) => `Order date ${fmtDate(d.order_date)}${d.partner_name ? ` · ${d.partner_name}` : ''}`, queryKey: 'so', docIdKey: 'sales_order_id', idPayload: 'salesOrderId', dateKey: 'deliveryDate', noKey: 'deliveryNo', endpoint: '/delivery-orders',
  ordCol: 'Ordered', doneCol: 'Delivered', doneKey: 'quantity_delivered', qtyCol: 'Deliver now', totalLabel: 'Delivery value', showStock: true,
  line: (l, v) => ({ salesOrderLineId: l.line_id, stockItemId: l.stock_item_id, description: l.description, quantity: v }),
});
export const grn = (env) => qtyComposer(env, {
  sub: 'Posts stock in and accrues the liability (GR/IR) until the supplier invoice arrives.', srcLabel: 'Purchase order', srcWord: 'purchase order', dateLabel: 'Received date', notes: false, linesTitle: 'Items received', linesHint: 'Quantities default to what is still outstanding on the order.',
  listUrl: '/purchase-orders', filter: (s) => ['SENT', 'PARTIALLY_RECEIVED'].includes(s.status), idKey: 'po_id', opt: (s) => `${s.po_no} · ${s.partner_name} · ${rm(s.total_amount)}`, none: 'There are no open purchase orders to receive against.',
  detailUrl: (id) => `/purchase-orders/${id}`, hint: (d) => `Order date ${fmtDate(d.order_date)}`, queryKey: 'po', docIdKey: 'po_id', idPayload: 'poId', dateKey: 'receivedDate', noKey: 'grnNo', endpoint: '/goods-received-notes',
  ordCol: 'Ordered', doneCol: 'Received', doneKey: 'quantity_received', qtyCol: 'Receive now', totalLabel: 'Received value', showStock: false,
  line: (l, v) => ({ poLineId: l.line_id, stockItemId: l.stock_item_id, itemCode: l.item_code, description: l.description, quantityReceived: v, unitPrice: num(l.unit_price), expenseAccountId: l.expense_account_id }),
});

/* ---------- credit / debit note ---------- */
export async function note(env) {
  const { ctx, cfg } = env; const isCredit = cfg.key === 'credit-notes'; const q = ctx.query;
  const F = frame(env, {
    heading: `New ${cfg.label.toLowerCase()}`, sub: isCredit ? 'Reduces what the customer owes. Optionally returns goods to stock.' : 'Increases what the customer owes (extra charges, price corrections).',
    mainHtml: html`<div class="card pad"><div class="form-grid">
        <div class="field full"><label class="req">Original invoice</label><select class="inp" data-inv><option value="">Choose an invoice…</option></select><span class="hint" data-hint>Only invoices with an open balance can be adjusted.</span></div>
        <div class="field"><label>Document no.</label><input class="inp" data-no placeholder="Auto-generated"></div>
        <div class="field"><label class="req">Note date</label><input class="inp" type="date" data-date value="${today()}"></div>
        ${isCredit ? html`<div class="field full"><label>Goods returned by the customer?</label><select class="inp" data-return><option value="false">No — financial adjustment only</option><option value="true">Yes — return the stock to inventory</option></select></div>` : ''}</div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Lines</div><div class="card-s">Enter the quantity and price to ${isCredit ? 'credit' : 'charge'} for each invoice line.</div></div><button class="btn sm" data-all>${raw(ico('copy'))}${isCredit ? 'Credit' : 'Charge'} all lines in full</button></div><div class="lines" data-lines style="padding-top:8px"><div class="empty" style="padding:36px"><p>Choose an invoice to load its lines.</p></div></div></div>` });
  const sel = $('[data-inv]', F.root), box = $('[data-lines]', F.root);
  const list = await api.get('/invoices/open-for-notes');
  sel.innerHTML += list.map((i) => `<option value="${i.invoice_id}">${esc(`${i.invoice_no} · ${i.partner_name} · balance ${rm(i.outstanding)}`)}</option>`).join('');
  let inv = null;
  const cols = 'minmax(160px,1.6fr) 84px 90px 112px 70px 116px';
  const calc = () => { let sub = 0, tax = 0; $$('[data-row]', box).forEach((r, i) => { const l = inv.lines[i], a = round2(num($('.ln-q', r).value) * num($('.ln-p', r).value)); sub += a; tax += round2((a * num(l.tax_rate)) / 100); $('.amt', r).textContent = rm(a); }); F.tot.innerHTML = totalsHtml({ subtotal: round2(sub), tax: round2(tax), total: round2(sub + tax) }); };
  const load = async (id) => {
    if (!id) { inv = null; box.innerHTML = '<div class="empty" style="padding:36px"><p>Choose an invoice to load its lines.</p></div>'; F.tot.innerHTML = ''; return; }
    inv = await api.get(`/invoices/${id}`); inv.lines = sortLines(inv.lines.map((l, i) => ({ ...l, _i: i }))).sort((a, b) => a._i - b._i);
    $('[data-hint]', F.root).textContent = `Invoice date ${fmtDate(inv.invoice_date)} · total ${rm(inv.total_amount)}`;
    box.innerHTML = `<div class="ln-grid" style="--cols:${cols}">${rowsHead(cols, [['Description'], ['Invoiced', 1], [isCredit ? 'Credit qty' : 'Charge qty', 1], ['Unit price', 1], ['Tax', 1], ['Amount', 1]])}${inv.lines.map((l) => `<div class="ln" data-row style="--cols:${cols}"><div class="cell ro">${esc(l.description)}<div class="meta">${esc(l.item_code || 'Service')}</div></div><div class="amt" style="padding-top:9px">${qty(l.quantity)}</div><div class="cell"><input class="inp num ln-q" type="number" min="0" max="${num(l.quantity)}" step="any" value="0" aria-label="Quantity"></div><div class="cell"><input class="inp num ln-p" type="number" min="0" step="0.01" value="${num(l.unit_price).toFixed(2)}" aria-label="Unit price"></div><div class="amt" style="padding-top:9px">${num(l.tax_rate) ? `${fmt(l.tax_rate, 0)}%` : '—'}</div><div class="amt">${rm(0)}</div></div>`).join('')}</div>`;
    calc();
  };
  box.addEventListener('input', (e) => { if (e.target.matches('.ln-q')) { const mx = num(e.target.max); if (num(e.target.value) > mx) e.target.value = mx; } if (inv) calc(); });
  $('[data-all]', F.root).addEventListener('click', () => { if (!inv) return; $$('[data-row]', box).forEach((r, i) => { $('.ln-q', r).value = num(inv.lines[i].quantity); }); calc(); });
  sel.addEventListener('change', () => load(sel.value).catch((e) => showErr(F, e.message)));
  if (q.invoice) { if (![...sel.options].some((o) => o.value === q.invoice)) sel.innerHTML += `<option value="${esc(q.invoice)}">Selected invoice</option>`; sel.value = q.invoice; await load(q.invoice).catch((e) => showErr(F, e.message)); }
  F.save.addEventListener('click', () => {
    const errs = []; if (!inv) errs.push('Choose the original invoice');
    const out = []; if (inv) $$('[data-row]', box).forEach((r, i) => { const v = num($('.ln-q', r).value); if (v > 0) out.push({ salesInvoiceLineId: inv.lines[i].line_id, quantity: v, unitPrice: num($('.ln-p', r).value) }); });
    if (inv && !out.length) errs.push('Enter a quantity on at least one line');
    if (errs.length) return showErr(F, errs);
    const p = { type: isCredit ? 'CREDIT' : 'DEBIT', partnerId: inv.partner_id, originalInvoiceId: inv.invoice_id, noteDate: $('[data-date]', F.root).value, returnGoods: isCredit && $('[data-return]', F.root).value === 'true', createdBy: user(), lines: out };
    const no = $('[data-no]', F.root).value.trim(); if (no) p.noteNo = no;
    submitDoc(env, F, '/sales-notes', p);
  });
}

/* ---------- receipt (customer) / payment (supplier): multi-invoice allocation ---------- */
export async function settle(env) {
  const { ctx, cfg, cash } = env; const isR = cfg.key === 'receipts'; const q = ctx.query;
  const F = frame(env, {
    heading: isR ? 'Receive customer payment' : 'Pay supplier', sub: isR ? 'Apply one payment across as many open invoices as you like.' : 'Settle one or more supplier invoices in a single payment.',
    mainHtml: html`<div class="card pad"><div class="form-grid">
        <div data-partner class="field"></div>
        <div class="field"><label>Document no.</label><input class="inp" data-no placeholder="Auto-generated"></div>
        <div class="field"><label class="req">${isR ? 'Receipt' : 'Payment'} date</label><input class="inp" type="date" data-date value="${today()}"></div>
        <div class="field"><label>Method</label><select class="inp" data-method>${METHODS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
        <div class="field full"><label class="req">${isR ? 'Deposit into' : 'Pay from'}</label><select class="inp" data-bank>${cash.map((a) => html`<option value="${a.account_id}">${a.account_code} · ${a.account_name}</option>`)}</select></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Open invoices</div><div class="card-s" data-osub>Choose a ${isR ? 'customer' : 'supplier'} to see what is outstanding.</div></div>
        <div class="row"><input class="inp sm num" style="width:140px" type="number" min="0" step="0.01" data-amt placeholder="Amount ${isR ? 'received' : 'paid'}" aria-label="Amount"><button class="btn sm" data-auto>${raw(ico('bolt'))}Auto-allocate</button></div></div>
        <div data-open style="padding-top:8px"></div></div>` });
  const openAll = (await api.get(isR ? '/invoices/open-for-notes' : '/purchase-invoices/open')).map((r) => isR
    ? { id: r.invoice_id, no: r.invoice_no, partnerId: r.partner_id, partner: r.partner_name, date: r.invoice_date, due: r.due_date, total: num(r.total_amount), out: num(r.outstanding) }
    : { id: r.purchase_invoice_id, no: r.invoice_no, partnerId: r.partner_id, partner: r.partner_name, date: r.invoice_date, due: r.due_date, total: num(r.total_amount), out: num(r.outstanding) });
  const box = $('[data-open]', F.root); let cur = [];
  const bankDef = () => { const m = $('[data-method]', F.root).value; const b = $('[data-bank]', F.root); const c = cash.find((a) => (m === 'CASH' ? /cash/i.test(a.account_name) : !/cash/i.test(a.account_name))); if (c) b.value = c.account_id; };
  $('[data-method]', F.root).addEventListener('change', bankDef); bankDef();
  const applied = () => cur.reduce((s, r, i) => s + num($(`[data-a="${i}"]`, box)?.value), 0);
  const calc = () => { const t = round2(applied()); const n = cur.filter((r, i) => num($(`[data-a="${i}"]`, box)?.value) > 0).length; F.tot.innerHTML = str(html`<div class="r"><span>Invoices settled</span><span>${n}</span></div><div class="r g"><span>Total ${isR ? 'received' : 'paid'}</span><span>${rm(t)}</span></div>`); };
  const draw = (p) => {
    cur = p ? openAll.filter((r) => r.partnerId === p.partner_id).sort((a, b) => String(a.due || a.date).localeCompare(String(b.due || b.date))) : [];
    $('[data-osub]', F.root).textContent = p ? (cur.length ? `${cur.length} open invoice${cur.length > 1 ? 's' : ''}, oldest due first.` : `${p.partner_name} has nothing outstanding.`) : `Choose a ${isR ? 'customer' : 'supplier'} to see what is outstanding.`;
    box.innerHTML = cur.length ? `<div class="alloc-row head"><span></span><span>Invoice</span><span>Date</span><span class="r">Total</span><span class="r">Outstanding</span><span class="r">Apply</span></div>${cur.map((r, i) => `<div class="alloc-row"><label class="check"><input type="checkbox" data-c="${i}" aria-label="Select ${esc(r.no)}"></label><span><b>${esc(r.no)}</b>${r.due ? `<div class="meta muted" style="font-size:12px">Due ${fmtDate(r.due)}</div>` : ''}</span><span>${fmtDate(r.date)}</span><span class="r">${fmt(r.total)}</span><span class="r">${fmt(r.out)}</span><span><input class="inp sm num" data-a="${i}" type="number" min="0" max="${r.out}" step="0.01" value="" placeholder="0.00" aria-label="Amount to apply"></span></div>`).join('')}` : '';
    calc();
  };
  const pf = partnerField($('[data-partner]', F.root), { type: isR ? 'CUSTOMER' : 'VENDOR', label: isR ? 'Customer' : 'Supplier', req: true, allowNew: false, onPick: (p) => draw(p) });
  box.addEventListener('change', (e) => { const c = e.target.closest('[data-c]'); if (c) { const a = $(`[data-a="${c.dataset.c}"]`, box); a.value = c.checked ? cur[+c.dataset.c].out.toFixed(2) : ''; calc(); } });
  box.addEventListener('input', (e) => { const a = e.target.closest('[data-a]'); if (a) { const r = cur[+a.dataset.a]; if (num(a.value) > r.out) a.value = r.out.toFixed(2); $(`[data-c="${a.dataset.a}"]`, box).checked = num(a.value) > 0; calc(); } });
  $('[data-auto]', F.root).addEventListener('click', () => {
    let left = num($('[data-amt]', F.root).value); if (!cur.length) return; if (left <= 0) { showErr(F, 'Enter the amount first, then auto-allocate.'); return; } showErr(F, []);
    cur.forEach((r, i) => { const use = Math.min(left, r.out); left = round2(left - use); $(`[data-a="${i}"]`, box).value = use > 0 ? use.toFixed(2) : ''; $(`[data-c="${i}"]`, box).checked = use > 0; });
    calc(); if (left > 0.004) showErr(F, `${rm(left)} is more than the open invoices — only invoices can be settled here.`);
  });
  if (q.invoice) { const r = openAll.find((x) => x.id === q.invoice); if (r) { const p = await ref.partner(r.partnerId); pf.set(p); draw(p); const i = cur.findIndex((x) => x.id === q.invoice); if (i >= 0) { $(`[data-c="${i}"]`, box).checked = true; $(`[data-a="${i}"]`, box).value = cur[i].out.toFixed(2); calc(); } } }
  calc();
  F.save.addEventListener('click', () => {
    const p = pf.get(); const errs = []; if (!p) errs.push(`Choose a ${isR ? 'customer' : 'supplier'}`);
    const allocs = cur.map((r, i) => ({ r, v: round2(num($(`[data-a="${i}"]`, box)?.value)) })).filter((x) => x.v > 0).map((x) => (isR ? { invoiceId: x.r.id, amount: x.v } : { purchaseInvoiceId: x.r.id, amount: x.v }));
    if (p && !allocs.length) errs.push('Tick at least one invoice, or enter an amount to apply');
    if (!$('[data-bank]', F.root).value) errs.push('Choose a bank or cash account');
    if (errs.length) return showErr(F, errs);
    const amount = round2(allocs.reduce((s, a) => s + a.amount, 0));
    const body = { partnerId: p.partner_id, [isR ? 'receiptDate' : 'paymentDate']: $('[data-date]', F.root).value, bankAccountId: $('[data-bank]', F.root).value, amount, paymentMethod: $('[data-method]', F.root).value, createdBy: user(), allocations: allocs };
    const no = $('[data-no]', F.root).value.trim(); if (no) body[isR ? 'receiptNo' : 'paymentNo'] = no;
    submitDoc(env, F, isR ? '/receipts' : '/payments', body);
  });
}

/* ---------- payment voucher / official receipt (general-ledger lines) ---------- */
export async function gl(env) {
  const { cfg, accounts, cash } = env; const isPV = cfg.key === 'payment-vouchers';
  const F = frame(env, {
    heading: `New ${cfg.label.toLowerCase()}`, sub: isPV ? 'Money paid out for expenses or other ledger accounts.' : 'Money received that is not tied to a sales invoice (interest, deposits, capital).',
    mainHtml: html`<div class="card pad"><div class="form-grid">
        <div class="field"><label class="req">${isPV ? 'Payee' : 'Received from'}</label><input class="inp" data-who placeholder="${isPV ? 'Who was paid?' : 'Who paid you?'}"></div>
        <div class="field"><label class="req">Date</label><input class="inp" type="date" data-date value="${today()}"></div>
        <div class="field"><label class="req">${isPV ? 'Paid from' : 'Received into'}</label><select class="inp" data-cash>${cash.map((a) => html`<option value="${a.account_id}">${a.account_code} · ${a.account_name}</option>`)}</select></div>
        <div class="field"><label>Description</label><input class="inp" data-desc placeholder="What is this for?"></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">${isPV ? 'Expense / account lines' : 'Income / account lines'}</div><div class="card-s">Each line debits${isPV ? '' : ' (credits)'} the account you choose.</div></div></div><div class="lines" data-lines style="padding-top:8px"></div><div class="ln-foot"><button class="btn sm" data-add>${raw(ico('plus'))}Add line</button></div></div>` });
  const box = $('[data-lines]', F.root); const cols = 'minmax(220px,1.6fr) minmax(160px,1.4fr) 130px 34px';
  const opts = () => { const c = $('[data-cash]', F.root).value; return accounts.filter((a) => a.account_id !== c && !a.is_control_account && !a.is_cash_account && !a.is_inventory_account && !a.is_receivable_account && !a.is_payable_account && !a.is_grir_account).map((a) => `<option value="${a.account_id}">${esc(a.account_code)} · ${esc(a.account_name)}</option>`).join(''); };
  box.innerHTML = `<div class="ln-grid" style="--cols:${cols}">${rowsHead(cols, [['Account'], ['Description'], ['Amount', 1], ['']])}<div data-body></div></div>`;
  const body = $('[data-body]', box);
  const calc = () => { const t = round2($$('.ln-a', body).reduce((s, i) => s + num(i.value), 0)); F.tot.innerHTML = str(html`<div class="r"><span>Lines</span><span>${$$('.ln-a', body).filter((i) => num(i.value) > 0).length}</span></div><div class="r g"><span>Total</span><span>${rm(t)}</span></div>`); };
  const add = (focus) => { const d = document.createElement('div'); d.className = 'ln'; d.dataset.row = ''; d.style.setProperty('--cols', cols); d.innerHTML = `<div class="cell"><select class="inp ln-acct" aria-label="Account"><option value="">Choose account…</option>${opts()}</select></div><div class="cell"><input class="inp ln-d" placeholder="Description" aria-label="Description"></div><div class="cell"><input class="inp num ln-a" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Amount"></div><div class="cell"><button class="icon-btn sm" data-rm aria-label="Remove line">${ico('x')}</button></div>`; body.appendChild(d); if (focus) $('.ln-acct', d).focus(); };
  add(); add();
  $('[data-cash]', F.root).addEventListener('change', () => { $$('.ln-acct', body).forEach((s) => { const v = s.value; s.innerHTML = `<option value="">Choose account…</option>${opts()}`; s.value = v; }); });
  F.root.addEventListener('click', (e) => { if (e.target.closest('[data-add]')) add(true); const r = e.target.closest('[data-rm]'); if (r) { if (body.children.length > 1) r.closest('.ln').remove(); calc(); } });
  body.addEventListener('input', calc); calc();
  F.save.addEventListener('click', () => {
    const errs = []; const who = $('[data-who]', F.root).value.trim(); if (!who) errs.push(isPV ? 'Enter the payee' : 'Enter who the money is from');
    const lines = []; $$('.ln', body).forEach((r, i) => { const a = $('.ln-acct', r).value, v = num($('.ln-a', r).value); if (!a && !v) return; if (!a) errs.push(`Line ${i + 1}: choose an account`); else if (!(v > 0)) errs.push(`Line ${i + 1}: enter an amount`); else lines.push({ accountId: a, description: $('.ln-d', r).value.trim() || null, amount: round2(v) }); });
    if (!lines.length && !errs.length) errs.push('Add at least one line');
    if (errs.length) return showErr(F, errs);
    const p = { [isPV ? 'pvDate' : 'orDate']: $('[data-date]', F.root).value, [isPV ? 'payee' : 'payer']: who, cashAccountId: $('[data-cash]', F.root).value, description: $('[data-desc]', F.root).value.trim() || null, createdBy: user(), lines };
    submitDoc(env, F, `/cash-book/${cfg.key}`, p);
  });
}
