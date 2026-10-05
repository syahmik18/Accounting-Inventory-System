const { v4: uuidv4 } = require('uuid');
const { nextDocumentNo } = require('./documentNumber');
const { resolveLineAccount, getStockAccountingAccounts } = require('./stock');

/**
 * Purchase Order - step 2 of the procurement cycle.
 * Also has NO journal posting: a PO is a commitment to a vendor, not an
 * economic event yet - same reason purchase orders are "off-balance-
 * sheet" in real accounting until goods/services actually show up.
 * The GL only gets touched starting at Goods Received Note.
 *
 * Stock lines use the stock item's Inventory / COGS account mapping and
 * do not require a legacy expense account. Non-stock lines still require
 * an Expense account, validated server-side.
 */
async function createPurchaseOrder(client, { poNo, partnerId, prId, orderDate, expectedDate, lines, createdBy }) {
  let subtotal = 0, taxAmount = 0;
  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPrice;
    l.line_total = lineTotal;
    subtotal += lineTotal;
    taxAmount += lineTotal * (l.taxRate || 0) / 100;
    if (l.stockItemId) {
      await getStockAccountingAccounts(client, l.stockItemId);
      l.expenseAccountId = null;
    } else {
      l.expenseAccountId = await resolveLineAccount(client, {
        stockItemId: null,
        manualAccountId: l.expenseAccountId,
        direction: 'PURCHASE',
      });
    }
  }
  const totalAmount = subtotal + taxAmount;
  const finalPoNo = String(poNo || '').trim() || await nextDocumentNo(client, 'PURCHASE_ORDER', orderDate);

  const poId = uuidv4();
  await client.query(
    `INSERT INTO purchase_order
       (po_id, po_no, pr_id, partner_id, order_date, expected_date, status,
        subtotal, tax_amount, total_amount, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'SENT',$7,$8,$9,$10)`,
    [poId, finalPoNo, prId || null, partnerId, orderDate, expectedDate || null, subtotal, taxAmount, totalAmount, createdBy || 'system']
  );

  let lineNo = 1;
  for (const l of lines) {
    await client.query(
      `INSERT INTO purchase_order_line       (line_id, po_id, item_code, stock_item_id, description, quantity, unit_price,
          tax_rate, line_total, expense_account_id, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), poId, l.itemCode || null, l.stockItemId || null, l.description, l.quantity,
       l.unitPrice, l.taxRate || 0, l.line_total, l.expenseAccountId, lineNo++]
    );
  }

  if (prId) {
    await client.query(
      `UPDATE purchase_request SET status = 'CONVERTED' WHERE pr_id = $1 AND status = 'APPROVED'`,
      [prId]
    );
  }

  return { poId, poNo: finalPoNo, subtotal, taxAmount, totalAmount };
}

/** Recomputes a PO's receiving status from its lines - called after each GRN. */
async function refreshPurchaseOrderStatus(client, poId) {
  const { rows } = await client.query(
    `SELECT quantity, quantity_received FROM purchase_order_line WHERE po_id = $1`,
    [poId]
  );
  const fullyReceived = rows.every((r) => Number(r.quantity_received) >= Number(r.quantity));
  const anyReceived = rows.some((r) => Number(r.quantity_received) > 0);
  const status = fullyReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : 'SENT';
  await client.query(`UPDATE purchase_order SET status = $1 WHERE po_id = $2`, [status, poId]);
  return status;
}

module.exports = { createPurchaseOrder, refreshPurchaseOrderStatus };
