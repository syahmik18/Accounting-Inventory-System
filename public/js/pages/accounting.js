/* ==========================================================================
   pages/accounting.js — Accounting workspace: headline position + tabbed
   Trial balance / Profit & loss / Balance sheet / General ledger / Journals.
   ========================================================================== */
import { $, html, raw, esc, str, api, ref, cached, on, num, fmt, rm, today, yearStart, fmtDate, title, sum, downloadCSV, errorNote, setHTML, empty, skeleton, navigate, qs } from '../core.js';
import { ico } from '../icons.js';

const TABS = [['tb', 'Trial balance'], ['pl', 'Profit & loss'], ['pli', 'P&L by item'], ['bs', 'Balance sheet'], ['ledger', 'General ledger'], ['journals', 'Journals']];
const SRC_LABEL = { SALES_INVOICE: 'Sales invoices', PURCHASE_INVOICE: 'Supplier invoices', RECEIPT: 'Receipts', PAYMENT: 'Payments', CASH_SALE: 'Cash sales', CASH_PURCHASE: 'Cash purchases', GRN: 'Goods received', DELIVERY_ORDER: 'Deliveries', CREDIT_NOTE: 'Credit notes', DEBIT_NOTE: 'Debit notes', PAYMENT_VOUCHER: 'Payment vouchers', OFFICIAL_RECEIPT: 'Official receipts', OPENING: 'Opening balances', MANUAL: 'Manual journals', REVERSAL: 'Reversals' };
const COSTING_LABEL = { FIXED: 'Fixed cost', AVERAGE: 'Average cost', FIFO: 'FIFO' };

