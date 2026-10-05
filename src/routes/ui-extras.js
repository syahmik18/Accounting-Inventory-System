/**
 * UI support routes (v39 Liquid Glass UI).
 *
 * Everything here is ADDITIVE and READ-ONLY, with one narrow exception
 * (PATCH /stock-items/:id/min-qty, which only touches stock_item.min_qty and
 * never posts anything). No existing route, model, migration or posting rule
 * is changed by this file.
 *
 * Why it exists:
 *   - Receipts, Payments and Credit/Debit Notes had no detail endpoint, so a
 *     document viewer / print view could not show their lines or allocations.
 *   - The dashboards need month-by-month aggregates that the old screens never
 *     needed (P&L trend, cash in/out, top items, stock valuation ...).
 *
 * Account analytics use semantic roles from account_reporting_role rather than
 * chart-of-accounts number prefixes. This keeps the dashboard correct when a
 * company uses a different numbering scheme.
 */
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const wrapAsync = (fn) => (req, res, next) => {
  try { return Promise.resolve(fn(req, res, next)).catch(next); } catch (err) { return next(err); }
};
for (const method of ['get', 'patch']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(wrapAsync));
}

const n = (v) => Number(v || 0);
const round2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;
const isoDate = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback);
const localToday = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const monthStart = (ymd) => `${ymd.slice(0, 7)}-01`;

// ---------------------------------------------------------------------------
// Receipts (customer payments) — list + detail
// ---------------------------------------------------------------------------
router.get('/receipts', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.receipt_id, r.receipt_no, r.partner_id, p.partner_name, r.receipt_date, r.amount,
           r.payment_method, r.status::text AS status, r.bank_account_id,
           ba.account_code AS bank_account_code, ba.account_name AS bank_account_name,
           (SELECT string_agg(si.invoice_no, ', ' ORDER BY si.invoice_no)
              FROM receipt_allocation ra JOIN sales_invoice si ON si.invoice_id = ra.invoice_id
             WHERE ra.receipt_id = r.receipt_id) AS applied_to
      FROM receipt r
      JOIN partner p ON p.partner_id = r.partner_id
      JOIN chart_of_accounts ba ON ba.account_id = r.bank_account_id
     ORDER BY r.receipt_date DESC, r.receipt_no DESC`);
  res.json(rows);
});

router.get('/receipts/:id', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT r.*, r.status::text AS status, p.partner_name, ba.account_code AS bank_account_code, ba.account_name AS bank_account_name
      FROM receipt r JOIN partner p ON p.partner_id = r.partner_id
      JOIN chart_of_accounts ba ON ba.account_id = r.bank_account_id
     WHERE r.receipt_id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Receipt not found' });
  const alloc = await pool.query(`
    SELECT ra.allocation_id, ra.invoice_id, si.invoice_no, si.invoice_date, si.total_amount, ra.amount_applied
      FROM receipt_allocation ra JOIN sales_invoice si ON si.invoice_id = ra.invoice_id
     WHERE ra.receipt_id = $1 ORDER BY si.invoice_no`, [req.params.id]);
  res.json({ ...rows[0], allocations: alloc.rows });
});

// ---------------------------------------------------------------------------
// Supplier payments — list + detail
// ---------------------------------------------------------------------------
router.get('/payments', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pay.payment_id, pay.payment_no, pay.partner_id, p.partner_name, pay.payment_date, pay.amount,
           pay.payment_method, pay.status::text AS status, pay.bank_account_id,
           ba.account_code AS bank_account_code, ba.account_name AS bank_account_name,
           (SELECT string_agg(pi.invoice_no, ', ' ORDER BY pi.invoice_no)
              FROM payment_allocation pa JOIN purchase_invoice pi ON pi.purchase_invoice_id = pa.purchase_invoice_id
             WHERE pa.payment_id = pay.payment_id) AS applied_to
      FROM payment pay
      JOIN partner p ON p.partner_id = pay.partner_id
      JOIN chart_of_accounts ba ON ba.account_id = pay.bank_account_id
     ORDER BY pay.payment_date DESC, pay.payment_no DESC`);
  res.json(rows);
});

router.get('/payments/:id', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pay.*, pay.status::text AS status, p.partner_name, ba.account_code AS bank_account_code, ba.account_name AS bank_account_name
      FROM payment pay JOIN partner p ON p.partner_id = pay.partner_id
      JOIN chart_of_accounts ba ON ba.account_id = pay.bank_account_id
     WHERE pay.payment_id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
  const alloc = await pool.query(`
    SELECT pa.allocation_id, pa.purchase_invoice_id, pi.invoice_no, pi.invoice_date, pi.total_amount, pa.amount_applied
      FROM payment_allocation pa JOIN purchase_invoice pi ON pi.purchase_invoice_id = pa.purchase_invoice_id
     WHERE pa.payment_id = $1 ORDER BY pi.invoice_no`, [req.params.id]);
  res.json({ ...rows[0], allocations: alloc.rows });
});

