const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
const { moveStockForLines, resolveLineAccount } = require('./stock');
const { resolveLineTax, resolveTaxCodeForLine } = require('./tax');
const { saleCostLines } = require('./inventoryAccounting');
const { nextDocumentNo } = require('./documentNumber');

/**
 * Create a cash sale AND post its GL journal atomically.
 * Unlike a sales invoice, there is no Accounts Receivable step - money
 * is assumed received at the moment the document is finalized:
 *
 *   DR  Cash/Bank (whichever account received payment)   (total_amount)
 *   CR  Sales Revenue (per line)                          (line subtotal) -
 *                                    resolved from the line's stock item
 *                                    default, or a manual account for
 *                                    non-stock lines
 *   CR  <tax account> (per code)    (tax_amount) - resolved per line's
 *                                    tax code, grouped by account
 *
 * cashAccountId lets the till/counter choose which Cash/Bank account
 * received the money (e.g. petty cash drawer vs. card terminal settling
 * to a bank account) - same idea as choosing "Payment To" in SQL
 * Accounting's Cash Sale screen.
 */
async function createAndPostCashSale(client, { cashSaleNo, partnerId, saleDate, paymentMethod, cashAccountId, lines, createdBy }) {
  let subtotal = 0, taxAmount = 0;
  const taxByAccount = new Map();

  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPrice;
    l.line_total = lineTotal;
    subtotal += lineTotal;

    l.revenueAccountId = await resolveLineAccount(client, {
      stockItemId: l.stockItemId, manualAccountId: l.revenueAccountId, direction: 'SALES',
    });

    const resolvedTaxCodeId = await resolveTaxCodeForLine(client, {
      stockItemId: l.stockItemId, explicitTaxCodeId: l.taxCodeId, direction: 'SALES',
    });
    const tax = await resolveLineTax(client, { taxCodeId: resolvedTaxCodeId, lineAmount: lineTotal });
    l.taxCodeId = tax.taxCodeId;
    l.taxRate = tax.rate;
    taxAmount += tax.taxAmount;
    if (tax.taxAmount > 0) {
      taxByAccount.set(tax.taxAccountId, (taxByAccount.get(tax.taxAccountId) || 0) + tax.taxAmount);
    }
  }
  const totalAmount = subtotal + taxAmount;
  const finalCashSaleNo = String(cashSaleNo || '').trim() || await nextDocumentNo(client, 'CASH_SALE', saleDate);

  const cashSaleId = uuidv4();
  await client.query(
    `INSERT INTO cash_sale
       (cash_sale_id, cash_sale_no, partner_id, sale_date, payment_method,
        cash_account_id, subtotal, tax_amount, total_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [cashSaleId, finalCashSaleNo, partnerId || null, saleDate, paymentMethod || 'CASH',
     cashAccountId, subtotal, taxAmount, totalAmount]
  );

  for (const l of lines) {
    await client.query(
      `INSERT INTO cash_sale_line
         (line_id, cash_sale_id, item_code, stock_item_id, description, quantity, unit_price,
          tax_rate, line_total, revenue_account_id, tax_code_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), cashSaleId, l.itemCode || null, l.stockItemId || null, l.description, l.quantity,
       l.unitPrice, l.taxRate || 0, l.line_total, l.revenueAccountId, l.taxCodeId]
    );
  }

  const stock = await moveStockForLines(client, {
    lines, direction: 'OUT', movementType: 'CASH_SALE',
    sourceDocId: cashSaleId, sourceDocNo: finalCashSaleNo, movementDate: saleDate,
  });

  const journalLines = [
    { accountId: cashAccountId, debit: totalAmount, credit: 0, description: `Cash Sale - ${finalCashSaleNo}` },
  ];
  for (const l of lines) {
    journalLines.push({
      accountId: l.revenueAccountId, debit: 0, credit: l.line_total,
      description: l.description,
    });
  }
  for (const [taxAccountId, amount] of taxByAccount) {
    journalLines.push({ accountId: taxAccountId, debit: 0, credit: amount, description: 'Sales tax' });
  }
  journalLines.push(...saleCostLines(stock.accounting));

  const { journalId } = await postJournal(
    client,
    { journalDate: saleDate, source: 'CASH_SALE', sourceDocId: cashSaleId,
      description: `Cash Sale ${finalCashSaleNo}`, createdBy, prefix: 'CS' },
    journalLines
  );

  await client.query(
    `UPDATE cash_sale SET journal_id = $1 WHERE cash_sale_id = $2`,
    [journalId, cashSaleId]
  );


  return { cashSaleId, cashSaleNo: finalCashSaleNo, subtotal, taxAmount, totalAmount, journalId, stockWarnings: stock.warnings };
}

module.exports = { createAndPostCashSale };
