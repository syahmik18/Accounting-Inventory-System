/* ==========================================================================
   pages/masters.js — customers, suppliers, stock items, chart of accounts
   and tax codes: searchable lists, detail drawers, create / edit dialogs.
   ========================================================================== */
import { $, $$, html, raw, esc, str, api, ref, invalidate, emit, user, num, fmt, rm, qty, title, fmtDate, badge, tone, openDrawer, openModal, confirmDialog, toast, empty, skeleton, errorNote, setHTML, formHtml, readForm, debounce, navigate, activeOnly, qs } from '../core.js';
import { ico } from '../icons.js';

export default async function render(ctx) {
  const seg = ctx.segs;
  if (seg[0] === 'customers' || seg[0] === 'suppliers') return partnersPage(ctx, seg[0] === 'customers' ? 'CUSTOMER' : 'VENDOR');
  if (seg[0] === 'inventory') return itemsPage(ctx);
  if (seg[0] === 'accounting') return accountsPage(ctx);
}
const COSTING_LABEL = { FIXED: 'Fixed cost', AVERAGE: 'Average cost', FIFO: 'FIFO' };
const pager = (S, total, size) => { const pages = Math.max(1, Math.ceil(total / size)); return html`<div class="pager"><span>${total} record${total === 1 ? '' : 's'} · page ${S.page} of ${pages}</span><div class="btns"><button class="btn sm" data-pg="-1" ${S.page <= 1 ? raw('disabled') : ''}>Previous</button><button class="btn sm" data-pg="1" ${S.page >= pages ? raw('disabled') : ''}>Next</button></div></div>`; };
const kv = (rows) => html`<div class="kv">${rows.map(([k, v]) => html`<div><div class="k">${k}</div><div class="v">${v === '' || v == null ? '—' : v}</div></div>`)}</div>`;