// ---------------------------------------------------------------------------
// Purchase invoices that still have an outstanding balance (for the Payment screen)
// ---------------------------------------------------------------------------
router.get('/purchase-invoices/open', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT pi.purchase_invoice_id, pi.invoice_no, pi.partner_id, p.partner_name, pi.invoice_date, pi.due_date,
           pi.total_amount, pi.paid_amount, (pi.total_amount - pi.paid_amount) AS outstanding, pi.status::text AS status
      FROM purchase_invoice pi JOIN partner p ON p.partner_id = pi.partner_id
     WHERE pi.status IN ('POSTED','PARTIALLY_PAID') AND (pi.total_amount - pi.paid_amount) > 0.005
     ORDER BY pi.due_date, pi.invoice_no`);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Debit / Credit note detail (list already exists at GET /sales-notes)
// ---------------------------------------------------------------------------
router.get('/sales-notes/:kind/:id', async (req, res) => {
  const kind = String(req.params.kind).toLowerCase();
  if (kind !== 'debit' && kind !== 'credit') return res.status(400).json({ error: 'Note type must be debit or credit' });
  const table = kind === 'credit' ? 'credit_note' : 'debit_note';
  const idCol = `${table}_id`;
  const { rows } = await pool.query(`
    SELECT n.*, n.${idCol} AS note_id, n.status::text AS status, p.partner_name, si.invoice_no AS original_invoice_no
      FROM ${table} n JOIN partner p ON p.partner_id = n.partner_id
      LEFT JOIN sales_invoice si ON si.invoice_id = n.original_invoice_id
     WHERE n.${idCol} = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Note not found' });
  const lines = await pool.query(`SELECT * FROM ${table}_line WHERE ${idCol} = $1 ORDER BY line_no`, [req.params.id]);
  res.json({ ...rows[0], kind, lines: lines.rows });
});

