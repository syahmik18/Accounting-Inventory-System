/* ==========================================================================
   pages/dashboard.js — executive dashboard. Each section loads and paints
   independently (progressive), refreshes every 60 s and after any change.
   ========================================================================== */
import { $, html, raw, esc, str, api, cached, invalidate, on, user, num, fmt, rm, compact, ago, today, monthStart, yearStart, addDays, monthLabel, pctChange, sum, title, menu, navigate, fmtDate, errorNote, setHTML, empty, dayDiff } from '../core.js';
import { ico } from '../icons.js';
import { plot, donut, hbar, spark, legend, disposeChart } from '../charts.js';
import { loadAlerts } from '../shell.js';
import { DOC_ROUTES, DOC_LABEL, DOC_ICON, DOC_TONE } from '../nav.js';

const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const BUCKET_ORDER = ['current', '0-30', '1-30', '31-60', '61-90', '60+', '90+'];
const bucketColor = ['var(--green)', 'var(--cyan)', 'var(--amber)', 'var(--red)', 'var(--red)'];

export default async function render(ctx) {
  const { root } = ctx;
  let period = 'month'; let alive = true; let updated = 0;
  root.innerHTML = str(html`
    <div class="page-head"><div><h1>${greet()}, ${user()}</h1><div class="sub">Here's how the business is doing — live from your ledger.</div></div>
      <div class="actions"><div class="seg" role="group" aria-label="Period"><button data-p="month" class="on">This month</button><button data-p="90">Last 90 days</button><button data-p="ytd">Year to date</button></div>
      <button class="btn primary" data-new>${raw(ico('plus'))}New${raw(ico('chevD'))}</button></div></div>

    <div class="grid g4" data-kpis>${[1, 2, 3, 4].map(() => html`<div class="kpi glass sheen"><div class="sk" style="height:130px"></div></div>`)}</div>

    <div class="qa" data-qa>
      ${[['Create invoice', '#/sales/invoices/new', 'sales', '--q1:#2563EB;--q2:#06B6D4'], ['Record payment', '#/sales/receipts/new', 'wallet', '--q1:#10B981;--q2:#06B6D4'], ['Add expense', '#/accounting/payment-vouchers/new', 'card', '--q1:#F59E0B;--q2:#EF4444'],
        ['Purchase order', '#/purchases/orders/new', 'cart', '--q1:#8B5CF6;--q2:#2563EB'], ['New customer', '#/customers?new=1', 'customers', '--q1:#06B6D4;--q2:#10B981'], ['New stock item', '#/inventory/items?new=1', 'inventory', '--q1:#2563EB;--q2:#8B5CF6'], ['Generate report', '#/reports', 'reports', '--q1:#EF4444;--q2:#F59E0B']]
        .map(([l, h, i, s]) => html`<a href="${h}" style="${s}"><span class="qi">${raw(ico(i))}</span>${l}</a>`)}</div>

    <div class="grid g-main">
      <div class="card"><div class="card-h"><div><div class="card-t">Profit &amp; loss trend</div><div class="card-s">Revenue vs expenses vs profit, last 12 months</div></div><div data-l1></div></div><div class="card-b"><div class="chart" data-pl style="min-height:280px"></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Expense breakdown</div><div class="card-s" data-perlab></div></div></div><div class="card-b"><div data-exp style="min-height:220px"></div></div></div>
    </div>
    <div class="grid g-main cv">
      <div class="card"><div class="card-h"><div><div class="card-t">Cash flow</div><div class="card-s">Inflow vs outflow of cash &amp; bank accounts · dashed = 3-month projection</div></div><div data-l2></div></div><div class="card-b"><div class="chart" data-cf style="min-height:280px"></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">Revenue sources</div><div class="card-s">Top-selling items &amp; services</div></div></div><div class="card-b" data-src style="min-height:220px"></div></div>
    </div>
    <div class="grid g-main cv">
      <div class="card"><div class="card-h"><div><div class="card-t">Financial health</div><div class="card-s">Margins, liquidity and ageing</div></div></div><div class="card-b"><div class="metrics" data-health></div></div></div>
      <div class="card"><div class="card-h"><div><div class="card-t">${raw(ico('sparkles', 'style="display:inline;width:18px;height:18px;vertical-align:-3px;color:var(--violet)"'))} Insights</div><div class="card-s">Calculated from your ledger. Nothing leaves this server.</div></div></div><div class="card-b stack" style="gap:10px" data-ins></div></div>
    </div>
    <div class="card cv"><div class="card-h"><div><div class="card-t">Recent activity</div><div class="card-s">Latest documents across sales, purchases and cash</div></div><a class="btn sm" href="#/reports">View all</a></div><div class="card-b" data-feed></div></div>`);

  const $k = $('[data-kpis]', root);
  $('[data-new]', root).addEventListener('click', (e) => menu(e.currentTarget, [{ title: 'Sales' }, { label: 'Quotation', icon: 'file', onClick: () => navigate('#/sales/quotations/new') }, { label: 'Invoice', icon: 'sales', onClick: () => navigate('#/sales/invoices/new') }, { label: 'Cash sale', icon: 'banknote', onClick: () => navigate('#/sales/cash-sales/new') },
    { title: 'Purchases' }, { label: 'Purchase order', icon: 'cart', onClick: () => navigate('#/purchases/orders/new') }, { label: 'Supplier invoice', icon: 'purchases', onClick: () => navigate('#/purchases/invoices/new') }, { title: 'Other' }, { label: 'Payment voucher', icon: 'card', onClick: () => navigate('#/accounting/payment-vouchers/new') }]));
  root.addEventListener('click', (e) => { const p = e.target.closest('[data-p]'); if (!p) return; period = p.dataset.p; root.querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b === p)); loadPeriod(); });

  const range = () => { const t = today(); return period === 'month' ? [monthStart(t), t, 'This month'] : period === '90' ? [addDays(t, -89), t, 'Last 90 days'] : [yearStart(t), t, 'Year to date']; };
  let PS = null; let periodRequest = 0;
  const overviewP = () => cached('dash:overview', () => { const e = window.__early; window.__early = null; return e && e.overview ? e.overview.catch(() => api.get('/insights/overview?months=12')) : api.get('/insights/overview?months=12'); }, 20000);
  let OV = null, BD = null, AL = null;

  /* ---------- P&L + cash flow ---------- */
  async function loadOverview() {
    try {
      OV = await overviewP(); updated = Date.now();
      const m = OV.months;
      const labels = m.map((x) => monthLabel(x.month));
      setHTML($('[data-l1]', root), legend([{ label: 'Revenue', color: 'var(--blue)' }, { label: 'Expenses', color: 'var(--amber)' }, { label: 'Profit', color: 'var(--green)' }]));
      plot($('[data-pl]', root), { labels, kind: 'line', series: [{ name: 'Revenue', values: m.map((x) => x.revenue), color: 'var(--blue)' }, { name: 'Expenses', values: m.map((x) => x.expense), color: 'var(--amber)' }, { name: 'Profit', values: m.map((x) => x.profit), color: 'var(--green)' }] });
      const completed = m.filter((x) => x.isComplete);
      const forecast = (values, steps = 3) => {
        const vals = values.map(Number).filter((v) => Number.isFinite(v));
        if (!vals.length) return Array(steps).fill(0);
        if (vals.length === 1) return Array(steps).fill(Math.max(0, vals[0]));
        const len = vals.length, xbar = (len - 1) / 2, ybar = vals.reduce((a, v) => a + v, 0) / len;
        let nume = 0, den = 0;
        vals.forEach((v, i) => { nume += (i - xbar) * (v - ybar); den += (i - xbar) ** 2; });
        const slope = den ? nume / den : 0;
        return Array.from({ length: steps }, (_, i) => Math.max(0, ybar + slope * (len + i)));
      };
      const base = completed.slice(-6), inflow = forecast(base.map((x) => x.cashIn)), outflow = forecast(base.map((x) => x.cashOut));
      const lm = m[m.length - 1]; const [yy, mm] = lm.month.split('-').map(Number); const fl = [];
      for (let i = 1; i <= 3; i++) { const d = new Date(yy, mm - 1 + i, 1); fl.push(d.toLocaleDateString('en-MY', { month: 'short' })); }
      setHTML($('[data-l2]', root), legend([{ label: 'Inflow', color: 'var(--green)' }, { label: 'Outflow', color: 'var(--red)' }]));
      plot($('[data-cf]', root), { labels: [...labels, ...fl], kind: 'area', forecastFrom: m.length, series: [{ name: 'Inflow', values: [...m.map((x) => x.cashIn), ...inflow], color: 'var(--green)' }, { name: 'Outflow', values: [...m.map((x) => x.cashOut), ...outflow], color: 'var(--red)' }] });
      if (PS) renderKpis();
      if (BD) { renderBreakdown(); insights(); }
    } catch (e) { setHTML($k, errorNote(e)); }
  }

  const comparisonLabel = () => PS?.label === 'This month' ? 'vs same days last month' : PS?.label === 'Last 90 days' ? 'vs previous 90 days' : 'vs same period last year';
  const renderKpis = () => {
    if (!PS) return;
    const m = OV?.months || [];
    const series = (key) => m.map((x) => Number(x[key] || 0));
    const dl = (c, p, goodUp = true) => { const d = pctChange(c, p); const lab = comparisonLabel(); if (d == null) return html`<div><span class="delta flat">New</span><span class="kpi-cmp">${lab}</span></div>`; const up = d >= 0, good = up === goodUp; return html`<div><span class="delta ${Math.abs(d) < 0.05 ? 'flat' : good ? 'up' : 'down'}">${raw(ico(up ? 'arrowUp' : 'arrowDown'))}${up ? '+' : ''}${d.toFixed(1)}%</span><span class="kpi-cmp">${lab}</span></div>`; };
    const card = (label, icon, k1, k2, kc, val, foot, sr, color) => html`<article class="kpi glass sheen" style="--k1:${k1};--k2:${k2};--kc:${kc}"><div class="kpi-top"><span class="kpi-ico">${raw(ico(icon))}</span>${label}</div><div class="kpi-val tnum"><small>RM</small>${fmt(val, 0)}</div><div class="kpi-foot"><div>${foot}</div>${raw(spark(sr, { color }))}</div></article>`;
    setHTML($k, html`
      ${card('Revenue', 'trend', '#2563EB', '#06B6D4', 'rgba(37,99,235,.35)', PS.current.revenue, dl(PS.current.revenue, PS.previous.revenue), series('revenue'), 'var(--blue)')}
      ${card('Expenses', 'wallet', '#F59E0B', '#EF4444', 'rgba(245,158,11,.35)', PS.current.expense, dl(PS.current.expense, PS.previous.expense, false), series('expense'), 'var(--amber)')}
      ${card('Net profit', 'scale', '#10B981', '#06B6D4', 'rgba(16,185,129,.35)', PS.current.profit, dl(PS.current.profit, PS.previous.profit), series('profit'), 'var(--green)')}
      ${card('Cash balance', 'banknote', '#8B5CF6', '#2563EB', 'rgba(139,92,246,.35)', PS.current.cashBalance, html`<div class="stack" style="gap:6px"><span class="live" title="Balances come from the posted ledger, not a bank feed">Live ledger · <span data-ago>just now</span></span>${dl(PS.current.cashBalance, PS.previous.cashBalance)}</div>`, m.map((x) => Number(x.cashIn || 0) - Number(x.cashOut || 0)), 'var(--violet)')}`);
  };

  const tick = () => { const el = $('[data-ago]', root); if (el) el.textContent = ago(updated); };

  /* ---------- period breakdown ---------- */
  function renderBreakdown() {
    if (!BD) return;
    const top = BD.expenses.slice(0, 5), rest = sum(BD.expenses.slice(5), (x) => x.amount);
    donut($('[data-exp]', root), { items: [...top.map((x) => ({ label: x.name, value: x.amount })), ...(rest > 0 ? [{ label: 'Other', value: rest }] : [])], center: { label: 'Expenses', value: compact(sum(BD.expenses, (x) => x.amount)) } });
    const totalRevenue = Number(BD.totalRevenue || 0);
    const positiveRevenue = (BD.revenue || []).filter((x) => Number(x.amount) > 0.004);
    const topRevenue = positiveRevenue.slice(0, 5);
    const shownRevenue = sum(topRevenue, (x) => x.amount);
    let sources;
    if (totalRevenue > 0.004 && shownRevenue <= totalRevenue + 0.01) {
      sources = topRevenue.map((x) => ({ label: x.name, value: x.amount }));
      const other = totalRevenue - shownRevenue;
      if (other > 0.004) sources.push({ label: 'Other revenue', value: other });
    } else if (totalRevenue > 0.004) {
      // Net revenue can be lower than the sum of positive accounts when the
      // period contains revenue reversals/credit notes. A single net bar keeps
      // the visual exactly reconciled to the Revenue KPI instead of pretending
      // that gross source amounts add to a net figure.
      sources = [{ label: 'Net revenue after adjustments', value: totalRevenue }];
    } else {
      sources = [];
    }
    setHTML($('[data-src]', root), hbar(sources.slice(0, 6), { empty: 'No revenue in this period.' }));
    $('[data-perlab]', root).textContent = range()[2];
  }
  async function loadBreakdown() { const [from, to] = range(); try { BD = await api.get(`/insights/breakdown?from=${from}&to=${to}`); renderBreakdown(); insights(); } catch (e) { setHTML($('[data-exp]', root), errorNote(e)); } }
  async function loadPeriod() { const requestId = ++periodRequest; const selectedPeriod = period; try { const next = await cached(`dash:period:${selectedPeriod}`, () => api.get(`/insights/period-summary?period=${selectedPeriod}`), 20000); if (requestId !== periodRequest || selectedPeriod !== period) return; PS = next; updated = Date.now(); renderKpis(); await loadBreakdown(); if (requestId !== periodRequest || selectedPeriod !== period) return; health(); insights(); tick(); } catch (e) { if (requestId === periodRequest) setHTML($k, errorNote(e)); } }

  /* ---------- financial health ---------- */
  let AR = null, AP = null;
  async function loadAging() { try { [AR, AP] = await Promise.all([cached('dash:ar', () => api.get('/reports/ar-aging'), 30000), cached('dash:ap', () => api.get('/reports/ap-aging'), 30000)]); health(); } catch { /* aging is optional */ } }
  const buckets = (rows) => { const g = {}; (rows || []).forEach((r) => { g[r.aging_bucket] = (g[r.aging_bucket] || 0) + num(r.outstanding); }); const idx = (k) => { const i = BUCKET_ORDER.findIndex((b) => String(k).toLowerCase().includes(b)); return i < 0 ? 99 : i; }; return Object.entries(g).sort((a, b) => idx(a[0]) - idx(b[0])); };
  function health() {
    if (!OV || !PS) return;
    const rev = PS.current.revenue, cogs = PS.current.cogs, pro = PS.current.profit, b = OV.balances;
    const gm = rev > 0 ? ((rev - cogs) / rev) * 100 : null, nm = rev > 0 ? (pro / rev) * 100 : null;
    const cr = b.currentLiabilities > 0 ? b.currentAssets / b.currentLiabilities : null, qr = b.currentLiabilities > 0 ? (b.cash + b.receivables) / b.currentLiabilities : null;
    const tile = (k, v, ss) => html`<div class="metric"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${ss}</div></div>`;
    const ag = (label, rows) => { const bs = buckets(rows), tot = sum(bs, (x) => x[1]); return html`<div class="metric"><div class="k">${label}</div><div class="v">${rm(tot, 0)}</div>${tot > 0 ? html`<div class="bar-stack" aria-hidden="true">${raw(bs.map(([k, v], i) => html`<i style="width:${(v / tot) * 100}%;background:${bucketColor[Math.min(i, 4)]}" title="${k}: ${rm(v)}"></i>`).join(''))}</div><div class="s">${bs.map(([k, v]) => `${k}: ${compact(v)}`).join(' · ')}</div>` : html`<div class="s">Nothing outstanding</div>`}</div>`; };
    setHTML($('[data-health]', root), html`${tile('Gross profit margin', gm == null ? '—' : `${gm.toFixed(1)}%`, PS.label)}${tile('Net profit margin', nm == null ? '—' : `${nm.toFixed(1)}%`, PS.label)}${tile('Current ratio', cr == null ? '—' : cr.toFixed(2), 'Current assets ÷ current liabilities')}${tile('Quick ratio', qr == null ? '—' : qr.toFixed(2), '(Cash + receivables) ÷ current liabilities')}${ag('Accounts receivable ageing', AR)}${ag('Accounts payable ageing', AP)}`);
  }

  /* ---------- insights (rule-based, computed locally) ---------- */
  function insights() {
    if (!OV || !PS) return; const out = [], m = OV.months.filter((x) => x.isComplete), cur = PS.current, prev = PS.previous, prev3 = m.slice(-3);
    if (PS.label === 'This month') {
      const day = new Date().getDate(), dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate(), f = dim / Math.max(day, 1), pace = cur.revenue * f, pAvg = sum(prev3, (x) => x.revenue) / Math.max(prev3.length, 1);
      if (pAvg > 0 && cur.revenue > 0) { const d = pctChange(pace, pAvg); out.push({ tone: d >= 0 ? 'ok' : 'warn', icon: 'trend', t: `Revenue is pacing ${d >= 0 ? 'above' : 'below'} your 3-month average`, p: `On track for about ${rm(pace, 0)} this month (${d >= 0 ? '+' : ''}${d.toFixed(0)}% vs ${rm(pAvg, 0)}).`, href: '#/sales' }); }
    } else if (prev.revenue > 0 || cur.revenue > 0) {
      const d = pctChange(cur.revenue, prev.revenue); if (d != null) out.push({ tone: d >= 0 ? 'ok' : 'warn', icon: 'trend', t: `Revenue ${d >= 0 ? 'increased' : 'decreased'} for ${PS.label.toLowerCase()}`, p: `${rm(cur.revenue, 0)} this period versus ${rm(prev.revenue, 0)} in the comparable period (${d >= 0 ? '+' : ''}${d.toFixed(1)}%).`, href: '#/sales' });
    }
    const eAvg = sum(prev3, (x) => x.expense) / Math.max(prev3.length, 1); if (PS.label === 'This month' && eAvg > 0 && cur.expense > eAvg * 1.35) out.push({ tone: 'warn', icon: 'alert', t: 'Unusual expense level this month', p: `Spending is ${(((cur.expense / eAvg) - 1) * 100).toFixed(0)}% above your recent completed-month average (${rm(eAvg, 0)}).`, href: '#/accounting', a: 'Review the ledger' });
    const avgOut = sum(prev3, (x) => x.cashOut) / Math.max(prev3.length, 1), net3 = sum(prev3, (x) => x.cashIn - x.cashOut); if (avgOut > 0) { const months = OV.balances.cash / avgOut; if (OV.balances.cash < 0) out.push({ tone: 'bad', icon: 'alert', t: 'Cash accounts are overdrawn', p: `The ledger shows ${rm(OV.balances.cash, 0)} across cash and bank accounts.`, href: '#/accounting' }); else if (months < 3 || (net3 < 0 && months < 6)) out.push({ tone: 'warn', icon: 'wallet', t: 'Cash flow warning', p: `Cash covers about ${months.toFixed(1)} months of average outflow${net3 < 0 ? ', and the last 3 completed months burned cash' : ''}.`, href: '#/sales/receipts/new', a: 'Collect a payment' }); }
    if (AL) { const r = AL.sales.receivables; if (r.overdueCount) out.push({ tone: 'bad', icon: 'clock', t: `${rm(r.overdue, 0)} is overdue from customers`, p: `${r.overdueCount} invoice${r.overdueCount > 1 ? 's are' : ' is'} past due.`, href: '#/reports/ar-aging', a: 'Open the ageing report' }); const st = AL.inventory.summary; if (st.outOfStock + st.lowStock) out.push({ tone: 'warn', icon: 'inventory', t: `${st.outOfStock + st.lowStock} item${st.outOfStock + st.lowStock > 1 ? 's need' : ' needs'} restocking`, p: `${st.outOfStock} out of stock, ${st.lowStock} below minimum.`, href: '#/purchases/requests/new', a: 'Raise a purchase request' }); }
    if (BD && BD.topCustomers.length) { const tot = sum(BD.topCustomers, (x) => x.amount), c = BD.topCustomers[0]; if (BD.topCustomers.length > 1 && tot > 0 && c.amount / tot > 0.45) out.push({ tone: 'warn', icon: 'customers', t: 'Revenue concentration', p: `${c.name} is ${((c.amount / tot) * 100).toFixed(0)}% of sales among your top customers this period.`, href: '#/customers' }); }
    setHTML($('[data-ins]', root), out.length ? raw(out.slice(0, 5).map((i) => html`<div class="insight ${i.tone}"><span class="ii">${raw(ico(i.icon === 'clock' ? 'history' : i.icon))}</span><div><b>${i.t}</b><p>${i.p}</p>${i.a ? html`<a class="act" href="${i.href}">${i.a} →</a>` : ''}</div></div>`).join('')) : html`<div class="insight ok"><span class="ii">${raw(ico('checkCircle'))}</span><div><b>Everything looks healthy</b><p>No unusual spending, overdue balances or stock problems detected.</p></div></div>`);
  }

  async function loadAlertsAndFeed() {
    try { AL = await loadAlerts(); insights(); } catch { /* insights degrade gracefully */ }
    try {
      const f = await cached('dash:feed', () => api.get('/reports/document-history?pageSize=10'), 15000);
      setHTML($('[data-feed]', root), (f.documents || []).length ? html`<div class="tl">${f.documents.slice(0, 8).map((d) => html`<a class="tl-item" href="#/${DOC_ROUTES[d.doc_type] || 'reports'}?view=${d.doc_id}"><span class="tl-dot tone-${DOC_TONE[d.doc_type] || 'muted'}">${raw(ico(DOC_ICON[d.doc_type] || 'file'))}</span><div class="tl-body"><b>${DOC_LABEL[d.doc_type] || title(d.doc_type)} ${d.doc_no}</b> ${raw(badgeOf(d.status))}<div class="s">${d.partner_name || ''}${d.items_summary ? ` · ${d.items_summary}` : ''}</div></div><div class="tl-amt">${rm(d.total_amount)}<div class="s muted" style="font-weight:500;font-size:12px">${fmtDate(d.doc_date)}</div></div></a>`)}</div>` : empty('history', 'No activity yet', 'Documents you create will appear here.'));
    } catch (e) { setHTML($('[data-feed]', root), errorNote(e)); }
  }
  const badgeOf = (s) => str(html`<span class="badge tone-${s === 'VOID' ? 'bad' : s === 'PAID' ? 'ok' : s === 'PARTIALLY_PAID' ? 'warn' : 'info'}" style="margin-left:6px">${title(s)}</span>`);

  const refresh = () => { invalidate('dash:'); invalidate('alerts'); loadOverview(); loadPeriod(); loadAging(); loadAlertsAndFeed(); };
  loadOverview(); loadPeriod(); loadAging(); loadAlertsAndFeed();
  const timer = setInterval(() => { if (alive && !document.hidden) { invalidate('dash:'); loadOverview(); loadAlertsAndFeed(); } }, 60000);
  const agoTimer = setInterval(tick, 5000);
  const off = on('changed', refresh);
  ctx.onCleanup(() => { alive = false; clearInterval(timer); clearInterval(agoTimer); off(); root.querySelectorAll('.chart').forEach(disposeChart); });
}
