const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
const { moveStockForLines, resolveLineAccount, getStockAccountingAccounts } = require('./stock');
const { resolveLineTax, resolveTaxCodeForLine } = require('./tax');
const { nextDocumentNo } = require('./documentNumber');

/**
 * Create a cash purchase AND post its GL journal atomically.
 * Step 5 of the procurement cycle - the "no PR, no PO, no GRN, just
 * paid it" path for petty cash / over-the-counter buys. Direct mirror
 * of createAndPostCashSale(), sides flipped:
 *
 *   DR  Inventory (stock line) / Expense (non-stock line)  (line subtotal) -
 *                                    stock lines use the item Inventory account;
 *                                    non-stock lines use a validated manual account.
 *   DR  <tax account> (per code)     (tax_amount) - resolved per line's
 *                                    tax code, grouped by account
 *   CR  Cash/Bank (whichever account paid)                 (total_amount)
 *
 * Recognized and paid in the same document - same as cash_sale never
 * touches AR, this never touches AP or GR/IR.
 */
async function createAndPostCashPurchase(client, { cashPurchaseNo, partnerId, purchaseDate, paymentMethod, cashAccountId, lines, createdBy }) {
  let subtotal = 0, taxAmount = 0;
  const taxByAccount = new Map();

  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPrice;
    l.line_total = lineTotal;
    subtotal += lineTotal;

    if (l.stockItemId) {
      const accounts = await getStockAccountingAccounts(client, l.stockItemId);
      l.inventoryAccountId = accounts.inventoryAccountId;
      l.expenseAccountId = null;
    } else {
      l.expenseAccountId = await resolveLineAccount(client, {
        stockItemId: null, manualAccountId: l.expenseAccountId, direction: 'PURCHASE',
      });
    }

    const resolvedTaxCodeId = await resolveTaxCodeForLine(client, {
      stockItemId: l.stockItemId, explicitTaxCodeId: l.taxCodeId, direction: 'PURCHASE',
    });
    if (l.stockItemId) { const r = await client.query(`SELECT default_inventory_account_id FROM stock_item WHERE stock_item_id=$1`, [l.stockItemId]); if (!r.rows.length || !r.rows[0].default_inventory_account_id) throw new Error(`Stock item ${l.stockItemId} has no inventory account`); l.inventoryAccountId = r.rows[0].default_inventory_account_id; }

    const tax = await resolveLineTax(client, { taxCodeId: resolvedTaxCodeId, lineAmount: lineTotal });
    l.taxCodeId = tax.taxCodeId;
    l.taxRate = tax.rate;
    taxAmount += tax.taxAmount;
    if (tax.taxAmount > 0) {
      taxByAccount.set(tax.taxAccountId, (taxByAccount.get(tax.taxAccountId) || 0) + tax.taxAmount);
    }
  }
  const totalAmount = subtotal + taxAmount;
  const finalCashPurchaseNo = String(cashPurchaseNo || '').trim() || await nextDocumentNo(client, 'CASH_PURCHASE', purchaseDate);

  const cashPurchaseId = uuidv4();
  await client.query(
    `INSERT INTO cash_purchase
       (cash_purchase_id, cash_purchase_no, partner_id, purchase_date, payment_method,
        cash_account_id, subtotal, tax_amount, total_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [cashPurchaseId, finalCashPurchaseNo, partnerId || null, purchaseDate, paymentMethod || 'CASH',
     cashAccountId, subtotal, taxAmount, totalAmount]
  );

  const journalLines = [];
  for (const l of lines) {
    await client.query(
      `INSERT INTO cash_purchase_line
         (line_id, cash_purchase_id, item_code, stock_item_id, description, quantity, unit_price,
          tax_rate, line_total, expense_account_id, tax_code_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), cashPurchaseId, l.itemCode || null, l.stockItemId || null, l.description, l.quantity,
       l.unitPrice, l.taxRate || 0, l.line_total, l.expenseAccountId, l.taxCodeId]
    );
    journalLines.push({ accountId: l.stockItemId ? (l.inventoryAccountId || null) : l.expenseAccountId, debit: l.line_total, credit: 0, description: l.description });
  }

  for (const [taxAccountId, amount] of taxByAccount) {
    journalLines.push({ accountId: taxAccountId, debit: amount, credit: 0, description: 'Purchase tax' });
  }
  journalLines.push({ accountId: cashAccountId, debit: 0, credit: totalAmount, description: `Cash Purchase - ${finalCashPurchaseNo}` });

  const { journalId } = await postJournal(
    client,
    { journalDate: purchaseDate, source: 'AP', sourceDocId: cashPurchaseId,
      description: `Cash Purchase ${finalCashPurchaseNo}`, createdBy, prefix: 'CP' },
    journalLines
  );

  await client.query(
    `UPDATE cash_purchase SET journal_id = $1 WHERE cash_purchase_id = $2`,
    [journalId, cashPurchaseId]
  );

  const stock = await moveStockForLines(client, {
    lines: lines.map(l => ({ ...l, unitCost: l.unitPrice })), direction: 'IN', movementType: 'CASH_PURCHASE',
    sourceDocId: cashPurchaseId, sourceDocNo: finalCashPurchaseNo, movementDate: purchaseDate,
  });


  return { cashPurchaseId, cashPurchaseNo: finalCashPurchaseNo, subtotal, taxAmount, totalAmount, journalId, stockWarnings: stock.warnings };
}

module.exports = { createAndPostCashPurchase };