/* ================================ PARTNERS ================================ */
const PARTNER_FIELDS = (type) => [
  { name: 'partnerCode', label: 'Code', req: true }, { name: 'partnerType', label: 'Type', type: 'select', options: [{ value: 'CUSTOMER', label: 'Customer' }, { value: 'VENDOR', label: 'Supplier' }, { value: 'BOTH', label: 'Customer & supplier' }] },
  { name: 'partnerName', label: 'Name', req: true, full: true }, { name: 'contactPerson', label: 'Contact person' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'creditTermsDays', label: 'Credit terms (days)', type: 'number', step: '1' }, { name: 'taxId', label: 'TIN (LHDN)', hint: 'Needed for e-Invoicing' }, { name: 'brnNo', label: 'BRN (SSM)' }, { name: 'sstNo', label: 'SST registration no.' },
  { name: 'address', label: 'Address', type: 'textarea', full: true },
];
export async function openPartnerModal({ type = 'CUSTOMER', partner = null, onSaved } = {}) {
  let code = '';
  if (!partner) { try { const r = await api.get(`/partners${qs({ type, page: 1, pageSize: 1, includeInactive: 'true' })}`); code = `${type === 'CUSTOMER' ? 'CUST' : 'SUPP'}${String((r.totalCount || 0) + 1).padStart(3, '0')}`; } catch { code = ''; } }
  const v = partner ? { partnerCode: partner.partner_code, partnerType: partner.partner_type, partnerName: partner.partner_name, contactPerson: partner.contact_person, phone: partner.phone, email: partner.email, creditTermsDays: partner.credit_terms_days, taxId: partner.tax_id, brnNo: partner.brn_no, sstNo: partner.sst_no, address: partner.address } : { partnerCode: code, partnerType: type, creditTermsDays: 30 };
  const m = openModal({ title: partner ? `Edit ${partner.partner_name}` : `New ${type === 'CUSTOMER' ? 'customer' : 'supplier'}`, size: 'lg', body: html`${formHtml(PARTNER_FIELDS(type), v)}<div data-err></div>`, footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-save>${partner ? 'Save changes' : 'Create'}</button>` });
  $('[data-save]', m.el).addEventListener('click', async (e) => {
    const f = readForm(m.body); const err = $('[data-err]', m.body);
    if (!f.partnerCode || !f.partnerName) { err.innerHTML = '<div class="note bad">Code and name are required.</div>'; return; }
    const body = { ...f, creditTermsDays: f.creditTermsDays === '' ? 30 : Number(f.creditTermsDays) };
    e.currentTarget.disabled = true;
    try {
      const r = partner ? await api.patch(`/partners/${partner.partner_id}`, body) : await api.post('/partners', body);
      const id = partner ? partner.partner_id : (r.partner_id || r.partnerId || r.id);
      invalidate(`ref:partner:${id}`); const saved = id ? await api.get(`/partners/${id}`) : r;
      toast(partner ? 'Changes saved' : `${saved.partner_name} created`); emit('changed'); m.close(); onSaved && onSaved(saved);
    } catch (x) { e.currentTarget.disabled = false; err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; }
  });
}
async function partnersPage(ctx, type) {
  const { root, query } = ctx; const cust = type === 'CUSTOMER'; const word = cust ? 'customer' : 'supplier';
  const S = { q: '', page: 1, inactive: false, size: 25 };
  root.innerHTML = str(html`<div class="page-head"><div><h1>${cust ? 'Customers' : 'Suppliers'}</h1><div class="sub" data-sub></div></div><div class="actions"><a class="btn primary" data-new href="#/${cust ? 'customers' : 'suppliers'}?new=1">${raw(ico('plus'))}New ${word}</a></div></div>
    <div class="card"><div class="toolbar"><div class="search">${raw(ico('search'))}<input class="inp" data-q placeholder="Search name, code, phone, TIN or BRN…" aria-label="Search"></div><label class="check"><input type="checkbox" data-inact> Show inactive</label></div><div data-tbl>${skeleton(6)}</div><div data-foot></div></div>`);
  const load = async () => {
    try {
      const r = await api.get(`/partners${qs({ type, q: S.q, page: S.page, pageSize: S.size, includeInactive: S.inactive ? 'true' : '' })}`);
      $('[data-sub]', root).textContent = `${r.totalCount} ${r.totalCount === 1 ? word : word + 's'}`;
      setHTML($('[data-tbl]', root), r.items.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Contact</th><th class="num">Terms</th><th>TIN / BRN</th><th>Status</th></tr></thead><tbody>${r.items.map((p) => html`<tr class="click" tabindex="0" data-id="${p.partner_id}"><td><div class="main">${p.partner_name}</div><div class="sub">${p.partner_code}${p.partner_type === 'BOTH' ? ' · customer & supplier' : ''}</div></td><td>${p.phone || '—'}<div class="sub">${p.email || ''}</div></td><td class="num">${p.credit_terms_days ?? '—'}${p.credit_terms_days != null ? ' d' : ''}</td><td>${p.tax_id || '—'}<div class="sub">${p.brn_no || ''}</div></td><td>${badge(p.is_active ? 'APPROVED' : 'CLOSED', p.is_active ? 'Active' : 'Inactive')}</td></tr>`)}</tbody></table></div>` : empty(cust ? 'customers' : 'suppliers', `No ${word}s found`, S.q ? 'Try a different search.' : `Add your first ${word} to start invoicing.`));
      setHTML($('[data-foot]', root), r.totalCount > S.size ? pager(S, r.totalCount, S.size) : '');
      root._rows = r.items;
    } catch (e) { setHTML($('[data-tbl]', root), errorNote(e)); }
  };
  const detail = async (id) => {
    const d = openDrawer({ title: 'Loading…', size: 'narrow', body: skeleton(4) });
    const p = await api.get(`/partners/${id}`);
    d.setTitle(p.partner_name, html`${badge(p.is_active ? 'APPROVED' : 'CLOSED', p.is_active ? 'Active' : 'Inactive')} <span class="muted" style="margin-left:6px">${p.partner_code}</span>`);
    d.setBody(kv([['Type', p.partner_type === 'BOTH' ? 'Customer & supplier' : title(p.partner_type === 'VENDOR' ? 'Supplier' : 'Customer')], ['Credit terms', p.credit_terms_days != null ? `${p.credit_terms_days} days` : ''], ['Contact', p.contact_person], ['Phone', p.phone], ['Email', p.email], ['TIN', p.tax_id], ['BRN', p.brn_no], ['SST no.', p.sst_no], ['Address', p.address]]));
    d.setFooter(html`${cust || p.partner_type === 'BOTH' ? html`<a class="btn primary" href="#/sales/invoices/new" data-close>${raw(ico('sales'))}New invoice</a>` : ''}${!cust ? html`<a class="btn primary" href="#/purchases/orders/new" data-close>${raw(ico('cart'))}New purchase order</a>` : ''}<button class="btn" data-e>${raw(ico('edit'))}Edit</button><span class="spacer"></span>${p.is_active ? html`<button class="btn danger" data-t>Deactivate</button>` : html`<button class="btn" data-t>Reactivate</button>`}`);
    d.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-e]')) { d.close(); openPartnerModal({ type, partner: p, onSaved: load }); }
      if (e.target.closest('[data-t]')) { try { p.is_active ? await api.del(`/partners/${id}`) : await api.post(`/partners/${id}/reactivate`); invalidate('ref:partner'); toast(p.is_active ? 'Deactivated' : 'Reactivated'); d.close(); load(); } catch (x) { toast(x.message, 'bad'); } }
    });
  };
  root.addEventListener('input', debounce((e) => { if (e.target.matches('[data-q]')) { S.q = e.target.value; S.page = 1; load(); } }, 220));
  root.addEventListener('change', (e) => { if (e.target.matches('[data-inact]')) { S.inactive = e.target.checked; S.page = 1; load(); } });
  root.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-pg]'); if (pg) { S.page += +pg.dataset.pg; load(); return; }
    if (e.target.closest('[data-new]')) { e.preventDefault(); openPartnerModal({ type, onSaved: load }); return; }
    const tr = e.target.closest('tr[data-id]'); if (tr) detail(tr.dataset.id).catch((x) => toast(x.message, 'bad'));
  });
  await load();
  if (query.new) openPartnerModal({ type, onSaved: load }); else if (query.view) detail(query.view).catch((x) => toast(x.message, 'bad'));
}

