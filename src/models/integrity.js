async function getGLIntegrity(client) {
  const issues = [];

  const { rows: journalIssues } = await client.query(`
    SELECT je.journal_id, je.journal_no,
           COALESCE(SUM(jl.debit),0) AS total_debit,
           COALESCE(SUM(jl.credit),0) AS total_credit,
           COUNT(jl.line_id)::int AS line_count
      FROM journal_entry je
      LEFT JOIN journal_line jl ON jl.journal_id=je.journal_id
     WHERE je.is_posted=TRUE
     GROUP BY je.journal_id,je.journal_no
    HAVING COUNT(jl.line_id)=0
        OR ABS(COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0)) > 0.005
     ORDER BY je.journal_no`);
  for (const r of journalIssues) issues.push({
    code: r.line_count === 0 ? 'POSTED_JOURNAL_NO_LINES' : 'UNBALANCED_POSTED_JOURNAL',
    severity: 'ERROR',
    reference: r.journal_no,
    detail: r.line_count === 0
      ? 'Posted journal has no journal lines.'
      : `Posted journal is not balanced: DR ${Number(r.total_debit).toFixed(2)} vs CR ${Number(r.total_credit).toFixed(2)}.`,
  });

  const { rows: cutoverRows } = await client.query(`
    SELECT cutover_at, cutover_date, opening_inventory_journal_id
      FROM gl_hardening_cutover
     WHERE cutover_id=TRUE`);
  const cutover = cutoverRows[0] || null;

  const sourceChecks = [
    ['SALES_INVOICE','sales_invoice','invoice_id','journal_id','status','VOID'],
    ['CASH_SALE','cash_sale','cash_sale_id','journal_id','status','VOID'],
    ['PURCHASE_INVOICE','purchase_invoice','purchase_invoice_id','journal_id','status','VOID'],
    ['CASH_PURCHASE','cash_purchase','cash_purchase_id','journal_id','status','VOID'],
    ['RECEIPT','receipt','receipt_id','journal_id','status','VOID'],
    ['PAYMENT','payment','payment_id','journal_id','status','VOID'],
    ['GRN','goods_received_note','grn_id','journal_id','status','VOID'],
    ['DELIVERY_ORDER','delivery_order','delivery_order_id','journal_id','status','CANCELLED'],
    ['CREDIT_NOTE','credit_note','credit_note_id','journal_id','status','VOID'],
    ['DEBIT_NOTE','debit_note','debit_note_id','journal_id','status','VOID'],
    ['PAYMENT_VOUCHER','payment_voucher','pv_id','journal_id','status','VOID'],
    ['OFFICIAL_RECEIPT','official_receipt','or_id','journal_id','status','VOID'],
  ];
  for (const [label, table, idCol, journalCol, statusCol, voidStatus] of sourceChecks) {
    let extra = '';
    const params = [voidStatus];
    if (label === 'DELIVERY_ORDER') {
      extra = ` AND EXISTS (
        SELECT 1 FROM stock_movement sm
         WHERE sm.source_doc_id=${table}.${idCol}
           AND sm.movement_type='DELIVERY_ORDER'
           AND sm.value_out > 0.01
      )`;
    }
    const { rows } = await client.query(
      `SELECT ${idCol} AS id, created_at FROM ${table}
        WHERE ${statusCol} <> $1 ${extra} AND ${journalCol} IS NULL LIMIT 100`,
      params
    );
    for (const r of rows) {
      const legacy = cutover && r.created_at && new Date(r.created_at) < new Date(cutover.cutover_at);
      issues.push({
        code: 'POSTED_DOCUMENT_MISSING_JOURNAL',
        severity: legacy ? 'INFO' : 'ERROR',
        reference: `${label}:${r.id}`,
        detail: legacy
          ? `${label} predates the GL hardening cut-over and has no journal_id; retained as a legacy finding.`
          : `${label} was created after the GL hardening cut-over but has no journal_id.`,
      });
    }
  }

  // An active document with a journal_id must point to a real, posted
  // journal for the same document. A non-null foreign key alone is not enough
  // to establish a valid audit trail.
  const { rows: brokenJournalLinks } = await client.query(`
    SELECT * FROM (
      SELECT 'SALES_INVOICE' AS label, s.invoice_id AS id, s.journal_id,
             je.is_posted, je.source_doc_id, je.source, 'AR' AS expected_source
        FROM sales_invoice s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'CASH_SALE', s.cash_sale_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'CASH_SALE'
        FROM cash_sale s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'PURCHASE_INVOICE', s.purchase_invoice_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'AP'
        FROM purchase_invoice s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'CASH_PURCHASE', s.cash_purchase_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'AP'
        FROM cash_purchase s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'GRN', s.grn_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'AP'
        FROM goods_received_note s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'DELIVERY_ORDER', s.delivery_order_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'AR'
        FROM delivery_order s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'CANCELLED' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'CREDIT_NOTE', s.credit_note_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'AR'
        FROM credit_note s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'DEBIT_NOTE', s.debit_note_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'AR'
        FROM debit_note s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'PAYMENT_VOUCHER', s.pv_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'BANK'
        FROM payment_voucher s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
      UNION ALL
      SELECT 'OFFICIAL_RECEIPT', s.or_id, s.journal_id, je.is_posted, je.source_doc_id, je.source, 'BANK'
        FROM official_receipt s LEFT JOIN journal_entry je ON je.journal_id=s.journal_id
       WHERE s.status <> 'VOID' AND s.journal_id IS NOT NULL
    ) x
    WHERE x.is_posted IS DISTINCT FROM TRUE
       OR x.source_doc_id IS DISTINCT FROM x.id
       OR x.source::text IS DISTINCT FROM x.expected_source
    LIMIT 200`);
  for (const r of brokenJournalLinks) issues.push({
    code:'POSTED_DOCUMENT_JOURNAL_LINK_INVALID', severity:'ERROR', reference:`${r.label}:${r.id}`,
    detail:`Active document journal link is invalid: journal must be posted, reference the same document, and use source ${r.expected_source}.`,
  });

  // Post-cutover GRNs that contain stock items must debit Inventory, not an
  // expense/COGS account. We deliberately flag only records created after the
  // hardening cut-over; historical journals remain audit-preserved.
  const { rows: grnPurchaseIssues } = await client.query(`
    WITH grns AS (
      SELECT grn.grn_id, grn.grn_no, grn.created_at,
             COALESCE(SUM(CASE WHEN gl.stock_item_id IS NOT NULL THEN gl.line_total ELSE 0 END),0) AS stock_value,
             COALESCE(SUM(CASE WHEN gl.stock_item_id IS NULL THEN gl.line_total ELSE 0 END),0) AS nonstock_expense_value
        FROM goods_received_note grn
        JOIN grn_line gl ON gl.grn_id = grn.grn_id
       WHERE grn.status <> 'VOID'
         AND $1::timestamptz IS NOT NULL
         AND grn.created_at >= $1::timestamptz
       GROUP BY grn.grn_id, grn.grn_no, grn.created_at
      HAVING COALESCE(SUM(CASE WHEN gl.stock_item_id IS NOT NULL THEN gl.line_total ELSE 0 END),0) > 0.01
    ),
    journal_expense AS (
      SELECT je.source_doc_id,
             COALESCE(SUM(jl.debit),0) AS expense_debit
        FROM journal_entry je
        JOIN journal_line jl ON jl.journal_id = je.journal_id
        JOIN chart_of_accounts a ON a.account_id = jl.account_id
       WHERE je.is_posted = TRUE
         AND je.reversal_of_journal_id IS NULL
         AND a.account_type = 'EXPENSE'
       GROUP BY je.source_doc_id
    )
    SELECT g.grn_id, g.grn_no, g.created_at, g.stock_value,
           g.nonstock_expense_value,
           COALESCE(e.expense_debit,0) AS expense_debit
      FROM grns g
      LEFT JOIN journal_expense e ON e.source_doc_id = g.grn_id
     WHERE ABS(COALESCE(e.expense_debit,0) - g.nonstock_expense_value) > 0.01
     ORDER BY g.created_at, g.grn_no
     LIMIT 200`, [cutover ? cutover.cutover_at : null]);
  for (const r of grnPurchaseIssues) {
    issues.push({
      code:'POSTED_GRN_STOCK_TO_EXPENSE',
      severity:'ERROR',
      reference:`GRN:${r.grn_no || r.grn_id}`,
      detail:`Post-cutover GRN has stock value RM${Number(r.stock_value).toFixed(2)} but expense-account debits total RM${Number(r.expense_debit).toFixed(2)}; expected non-stock expense debit RM${Number(r.nonstock_expense_value).toFixed(2)}. Stock receipts must debit Inventory, not COGS/Expense.`,
    });
  }

  // Active stock items that are already used by the ledger must have a valid
  // Inventory (ASSET) and COGS (EXPENSE) mapping. This prevents a balanced
  // journal from still being semantically wrong. New, unused items are left
  // alone so maintenance can configure them before first use.
  const { rows: stockAccountIssues } = await client.query(`
    SELECT si.item_code,
           si.default_inventory_account_id, inv.account_code AS inventory_account_code,
           inv.account_type AS inventory_account_type, inv.is_active AS inventory_active,
           si.default_cogs_account_id, cogs.account_code AS cogs_account_code,
           cogs.account_type AS cogs_account_type, cogs.is_active AS cogs_active
      FROM stock_item si
      LEFT JOIN chart_of_accounts inv ON inv.account_id = si.default_inventory_account_id
      LEFT JOIN chart_of_accounts cogs ON cogs.account_id = si.default_cogs_account_id
     WHERE si.is_active = TRUE
       AND (si.current_qty <> 0 OR ABS(si.inventory_value) > 0.01
            OR EXISTS (SELECT 1 FROM stock_movement sm WHERE sm.stock_item_id = si.stock_item_id))
       AND (si.default_inventory_account_id IS NULL OR inv.is_active IS DISTINCT FROM TRUE OR inv.account_type <> 'ASSET'
            OR si.default_cogs_account_id IS NULL OR cogs.is_active IS DISTINCT FROM TRUE OR cogs.account_type <> 'EXPENSE')
     ORDER BY si.item_code
     LIMIT 200`);
  for (const r of stockAccountIssues) issues.push({
    code:'STOCK_ACCOUNT_MAPPING_INVALID', severity:'ERROR', reference:r.item_code,
    detail:`Stock item account mapping is invalid: Inventory ${r.inventory_account_code || 'missing'} (${r.inventory_account_type || 'unknown'}) / COGS ${r.cogs_account_code || 'missing'} (${r.cogs_account_type || 'unknown'}). Inventory must be an active ASSET and COGS must be an active EXPENSE.`,
  });

  // For new/post-cutover stock transactions, the exact stock value must agree
  // with the corresponding Inventory/COGS journal lines. Account type checks
  // alone are not enough: DR COGS RM100 / CR Inventory RM100 would balance even
  // when the stock movement is only RM50.
  const { rows: stockInAmountIssues } = await client.query(`
    WITH stock_docs AS (
      SELECT sm.source_doc_id AS id, sm.stock_item_id, sm.value_in, si.default_inventory_account_id AS inventory_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN goods_received_note d ON d.grn_id = sm.source_doc_id
       WHERE sm.movement_type='GRN' AND sm.value_in > 0.01 AND d.status <> 'VOID'
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
      UNION ALL
      SELECT sm.source_doc_id, sm.stock_item_id, sm.value_in, si.default_inventory_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN purchase_invoice d ON d.purchase_invoice_id = sm.source_doc_id
       WHERE sm.movement_type='PURCHASE_INVOICE' AND sm.value_in > 0.01 AND d.status <> 'VOID'
         AND d.grn_id IS NULL
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
      UNION ALL
      SELECT sm.source_doc_id, sm.stock_item_id, sm.value_in, si.default_inventory_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN cash_purchase d ON d.cash_purchase_id = sm.source_doc_id
       WHERE sm.movement_type='CASH_PURCHASE' AND sm.value_in > 0.01 AND d.status <> 'VOID'
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
    ), expected AS (
      SELECT id AS source_doc_id, inventory_account_id AS account_id,
             ROUND(SUM(value_in),2) AS expected_debit, 0::numeric AS expected_credit
        FROM stock_docs
       GROUP BY id, inventory_account_id
    ), actual AS (
      SELECT je.source_doc_id, jl.account_id,
             ROUND(SUM(jl.debit),2) AS actual_debit,
             ROUND(SUM(jl.credit),2) AS actual_credit
        FROM journal_entry je
        JOIN journal_line jl ON jl.journal_id = je.journal_id
       WHERE je.is_posted=TRUE AND je.reversal_of_journal_id IS NULL
       GROUP BY je.source_doc_id, jl.account_id
    )
    SELECT e.source_doc_id, e.account_id, e.expected_debit,
           COALESCE(a.actual_debit,0) AS actual_debit, COALESCE(a.actual_credit,0) AS actual_credit
      FROM expected e
      LEFT JOIN actual a ON a.source_doc_id=e.source_doc_id AND a.account_id=e.account_id
     WHERE ABS(COALESCE(a.actual_debit,0)-e.expected_debit)>0.01
        OR ABS(COALESCE(a.actual_credit,0)-e.expected_credit)>0.01
     LIMIT 200`, [cutover ? cutover.cutover_at : null]);
  for (const r of stockInAmountIssues) issues.push({
    code:'STOCK_IN_GL_AMOUNT_MISMATCH', severity:'ERROR', reference:`STOCK_IN:${r.source_doc_id}`,
    detail:`Stock receipt expects Inventory debit RM${Number(r.expected_debit).toFixed(2)} on account ${r.account_id}, but posted journal has DR RM${Number(r.actual_debit).toFixed(2)} / CR RM${Number(r.actual_credit).toFixed(2)} on that account.`,
  });

  const { rows: stockOutAmountIssues } = await client.query(`
    WITH stock_docs AS (
      SELECT sm.source_doc_id AS id, sm.value_out, si.default_cogs_account_id AS cogs_account_id, si.default_inventory_account_id AS inventory_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN delivery_order d ON d.delivery_order_id = sm.source_doc_id
       WHERE sm.movement_type='DELIVERY_ORDER' AND sm.value_out > 0.01 AND d.status <> 'CANCELLED'
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
      UNION ALL
      SELECT sm.source_doc_id, sm.value_out, si.default_cogs_account_id, si.default_inventory_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN sales_invoice d ON d.invoice_id = sm.source_doc_id
       WHERE sm.movement_type='SALES_INVOICE' AND sm.value_out > 0.01 AND d.status <> 'VOID'
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
      UNION ALL
      SELECT sm.source_doc_id, sm.value_out, si.default_cogs_account_id, si.default_inventory_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN cash_sale d ON d.cash_sale_id = sm.source_doc_id
       WHERE sm.movement_type='CASH_SALE' AND sm.value_out > 0.01 AND d.status <> 'VOID'
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
    ), expected AS (
      SELECT id AS source_doc_id, cogs_account_id AS account_id,
             ROUND(SUM(value_out),2) AS expected_debit, 0::numeric AS expected_credit
        FROM stock_docs
       GROUP BY id, cogs_account_id
      UNION ALL
      SELECT id AS source_doc_id, inventory_account_id AS account_id,
             0::numeric AS expected_debit, ROUND(SUM(value_out),2) AS expected_credit
        FROM stock_docs
       GROUP BY id, inventory_account_id
    ), actual AS (
      SELECT je.source_doc_id, jl.account_id,
             ROUND(SUM(jl.debit),2) AS actual_debit,
             ROUND(SUM(jl.credit),2) AS actual_credit
        FROM journal_entry je
        JOIN journal_line jl ON jl.journal_id=je.journal_id
       WHERE je.is_posted=TRUE AND je.reversal_of_journal_id IS NULL
       GROUP BY je.source_doc_id, jl.account_id
    )
    SELECT e.source_doc_id, e.account_id, e.expected_debit, e.expected_credit,
           COALESCE(a.actual_debit,0) AS actual_debit, COALESCE(a.actual_credit,0) AS actual_credit
      FROM expected e
      LEFT JOIN actual a ON a.source_doc_id=e.source_doc_id AND a.account_id=e.account_id
     WHERE ABS(COALESCE(a.actual_debit,0)-e.expected_debit)>0.01
        OR ABS(COALESCE(a.actual_credit,0)-e.expected_credit)>0.01
     LIMIT 400`, [cutover ? cutover.cutover_at : null]);
  for (const r of stockOutAmountIssues) issues.push({
    code:'STOCK_OUT_GL_AMOUNT_MISMATCH', severity:'ERROR', reference:`STOCK_OUT:${r.source_doc_id}`,
    detail:`Stock issue expects account ${r.account_id} DR RM${Number(r.expected_debit).toFixed(2)} / CR RM${Number(r.expected_credit).toFixed(2)}, but posted journal has DR RM${Number(r.actual_debit).toFixed(2)} / CR RM${Number(r.actual_credit).toFixed(2)}.`,
  });

  const { rows: stockReturnAmountIssues } = await client.query(`
    WITH stock_docs AS (
      SELECT sm.source_doc_id AS id, sm.value_in, si.default_inventory_account_id AS inventory_account_id, si.default_cogs_account_id AS cogs_account_id, d.created_at
        FROM stock_movement sm
        JOIN stock_item si ON si.stock_item_id = sm.stock_item_id
        JOIN credit_note d ON d.credit_note_id = sm.source_doc_id
       WHERE sm.movement_type='CREDIT_NOTE' AND sm.value_in > 0.01 AND d.status <> 'VOID'
         AND d.return_goods=TRUE
         AND $1::timestamptz IS NOT NULL AND d.created_at >= $1::timestamptz
    ), expected AS (
      SELECT id AS source_doc_id, inventory_account_id AS account_id,
             ROUND(SUM(value_in),2) AS expected_debit, 0::numeric AS expected_credit
        FROM stock_docs GROUP BY id, inventory_account_id
      UNION ALL
      SELECT id AS source_doc_id, cogs_account_id AS account_id,
             0::numeric AS expected_debit, ROUND(SUM(value_in),2) AS expected_credit
        FROM stock_docs GROUP BY id, cogs_account_id
    ), actual AS (
      SELECT je.source_doc_id, jl.account_id,
             ROUND(SUM(jl.debit),2) AS actual_debit,
             ROUND(SUM(jl.credit),2) AS actual_credit
        FROM journal_entry je
        JOIN journal_line jl ON jl.journal_id=je.journal_id
       WHERE je.is_posted=TRUE AND je.reversal_of_journal_id IS NULL
       GROUP BY je.source_doc_id, jl.account_id
    )
    SELECT e.source_doc_id, e.account_id, e.expected_debit, e.expected_credit,
           COALESCE(a.actual_debit,0) AS actual_debit, COALESCE(a.actual_credit,0) AS actual_credit
      FROM expected e
      LEFT JOIN actual a ON a.source_doc_id=e.source_doc_id AND a.account_id=e.account_id
     WHERE ABS(COALESCE(a.actual_debit,0)-e.expected_debit)>0.01
        OR ABS(COALESCE(a.actual_credit,0)-e.expected_credit)>0.01
     LIMIT 200`, [cutover ? cutover.cutover_at : null]);
  for (const r of stockReturnAmountIssues) issues.push({
    code:'STOCK_RETURN_GL_AMOUNT_MISMATCH', severity:'ERROR', reference:`CREDIT_NOTE:${r.source_doc_id}`,
    detail:`Stock return expects account ${r.account_id} DR RM${Number(r.expected_debit).toFixed(2)} / CR RM${Number(r.expected_credit).toFixed(2)}, but posted journal has DR RM${Number(r.actual_debit).toFixed(2)} / CR RM${Number(r.actual_credit).toFixed(2)}.`,
  });

  const { rows: stockReconcile } = await client.query(`
    SELECT si.stock_item_id, si.item_code, si.current_qty, si.inventory_value,
           COALESCE(SUM(sm.quantity_in-sm.quantity_out),0) AS movement_qty,
           COALESCE(SUM(sm.value_in-sm.value_out),0) AS movement_value
      FROM stock_item si
      LEFT JOIN stock_movement sm ON sm.stock_item_id=si.stock_item_id
     GROUP BY si.stock_item_id,si.item_code,si.current_qty,si.inventory_value
    HAVING ABS(si.current_qty-COALESCE(SUM(sm.quantity_in-sm.quantity_out),0)) > 0.0001
        OR ABS(si.inventory_value-COALESCE(SUM(sm.value_in-sm.value_out),0)) > 0.01
     ORDER BY si.item_code
     LIMIT 200`);
  for (const r of stockReconcile) issues.push({
    code:'STOCK_LEDGER_MISMATCH', severity:'ERROR', reference:r.item_code,
    detail:`Stock balance/value does not agree with stock movements (qty ${r.current_qty} vs ${r.movement_qty}; value ${Number(r.inventory_value).toFixed(2)} vs ${Number(r.movement_value).toFixed(2)}).`,
  });

  const { rows: negativeStock } = await client.query(`
    SELECT item_code,current_qty,inventory_value
      FROM stock_item
     WHERE current_qty < -0.0001 OR inventory_value < -0.01
     ORDER BY item_code LIMIT 200`);
  for (const r of negativeStock) issues.push({
    code:'NEGATIVE_STOCK_OR_VALUE', severity:'ERROR', reference:r.item_code,
    detail:`Negative stock/value detected: qty ${r.current_qty}, value ${Number(r.inventory_value).toFixed(2)}.`,
  });

  const { rows: inventoryRecon } = await client.query(`
    WITH inventory_accounts AS (
      SELECT DISTINCT default_inventory_account_id AS account_id
        FROM stock_item
       WHERE default_inventory_account_id IS NOT NULL
    ),
    stock_value AS (
      SELECT COALESCE(SUM(inventory_value),0) AS value FROM stock_item
    ),
    gl_value AS (
      SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS value
        FROM journal_line jl
        JOIN journal_entry je ON je.journal_id=jl.journal_id AND je.is_posted=TRUE
        JOIN inventory_accounts ia ON ia.account_id=jl.account_id
    )
    SELECT stock_value.value AS stock_value, gl_value.value AS gl_value,
           ABS(stock_value.value-gl_value.value) AS difference
      FROM stock_value CROSS JOIN gl_value
     WHERE ABS(stock_value.value-gl_value.value) > 0.01`);
  for (const r of inventoryRecon) issues.push({
    code:'INVENTORY_GL_RECONCILIATION_MISMATCH', severity:'ERROR', reference:'INVENTORY',
    detail:`Stock valuation is RM${Number(r.stock_value).toFixed(2)} but the related Inventory GL accounts net to RM${Number(r.gl_value).toFixed(2)} (difference RM${Number(r.difference).toFixed(2)}).`,
  });

  const { rows: costingIssues } = await client.query(`
    WITH stock_docs AS (
      SELECT sm.source_doc_id AS id, 'STOCK_OUT' AS kind, 'delivery_order' AS doc_table, d.created_at
        FROM stock_movement sm
        JOIN delivery_order d ON d.delivery_order_id = sm.source_doc_id
       WHERE sm.quantity_out > 0
         AND sm.value_out > 0.01
         AND sm.movement_type = 'DELIVERY_ORDER'
         AND d.status <> 'CANCELLED'
       GROUP BY sm.source_doc_id, d.created_at
      UNION ALL
      SELECT sm.source_doc_id, 'STOCK_OUT', 'sales_invoice', si.created_at
        FROM stock_movement sm
        JOIN sales_invoice si ON si.invoice_id = sm.source_doc_id
       WHERE sm.quantity_out > 0
         AND sm.value_out > 0.01
         AND sm.movement_type = 'SALES_INVOICE'
         AND si.status <> 'VOID'
       GROUP BY sm.source_doc_id, si.created_at
      UNION ALL
      SELECT sm.source_doc_id, 'STOCK_OUT', 'cash_sale', cs.created_at
        FROM stock_movement sm
        JOIN cash_sale cs ON cs.cash_sale_id = sm.source_doc_id
       WHERE sm.quantity_out > 0
         AND sm.value_out > 0.01
         AND sm.movement_type = 'CASH_SALE'
         AND cs.status <> 'VOID'
       GROUP BY sm.source_doc_id, cs.created_at
      UNION ALL
      SELECT sm.source_doc_id, 'STOCK_RETURN', 'credit_note', cn.created_at
        FROM stock_movement sm
        JOIN credit_note cn ON cn.credit_note_id = sm.source_doc_id
       WHERE sm.quantity_in > 0
         AND sm.value_in > 0.01
         AND sm.movement_type='CREDIT_NOTE'
         AND cn.status <> 'VOID'
       GROUP BY sm.source_doc_id, cn.created_at
    ), linked AS (
      SELECT sd.id, sd.kind, sd.created_at, je.journal_id
        FROM stock_docs sd
        LEFT JOIN journal_entry je
          ON je.source_doc_id=sd.id
         AND je.is_posted=TRUE
         AND je.reversal_of_journal_id IS NULL
    )
    SELECT l.id,l.kind,l.created_at,l.journal_id
      FROM linked l
     WHERE l.journal_id IS NULL
        OR (l.kind='STOCK_OUT' AND NOT EXISTS (
             SELECT 1 FROM journal_line x JOIN chart_of_accounts a ON a.account_id=x.account_id
              WHERE x.journal_id=l.journal_id AND x.debit>0 AND a.account_type='EXPENSE'
           ))
        OR (l.kind='STOCK_OUT' AND NOT EXISTS (
             SELECT 1 FROM journal_line x JOIN chart_of_accounts a ON a.account_id=x.account_id
              WHERE x.journal_id=l.journal_id AND x.credit>0 AND a.account_type='ASSET'
           ))
        OR (l.kind='STOCK_RETURN' AND NOT EXISTS (
             SELECT 1 FROM journal_line x JOIN chart_of_accounts a ON a.account_id=x.account_id
              WHERE x.journal_id=l.journal_id AND x.debit>0 AND a.account_type='ASSET'
           ))
     GROUP BY l.id,l.kind,l.created_at,l.journal_id
     LIMIT 200`);
  for (const r of costingIssues) {
    const legacy = cutover && r.created_at && new Date(r.created_at) < new Date(cutover.cutover_at);
    issues.push({
      code:'STOCK_DOCUMENT_COSTING_MISSING',
      severity: legacy ? 'INFO' : 'ERROR',
      reference:`${r.kind}:${r.id}`,
      detail: legacy
        ? 'Stock movement predates the GL hardening cut-over and its original posting does not show the expected Inventory / COGS side; retained as a legacy finding.'
        : 'Active stock movement was created after the GL hardening cut-over but its posted journal does not show the expected Inventory / COGS side.',
    });
  }


  const { rows: fifoLayerIssues } = await client.query(`
    SELECT si.item_code, si.current_qty, COALESCE(SUM(sl.qty_remaining) FILTER (WHERE sl.is_active_layer=TRUE),0) AS fifo_qty,
           COALESCE(SUM(sl.qty_received * sl.unit_cost) FILTER (WHERE sl.is_active_layer=TRUE),0) AS fifo_value
      FROM stock_item si
      LEFT JOIN stock_lot sl ON sl.stock_item_id=si.stock_item_id
     WHERE si.costing_method='FIFO'
     GROUP BY si.stock_item_id, si.item_code, si.current_qty
    HAVING ABS(si.current_qty-COALESCE(SUM(sl.qty_remaining) FILTER (WHERE sl.is_active_layer=TRUE),0)) > 0.0001
    ORDER BY si.item_code LIMIT 200`);
  for (const r of fifoLayerIssues) issues.push({
    code:'FIFO_ACTIVE_LAYER_MISMATCH', severity:'ERROR', reference:r.item_code,
    detail:`FIFO active layers total ${Number(r.fifo_qty).toFixed(4)} unit(s) but stock balance is ${Number(r.current_qty).toFixed(4)}. FIFO layers must equal on-hand quantity.`
  });

  const { rows: fifoConsumptionIssues } = await client.query(`
    SELECT sl.lot_id, sl.source_doc_no, sl.qty_received,
           COALESCE(SUM(c.quantity),0) AS consumed_qty
      FROM stock_lot sl
      LEFT JOIN stock_lot_consumption c ON c.lot_id=sl.lot_id
     GROUP BY sl.lot_id, sl.source_doc_no, sl.qty_received
    HAVING COALESCE(SUM(c.quantity),0) > sl.qty_received + 0.0001
    ORDER BY sl.source_doc_no LIMIT 200`);
  for (const r of fifoConsumptionIssues) issues.push({
    code:'FIFO_LOT_OVERCONSUMED', severity:'ERROR', reference:r.lot_id,
    detail:`FIFO lot ${r.source_doc_no || r.lot_id} has ${Number(r.consumed_qty).toFixed(4)} consumed against ${Number(r.qty_received).toFixed(4)} received.`
  });

  const { rows: cashBookIssues } = await client.query(`
    SELECT 'PAYMENT_VOUCHER' AS label, p.pv_id AS id, p.pv_no AS doc_no,
           r.account_code, r.account_name, r.reporting_role
      FROM payment_voucher p
      JOIN payment_voucher_line l ON l.pv_id=p.pv_id
      JOIN account_reporting_role r ON r.account_id=l.account_id
     WHERE p.status <> 'VOID'
       AND (r.is_control_account OR r.is_inventory_account OR r.is_cash_account OR r.is_receivable_account OR r.is_payable_account OR r.is_grir_account)
    UNION ALL
    SELECT 'OFFICIAL_RECEIPT', p.or_id, p.or_no,
           r.account_code, r.account_name, r.reporting_role
      FROM official_receipt p
      JOIN official_receipt_line l ON l.or_id=p.or_id
      JOIN account_reporting_role r ON r.account_id=l.account_id
     WHERE p.status <> 'VOID'
       AND (r.is_control_account OR r.is_inventory_account OR r.is_cash_account OR r.is_receivable_account OR r.is_payable_account OR r.is_grir_account)
    LIMIT 200`);
  for (const r of cashBookIssues) issues.push({
    code:'CASH_BOOK_CONTROL_ACCOUNT_POSTING', severity:'ERROR', reference:`${r.label}:${r.doc_no || r.id}`,
    detail:`Active ${r.label.replace('_',' ')} uses restricted account ${r.account_code} ${r.account_name} (${r.reporting_role}); PV/OR offset lines may not use Cash/Bank, Inventory, Receivable, Payable or GR/IR control accounts.`
  });

  const errorCount = issues.filter(x => x.severity === 'ERROR').length;
  const warningCount = issues.filter(x => x.severity === 'WARNING').length;
  const infoCount = issues.filter(x => x.severity === 'INFO').length;
  return {
    ok: errorCount === 0,
    issueCount: issues.length,
    errorCount,
    warningCount,
    infoCount,
    issues,
    cutover,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { getGLIntegrity };
