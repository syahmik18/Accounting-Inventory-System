/* ==========================================================================
   pages/reports.js — document register, receivable / payable ageing and the
   ledger integrity check.
   ========================================================================== */
import { $, html, raw, esc, str, api, cached, num, fmt, rm, today, fmtDate, title, badge, sum, downloadCSV, debounce, errorNote, setHTML, empty, skeleton, navigate, qs, dayDiff } from '../core.js';
import { ico } from '../icons.js';
import { DOC_ROUTES, DOC_LABEL, DOC_ICON } from '../nav.js';

const TABS = [['register', 'Document register', ''], ['ar-aging', 'Receivable ageing', 'ar-aging'], ['ap-aging', 'Payable ageing', 'ap-aging'], ['integrity', 'Ledger integrity', 'integrity']];
export default async function render(ctx) {
  const which = ctx.segs[1] || 'register';
  const F = { register, 'ar-aging': (c) => aging(c, true), 'ap-aging': (c) => aging(c, false), integrity }[which];
  if (!F) return setHTML(ctx.root, empty('search', 'Unknown report', ''));
  ctx.root.innerHTML = str(html`<div class="page-head"><div><h1>Reports</h1><div class="sub">Registers, ageing and integrity checks.</div></div></div>
    <div class="chips">${TABS.map(([k, l, h]) => html`<a class="chip ${k === which ? 'on' : ''}" href="#/reports${h ? `/${h}` : ''}" style="text-decoration:none">${l}</a>`)}</div><div data-pane class="stack"></div>`);
  return F({ ...ctx, pane: $('[data-pane]', ctx.root) });
}

