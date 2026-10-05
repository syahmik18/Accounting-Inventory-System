/* ==========================================================================
   lines.js — reusable editor parts: partner picker + line-item grid.
   The grid works for quotations, orders, invoices, cash sales, purchase
   requests / orders / invoices and cash purchases (item lookup, stock on
   hand, tax + account resolution, live totals).
   ========================================================================== */
import { $, $$, html, raw, esc, str, api, num, round2, fmt, rm, qty, combo, qs } from './core.js';
import { ico } from './icons.js';

/* ---------- partner (customer / supplier) picker ---------- */
export function partnerField(host, { type, label, req = false, placeholder = '', onPick, allowNew = true }) {
  const id = `pf${Math.random().toString(36).slice(2, 7)}`;
  host.innerHTML = `<label for="${id}" class="${req ? 'req' : ''}">${esc(label)}</label><input class="inp" id="${id}" placeholder="${esc(placeholder || `Search ${type === 'CUSTOMER' ? 'customer' : 'supplier'} by name or code…`)}"><span class="hint"></span>`;
  host.classList.add('field');
  const input = $('input', host), hint = $('.hint', host);
  let cur = null;
  const set = (p) => { cur = p || null; input.value = p ? p.partner_name : ''; hint.textContent = p ? [p.partner_code, p.credit_terms_days != null ? `${p.credit_terms_days}-day terms` : '', p.phone].filter(Boolean).join(' · ') : ''; };
  combo(input, {
    search: (q, signal) => api.get(`/partners/search${qs({ q, type, limit: 12 })}`, { signal }),
    render: (p) => html`<span class="t"><b>${p.partner_name}</b><small>${p.partner_code} · ${p.phone || p.email || 'no contact'}</small></span><span class="r">${p.credit_terms_days != null ? `${p.credit_terms_days}d terms` : ''}</span>`,
    onPick: (p) => { set(p); onPick && onPick(p); },
    footer: allowNew ? { label: `New ${type === 'CUSTOMER' ? 'customer' : 'supplier'}`, onClick: () => import('./pages/masters.js').then((m) => m.openPartnerModal({ type, onSaved: (p) => { set(p); onPick && onPick(p); } })) } : null,
  });
  input.addEventListener('input', () => { if (cur && input.value !== cur.partner_name) { cur = null; hint.textContent = ''; onPick && onPick(null); } });
  return { get: () => cur, set, input, lock(on, note) { input.readOnly = on; if (note) hint.textContent = note; } };
}

/* ---------- line-item grid ---------- */
/**
 * o: { side: 'SALES'|'PURCHASE', tax: 'code'|'rate'|'none', account: bool, stockOut: bool,
 *      taxCodes, accounts, priceLabel, taxSelect: false|'blank', onChange }
 */