export default async function render(ctx) {
  const { root, query } = ctx; let tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'tb';
  root.innerHTML = str(html`
    <div class="page-head"><div><h1>Accounting</h1><div class="sub">The ledger at a glance — statements, balances and journal activity.</div></div>
      <div class="actions"><a class="btn" href="#/accounting/accounts">${raw(ico('list'))}Chart of accounts</a><a class="btn" href="#/accounting/official-receipts/new">${raw(ico('wallet'))}Official receipt</a><a class="btn primary" href="#/accounting/payment-vouchers/new">${raw(ico('plus'))}Payment voucher</a></div></div>
    <div class="grid g4" data-head>${[1, 2, 3, 4].map(() => html`<div class="card pad"><div class="sk" style="height:64px"></div></div>`)}</div>
    <div class="row wrap"><div class="seg" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`)}</div></div>
    <div class="card"><div data-body style="padding:20px">${skeleton(6)}</div></div>`);

  cached('acc:bs', () => api.get('/reports/balance-sheet'), 15000).then((b) => {
    const t = (k, v, s, cls = '') => html`<div class="card pad"><div class="metric" style="border:0;background:none;padding:0"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div></div>`;
    setHTML($('[data-head]', root), html`${t('Total assets', rm(b.totalAssets, 0), 'as of today')}${t('Total liabilities', rm(b.totalLiabilities, 0), 'what you owe')}${t('Equity incl. earnings', rm(b.totalEquity, 0), `earnings ${rm(b.currentEarnings, 0)}`)}${t('Books', b.isBalanced ? 'Balanced' : 'Out of balance', 'Assets = liabilities + equity', b.isBalanced ? '' : 'neg')}`);
  }).catch((e) => setHTML($('[data-head]', root), errorNote(e)));

  const T = {
    async tb(body) {
      body.innerHTML = str(html`<div class="row wrap" style="margin-bottom:14px"><label class="lbl">As of</label><input class="inp" type="date" style="width:160px" data-d value="${today()}"><span class="spacer"></span><button class="btn sm" data-csv>${raw(ico('download'))}Export CSV</button></div><div data-o>${skeleton(6)}</div>`);
      const run = async () => {
        const d = $('[data-d]', body).value; const r = await api.get(`/reports/trial-balance${qs({ asOf: d })}`);
        const rows = r.accounts.map((a) => { const net = num(a.total_debit) - num(a.total_credit); return { ...a, dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 }; }).filter((a) => a.dr || a.cr);
        const dr = sum(rows, (a) => a.dr), cr = sum(rows, (a) => a.cr); body._rows = rows;
        setHTML($('[data-o]', body), html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${rows.map((a) => html`<tr><td class="mono main">${a.account_code}</td><td>${a.account_name}</td><td class="muted">${title(a.account_type)}</td><td class="num">${a.dr ? fmt(a.dr) : ''}</td><td class="num">${a.cr ? fmt(a.cr) : ''}</td></tr>`)}</tbody><tfoot><tr><td colspan="3">Total ${Math.abs(dr - cr) < 0.005 ? html`<span class="badge tone-ok" style="margin-left:8px">Balanced</span>` : html`<span class="badge tone-bad" style="margin-left:8px">Out by ${fmt(Math.abs(dr - cr))}</span>`}</td><td class="num">${fmt(dr)}</td><td class="num">${fmt(cr)}</td></tr></tfoot></table></div>`);
      };
      $('[data-d]', body).addEventListener('change', () => run().catch((e) => setHTML($('[data-o]', body), errorNote(e))));
      $('[data-csv]', body).addEventListener('click', () => body._rows && downloadCSV(`trial-balance-${$('[data-d]', body).value}.csv`, [['Code', 'Account', 'Type', 'Debit', 'Credit'], ...body._rows.map((a) => [a.account_code, a.account_name, a.account_type, a.dr || '', a.cr || ''])]));
      await run();
    },
    async pl(body) {
      body.innerHTML = str(html`<div class="row wrap" style="margin-bottom:14px"><label class="lbl">From</label><input class="inp" type="date" style="width:160px" data-f value="${yearStart()}"><label class="lbl">to</label><input class="inp" type="date" style="width:160px" data-t value="${today()}"></div><div data-o>${skeleton(6)}</div>`);
      const sec = (label, rows, total, neg = false) => html`<tr><td colspan="2" class="main" style="padding-top:18px">${label}</td></tr>${rows.length ? rows.map((r) => html`<tr><td style="padding-left:30px"><span class="mono muted">${r.code}</span> &nbsp;${r.name}</td><td class="num">${fmt(r.amount)}</td></tr>`) : html`<tr><td class="muted" style="padding-left:30px">None</td><td></td></tr>`}<tr><td class="main" style="text-align:right">Total ${label.toLowerCase()}</td><td class="num main">${neg ? '(' : ''}${fmt(total)}${neg ? ')' : ''}</td></tr>`;
      const run = async () => {
        const r = await api.get(`/reports/profit-loss${qs({ from: $('[data-f]', body).value, to: $('[data-t]', body).value })}`);
        setHTML($('[data-o]', body), html`<div class="tbl-wrap"><table class="tbl compact" style="max-width:760px"><tbody>${sec('Revenue', r.revenue, r.totalRevenue)}${sec('Cost of sales', r.cogs, r.totalCogs, true)}<tr style="background:var(--hover)"><td class="main">Gross profit</td><td class="num main">${fmt(r.grossProfit)}</td></tr>${sec('Operating expenses', r.expenses, r.totalExpenses, true)}<tr style="background:var(--sel)"><td class="main" style="font-size:16px">Net profit</td><td class="num main ${r.netProfit < 0 ? 'neg' : 'pos'}" style="font-size:16px">${fmt(r.netProfit)}</td></tr></tbody></table></div>`);
      };
      body.addEventListener('change', (e) => e.target.matches('input') && run().catch((x) => setHTML($('[data-o]', body), errorNote(x))));
      await run();
    },
    async pli(body) {
      body.innerHTML = str(html`<div class="row wrap" style="margin-bottom:14px"><label class="lbl">From</label><input class="inp" type="date" style="width:160px" data-f value="${yearStart()}"><label class="lbl">to</label><input class="inp" type="date" style="width:160px" data-t value="${today()}"><span class="spacer"></span><button class="btn sm" data-csv>${raw(ico('download'))}Export CSV</button></div><div data-o>${skeleton(6)}</div>`);
      const run = async () => {
        const r = await api.get(`/reports/pnl-by-item${qs({ from: $('[data-f]', body).value, to: $('[data-t]', body).value })}`);
        body._rows = r.items;
        setHTML($('[data-o]', body), r.items.length ? html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Item</th><th>Costing</th><th class="num">Qty sold</th><th class="num">Revenue</th><th class="num">COGS</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
          <tbody>${r.items.map((it) => html`<tr><td><div class="main">${it.code}</div><div class="sub">${it.name}</div></td><td class="muted">${COSTING_LABEL[it.costingMethod] || '—'}</td><td class="num">${it.qtySold}</td><td class="num">${fmt(it.revenue)}</td><td class="num">${fmt(it.cogs)}</td><td class="num ${it.profit < 0 ? 'neg' : 'pos'}"><b>${fmt(it.profit)}</b></td><td class="num">${it.margin == null ? '—' : `${it.margin.toFixed(1)}%`}</td></tr>`)}</tbody>
          <tfoot><tr><td colspan="3">Total</td><td class="num">${fmt(r.totals.revenue)}</td><td class="num">${fmt(r.totals.cogs)}</td><td class="num ${r.totals.profit < 0 ? 'neg' : 'pos'}">${fmt(r.totals.profit)}</td><td></td></tr></tfoot></table></div>
          <div class="note" style="margin-top:14px">${raw(ico('info'))}<div>Cost of goods sold here is the same figure already posted to the ledger for each sale, so the total above reconciles with the Cost of sales total on the Profit &amp; loss tab. For an item sold via a delivery order, its cost can land in an earlier period than the invoice that recognises the revenue — the same timing the general ledger already uses.</div></div>`
          : empty('reports', 'No item sales in this period', 'Try a different date range.'));
      };
      body.addEventListener('change', (e) => e.target.matches('input') && run().catch((x) => setHTML($('[data-o]', body), errorNote(x))));
      $('[data-csv]', body).addEventListener('click', () => body._rows && downloadCSV(`pnl-by-item-${$('[data-f]', body).value}_${$('[data-t]', body).value}.csv`, [['Code', 'Name', 'Costing method', 'Qty sold', 'Revenue', 'COGS', 'Profit', 'Margin %'], ...body._rows.map((it) => [it.code, it.name, COSTING_LABEL[it.costingMethod] || '', it.qtySold, it.revenue, it.cogs, it.profit, it.margin ?? ''])]));
      await run();
    },
    async bs(body) {
      body.innerHTML = str(html`<div class="row wrap" style="margin-bottom:14px"><label class="lbl">As of</label><input class="inp" type="date" style="width:160px" data-d value="${today()}"></div><div data-o>${skeleton(6)}</div>`);
      const col = (label, rows, tot, extra = '') => html`<div><h3 style="margin-bottom:8px">${label}</h3><table class="tbl compact"><tbody>${rows.map((r) => html`<tr><td><span class="mono muted">${r.code}</span> &nbsp;${r.name}</td><td class="num">${fmt(r.amount)}</td></tr>`)}${raw(extra)}</tbody><tfoot><tr><td>Total ${label.toLowerCase()}</td><td class="num">${fmt(tot)}</td></tr></tfoot></table></div>`;
      const run = async () => {
        const r = await api.get(`/reports/balance-sheet${qs({ asOf: $('[data-d]', body).value })}`);
        setHTML($('[data-o]', body), html`<div class="grid g2" style="align-items:start">${col('Assets', r.assets, r.totalAssets)}<div class="stack">${col('Liabilities', r.liabilities, r.totalLiabilities)}${col('Equity', r.equity, r.totalEquity, str(html`<tr><td>Current period earnings</td><td class="num">${fmt(r.currentEarnings)}</td></tr>`))}</div></div><div class="note ${r.isBalanced ? 'ok' : 'bad'}" style="margin-top:16px">${raw(ico(r.isBalanced ? 'checkCircle' : 'alert'))}<div>${r.isBalanced ? 'The balance sheet balances: assets equal liabilities plus equity.' : 'The balance sheet is out of balance — run the ledger integrity check.'}</div></div>`);
      };
      $('[data-d]', body).addEventListener('change', () => run().catch((x) => setHTML($('[data-o]', body), errorNote(x))));
      await run();
    },
    async ledger(body) {
      const accts = await ref.accounts();
      body.innerHTML = str(html`<div class="row wrap" style="margin-bottom:14px"><select class="inp" style="width:min(340px,100%)" data-a aria-label="Account">${accts.map((a) => html`<option value="${a.account_id}" ${a.account_id === query.account ? raw('selected') : ''}>${a.account_code} · ${a.account_name}</option>`)}</select><input class="inp" type="date" style="width:150px" data-f value="${yearStart()}" aria-label="From"><input class="inp" type="date" style="width:150px" data-t value="${today()}" aria-label="To"><span class="spacer"></span><button class="btn sm" data-csv>${raw(ico('download'))}Export CSV</button></div><div data-o>${skeleton(6)}</div>`);
      const run = async () => {
        const r = await api.get(`/reports/general-ledger${qs({ accountId: $('[data-a]', body).value, from: $('[data-f]', body).value, to: $('[data-t]', body).value })}`); body._r = r;
        setHTML($('[data-o]', body), html`<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Date</th><th>Journal</th><th>Source</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody><tr><td colspan="6" class="muted">Opening balance</td><td class="num"><b>${fmt(r.openingBalance)}</b></td></tr>${r.lines.map((l) => html`<tr><td>${fmtDate(l.date)}</td><td class="mono main">${l.journalNo}</td><td class="muted">${title(l.source)}</td><td>${l.description || '—'}</td><td class="num">${l.debit ? fmt(l.debit) : ''}</td><td class="num">${l.credit ? fmt(l.credit) : ''}</td><td class="num">${fmt(l.balance)}</td></tr>`)}</tbody><tfoot><tr><td colspan="4">Closing balance</td><td class="num">${fmt(r.totalDebit)}</td><td class="num">${fmt(r.totalCredit)}</td><td class="num">${fmt(r.closingBalance)}</td></tr></tfoot></table></div>${r.lines.length >= 1000 ? html`<div class="note warn" style="margin-top:12px">${raw(ico('info'))}<div>Showing the first 1,000 lines. Narrow the date range for the rest.</div></div>` : ''}`);
      };
      body.addEventListener('change', (e) => e.target.matches('select,input') && run().catch((x) => setHTML($('[data-o]', body), errorNote(x))));
      $('[data-csv]', body).addEventListener('click', () => { const r = body._r; r && downloadCSV(`ledger-${r.account.code}.csv`, [['Date', 'Journal', 'Source', 'Description', 'Debit', 'Credit', 'Balance'], ...r.lines.map((l) => [l.date, l.journalNo, l.source, l.description, l.debit || '', l.credit || '', l.balance])]); });
      await run();
    },
    async journals(body) {
      const r = await api.get(`/reports/journals${qs({ limit: 25, from: yearStart(), to: today() })}`);
      setHTML(body, html`<div class="metrics" style="margin-bottom:18px">${r.bySource.map((s) => html`<div class="metric"><div class="k">${SRC_LABEL[s.source] || title(s.source)}</div><div class="v">${s.entries}</div><div class="s">${rm(s.amount, 0)} posted</div></div>`)}</div>
        <div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Journal</th><th>Date</th><th>Source</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${r.journals.map((j) => html`<tr><td class="mono main">${j.no}${j.isReversal ? html` <span class="badge tone-bad" style="margin-left:6px">Reversal</span>` : ''}</td><td>${fmtDate(j.date)}</td><td class="muted">${SRC_LABEL[j.source] || title(j.source)}</td><td>${j.description || '—'}</td><td class="num">${fmt(j.amount)}</td></tr>`)}</tbody></table></div><div class="muted" style="margin-top:10px;font-size:13px">Latest 25 entries this year. Use the general ledger tab to drill into an account.</div>`);
    },
  };
  const open = async (k) => {
    tab = k; root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    const pane = document.createElement('div'); pane.innerHTML = str(skeleton(6)); $('[data-body]', root).replaceChildren(pane);
    try { await T[k](pane); } catch (e) { setHTML(pane, errorNote(e)); }
  };
  root.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) { history.replaceState(null, '', `#/accounting?tab=${t.dataset.tab}`); open(t.dataset.tab); } });
  const off = on('changed', () => { cached('acc:bs', () => Promise.resolve(null), 0); });
  ctx.onCleanup(off);
  await open(tab);
}