async function register({ pane, query }) {
  const S = { q: '', cat: '', type: '', from: '', to: '', page: 1 }; const SIZE = 25;
  const SALES = ['QUOTATION', 'SALES_ORDER', 'DELIVERY_ORDER', 'SALES_INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'RECEIPT'], PURCH = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GRN', 'PURCHASE_INVOICE', 'CASH_PURCHASE', 'PAYMENT'];
  pane.innerHTML = str(html`<div class="card"><div class="toolbar"><div class="search">${raw(ico('search'))}<input class="inp" data-f="q" placeholder="Search number, party or items…" aria-label="Search"></div>
    <select class="inp" data-f="cat" style="width:150px" aria-label="Module"><option value="">All modules</option><option value="sales">Sales</option><option value="purchases">Purchases</option></select>
    <select class="inp" data-f="type" style="width:190px" aria-label="Document type"><option value="">All document types</option>${[...SALES, ...PURCH].map((t) => html`<option value="${t}">${DOC_LABEL[t]}</option>`)}</select>
    <span class="dates"><input class="inp" type="date" data-f="from" aria-label="From"><span class="muted">to</span><input class="inp" type="date" data-f="to" aria-label="To"></span><span class="spacer"></span><button class="btn sm" data-csv>${raw(ico('download'))}CSV</button></div><div data-tbl>${skeleton(8)}</div><div data-foot></div></div>`);
  let last = [];
  const load = async () => {
    try {
      const r = await api.get(`/reports/document-history${qs({ q: S.q, category: S.cat, type: S.type, from: S.from, to: S.to, page: S.page, pageSize: SIZE })}`);
      const docs = r.documents || []; last = docs; const total = r.totalCount ?? r.total ?? docs.length; const pages = Math.max(1, Math.ceil(total / SIZE));
      setHTML($('[data-tbl]', pane), docs.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Document</th><th>Date</th><th>Party</th><th>Details</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>${docs.map((d) => html`<tr class="click" data-go="#/${DOC_ROUTES[d.doc_type] || 'reports'}?view=${d.doc_id}"><td><div class="main">${d.doc_no}</div><div class="sub">${DOC_LABEL[d.doc_type] || title(d.doc_type)}</div></td><td>${fmtDate(d.doc_date)}</td><td>${d.partner_name || '—'}</td><td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.items_summary || ''}</td><td>${badge(d.status)}</td><td class="num">${fmt(d.total_amount)}</td></tr>`)}</tbody></table></div>` : empty('search', 'No documents match', 'Adjust the filters above.'));
      setHTML($('[data-foot]', pane), html`<div class="pager"><span>${total} document${total === 1 ? '' : 's'} · page ${S.page} of ${pages}</span><div class="btns"><button class="btn sm" data-pg="-1" ${S.page <= 1 ? raw('disabled') : ''}>Previous</button><button class="btn sm" data-pg="1" ${S.page >= pages ? raw('disabled') : ''}>Next</button></div></div>`);
    } catch (e) { setHTML($('[data-tbl]', pane), errorNote(e)); }
  };
  pane.addEventListener('input', debounce((e) => { const f = e.target.dataset.f; if (f === 'q' || f === 'from' || f === 'to') { S[f] = e.target.value; S.page = 1; load(); } }, 220));
  pane.addEventListener('change', (e) => { const f = e.target.dataset.f; if (f === 'cat' || f === 'type') { S[f] = e.target.value; S.page = 1; load(); } });
  pane.addEventListener('click', (e) => {
    const pg = e.target.closest('[data-pg]'); if (pg) { S.page += +pg.dataset.pg; load(); return; }
    if (e.target.closest('[data-csv]')) { downloadCSV(`documents-${today()}.csv`, [['Type', 'Number', 'Date', 'Party', 'Details', 'Status', 'Amount'], ...last.map((d) => [DOC_LABEL[d.doc_type] || d.doc_type, d.doc_no, String(d.doc_date).slice(0, 10), d.partner_name, d.items_summary, d.status, d.total_amount])]); return; }
    const r = e.target.closest('[data-go]'); if (r) navigate(r.dataset.go);
  });
  await load();
}

async function aging({ pane }, isAR) {
  pane.innerHTML = str(skeleton(6));
  let rows; try { rows = await api.get(`/reports/${isAR ? 'ar' : 'ap'}-aging`); } catch (e) { return setHTML(pane, errorNote(e)); }
  const ORDER = ['current', '0-30', '1-30', '31-60', '61-90', '60+', '90+']; const idx = (k) => { const i = ORDER.findIndex((b) => String(k).toLowerCase().includes(b)); return i < 0 ? 99 : i; };
  const g = {}; rows.forEach((r) => { (g[r.aging_bucket] = g[r.aging_bucket] || []).push(r); });
  const keys = Object.keys(g).sort((a, b) => idx(a) - idx(b)); const total = sum(rows, (r) => r.outstanding);
  const col = ['var(--green)', 'var(--cyan)', 'var(--amber)', 'var(--red)', 'var(--red)'];
  setHTML(pane, html`<div class="grid g4">${[html`<div class="card pad"><div class="metric" style="border:0;background:none;padding:0"><div class="k">Total ${isAR ? 'receivable' : 'payable'}</div><div class="v">${rm(total, 0)}</div><div class="s">${rows.length} open invoices</div></div></div>`, ...keys.slice(0, 3).map((k, i) => html`<div class="card pad"><div class="metric" style="border:0;background:none;padding:0"><div class="k"><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${col[i]};margin-right:7px"></span>${k}</div><div class="v">${rm(sum(g[k], (r) => r.outstanding), 0)}</div><div class="s">${g[k].length} invoices</div></div></div>`)]}</div>
    <div class="card"><div class="card-h"><div><div class="card-t">${isAR ? 'Customers who owe you' : 'Suppliers you owe'}</div><div class="card-s">Grouped by how long each invoice has been due.</div></div><button class="btn sm" data-csv>${raw(ico('download'))}CSV</button></div>${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>${isAR ? 'Customer' : 'Supplier'}</th><th>Invoice</th><th>Due</th><th>Ageing</th><th class="num">Outstanding</th></tr></thead><tbody>${keys.flatMap((k) => g[k].map((r) => html`<tr><td class="main">${r.partner_name}</td><td>${r.invoice_no}</td><td>${fmtDate(r.due_date)}</td><td><span class="badge tone-${idx(k) <= 1 ? 'ok' : idx(k) <= 3 ? 'warn' : 'bad'}">${k}</span></td><td class="num"><b>${fmt(r.outstanding)}</b></td></tr>`))}</tbody><tfoot><tr><td colspan="4">Total</td><td class="num">${fmt(total)}</td></tr></tfoot></table></div>` : empty('checkCircle', 'Nothing outstanding', isAR ? 'All customer invoices are settled.' : 'All supplier invoices are settled.')}</div>`);
  $('[data-csv]', pane)?.addEventListener('click', () => downloadCSV(`${isAR ? 'ar' : 'ap'}-aging-${today()}.csv`, [['Partner', 'Invoice', 'Due', 'Ageing', 'Outstanding'], ...rows.map((r) => [r.partner_name, r.invoice_no, String(r.due_date).slice(0, 10), r.aging_bucket, r.outstanding])]));
}

async function integrity({ pane }) {
  const run = async () => {
    pane.innerHTML = str(skeleton(4));
    try {
      const r = await api.get('/reports/gl-integrity');
      setHTML(pane, html`<div class="card pad"><div class="row wrap"><div class="ico" style="width:52px;height:52px;border-radius:18px;display:grid;place-items:center;background:var(--${r.ok ? 'ok' : 'bad'}-bg);color:var(--${r.ok ? 'ok' : 'bad'})">${raw(ico(r.ok ? 'shield' : 'alert', 'width="26" height="26"'))}</div>
        <div style="flex:1"><h2>${r.ok ? 'The ledger is consistent' : `${r.issueCount} issue${r.issueCount === 1 ? '' : 's'} found`}</h2><div class="muted">Checked ${new Date(r.checkedAt).toLocaleString('en-MY')} · ${r.errorCount} errors · ${r.warningCount} warnings · ${r.infoCount} notes</div></div><button class="btn" data-run>${raw(ico('refresh'))}Run again</button></div>
        ${r.ok ? html`<p class="muted" style="margin-top:14px">Every posted journal balances, every active document links to a matching journal, and stock movements agree with the ledger.</p>` : html`<div class="tbl-wrap" style="margin-top:16px"><table class="tbl compact"><thead><tr><th>Severity</th><th>Check</th><th>Reference</th><th>Detail</th></tr></thead><tbody>${r.issues.map((i) => html`<tr><td><span class="badge tone-${i.severity === 'ERROR' ? 'bad' : i.severity === 'WARNING' ? 'warn' : 'info'}">${title(i.severity)}</span></td><td class="mono">${i.code}</td><td class="main">${i.reference}</td><td>${i.detail}</td></tr>`)}</tbody></table></div>`}</div>`);
      $('[data-run]', pane).addEventListener('click', run);
    } catch (e) { setHTML(pane, errorNote(e)); }
  };
  await run();
}