/* ================================ STOCK ITEMS ================================ */
export async function openItemModal({ item = null, onSaved } = {}) {
  const [accts, taxes] = await Promise.all([ref.accounts(), ref.taxCodes()]);
  const A = activeOnly(accts), T = activeOnly(taxes);
  const opt = (list, f, none = '— none —') => [{ value: '', label: none }, ...list.map((a) => ({ value: a.account_id ?? a.tax_code_id, label: f(a) }))];
  const acct = (t, pre) => opt(A.filter((a) => a.account_type === t && (!pre || String(a.account_code).startsWith(pre))), (a) => `${a.account_code} · ${a.account_name}`);
  const code = (re) => opt(T.filter((t) => re.test(String(t.direction))), (t) => `${t.code} · ${num(t.rate)}%`);
  const costingOptions = [
    { value: 'AVERAGE', label: 'Average cost — blends every purchase into one moving average' },
    { value: 'FIXED', label: 'Fixed cost — always uses Reference Cost until you edit it here' },
    { value: 'FIFO', label: 'FIFO — first stock in is the first stock costed out' },
  ];
  const fields = [
    { name: 'itemCode', label: 'Item code', req: true, readonly: !!item }, { name: 'unit', label: 'Unit', ph: 'UNIT, PC, BOX…' }, { name: 'itemName', label: 'Name', req: true, full: true }, { name: 'barcode', label: 'Barcode' },
    { name: 'minQty', label: 'Minimum stock (alert level)', type: 'number', step: 'any', hint: 'Get a low-stock alert at or below this quantity' }, { name: 'refCost', label: 'Reference cost (RM)', type: 'number', step: '0.01', hint: 'Also the cost used for every sale/issue when Costing method is Fixed' }, { name: 'refPrice', label: 'Selling price (RM)', type: 'number', step: '0.01' },
    { name: 'costingMethod', label: 'Costing method', type: 'select', options: costingOptions, full: true, hint: item ? 'Changing this affects cost of goods sold and profit & loss going forward — it never rewrites past sales.' : 'How this item values inventory and cost of goods sold. Can be changed later.' },
    ...(item ? [] : [{ name: 'openingQty', label: 'Opening quantity', type: 'number', step: 'any', hint: 'Posted against opening balance equity at reference cost' }]),
    { name: 'defaultRevenueAccountId', label: 'Sales revenue account', type: 'select', options: acct('REVENUE') }, { name: 'defaultSalesTaxCodeId', label: 'Sales tax code', type: 'select', options: code(/^SAL/i) },
    { name: 'defaultInventoryAccountId', label: 'Inventory account', type: 'select', options: acct('ASSET', '12') }, { name: 'defaultCogsAccountId', label: 'Cost of sales account', type: 'select', options: acct('EXPENSE', '5') },
    { name: 'defaultExpenseAccountId', label: 'Purchase expense account', type: 'select', options: acct('EXPENSE') }, { name: 'defaultPurchaseTaxCodeId', label: 'Purchase tax code', type: 'select', options: code(/^PUR/i) },
  ];
  const first = (l, c) => (l.find((a) => String(a.account_code) === c) || {}).account_id || '';
  const v = item ? { itemCode: item.item_code, itemName: item.item_name, unit: item.unit, barcode: item.barcode, minQty: item.min_qty, refCost: item.ref_cost, refPrice: item.ref_price, costingMethod: item.costing_method || 'AVERAGE', defaultRevenueAccountId: item.default_revenue_account_id || '', defaultSalesTaxCodeId: item.default_sales_tax_code_id || '', defaultInventoryAccountId: item.default_inventory_account_id || '', defaultCogsAccountId: item.default_cogs_account_id || '', defaultExpenseAccountId: item.default_expense_account_id || '', defaultPurchaseTaxCodeId: item.default_purchase_tax_code_id || '' }
    : { unit: 'UNIT', minQty: 0, openingQty: 0, costingMethod: 'AVERAGE', defaultRevenueAccountId: first(A, '4000'), defaultInventoryAccountId: first(A, '1200'), defaultCogsAccountId: first(A, '5000'), defaultExpenseAccountId: first(A, '6000'), defaultSalesTaxCodeId: (T.find((t) => /^SAL/i.test(t.direction) && t.is_default) || {}).tax_code_id || '', defaultPurchaseTaxCodeId: (T.find((t) => /^PUR/i.test(t.direction) && t.is_default) || {}).tax_code_id || '' };
  const m = openModal({ title: item ? `Edit ${item.item_code}` : 'New stock item', size: 'lg', body: html`${formHtml(fields, v)}<div data-err></div>`, footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-save>${item ? 'Save changes' : 'Create item'}</button>` });
  $('[data-save]', m.el).addEventListener('click', async (e) => {
    const btn = e.currentTarget; // captured now: after the confirmDialog await below, the event object's currentTarget is gone
    const f = readForm(m.body); const err = $('[data-err]', m.body);
    if (!f.itemCode || !f.itemName) { err.innerHTML = '<div class="note bad">Code and name are required.</div>'; return; }
    const newMethod = f.costingMethod;
    // Switching costing method on an EXISTING item has real side effects (it
    // may open a FIFO lot for stock already on hand), so it always goes
    // through its own confirmed endpoint - never silently folded into the
    // general field-by-field save below. New items just create with it.
    if (item && newMethod !== (item.costing_method || 'AVERAGE')) {
      const r = await confirmDialog({
        title: `Switch ${item.item_code} to ${newMethod === 'FIFO' ? 'FIFO' : newMethod === 'FIXED' ? 'Fixed cost' : 'Average cost'} costing?`,
        message: newMethod === 'FIFO' ? 'Stock currently on hand becomes one FIFO layer at today\u2019s average cost. Sales made before this switch keep the cost they already posted.'
          : item.costing_method === 'FIFO' ? 'FIFO cost layers stop being used for new sales. Stock already on hand keeps its current value; new issues follow the new method.'
          : 'Sales made before this switch keep the cost they already posted. New sales follow the new method from now on.',
        confirm: 'Switch costing method',
      });
      if (!r.ok) return;
    }
    const body = { ...f, refCost: num(f.refCost), refPrice: num(f.refPrice), openingQty: num(f.openingQty) };
    ['defaultRevenueAccountId', 'defaultSalesTaxCodeId', 'defaultInventoryAccountId', 'defaultCogsAccountId', 'defaultExpenseAccountId', 'defaultPurchaseTaxCodeId'].forEach((k) => { if (!body[k]) body[k] = null; });
    delete body.minQty; if (item) delete body.costingMethod; btn.disabled = true;
    try {
      const r = item ? await api.patch(`/stock-items/${item.stock_item_id}`, body) : await api.post('/stock-items', body);
      const id = item ? item.stock_item_id : (r.stock_item_id || r.stockItemId || r.id);
      if (item && newMethod !== (item.costing_method || 'AVERAGE')) await api.patch(`/stock-items/${item.stock_item_id}/costing-method`, { costingMethod: newMethod });
      if (id) await api.patch(`/stock-items/${id}/min-qty`, { minQty: num(f.minQty) });
      invalidate('ref:item'); invalidate('ov:'); toast(item ? 'Changes saved' : `${f.itemCode} created`); emit('changed'); m.close(); onSaved && onSaved(id);
    } catch (x) { btn.disabled = false; err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; }
  });
}
async function itemsPage(ctx) {
  const { root, query } = ctx; const S = { q: '', page: 1, inactive: false, size: 25, sort: 'item_code', dir: 'asc' };
  root.innerHTML = str(html`<div class="page-head"><div><div class="crumbs"><a href="#/inventory">Inventory</a> / Items</div><h1>Stock items</h1><div class="sub" data-sub></div></div><div class="actions"><a class="btn" href="#/inventory">${raw(ico('pie'))}Overview</a><button class="btn primary" data-new>${raw(ico('plus'))}New item</button></div></div>
    <div class="card"><div class="toolbar"><div class="search">${raw(ico('search'))}<input class="inp" data-q placeholder="Search code, name or barcode…" aria-label="Search"></div><label class="check"><input type="checkbox" data-inact> Show inactive</label></div><div data-tbl>${skeleton(6)}</div><div data-foot></div></div>`);
  const th = (l, k, c = '') => html`<th class="sortable ${c}" data-sort="${k}">${l}<span class="arr">${S.sort === k ? (S.dir === 'asc' ? '↑' : '↓') : ''}</span></th>`;
  const load = async () => {
    try {
      const r = await api.get(`/stock-items${qs({ q: S.q, search: S.q, page: S.page, pageSize: S.size, sortBy: S.sort, sortDir: S.dir, includeInactive: S.inactive ? 'true' : '' })}`);
      const items = r.items || r; const total = r.totalCount ?? r.total ?? items.length;
      $('[data-sub]', root).textContent = `${total} item${total === 1 ? '' : 's'}`;
      setHTML($('[data-tbl]', root), items.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr>${th('Item', 'item_code')}${th('Unit', 'unit')}${th('Cost', 'ref_cost', 'num')}${th('Price', 'ref_price', 'num')}${th('On hand', 'current_qty', 'num')}${th('Value', 'inventory_value', 'num')}<th>Status</th></tr></thead><tbody>${items.map((i) => { const low = num(i.min_qty) > 0 && num(i.current_qty) <= num(i.min_qty); return html`<tr class="click" tabindex="0" data-id="${i.stock_item_id}"><td><div class="main">${i.item_code}</div><div class="sub">${i.item_name}</div></td><td>${i.unit || '—'}</td><td class="num">${fmt(i.ref_cost)}</td><td class="num">${fmt(i.ref_price)}</td><td class="num ${num(i.current_qty) <= 0 ? 'neg' : ''}"><b>${qty(i.current_qty)}</b>${low ? html` <span class="badge tone-warn" style="margin-left:6px">Low</span>` : ''}</td><td class="num">${fmt(i.inventory_value)}</td><td>${badge(i.is_active ? 'APPROVED' : 'CLOSED', i.is_active ? 'Active' : 'Inactive')}</td></tr>`; })}</tbody></table></div>` : empty('inventory', 'No items found', S.q ? 'Try a different search.' : 'Create your first stock item.'));
      setHTML($('[data-foot]', root), total > S.size ? pager(S, total, S.size) : '');
    } catch (e) { setHTML($('[data-tbl]', root), errorNote(e)); }
  };
  const detail = async (id) => {
    const d = openDrawer({ title: 'Loading…', size: 'wide', body: skeleton(5) });
    const i = await api.get(`/stock-items/${id}`);
    d.setTitle(`${i.item_code} — ${i.item_name}`, html`${badge(i.is_active ? 'APPROVED' : 'CLOSED', i.is_active ? 'Active' : 'Inactive')} <span class="badge tone-info" style="margin-left:6px">${COSTING_LABEL[i.costing_method] || 'Average cost'}</span>`);
    const mv = i.movements || [];
    d.setBody(html`<div class="grid g3" style="gap:12px">${[['On hand', `${qty(i.current_qty)} ${i.unit || ''}`], ['Average cost', rm(i.average_cost)], ['Stock value', rm(i.inventory_value)]].map(([k, v]) => html`<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)}</div>
      ${kv([['Costing method', COSTING_LABEL[i.costing_method] || 'Average cost'], ['Barcode', i.barcode], ['Minimum stock', num(i.min_qty) ? qty(i.min_qty) : 'Not set'], ['Reference cost', rm(i.ref_cost)], ['Selling price', rm(i.ref_price)]])}
      <div class="card" style="box-shadow:none"><div class="card-h"><div class="card-t">Stock movements</div></div>${mv.length ? html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Date</th><th>Type</th><th>Document</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th></tr></thead><tbody>${mv.slice(0, 40).map((m) => html`<tr><td>${fmtDate(m.movement_date)}</td><td>${title(m.movement_type)}</td><td class="main">${m.source_doc_no || '—'}</td><td class="num pos">${num(m.quantity_in) ? qty(m.quantity_in) : ''}</td><td class="num neg">${num(m.quantity_out) ? qty(m.quantity_out) : ''}</td><td class="num"><b>${qty(m.balance_after)}</b></td></tr>`)}</tbody></table></div>` : empty('history', 'No movements yet', '')}</div>`);
    d.setFooter(html`<a class="btn" href="#/sales/invoices/new" data-close>${raw(ico('sales'))}Sell</a><a class="btn" href="#/purchases/requests/new" data-close>${raw(ico('clipboard'))}Request stock</a><button class="btn" data-e>${raw(ico('edit'))}Edit</button><span class="spacer"></span>${i.is_active ? html`<button class="btn danger" data-t>Deactivate</button>` : html`<button class="btn" data-t>Reactivate</button>`}`);
    d.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-e]')) { d.close(); openItemModal({ item: i, onSaved: load }); }
      if (e.target.closest('[data-t]')) { try { i.is_active ? await api.del(`/stock-items/${id}`) : await api.post(`/stock-items/${id}/reactivate`); invalidate('ref:item'); toast(i.is_active ? 'Deactivated' : 'Reactivated'); d.close(); load(); } catch (x) { toast(x.message, 'bad'); } }
    });
  };
  root.addEventListener('input', debounce((e) => { if (e.target.matches('[data-q]')) { S.q = e.target.value; S.page = 1; load(); } }, 220));
  root.addEventListener('change', (e) => { if (e.target.matches('[data-inact]')) { S.inactive = e.target.checked; S.page = 1; load(); } });
  root.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-pg]'); if (pg) { S.page += +pg.dataset.pg; load(); return; }
    const so = e.target.closest('[data-sort]'); if (so) { const k = so.dataset.sort; S.dir = S.sort === k && S.dir === 'asc' ? 'desc' : 'asc'; S.sort = k; load(); return; }
    if (e.target.closest('[data-new]')) { openItemModal({ onSaved: load }); return; }
    const tr = e.target.closest('tr[data-id]'); if (tr) detail(tr.dataset.id).catch((x) => toast(x.message, 'bad'));
  });
  await load();
  if (query.new) openItemModal({ onSaved: load }); else if (query.view) detail(query.view).catch((x) => toast(x.message, 'bad'));
}