export function lineGrid(host, o) {
  const dirRe = o.side === 'SALES' ? /^SAL/i : /^PUR/i;
  const taxOpts = (o.taxCodes || []).filter((t) => dirRe.test(String(t.direction)));
  const defCode = taxOpts.find((t) => t.is_default) || taxOpts[0] || null;
  const codeById = (id) => (o.taxCodes || []).find((t) => t.tax_code_id === id) || null;
  const acctType = o.side === 'SALES' ? 'REVENUE' : 'EXPENSE';
  const accts = (o.accounts || []).filter((a) => a.account_type === acctType);
  const defAcct = (o.side === 'SALES' ? accts.find((a) => a.account_code === '4000') : accts.find((a) => a.account_code === '6000')) || accts[0] || null;
  const hasTax = o.tax !== 'none';
  const cols = 'minmax(150px,1.3fr) minmax(140px,1.3fr) 76px 108px 108px 32px';
  let locked = false;

  host.innerHTML = `<div class="lines"><div class="ln-grid" style="--cols:${cols}"><div class="ln-head" role="row"><div>Item</div><div>Description</div><div class="r">Qty</div><div class="r">${esc(o.priceLabel || 'Unit price')}</div><div class="r">Amount</div><div></div></div><div data-body></div></div></div>
    <div class="ln-foot"><button type="button" class="btn sm" data-add>${ico('plus')}Add line</button><span class="muted" style="font-size:12px" data-tip>Type an item code, name or scan a barcode. Leave the item empty for a service line.</span></div>`;
  const body = $('[data-body]', host);

  const rowHtml = (init) => `<div class="ln" data-row>
    <div class="cell"><input class="inp ln-item" placeholder="Item code, name or barcode" value="${esc(init.stock ? init.stock.item_code : '')}" aria-label="Item" ${locked ? 'readonly' : ''}><div class="meta"></div></div>
    <div class="cell"><input class="inp ln-desc" placeholder="Description" value="${esc(init.description || '')}" aria-label="Description" ${locked ? 'readonly' : ''}></div>
    <div class="cell"><input class="inp num ln-qty" type="number" min="0" step="any" value="${init.quantity ?? 1}" aria-label="Quantity" ${locked ? 'readonly' : ''}></div>
    <div class="cell"><input class="inp num ln-price" type="number" min="0" step="0.01" value="${init.unitPrice ?? ''}" placeholder="0.00" aria-label="Unit price" ${locked ? 'readonly' : ''}></div>
    <div class="amt">${rm(0)}</div>
    <div class="cell">${locked ? '' : `<button type="button" class="icon-btn sm" data-rm aria-label="Remove line">${ico('x')}</button>`}</div>
    <div class="sub" hidden></div></div>`;

  const isStockLine = (row) => !!row._s.stock;
  function resolveTax(row) {
    if (!hasTax) return null;
    const s = row._s;
    if (isStockLine(row) && !o.taxSelect) {
      const id = s.taxCodeId || (o.side === 'SALES' ? s.stock.default_sales_tax_code_id : s.stock.default_purchase_tax_code_id);
      return codeById(id) || defCode;
    }
    const sel = $('.ln-tax', row); const id = sel ? sel.value : s.taxCodeId;
    return id ? codeById(id) : (o.taxSelect === 'blank' ? null : defCode);
  }
  function refreshRow(row) {
    const s = row._s; let parts = '';
    if (hasTax) {
      if (isStockLine(row) && !o.taxSelect) {
        const c = resolveTax(row);
        parts += `<span class="taxchip" title="Taken from the item master">Tax ${esc(c ? `${c.code} · ${num(c.rate)}%` : 'none')}</span>`;
      } else {
        const cur = s.taxCodeId || (o.taxSelect === 'blank' ? '' : defCode ? defCode.tax_code_id : '');
        parts += `<span>Tax</span><select class="inp sm ln-tax" aria-label="Tax code" ${locked && !o.taxSelect ? 'disabled' : ''}>${o.taxSelect === 'blank' ? '<option value="">No tax</option>' : ''}${taxOpts.map((t) => `<option value="${t.tax_code_id}" ${t.tax_code_id === cur ? 'selected' : ''}>${esc(t.code)} · ${num(t.rate)}%</option>`).join('')}</select>`;
      }
    }
    if (o.account && !isStockLine(row)) {
      const cur = s.accountId || (defAcct ? defAcct.account_id : '');
      parts += `<span>${o.side === 'SALES' ? 'Revenue account' : 'Expense account'}</span><select class="inp sm ln-acct" aria-label="Account" ${locked ? 'disabled' : ''}>${accts.map((a) => `<option value="${a.account_id}" ${a.account_id === cur ? 'selected' : ''}>${esc(a.account_code)} · ${esc(a.account_name)}</option>`).join('')}</select>`;
    }
    const sub = $('.sub', row); sub.hidden = !parts; sub.innerHTML = parts;
    calcRow(row);
  }
  function calcRow(row) {
    const q = num($('.ln-qty', row).value), p = num($('.ln-price', row).value), amount = round2(q * p);
    const code = resolveTax(row), rate = code ? num(code.rate) : 0, taxAmt = round2((amount * rate) / 100);
    $('.amt', row).textContent = rm(amount);
    const meta = $('.meta', row), st = row._s.stock;
    if (st && st.current_qty != null) {
      const on = num(st.current_qty);
      if (o.stockOut && q > on + 1e-9) { meta.className = 'meta bad'; meta.textContent = `Only ${qty(on)} ${st.unit || ''} on hand`; }
      else if (o.side === 'SALES' && !st.default_revenue_account_id) { meta.className = 'meta warn'; meta.textContent = 'No default revenue account on this item'; }
      else { meta.className = 'meta'; meta.textContent = `${qty(on)} ${st.unit || ''} on hand`; }
    } else if (!st) { meta.className = 'meta'; meta.textContent = ''; }
    return { amount, taxAmt, code, rate };
  }
  const isEmpty = (row) => !row._s.stock && !$('.ln-desc', row).value.trim() && !num($('.ln-price', row).value);
  const changed = () => o.onChange && o.onChange(api2.calc());

  function pickItem(row, it) {
    const s = row._s; s.stock = it; s.taxCodeId = null;
    $('.ln-item', row).value = it.item_code;
    $('.ln-desc', row).value = it.item_name;
    const price = o.side === 'SALES' ? it.ref_price : it.ref_cost;
    $('.ln-price', row).value = num(price) ? num(price).toFixed(2) : '';
    refreshRow(row); changed();
    $('.ln-qty', row).focus(); $('.ln-qty', row).select();
  }
  function wire(row) {
    const inp = $('.ln-item', row);
    if (locked) return;
    combo(inp, {
      search: async (q, signal) => { const r = await api.get(`/stock-items/search${qs({ q, limit: 12 })}`, { signal }); return r.filter((i) => i.is_active !== false); },
      render: (it) => html`<span class="t"><b>${it.item_code} · ${it.item_name}</b><small>${qty(it.current_qty)} ${it.unit || ''} on hand${it.barcode ? ` · ${it.barcode}` : ''}</small></span><span class="r">${rm(o.side === 'SALES' ? it.ref_price : it.ref_cost)}</span>`,
      onPick: (it) => pickItem(row, it),
    });
    inp.addEventListener('input', () => { if (row._s.stock && inp.value !== row._s.stock.item_code) { row._s.stock = null; row._s.taxCodeId = null; refreshRow(row); changed(); } });
    inp.addEventListener('blur', () => { if (!row._s.stock) setTimeout(() => { if (!row._s.stock && document.activeElement !== inp) inp.value = ''; }, 200); });
  }
  function add(init = {}, focus = false) {
    const wrap = document.createElement('div'); wrap.innerHTML = rowHtml(init); const row = wrap.firstElementChild;
    row._s = { stock: init.stock || null, taxCodeId: init.taxCodeId || null, accountId: init.accountId || null, init };
    body.appendChild(row); wire(row); refreshRow(row);
    if (init.stock && init.stock.current_qty == null) $('.meta', row).textContent = '';
    if (focus) $('.ln-item', row).focus();
    return row;
  }

  host.addEventListener('input', (e) => { const row = e.target.closest('[data-row]'); if (!row) return; if (e.target.matches('.ln-qty,.ln-price,.ln-desc')) { calcRow(row); changed(); } });
  host.addEventListener('change', (e) => {
    const row = e.target.closest('[data-row]'); if (!row) return;
    if (e.target.matches('.ln-tax')) { row._s.taxCodeId = e.target.value || null; calcRow(row); changed(); }
    if (e.target.matches('.ln-acct')) row._s.accountId = e.target.value;
  });
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) { add({}, true); return; }
    const rm2 = e.target.closest('[data-rm]');
    if (rm2) { const row = rm2.closest('[data-row]'); if (body.children.length > 1) row.remove(); else { body.innerHTML = ''; add({}); } changed(); }
  });
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.ln-price') && !locked) { const row = e.target.closest('[data-row]'); if (row === body.lastElementChild) { e.preventDefault(); add({}, true); } }
  });

  const api2 = {
    add, rows: () => $$('[data-row]', body),
    clear() { body.innerHTML = ''; },
    lock(on) { locked = on; $('[data-add]', host).hidden = on; $('[data-tip]', host).hidden = on; },
    calc() {
      let subtotal = 0, tax = 0, n = 0; const groups = new Map();
      for (const row of api2.rows()) {
        if (isEmpty(row)) continue; n++;
        const c = calcRow(row); subtotal += c.amount; tax += c.taxAmt;
        if (c.code && c.taxAmt) { const g = groups.get(c.code.code) || { label: `${c.code.code} (${num(c.rate)}%)`, amount: 0 }; g.amount += c.taxAmt; groups.set(c.code.code, g); }
      }
      return { subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax), groups: [...groups.values()], count: n };
    },
    /** normalised lines + validation errors */
    collect() {
      const lines = [], errors = [];
      api2.rows().forEach((row, i) => {
        if (isEmpty(row)) return;
        const s = row._s, code = resolveTax(row), q = num($('.ln-qty', row).value), p = num($('.ln-price', row).value), desc = $('.ln-desc', row).value.trim();
        const n = i + 1;
        if (!desc) errors.push(`Line ${n}: add a description`);
        if (!(q > 0)) errors.push(`Line ${n}: quantity must be greater than zero`);
        if (o.tax !== 'none' || o.priceRequired) { if ($('.ln-price', row).value === '') errors.push(`Line ${n}: enter a price`); }
        if (o.stockOut && s.stock && s.stock.current_qty != null && q > num(s.stock.current_qty) + 1e-9) errors.push(`Line ${n}: only ${qty(s.stock.current_qty)} ${s.stock.unit || ''} of ${s.stock.item_code} on hand`);
        lines.push({ stock: s.stock, stockItemId: s.stock ? s.stock.stock_item_id : null, itemCode: s.stock ? s.stock.item_code : null, description: desc, quantity: q, unitPrice: p,
          taxCodeId: code ? code.tax_code_id : null, taxRate: code ? num(code.rate) : 0, accountId: !s.stock && o.account ? ($('.ln-acct', row) ? $('.ln-acct', row).value : null) : null, init: s.init || {}, isStock: !!s.stock });
      });
      if (!lines.length) errors.unshift('Add at least one line');
      return { lines, errors };
    },
  };
  return api2;
}