// ---------------------------------------------------------------------------
// Stock: minimum quantity (drives low-stock alerts). Never posts anything.
// ---------------------------------------------------------------------------
router.patch('/stock-items/:id/min-qty', async (req, res) => {
  const v = Number(req.body && req.body.minQty);
  if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Minimum quantity must be zero or greater' });
  const { rows } = await pool.query(
    `UPDATE stock_item SET min_qty = $1 WHERE stock_item_id = $2 RETURNING stock_item_id, item_code, min_qty`,
    [v, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Stock item not found' });
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// Insights: overview (monthly P&L / cash series + balance-sheet headline numbers)
// ---------------------------------------------------------------------------
router.get('/insights/overview', async (req, res) => {
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 3), 36);
  const today = localToday();

  const series = await pool.query(`
    WITH months AS (
      SELECT generate_series(date_trunc('month', $1::date) - (($2::int - 1) * interval '1 month'),
                             date_trunc('month', $1::date), interval '1 month')::date AS m
    ), agg AS (
      SELECT date_trunc('month', je.journal_date)::date AS m,
             SUM(CASE WHEN r.reporting_role = 'REVENUE' THEN jl.credit - jl.debit ELSE 0 END) AS revenue,
             SUM(CASE WHEN r.reporting_role IN ('EXPENSE','COGS') THEN jl.debit - jl.credit ELSE 0 END) AS expense,
             SUM(CASE WHEN r.reporting_role = 'COGS' THEN jl.debit - jl.credit ELSE 0 END) AS cogs
        FROM journal_line jl
        JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
        JOIN account_reporting_role r ON r.account_id = jl.account_id
       WHERE je.journal_date >= (SELECT MIN(m) FROM months) AND je.journal_date <= $1::date
       GROUP BY 1
    ), cash_journals AS (
      SELECT date_trunc('month', je.journal_date)::date AS m,
             je.journal_id,
             SUM(CASE WHEN r.is_cash_account THEN jl.debit - jl.credit ELSE 0 END) AS cash_net
        FROM journal_line jl
        JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
        JOIN account_reporting_role r ON r.account_id = jl.account_id
       WHERE je.journal_date >= (SELECT MIN(m) FROM months) AND je.journal_date <= $1::date
       GROUP BY 1, je.journal_id
    ), cash_agg AS (
      SELECT m,
             SUM(CASE WHEN cash_net > 0.004 THEN cash_net ELSE 0 END) AS cash_in,
             SUM(CASE WHEN cash_net < -0.004 THEN -cash_net ELSE 0 END) AS cash_out
        FROM cash_journals GROUP BY m
    )
    SELECT to_char(months.m, 'YYYY-MM') AS month,
           (months.m < date_trunc('month', $1::date)::date) AS is_complete,
           COALESCE(agg.revenue, 0) AS revenue,
           COALESCE(agg.expense, 0) AS expense,
           COALESCE(agg.cogs, 0) AS cogs,
           COALESCE(cash_agg.cash_in, 0) AS cash_in,
           COALESCE(cash_agg.cash_out, 0) AS cash_out
      FROM months
      LEFT JOIN agg ON agg.m = months.m
      LEFT JOIN cash_agg ON cash_agg.m = months.m
     ORDER BY months.m`, [today, months]);

  const bal = await pool.query(`
    SELECT c.account_type::text AS account_type, c.account_code,
           COALESCE(r.is_cash_account, FALSE) AS is_cash_account,
           COALESCE(r.is_receivable_account, FALSE) AS is_receivable_account,
           COALESCE(r.is_inventory_account, FALSE) AS is_inventory_account,
           COALESCE(r.is_payable_account, FALSE) AS is_payable_account,
           COALESCE(r.is_current_asset, FALSE) AS is_current_asset,
           COALESCE(r.is_current_liability, FALSE) AS is_current_liability,
           COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr
      FROM chart_of_accounts c
      LEFT JOIN account_reporting_role r ON r.account_id = c.account_id
      LEFT JOIN journal_line jl ON jl.account_id = c.account_id
      LEFT JOIN journal_entry je ON je.journal_id = jl.journal_id
     WHERE je.journal_id IS NULL OR (je.is_posted = TRUE AND je.journal_date <= $1::date)
     GROUP BY c.account_id, c.account_type, c.account_code, r.is_cash_account,
              r.is_receivable_account, r.is_inventory_account, r.is_payable_account,
              r.is_current_asset, r.is_current_liability`, [today]);

  const prevCash = await pool.query(`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS bal
      FROM journal_line jl
      JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
      JOIN account_reporting_role r ON r.account_id = jl.account_id
     WHERE r.is_cash_account = TRUE AND je.journal_date < date_trunc('month', $1::date)`, [today]);

  const b = { cash: 0, receivables: 0, inventory: 0, currentAssets: 0, totalAssets: 0, payables: 0, currentLiabilities: 0, totalLiabilities: 0, equity: 0, earnings: 0 };
  for (const r of bal.rows) {
    const dr = n(r.dr), cr = n(r.cr);
    if (r.account_type === 'ASSET') {
      const v = dr - cr; b.totalAssets += v; if (r.is_current_asset) b.currentAssets += v;
      if (r.is_cash_account) b.cash += v; if (r.is_receivable_account) b.receivables += v; if (r.is_inventory_account) b.inventory += v;
    } else if (r.account_type === 'LIABILITY') {
      const v = cr - dr; b.totalLiabilities += v; if (r.is_current_liability) b.currentLiabilities += v; if (r.is_payable_account) b.payables += v;
    } else if (r.account_type === 'EQUITY') b.equity += cr - dr;
    else if (r.account_type === 'REVENUE') b.earnings += cr - dr;
    else if (r.account_type === 'EXPENSE') b.earnings -= dr - cr;
  }

  res.json({ asOf: today, generatedAt: new Date().toISOString(),
    months: series.rows.map((r) => ({ month: r.month, isComplete: r.is_complete === true, revenue: n(r.revenue), expense: n(r.expense), cogs: n(r.cogs), profit: n(r.revenue) - n(r.expense), cashIn: n(r.cash_in), cashOut: n(r.cash_out) })),
    balances: b, cashAtPrevMonthEnd: n(prevCash.rows[0].bal) });
});

router.get('/insights/period-summary', async (req, res) => {
  const requested = String(req.query.period || 'month').toLowerCase();
  const period = ['month', '90', 'ytd'].includes(requested) ? requested : 'month';
  const to = localToday();
  const d = new Date(`${to}T00:00:00Z`);
  const elapsedDays = Math.floor((d - new Date(`${d.getUTCFullYear()}-01-01T00:00:00Z`)) / 86400000) + 1;
  let from, previousFrom, previousTo, label;
  const pad = (v) => String(v).padStart(2, '0');
  if (period === 'month') {
    from = monthStart(to);
    const pm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const pStart = `${pm.getUTCFullYear()}-${pad(pm.getUTCMonth() + 1)}-01`;
    const pLast = new Date(Date.UTC(pm.getUTCFullYear(), pm.getUTCMonth() + 1, 0)).getUTCDate();
    const day = Math.min(d.getUTCDate(), pLast);
    previousFrom = pStart; previousTo = `${pStart.slice(0, 7)}-${pad(day)}`; label = 'This month';
  } else if (period === '90') {
    const curFromDate = new Date(d.getTime() - 89 * 86400000);
    from = curFromDate.toISOString().slice(0, 10);
    const prevEnd = new Date(curFromDate.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - 89 * 86400000);
    previousFrom = prevStart.toISOString().slice(0, 10); previousTo = prevEnd.toISOString().slice(0, 10); label = 'Last 90 days';
  } else {
    from = yearStart(to);
    const prevYear = d.getUTCFullYear() - 1;
    const month = d.getUTCMonth();
    const day = Math.min(d.getUTCDate(), new Date(Date.UTC(prevYear, month + 1, 0)).getUTCDate());
    const prevYearEnd = new Date(Date.UTC(prevYear, month, day));
    previousFrom = `${prevYear}-01-01`; previousTo = prevYearEnd.toISOString().slice(0, 10); label = 'Year to date';
  }
  const periodQuery = async (a, b) => (await pool.query(`
    SELECT COALESCE(SUM(CASE WHEN r.reporting_role='REVENUE' THEN jl.credit-jl.debit ELSE 0 END),0) AS revenue,
           COALESCE(SUM(CASE WHEN r.reporting_role IN ('EXPENSE','COGS') THEN jl.debit-jl.credit ELSE 0 END),0) AS expense,
           COALESCE(SUM(CASE WHEN r.reporting_role='COGS' THEN jl.debit-jl.credit ELSE 0 END),0) AS cogs
      FROM journal_line jl JOIN journal_entry je ON je.journal_id=jl.journal_id AND je.is_posted=TRUE
      JOIN account_reporting_role r ON r.account_id=jl.account_id
     WHERE je.journal_date BETWEEN $1 AND $2`, [a,b])).rows[0];
  const cashAt = async (a) => (await pool.query(`
    SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS balance
      FROM journal_line jl JOIN journal_entry je ON je.journal_id=jl.journal_id AND je.is_posted=TRUE
      JOIN account_reporting_role r ON r.account_id=jl.account_id
     WHERE r.is_cash_account=TRUE AND je.journal_date <= $1`, [a])).rows[0].balance;
  const [cur, prev, cashCurrent, cashPrevious] = await Promise.all([periodQuery(from,to), periodQuery(previousFrom,previousTo), cashAt(to), cashAt(previousTo)]);
  const current = { revenue:n(cur.revenue), expense:n(cur.expense), cogs:n(cur.cogs), profit:n(cur.revenue)-n(cur.expense), cashBalance:n(cashCurrent) };
  const previous = { revenue:n(prev.revenue), expense:n(prev.expense), cogs:n(prev.cogs), profit:n(prev.revenue)-n(prev.expense), cashBalance:n(cashPrevious) };
  const pct = (a,b) => Math.abs(b) > 0.004 ? ((a-b)/Math.abs(b))*100 : null;
  res.json({ period, label, from, to, previousFrom, previousTo, elapsedDays: period==='month' ? d.getUTCDate() : period==='90' ? 90 : elapsedDays,
    current, previous,
    comparison:{ revenue:pct(current.revenue,previous.revenue), expense:pct(current.expense,previous.expense), profit:pct(current.profit,previous.profit), cash:pct(current.cashBalance,previous.cashBalance) } });
});

// ---------------------------------------------------------------------------
// Insights: period breakdown (expense / revenue by account, top items, customers, suppliers)
// ---------------------------------------------------------------------------
router.get('/insights/breakdown', async (req, res) => {
  const to = isoDate(req.query.to, localToday());
  const from = isoDate(req.query.from, monthStart(to));

  const byAccount = async (type, sign) => (await pool.query(`
    SELECT c.account_code, c.account_name, SUM(${sign}) AS amount
      FROM journal_line jl
      JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
      JOIN chart_of_accounts c ON c.account_id = jl.account_id
     WHERE c.account_type = $1 AND je.journal_date BETWEEN $2 AND $3
     GROUP BY c.account_id, c.account_code, c.account_name
    HAVING ABS(SUM(${sign})) > 0.004
     ORDER BY amount DESC`, [type, from, to])).rows.map((r) => ({ code: r.account_code, name: r.account_name, amount: n(r.amount) }));

  const [expenses, revenue] = await Promise.all([
    byAccount('EXPENSE', 'jl.debit - jl.credit'),
    byAccount('REVENUE', 'jl.credit - jl.debit'),
  ]);

  const items = await pool.query(`
    WITH sold AS (
      SELECT l.stock_item_id, l.description, l.quantity, l.line_total
        FROM sales_invoice_line l JOIN sales_invoice s ON s.invoice_id = l.invoice_id
       WHERE s.status <> 'VOID' AND s.invoice_date BETWEEN $1 AND $2
      UNION ALL
      SELECT l.stock_item_id, l.description, l.quantity, l.line_total
        FROM cash_sale_line l JOIN cash_sale s ON s.cash_sale_id = l.cash_sale_id
       WHERE s.status <> 'VOID' AND s.sale_date BETWEEN $1 AND $2
    )
    SELECT COALESCE(si.item_code, 'SERVICE') AS code, COALESCE(si.item_name, sold.description) AS name,
           SUM(sold.quantity) AS qty, SUM(sold.line_total) AS amount
      FROM sold LEFT JOIN stock_item si ON si.stock_item_id = sold.stock_item_id
     GROUP BY COALESCE(sold.stock_item_id::text, sold.description), si.item_code, COALESCE(si.item_name, sold.description)
     ORDER BY amount DESC LIMIT 8`, [from, to]);

  const customers = await pool.query(`
    SELECT p.partner_id, p.partner_name, SUM(x.amount) AS amount, COUNT(*)::int AS docs
      FROM (
        SELECT partner_id, subtotal AS amount FROM sales_invoice WHERE status <> 'VOID' AND invoice_date BETWEEN $1 AND $2
        UNION ALL
        SELECT partner_id, subtotal FROM cash_sale WHERE status <> 'VOID' AND partner_id IS NOT NULL AND sale_date BETWEEN $1 AND $2
      ) x JOIN partner p ON p.partner_id = x.partner_id
     GROUP BY p.partner_id, p.partner_name ORDER BY amount DESC LIMIT 6`, [from, to]);

  const suppliers = await pool.query(`
    SELECT p.partner_id, p.partner_name, SUM(x.amount) AS amount, COUNT(*)::int AS docs
      FROM (
        SELECT partner_id, subtotal AS amount FROM purchase_invoice WHERE status <> 'VOID' AND invoice_date BETWEEN $1 AND $2
        UNION ALL
        SELECT partner_id, subtotal FROM cash_purchase WHERE status <> 'VOID' AND partner_id IS NOT NULL AND purchase_date BETWEEN $1 AND $2
      ) x JOIN partner p ON p.partner_id = x.partner_id
     GROUP BY p.partner_id, p.partner_name ORDER BY amount DESC LIMIT 6`, [from, to]);

  const totalRevenue = revenue.reduce((acc, x) => acc + n(x.amount), 0);
  res.json({
    from, to, expenses, revenue, totalRevenue,
    topItems: items.rows.map((r) => ({ code: r.code, name: r.name, qty: n(r.qty), amount: n(r.amount) })),
    topCustomers: customers.rows.map((r) => ({ id: r.partner_id, name: r.partner_name, amount: n(r.amount), docs: r.docs })),
    topSuppliers: suppliers.rows.map((r) => ({ id: r.partner_id, name: r.partner_name, amount: n(r.amount), docs: r.docs })),
  });
});

// ---------------------------------------------------------------------------
// Insights: sales workspace
// ---------------------------------------------------------------------------
router.get('/insights/sales', async (req, res) => {
  const today = localToday();
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

  const [quotes, orders, deliveries, ar, statuses, monthly] = await Promise.all([
    one(`SELECT COUNT(*)::int AS c, COALESCE(SUM(total_amount),0) AS v FROM quotation WHERE status = 'OPEN'`),
    one(`SELECT COUNT(*)::int AS c, COALESCE(SUM(total_amount),0) AS v FROM sales_order WHERE status IN ('OPEN','PARTIALLY_DELIVERED')`),
    one(`SELECT COUNT(*)::int AS c, COALESCE(SUM(total_amount),0) AS v FROM delivery_order WHERE status = 'POSTED' AND is_fully_invoiced = FALSE`),
    one(`SELECT COALESCE(SUM(total_amount + debited_amount - credited_amount - paid_amount),0) AS outstanding,
                COUNT(*)::int AS open_count,
                COALESCE(SUM(CASE WHEN due_date < $1::date THEN total_amount + debited_amount - credited_amount - paid_amount ELSE 0 END),0) AS overdue,
                COUNT(*) FILTER (WHERE due_date < $1::date)::int AS overdue_count
           FROM sales_invoice
          WHERE status IN ('POSTED','PARTIALLY_PAID') AND (total_amount + debited_amount - credited_amount - paid_amount) > 0.005`, [today]),
    pool.query(`SELECT status::text AS status, COUNT(*)::int AS c, COALESCE(SUM(total_amount),0) AS v FROM sales_invoice GROUP BY status`),
    pool.query(`
      WITH months AS (
        SELECT generate_series(date_trunc('month', $1::date) - interval '11 months', date_trunc('month', $1::date), interval '1 month')::date AS m
      ), inv AS (
        SELECT date_trunc('month', invoice_date)::date AS m, SUM(subtotal) AS v, COUNT(*)::int AS c FROM sales_invoice WHERE status <> 'VOID' GROUP BY 1
      ), cs AS (
        SELECT date_trunc('month', sale_date)::date AS m, SUM(subtotal) AS v, COUNT(*)::int AS c FROM cash_sale WHERE status <> 'VOID' GROUP BY 1
      ), cn AS (
        SELECT date_trunc('month', note_date)::date AS m, SUM(subtotal) AS v FROM credit_note WHERE status <> 'VOID' GROUP BY 1
      )
      SELECT to_char(months.m,'YYYY-MM') AS month,
             COALESCE(inv.v,0) AS invoices, COALESCE(cs.v,0) AS cash_sales, COALESCE(cn.v,0) AS credits,
             COALESCE(inv.c,0) AS invoice_count, COALESCE(cs.c,0) AS cash_sale_count
        FROM months LEFT JOIN inv ON inv.m = months.m LEFT JOIN cs ON cs.m = months.m LEFT JOIN cn ON cn.m = months.m
       ORDER BY months.m`, [today]),
  ]);

  res.json({
    asOf: today,
    pipeline: {
      openQuotations: { count: quotes.c, value: n(quotes.v) },
      openOrders: { count: orders.c, value: n(orders.v) },
      deliveriesToInvoice: { count: deliveries.c, value: n(deliveries.v) },
    },
    receivables: { outstanding: n(ar.outstanding), openCount: ar.open_count, overdue: n(ar.overdue), overdueCount: ar.overdue_count },
    invoiceStatuses: statuses.rows.map((r) => ({ status: r.status, count: r.c, value: n(r.v) })),
    monthly: monthly.rows.map((r) => ({
      month: r.month, invoices: n(r.invoices), cashSales: n(r.cash_sales), credits: n(r.credits),
      invoiceCount: r.invoice_count, cashSaleCount: r.cash_sale_count,
    })),
  });
});

// ---------------------------------------------------------------------------
// Insights: purchase workspace
// ---------------------------------------------------------------------------
router.get('/insights/purchases', async (req, res) => {
  const today = localToday();
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

  const [prs, pos, grns, ap, statuses, monthly] = await Promise.all([
    one(`SELECT COUNT(*)::int AS c FROM purchase_request WHERE status = 'PENDING_APPROVAL'`),
    one(`SELECT COUNT(*)::int AS c, COALESCE(SUM(total_amount),0) AS v FROM purchase_order WHERE status IN ('SENT','PARTIALLY_RECEIVED')`),
    one(`SELECT COUNT(*)::int AS c, COALESCE(SUM(total_value),0) AS v FROM goods_received_note WHERE status = 'POSTED' AND is_fully_invoiced = FALSE`),
    one(`SELECT COALESCE(SUM(total_amount - paid_amount),0) AS outstanding,
                COUNT(*)::int AS open_count,
                COALESCE(SUM(CASE WHEN due_date < $1::date THEN total_amount - paid_amount ELSE 0 END),0) AS overdue,
                COUNT(*) FILTER (WHERE due_date < $1::date)::int AS overdue_count,
                COALESCE(SUM(CASE WHEN due_date >= $1::date AND due_date <= $1::date + 7 THEN total_amount - paid_amount ELSE 0 END),0) AS due_soon,
                COUNT(*) FILTER (WHERE due_date >= $1::date AND due_date <= $1::date + 7)::int AS due_soon_count
           FROM purchase_invoice
          WHERE status IN ('POSTED','PARTIALLY_PAID') AND (total_amount - paid_amount) > 0.005`, [today]),
    pool.query(`SELECT status::text AS status, COUNT(*)::int AS c, COALESCE(SUM(total_amount),0) AS v FROM purchase_invoice GROUP BY status`),
    pool.query(`
      WITH months AS (
        SELECT generate_series(date_trunc('month', $1::date) - interval '11 months', date_trunc('month', $1::date), interval '1 month')::date AS m
      ), pi AS (
        SELECT date_trunc('month', invoice_date)::date AS m, SUM(subtotal) AS v FROM purchase_invoice WHERE status <> 'VOID' GROUP BY 1
      ), cp AS (
        SELECT date_trunc('month', purchase_date)::date AS m, SUM(subtotal) AS v FROM cash_purchase WHERE status <> 'VOID' GROUP BY 1
      )
      SELECT to_char(months.m,'YYYY-MM') AS month, COALESCE(pi.v,0) AS invoices, COALESCE(cp.v,0) AS cash_purchases
        FROM months LEFT JOIN pi ON pi.m = months.m LEFT JOIN cp ON cp.m = months.m ORDER BY months.m`, [today]),
  ]);

  res.json({
    asOf: today,
    pipeline: {
      pendingRequests: { count: prs.c },
      openOrders: { count: pos.c, value: n(pos.v) },
      receivedNotInvoiced: { count: grns.c, value: n(grns.v) },
    },
    payables: {
      outstanding: n(ap.outstanding), openCount: ap.open_count, overdue: n(ap.overdue), overdueCount: ap.overdue_count,
      dueSoon: n(ap.due_soon), dueSoonCount: ap.due_soon_count,
    },
    invoiceStatuses: statuses.rows.map((r) => ({ status: r.status, count: r.c, value: n(r.v) })),
    monthly: monthly.rows.map((r) => ({ month: r.month, invoices: n(r.invoices), cashPurchases: n(r.cash_purchases) })),
  });
});

// ---------------------------------------------------------------------------
// Insights: inventory workspace
// ---------------------------------------------------------------------------
router.get('/insights/inventory', async (req, res) => {
  const today = localToday();
  const from90 = (() => { const d = new Date(); d.setDate(d.getDate() - 90); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

  const summary = (await pool.query(`
    SELECT COUNT(*)::int AS items,
           COUNT(*) FILTER (WHERE current_qty <= 0)::int AS out_of_stock,
           COUNT(*) FILTER (WHERE current_qty > 0 AND min_qty > 0 AND current_qty <= min_qty)::int AS low_stock,
           COALESCE(SUM(inventory_value),0) AS valuation,
           COALESCE(SUM(current_qty),0) AS units
      FROM stock_item WHERE is_active = TRUE`)).rows[0];

  const low = await pool.query(`
    SELECT stock_item_id, item_code, item_name, unit, current_qty, min_qty, average_cost, inventory_value
      FROM stock_item
     WHERE is_active = TRUE AND (current_qty <= 0 OR (min_qty > 0 AND current_qty <= min_qty))
     ORDER BY current_qty ASC, item_code ASC LIMIT 12`);

  const top = await pool.query(`
    WITH sold AS (
      SELECT l.stock_item_id, l.quantity, l.line_total FROM sales_invoice_line l JOIN sales_invoice s ON s.invoice_id = l.invoice_id
       WHERE s.status <> 'VOID' AND l.stock_item_id IS NOT NULL AND s.invoice_date BETWEEN $1 AND $2
      UNION ALL
      SELECT l.stock_item_id, l.quantity, l.line_total FROM cash_sale_line l JOIN cash_sale s ON s.cash_sale_id = l.cash_sale_id
       WHERE s.status <> 'VOID' AND l.stock_item_id IS NOT NULL AND s.sale_date BETWEEN $1 AND $2
    )
    SELECT si.stock_item_id, si.item_code, si.item_name, si.unit, SUM(sold.quantity) AS qty, SUM(sold.line_total) AS amount
      FROM sold JOIN stock_item si ON si.stock_item_id = sold.stock_item_id
     GROUP BY si.stock_item_id, si.item_code, si.item_name, si.unit ORDER BY amount DESC LIMIT 8`, [from90, today]);

  const movement = await pool.query(`
    WITH months AS (
      SELECT generate_series(date_trunc('month', $1::date) - interval '5 months', date_trunc('month', $1::date), interval '1 month')::date AS m
    ), mv AS (
      SELECT date_trunc('month', movement_date)::date AS m, SUM(quantity_in) AS qin, SUM(quantity_out) AS qout,
             SUM(value_in) AS vin, SUM(value_out) AS vout
        FROM stock_movement GROUP BY 1
    )
    SELECT to_char(months.m,'YYYY-MM') AS month, COALESCE(mv.qin,0) AS qty_in, COALESCE(mv.qout,0) AS qty_out,
           COALESCE(mv.vin,0) AS value_in, COALESCE(mv.vout,0) AS value_out
      FROM months LEFT JOIN mv ON mv.m = months.m ORDER BY months.m`, [today]);

  const recent = await pool.query(`
    SELECT sm.movement_id, sm.movement_date, sm.movement_type, sm.source_doc_no, sm.quantity_in, sm.quantity_out,
           sm.balance_after, si.item_code, si.item_name, si.stock_item_id
      FROM stock_movement sm JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
     ORDER BY sm.created_at DESC LIMIT 10`);

  res.json({
    asOf: today,
    summary: { items: summary.items, outOfStock: summary.out_of_stock, lowStock: summary.low_stock, valuation: n(summary.valuation), units: n(summary.units) },
    lowStock: low.rows.map((r) => ({ id: r.stock_item_id, code: r.item_code, name: r.item_name, unit: r.unit, qty: n(r.current_qty), minQty: n(r.min_qty), avgCost: n(r.average_cost), value: n(r.inventory_value) })),
    topSelling: top.rows.map((r) => ({ id: r.stock_item_id, code: r.item_code, name: r.item_name, unit: r.unit, qty: n(r.qty), amount: n(r.amount) })),
    movement: movement.rows.map((r) => ({ month: r.month, qtyIn: n(r.qty_in), qtyOut: n(r.qty_out), valueIn: n(r.value_in), valueOut: n(r.value_out) })),
    recent: recent.rows.map((r) => ({
      id: r.movement_id, date: r.movement_date, type: r.movement_type, docNo: r.source_doc_no,
      qtyIn: n(r.quantity_in), qtyOut: n(r.quantity_out), balance: n(r.balance_after),
      code: r.item_code, name: r.item_name, itemId: r.stock_item_id,
    })),
  });
});

// ---------------------------------------------------------------------------
// Accounting reports: P&L, balance sheet, general ledger, journal register
// ---------------------------------------------------------------------------
router.get('/reports/profit-loss', async (req, res) => {
  const to = isoDate(req.query.to, localToday());
  const from = isoDate(req.query.from, `${to.slice(0, 4)}-01-01`);
  const { rows } = await pool.query(`
    SELECT c.account_id, c.account_code, c.account_name, r.reporting_role,
           SUM(CASE WHEN r.reporting_role = 'REVENUE' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END) AS amount
      FROM journal_line jl
      JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
      JOIN account_reporting_role r ON r.account_id = jl.account_id
      JOIN chart_of_accounts c ON c.account_id = jl.account_id
     WHERE r.reporting_role IN ('REVENUE','COGS','EXPENSE') AND je.journal_date BETWEEN $1 AND $2
     GROUP BY c.account_id, c.account_code, c.account_name, r.reporting_role
    HAVING ABS(SUM(CASE WHEN r.reporting_role = 'REVENUE' THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END)) > 0.004
     ORDER BY c.account_code`, [from, to]);
  const revenue = rows.filter((r) => r.reporting_role === 'REVENUE').map((r) => ({ code: r.account_code, name: r.account_name, amount: n(r.amount) }));
  const cogs = rows.filter((r) => r.reporting_role === 'COGS').map((r) => ({ code: r.account_code, name: r.account_name, amount: n(r.amount) }));
  const expenses = rows.filter((r) => r.reporting_role === 'EXPENSE').map((r) => ({ code: r.account_code, name: r.account_name, amount: n(r.amount) }));
  const sum = (a) => a.reduce((s, r) => s + r.amount, 0);
  res.json({
    from, to, revenue, cogs, expenses,
    totalRevenue: sum(revenue), totalCogs: sum(cogs), grossProfit: sum(revenue) - sum(cogs),
    totalExpenses: sum(expenses), netProfit: sum(revenue) - sum(cogs) - sum(expenses),
  });
});

// ---------------------------------------------------------------------------
// Profit & loss by item
//
// Revenue per item is the invoice/cash-sale line total for that period
// (matching how the top-level P&L above recognises revenue: by invoice or
// sale date). Cost of goods sold per item is the stock_movement value_out
// already posted for that same period, for the movement types that
// represent a sale actually leaving the warehouse (SALES_INVOICE,
// CASH_SALE, and DELIVERY_ORDER for the deliver-then-invoice flow), less
// value_in from CREDIT_NOTE returns. That is deliberately the exact cost
// the general ledger already posted - see docs/PNL_BY_ITEM.md - so this
// report's total always reconciles to the COGS line on the P&L above, even
// though for a delivered-then-invoiced sale the cost may have posted in an
// earlier month than the revenue (a pre-existing characteristic of the
// deliver-then-invoice flow, not something this report changes).
// ---------------------------------------------------------------------------
router.get('/reports/pnl-by-item', async (req, res) => {
  const to = isoDate(req.query.to, localToday());
  const from = isoDate(req.query.from, `${to.slice(0, 4)}-01-01`);

  const revenueRows = await pool.query(`
    WITH lines AS (
      SELECT l.stock_item_id, l.description, l.quantity, l.line_total
        FROM sales_invoice_line l JOIN sales_invoice s ON s.invoice_id = l.invoice_id
       WHERE s.status <> 'VOID' AND s.invoice_date BETWEEN $1 AND $2
      UNION ALL
      SELECT l.stock_item_id, l.description, l.quantity, l.line_total
        FROM cash_sale_line l JOIN cash_sale s ON s.cash_sale_id = l.cash_sale_id
       WHERE s.status <> 'VOID' AND s.sale_date BETWEEN $1 AND $2
      UNION ALL
      SELECT l.stock_item_id, l.description, l.quantity, l.line_total
        FROM debit_note_line l JOIN debit_note n ON n.debit_note_id = l.debit_note_id
       WHERE n.status <> 'VOID' AND n.note_date BETWEEN $1 AND $2
      UNION ALL
      SELECT l.stock_item_id, l.description, -l.quantity AS quantity, -l.line_total AS line_total
        FROM credit_note_line l JOIN credit_note n ON n.credit_note_id = l.credit_note_id
       WHERE n.status <> 'VOID' AND n.note_date BETWEEN $1 AND $2
    )
    SELECT COALESCE(lines.stock_item_id::text, '(no item)') AS key, lines.stock_item_id,
           COALESCE(si.item_code, 'SERVICE') AS code, COALESCE(si.item_name, MIN(lines.description)) AS name,
           SUM(lines.quantity) AS qty_sold, SUM(lines.line_total) AS revenue
      FROM lines LEFT JOIN stock_item si ON si.stock_item_id = lines.stock_item_id
     GROUP BY COALESCE(lines.stock_item_id::text, '(no item)'), lines.stock_item_id, si.item_code, si.item_name`, [from, to]);

  const cogsRows = await pool.query(`
    SELECT sm.stock_item_id::text AS key, sm.stock_item_id, si.item_code AS code, si.item_name AS name, si.costing_method,
           SUM(CASE WHEN sm.movement_type IN ('SALES_INVOICE','CASH_SALE','DELIVERY_ORDER') THEN sm.value_out ELSE 0 END
               - CASE WHEN sm.movement_type = 'CREDIT_NOTE' THEN sm.value_in ELSE 0 END) AS cogs
      FROM stock_movement sm JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
     WHERE sm.movement_type IN ('SALES_INVOICE','CASH_SALE','DELIVERY_ORDER','CREDIT_NOTE') AND sm.movement_date BETWEEN $1 AND $2
     GROUP BY sm.stock_item_id, si.item_code, si.item_name, si.costing_method
    HAVING SUM(CASE WHEN sm.movement_type IN ('SALES_INVOICE','CASH_SALE','DELIVERY_ORDER') THEN sm.value_out ELSE 0 END
                - CASE WHEN sm.movement_type = 'CREDIT_NOTE' THEN sm.value_in ELSE 0 END) <> 0`, [from, to]);

  const cogsByKey = new Map(cogsRows.rows.map((r) => [r.key, r]));
  const items = revenueRows.rows.map((r) => {
    const c = r.stock_item_id ? cogsByKey.get(r.stock_item_id) : null;
    const revenue = n(r.revenue);
    const cogs = c ? n(c.cogs) : 0;
    return {
      itemId: r.stock_item_id, code: r.code, name: r.name, costingMethod: c ? c.costing_method : null,
      qtySold: n(r.qty_sold), revenue, cogs, profit: round2(revenue - cogs),
      margin: revenue > 0 ? round2(((revenue - cogs) / revenue) * 100) : null,
    };
  });
  // Items with COGS posted this period but no revenue line matched (e.g. a stand-alone
  // delivery order not yet invoiced still moves cost) still belong on the report.
  for (const c of cogsRows.rows) {
    if (!items.some((it) => it.itemId === c.stock_item_id)) {
      const cogs = n(c.cogs);
      items.push({ itemId: c.stock_item_id, code: c.code, name: c.name, costingMethod: c.costing_method, qtySold: 0, revenue: 0, cogs, profit: round2(-cogs), margin: null });
    }
  }
  items.sort((a, b) => b.profit - a.profit);
  const totals = items.reduce((s, it) => ({ revenue: s.revenue + it.revenue, cogs: s.cogs + it.cogs, profit: s.profit + it.profit }), { revenue: 0, cogs: 0, profit: 0 });
  res.json({ from, to, items, totals: { ...totals, revenue: round2(totals.revenue), cogs: round2(totals.cogs), profit: round2(totals.profit) } });
});

router.get('/reports/balance-sheet', async (req, res) => {
  const asOf = isoDate(req.query.asOf, localToday());
  const { rows } = await pool.query(`
    SELECT c.account_code, c.account_name, c.account_type::text AS account_type,
           COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
      FROM chart_of_accounts c
      LEFT JOIN journal_line jl ON jl.account_id = c.account_id
      LEFT JOIN journal_entry je ON je.journal_id = jl.journal_id
     WHERE je.journal_id IS NULL OR (je.is_posted = TRUE AND je.journal_date <= $1)
     GROUP BY c.account_id, c.account_code, c.account_name, c.account_type
     ORDER BY c.account_code`, [asOf]);
  const pick = (type, sign) => rows.filter((r) => r.account_type === type)
    .map((r) => ({ code: r.account_code, name: r.account_name, amount: sign * (n(r.dr) - n(r.cr)) }))
    .filter((r) => Math.abs(r.amount) > 0.004);
  const assets = pick('ASSET', 1);
  const liabilities = pick('LIABILITY', -1);
  const equity = pick('EQUITY', -1);
  const earnings = rows.filter((r) => r.account_type === 'REVENUE').reduce((s, r) => s + n(r.cr) - n(r.dr), 0)
    - rows.filter((r) => r.account_type === 'EXPENSE').reduce((s, r) => s + n(r.dr) - n(r.cr), 0);
  const sum = (a) => a.reduce((s, r) => s + r.amount, 0);
  res.json({
    asOf, assets, liabilities, equity, currentEarnings: earnings,
    totalAssets: sum(assets), totalLiabilities: sum(liabilities), totalEquity: sum(equity) + earnings,
    isBalanced: Math.abs(sum(assets) - sum(liabilities) - sum(equity) - earnings) < 0.01,
  });
});

router.get('/reports/general-ledger', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId is required' });
  const to = isoDate(req.query.to, localToday());
  const from = isoDate(req.query.from, `${to.slice(0, 4)}-01-01`);
  const acct = (await pool.query(`SELECT account_id, account_code, account_name, account_type::text AS account_type, normal_balance FROM chart_of_accounts WHERE account_id = $1`, [accountId])).rows[0];
  if (!acct) return res.status(404).json({ error: 'Account not found' });
  const sign = acct.normal_balance === 'DR' ? 1 : -1;
  const opening = (await pool.query(`
    SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS bal FROM journal_line jl
      JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
     WHERE jl.account_id = $1 AND je.journal_date < $2`, [accountId, from])).rows[0];
  const lines = await pool.query(`
    SELECT je.journal_id, je.journal_no, je.journal_date, je.source::text AS source, je.description AS journal_description,
           jl.description, jl.debit, jl.credit
      FROM journal_line jl JOIN journal_entry je ON je.journal_id = jl.journal_id AND je.is_posted = TRUE
     WHERE jl.account_id = $1 AND je.journal_date BETWEEN $2 AND $3
     ORDER BY je.journal_date, je.journal_no, jl.line_no LIMIT 1000`, [accountId, from, to]);
  let running = sign * n(opening.bal);
  const out = lines.rows.map((r) => {
    running += sign * (n(r.debit) - n(r.credit));
    return { journalId: r.journal_id, journalNo: r.journal_no, date: r.journal_date, source: r.source, description: r.description || r.journal_description, debit: n(r.debit), credit: n(r.credit), balance: running };
  });
  res.json({
    account: { id: acct.account_id, code: acct.account_code, name: acct.account_name, type: acct.account_type, normalBalance: acct.normal_balance },
    from, to, openingBalance: sign * n(opening.bal), closingBalance: running, lines: out,
    totalDebit: out.reduce((s, r) => s + r.debit, 0), totalCredit: out.reduce((s, r) => s + r.credit, 0),
  });
});

router.get('/reports/journals', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
  const to = isoDate(req.query.to, localToday());
  const from = isoDate(req.query.from, `${to.slice(0, 4)}-01-01`);
  const list = await pool.query(`
    SELECT je.journal_id, je.journal_no, je.journal_date, je.source::text AS source, je.description,
           (SELECT COALESCE(SUM(debit),0) FROM journal_line WHERE journal_id = je.journal_id) AS amount,
           (je.reversal_of_journal_id IS NOT NULL) AS is_reversal
      FROM journal_entry je
     WHERE je.is_posted = TRUE AND je.journal_date BETWEEN $1 AND $2
     ORDER BY je.journal_date DESC, je.journal_no DESC LIMIT $3`, [from, to, limit]);
  const bySource = await pool.query(`
    SELECT je.source::text AS source, COUNT(*)::int AS entries,
           COALESCE(SUM((SELECT SUM(debit) FROM journal_line WHERE journal_id = je.journal_id)),0) AS amount
      FROM journal_entry je WHERE je.is_posted = TRUE AND je.journal_date BETWEEN $1 AND $2
     GROUP BY je.source ORDER BY entries DESC`, [from, to]);
  res.json({
    from, to,
    journals: list.rows.map((r) => ({ id: r.journal_id, no: r.journal_no, date: r.journal_date, source: r.source, description: r.description, amount: n(r.amount), isReversal: r.is_reversal })),
    bySource: bySource.rows.map((r) => ({ source: r.source, entries: r.entries, amount: n(r.amount) })),
  });
});

module.exports = router;