/* ================================ CHART OF ACCOUNTS ================================ */
const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const TYPE_TONE = { ASSET: 'info', LIABILITY: 'warn', EQUITY: 'muted', REVENUE: 'ok', EXPENSE: 'bad' };
export function openAccountModal({ account = null, onSaved } = {}) {
  const fields = [{ name: 'accountCode', label: 'Account code', req: true, readonly: !!account }, { name: 'accountType', label: 'Type', type: 'select', options: TYPES.map((t) => ({ value: t, label: title(t) })) }, { name: 'accountName', label: 'Account name', req: true, full: true }];
  const m = openModal({ title: account ? `Edit ${account.account_code}` : 'New account', body: html`${formHtml(fields, account ? { accountCode: account.account_code, accountType: account.account_type, accountName: account.account_name } : { accountType: 'EXPENSE' })}${account ? html`<div class="note">${raw(ico('info'))}<div>The type cannot be changed once an account exists.</div></div>` : ''}<div data-err></div>`, footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-save>${account ? 'Save changes' : 'Create account'}</button>` });
  if (account) $('[name="accountType"]', m.body).disabled = true;
  $('[data-save]', m.el).addEventListener('click', async (e) => {
    const f = readForm(m.body); const err = $('[data-err]', m.body);
    if (!f.accountCode || !f.accountName) { err.innerHTML = '<div class="note bad">Code and name are required.</div>'; return; }
    e.currentTarget.disabled = true;
    try { account ? await api.patch(`/accounts/${account.account_id}`, { accountName: f.accountName }) : await api.post('/accounts', f); invalidate('ref:accounts'); toast(account ? 'Changes saved' : 'Account created'); emit('changed'); m.close(); onSaved && onSaved(); }
    catch (x) { e.currentTarget.disabled = false; err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; }
  });
}
async function accountsPage(ctx) {
  const { root } = ctx; const S = { q: '', type: '' };
  root.innerHTML = str(html`<div class="page-head"><div><div class="crumbs"><a href="#/accounting">Accounting</a> / Chart of accounts</div><h1>Chart of accounts</h1><div class="sub" data-sub></div></div><div class="actions"><button class="btn primary" data-new>${raw(ico('plus'))}New account</button></div></div>
    <div class="card"><div class="toolbar"><div class="search">${raw(ico('search'))}<input class="inp" data-q placeholder="Search code or name…" aria-label="Search"></div><div class="chips" data-chips></div></div><div data-tbl>${skeleton(8)}</div></div>`);
  let rows = [], bal = {};
  const load = async () => {
    try {
      invalidate('ref:accounts'); const [a, tb] = await Promise.all([ref.accounts(), api.get('/reports/trial-balance')]);
      rows = a; bal = {}; tb.accounts.forEach((x) => { bal[x.account_code] = num(x.total_debit) - num(x.total_credit); }); paint();
    } catch (e) { setHTML($('[data-tbl]', root), errorNote(e)); }
  };
  const paint = () => {
    const q = S.q.toLowerCase(); const list = rows.filter((a) => (!S.type || a.account_type === S.type) && (!q || `${a.account_code} ${a.account_name}`.toLowerCase().includes(q)));
    $('[data-sub]', root).textContent = `${rows.length} accounts`;
    setHTML($('[data-chips]', root), TYPES.map((t) => html`<button class="chip ${S.type === t ? 'on' : ''}" data-type="${t}">${title(t)} <span class="n">${rows.filter((a) => a.account_type === t).length}</span></button>`));
    setHTML($('[data-tbl]', root), list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Balance</th><th></th></tr></thead><tbody>${list.map((a) => { const b = bal[a.account_code] || 0; const nb = a.normal_balance === 'DR' ? b : -b; return html`<tr><td class="main mono">${a.account_code}</td><td>${a.account_name}${a.is_active === false ? html` <span class="badge tone-muted" style="margin-left:6px">Inactive</span>` : ''}</td><td><span class="badge tone-${TYPE_TONE[a.account_type]}">${title(a.account_type)}</span></td><td class="num ${nb < 0 ? 'neg' : ''}">${Math.abs(nb) > 0.004 ? fmt(nb) : '—'}</td><td style="text-align:right;white-space:nowrap"><a class="btn sm ghost" href="#/accounting?tab=ledger&account=${a.account_id}">Ledger</a><button class="btn sm ghost" data-edit="${a.account_id}">Edit</button><button class="btn sm ghost danger" data-off="${a.account_id}">${a.is_active === false ? 'Reactivate' : 'Deactivate'}</button></td></tr>`; })}</tbody></table></div>` : empty('list', 'No accounts match', ''));
  };
  root.addEventListener('input', debounce((e) => { if (e.target.matches('[data-q]')) { S.q = e.target.value; paint(); } }, 150));
  root.addEventListener('click', async (e) => {
    const ty = e.target.closest('[data-type]'); if (ty) { S.type = S.type === ty.dataset.type ? '' : ty.dataset.type; paint(); return; }
    if (e.target.closest('[data-new]')) { openAccountModal({ onSaved: load }); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) { openAccountModal({ account: rows.find((a) => a.account_id === ed.dataset.edit), onSaved: load }); return; }
    const off = e.target.closest('[data-off]'); if (off) { const a = rows.find((x) => x.account_id === off.dataset.off); const inactive = a.is_active === false;
      const r = await confirmDialog({ title: `${inactive ? 'Reactivate' : 'Deactivate'} ${a.account_code}?`, message: inactive ? 'It will be available for postings again.' : 'It will no longer be offered for new postings. Existing history is kept. Accounts with a balance cannot be deactivated.', confirm: inactive ? 'Reactivate' : 'Deactivate', danger: !inactive });
      if (r.ok) try { inactive ? await api.post(`/accounts/${a.account_id}/reactivate`) : await api.del(`/accounts/${a.account_id}`); toast('Done'); load(); } catch (x) { toast(x.message, 'bad'); } }
  });
  await load();
}

