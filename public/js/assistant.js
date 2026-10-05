/* ==========================================================================
   assistant.js — a rule-based assistant. It understands a set of common
   business questions, answers from live ledger data, and falls back to a
   document search. It does not use a language model and sends nothing
   outside your server.
   ========================================================================== */
import { $, html, raw, esc, str, api, cached, user, num, fmt, rm, today, yearStart, monthStart, fmtDate, title, sum, openDrawer, dayDiff } from './core.js';
import { ico } from './icons.js';
import { loadAlerts } from './shell.js';
import { DOC_ROUTES, DOC_LABEL } from './nav.js';

const SUGGEST = ['What is overdue?', 'How is my cash position?', 'Who are my top customers?', 'Which items are low on stock?', 'How did we do this month?', 'What bills are due soon?'];
const link = (h, t) => `<a href="${h}" data-close>${esc(t)}</a>`;

const INTENTS = [
  [/overdue|late|owe(s)? me|unpaid invoice|collect/i, async () => {
    const [al, ar] = await Promise.all([loadAlerts(), api.get('/reports/ar-aging')]); const r = al.sales.receivables;
    if (!r.overdueCount) return `Nothing is overdue. ${rm(r.outstanding)} is outstanding across ${r.openCount} invoice${r.openCount === 1 ? '' : 's'}, all within terms.`;
    const worst = ar.filter((x) => dayDiff(today(), x.due_date) > 0).sort((a, b) => num(b.outstanding) - num(a.outstanding)).slice(0, 4);
    return `<b>${rm(r.overdue)}</b> is overdue across ${r.overdueCount} invoice${r.overdueCount === 1 ? '' : 's'}. The largest:<ul>${worst.map((x) => `<li>${esc(x.partner_name)} — ${rm(x.outstanding)} (${dayDiff(today(), x.due_date)} days late, ${esc(x.invoice_no)})</li>`).join('')}</ul>${link('#/reports/ar-aging', 'Open the ageing report →')}`;
  }],
  [/cash|bank|runway|liquid/i, async () => {
    const o = await api.get('/insights/overview?months=8'); const m = o.months.filter((x) => x.isComplete).slice(-3); const out = m.length ? sum(m, (x) => x.cashOut) / m.length : 0, inn = m.length ? sum(m, (x) => x.cashIn) / m.length : 0;
    return `Cash and bank accounts hold <b>${rm(o.balances.cash)}</b>. Over the last 3 months you averaged ${rm(inn, 0)} in and ${rm(out, 0)} out per month${out > 0 ? `, which covers about <b>${Math.max(0, o.balances.cash / out).toFixed(1)} months</b> of outflow` : ''}.`;
  }],
  [/top customer|best customer|biggest customer|customers?( this| ytd)?$/i, async () => {
    const b = await api.get(`/insights/breakdown?from=${yearStart()}&to=${today()}`);
    return b.topCustomers.length ? `Top customers this year (excluding tax):<ul>${b.topCustomers.map((c) => `<li>${esc(c.name)} — ${rm(c.amount, 0)} (${c.docs} documents)</li>`).join('')}</ul>${link('#/customers', 'Open customers →')}` : 'There are no sales recorded yet this year.';
  }],
  [/top supplier|biggest supplier|suppliers?$/i, async () => {
    const b = await api.get(`/insights/breakdown?from=${yearStart()}&to=${today()}`);
    return b.topSuppliers.length ? `Where you spent the most this year:<ul>${b.topSuppliers.map((c) => `<li>${esc(c.name)} — ${rm(c.amount, 0)}</li>`).join('')}</ul>` : 'No purchases recorded yet this year.';
  }],
  [/low stock|out of stock|reorder|restock|inventory/i, async () => {
    const v = await api.get('/insights/inventory'); const s = v.summary;
    if (!v.lowStock.length) return `Stock looks healthy: ${s.items} active items worth ${rm(s.valuation, 0)} and none at or below their minimum.`;
    return `${s.outOfStock} out of stock and ${s.lowStock} below minimum:<ul>${v.lowStock.slice(0, 6).map((i) => `<li>${esc(i.code)} — ${esc(i.name)}: ${num(i.qty)} on hand${i.minQty ? ` (min ${num(i.minQty)})` : ''}</li>`).join('')}</ul>${link('#/purchases/requests/new', 'Raise a purchase request →')}`;
  }],
  [/month|profit|revenue|sales|income|expense|how (did|are) we/i, async () => {
    const o = await api.get('/insights/period-summary?period=month'); const c = o.current, p = o.previous;
    const d = (pct) => (pct == null ? 'no comparable prior period' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs same days last month`);
    return `So far this month: revenue <b>${rm(c.revenue, 0)}</b> (${d(o.comparison.revenue)}), expenses <b>${rm(c.expense, 0)}</b>, giving a net ${c.profit >= 0 ? 'profit' : 'loss'} of <b>${rm(Math.abs(c.profit), 0)}</b>.`;
  }],
  [/bill|payable|supplier.*(due|owe)|due soon|pay(ing)? (my )?supplier/i, async () => {
    const p = (await loadAlerts()).purchases.payables;
    return `You owe suppliers <b>${rm(p.outstanding)}</b> across ${p.openCount} bill${p.openCount === 1 ? '' : 's'}. ${p.overdueCount ? `${rm(p.overdue)} is overdue. ` : ''}${p.dueSoonCount ? `${rm(p.dueSoon)} falls due within 7 days.` : 'Nothing falls due in the next 7 days.'} ${link('#/purchases/payments/new', 'Pay suppliers →')}`;
  }],
  [/create|new|make|add|record/i, async (q) => {
    const map = [[/quot/, 'sales/quotations', 'a quotation'], [/sales? order|\bso\b/, 'sales/orders', 'a sales order'], [/deliver/, 'sales/deliveries', 'a delivery order'], [/invoice/, 'sales/invoices', 'an invoice'], [/cash sale/, 'sales/cash-sales', 'a cash sale'], [/receipt|payment from|received/, 'sales/receipts', 'a customer receipt'], [/credit/, 'sales/credit-notes', 'a credit note'], [/debit/, 'sales/debit-notes', 'a debit note'], [/request/, 'purchases/requests', 'a purchase request'], [/purchase order|\bpo\b/, 'purchases/orders', 'a purchase order'], [/grn|goods|receive/, 'purchases/grn', 'a goods received note'], [/bill|supplier invoice/, 'purchases/invoices', 'a supplier invoice'], [/pay/, 'purchases/payments', 'a supplier payment'], [/voucher|expense/, 'accounting/payment-vouchers', 'a payment voucher']];
    const hit = map.find(([re]) => re.test(q)); return hit ? `Sure — ${link(`#/${hit[1]}/new`, `open the form to create ${hit[2]}`)}.` : null;
  }],
];

export function openAssistant() {
  const d = openDrawer({ title: 'Assistant', subtitle: 'Answers come from your live ledger', size: 'narrow',
    body: html`<div class="stack" style="gap:12px" data-log><div class="msg bot">Hi ${esc(user())} — ask me about cash, overdue invoices, customers, stock or this month's results. I'm rule-based, so I stick to what your data can answer.</div><div class="chips" data-sug>${SUGGEST.map((s) => html`<button class="chip" data-s="${s}">${s}</button>`)}</div></div>`,
    footer: html`<form data-f style="display:flex;gap:8px;width:100%"><input class="inp" data-q placeholder="Ask about your business…" aria-label="Ask a question" autocomplete="off"><button class="btn primary" type="submit" aria-label="Send">${raw(ico('send'))}</button></form>` });
  const log = $('[data-log]', d.el), input = $('[data-q]', d.el);
  const say = (cls, h) => { const m = document.createElement('div'); m.className = `msg ${cls}`; m.innerHTML = h; log.appendChild(m); d.body.scrollTop = d.body.scrollHeight; return m; };
  async function ask(q) {
    if (!q.trim()) return; $('[data-sug]', log)?.remove(); say('me', esc(q)); input.value = '';
    const w = say('bot', '<span class="muted">Checking your ledger…</span>');
    try {
      let ans = null;
      for (const [re, fn] of INTENTS) { if (re.test(q)) { ans = await fn(q); if (ans) break; } }
      if (!ans) {
        const r = await api.get(`/reports/document-history?q=${encodeURIComponent(q)}&pageSize=10`); const docs = (r.documents || []).slice(0, 5);
        ans = docs.length ? `I found these documents matching “${esc(q)}”:<ul>${docs.map((x) => `<li>${link(`#/${DOC_ROUTES[x.doc_type] || 'reports'}?view=${x.doc_id}`, `${DOC_LABEL[x.doc_type] || title(x.doc_type)} ${x.doc_no}`)} — ${esc(x.partner_name || '')} · ${rm(x.total_amount)}</li>`).join('')}</ul>` : `I couldn't match that to a question or document. Try asking about <i>overdue invoices</i>, <i>cash</i>, <i>top customers</i>, <i>low stock</i> or <i>this month's profit</i>.`;
      }
      w.innerHTML = ans;
    } catch (e) { w.innerHTML = `Sorry, I couldn't get that: ${esc(e.message)}`; }
    d.body.scrollTop = d.body.scrollHeight;
  }
  d.el.addEventListener('click', (e) => { const s = e.target.closest('[data-s]'); if (s) ask(s.dataset.s); });
  $('[data-f]', d.el).addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
}