/* ================================ TAX CODES (rendered inside Settings) ================================ */
export async function taxPanel(host) {
  host.innerHTML = str(html`<div class="card"><div class="card-h"><div><div class="card-t">Tax codes</div><div class="card-s">SST and other taxes applied on sales and purchases. Items pick their default from here.</div></div><button class="btn primary" data-new>${raw(ico('plus'))}New tax code</button></div><div data-tbl style="padding-top:12px">${skeleton(4)}</div></div>`);
  const load = async () => {
    invalidate('ref:tax'); let list; try { list = await ref.taxCodes(); } catch (e) { setHTML($('[data-tbl]', host), errorNote(e)); return; }
    setHTML($('[data-tbl]', host), html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Description</th><th class="num">Rate</th><th>Applies to</th><th>Status</th><th></th></tr></thead><tbody>${list.map((t) => html`<tr><td class="main">${t.code}${t.is_default ? html` <span class="badge tone-info" style="margin-left:6px">Default</span>` : ''}</td><td>${t.description || '—'}</td><td class="num">${num(t.rate)}%</td><td>${/^SAL/i.test(t.direction) ? 'Sales' : 'Purchases'}</td><td>${badge(t.is_active === false ? 'CLOSED' : 'APPROVED', t.is_active === false ? 'Inactive' : 'Active')}</td><td style="text-align:right"><button class="btn sm ghost" data-edit="${t.tax_code_id}">Edit</button><button class="btn sm ghost ${t.is_active === false ? '' : 'danger'}" data-off="${t.tax_code_id}">${t.is_active === false ? 'Reactivate' : 'Deactivate'}</button></td></tr>`)}</tbody></table></div>`);
    host._list = list;
  };
  let taxAccts = []; ref.accounts().then((a) => { taxAccts = activeOnly(a).filter((x) => ['LIABILITY', 'ASSET', 'EXPENSE'].includes(x.account_type)); });
  const modal = (t) => {
    const fields = [{ name: 'code', label: 'Code', req: true, readonly: !!t }, { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01', req: true }, { name: 'description', label: 'Description', req: true, full: true },
      { name: 'direction', label: 'Applies to', type: 'select', options: [{ value: 'SALES', label: 'Sales' }, { value: 'PURCHASE', label: 'Purchases' }] },
      { name: 'taxAccountId', label: 'Tax account (ledger)', type: 'select', req: true, options: taxAccts.map((a) => ({ value: a.account_id, label: `${a.account_code} · ${a.account_name}` })) },
      { name: 'isDefault', label: 'Use as the default for this direction', type: 'check', full: true }];
    const m = openModal({ title: t ? `Edit ${t.code}` : 'New tax code', body: html`${formHtml(fields, t ? { code: t.code, rate: t.rate, description: t.description, direction: /^SAL/i.test(t.direction) ? 'SALES' : 'PURCHASE', taxAccountId: t.tax_account_id, isDefault: t.is_default } : { direction: 'SALES', rate: 6, taxAccountId: (taxAccts.find((a) => a.account_type === 'LIABILITY') || taxAccts[0] || {}).account_id })}<div data-err></div>`, footer: html`<button class="btn" data-close>Cancel</button><span class="spacer"></span><button class="btn primary" data-save>${t ? 'Save changes' : 'Create'}</button>` });
    $('[data-save]', m.el).addEventListener('click', async (e) => {
      const f = readForm(m.body); const err = $('[data-err]', m.body);
      if (!f.code || f.rate === '' || !f.description) { err.innerHTML = '<div class="note bad">Code, description and rate are required.</div>'; return; }
      const body = { ...f, rate: Number(f.rate) }; e.currentTarget.disabled = true;
      try { t ? await api.patch(`/tax-codes/${t.tax_code_id}`, body) : await api.post('/tax-codes', body); toast('Saved'); emit('changed'); m.close(); load(); }
      catch (x) { e.currentTarget.disabled = false; err.innerHTML = `<div class="note bad">${esc(x.message)}</div>`; }
    });
  };
  host.addEventListener('click', async (e) => {
    if (e.target.closest('[data-new]')) return modal(null);
    const ed = e.target.closest('[data-edit]'); if (ed) return modal(host._list.find((t) => t.tax_code_id === ed.dataset.edit));
    const off = e.target.closest('[data-off]'); if (off) { const t = host._list.find((x) => x.tax_code_id === off.dataset.off); try { t.is_active === false ? await api.post(`/tax-codes/${t.tax_code_id}/reactivate`) : await api.del(`/tax-codes/${t.tax_code_id}`); toast('Done'); load(); } catch (x) { toast(x.message, 'bad'); } }
  });
  await load();
}
