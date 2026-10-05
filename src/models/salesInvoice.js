const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
const { moveStockForLines, resolveLineAccount } = require('./stock');
const { resolveLineTax, resolveTaxCodeForLine } = require('./tax');
const { saleCostLines } = require('./inventoryAccounting');
const { nextDocumentNo } = require('./documentNumber');

const AR_CONTROL_ACCOUNT_CODE = '1100';

async function getAccountIdByCode(client, code) {
  const { rows } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = $1`, [code]
  );
  if (rows.length === 0) throw new Error(`Account code ${code} not found`);
  return rows[0].account_id;
}

/**
 * Create a sales invoice AND post its GL journal atomically:
 *   DR  Accounts Receivable         (total_amount)
 *   CR  Sales Revenue (per line)    (line subtotal) - resolved from the
 *                                    line's stock item default, or a
 *                                    manual account for non-stock lines
 *   CR  <tax account> (per code)    (tax_amount) - resolved from each
 *                                    line's tax code; lines using
 *                                    different codes post to different
 *                                    accounts, grouped together here
 *
 * This mirrors how SQL Accounting's Cash Sale / Sales Invoice modules
 * post automatically into the GL the moment a document is finalized -
 * the user never journals it manually, and (as of the tax code master)
 * never re-picks an account or types a tax rate for a stock item either.
 */
async function createAndPostInvoice(client, { invoiceNo, partnerId, invoiceDate, dueDate, deliveryOrderId, lines, createdBy }) {
  // A Delivery Order is the physical stock event. When an invoice is
  // transferred from a DO, the server copies the DO lines authoritatively
  // and never moves stock again. This mirrors the GRN -> Purchase Invoice
  // flow on the purchasing side.
  let effectiveLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  let effectivePartnerId = partnerId || null;

  if (deliveryOrderId) {
    const { rows: doRows } = await client.query(
      `SELECT delivery_order_id, partner_id, status, is_fully_invoiced
         FROM delivery_order
        WHERE delivery_order_id = $1
        FOR UPDATE`,
      [deliveryOrderId]
    );
    if (!doRows.length) throw new Error('Delivery Order not found');
    const delivery = doRows[0];
    if (delivery.status !== 'POSTED') throw new Error('Delivery Order is not posted');
    if (delivery.is_fully_invoiced) throw new Error(`Delivery Order ${deliveryOrderId} is already fully invoiced`);
    effectivePartnerId = effectivePartnerId || delivery.partner_id;
    if (effectivePartnerId !== delivery.partner_id) throw new Error('Delivery Order customer does not match the invoice customer');

    const { rows: doLines } = await client.query(
      `SELECT item_code, stock_item_id, description, quantity, unit_price, tax_rate, tax_code_id
         FROM delivery_order_line
        WHERE delivery_order_id = $1
        ORDER BY line_no`,
      [deliveryOrderId]
    );
    effectiveLines = doLines.map(l => ({
      itemCode: l.item_code,
      stockItemId: l.stock_item_id,
      description: l.description,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      taxRate: Number(l.tax_rate || 0),
      taxCodeId: l.tax_code_id,
    }));
    if (!effectiveLines.length) throw new Error('Delivery Order has no lines to invoice');
  }

  if (!effectivePartnerId) throw new Error('Customer is required');
  if (!effectiveLines.length) throw new Error('At least one line is required');

  // --- Resolve account + tax for every line up front ---
  let subtotal = 0, taxAmount = 0;
  const taxByAccount = new Map(); // accountId -> accumulated tax amount

  for (const l of effectiveLines) {
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
    l.taxAmount = tax.taxAmount;
    taxAmount += tax.taxAmount;

    if (tax.taxAmount > 0) {
      taxByAccount.set(tax.taxAccountId, (taxByAccount.get(tax.taxAccountId) || 0) + tax.taxAmount);
    }
  }
  const totalAmount = subtotal + taxAmount;
  const finalInvoiceNo = String(invoiceNo || '').trim() || await nextDocumentNo(client, 'SALES_INVOICE', invoiceDate);

  const invoiceId = uuidv4();
  await client.query(
    `INSERT INTO sales_invoice
       (invoice_id, invoice_no, partner_id, invoice_date, due_date, status,
        subtotal, tax_amount, total_amount, paid_amount)
     VALUES ($1,$2,$3,$4,$5,'POSTED',$6,$7,$8,0)`,
    [invoiceId, finalInvoiceNo, effectivePartnerId, invoiceDate, dueDate, subtotal, taxAmount, totalAmount]
  );

  if (deliveryOrderId) {
    await client.query(`UPDATE sales_invoice SET delivery_order_id = $1 WHERE invoice_id = $2`, [deliveryOrderId, invoiceId]);
  }

  for (const l of effectiveLines) {
    await client.query(
      `INSERT INTO sales_invoice_line
         (line_id, invoice_id, item_code, stock_item_id, description, quantity, unit_price,
          tax_rate, line_total, revenue_account_id, tax_code_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), invoiceId, l.itemCode || null, l.stockItemId || null, l.description, l.quantity,
       l.unitPrice, l.taxRate || 0, l.line_total, l.revenueAccountId, l.taxCodeId]
    );
  }

  const stock = deliveryOrderId ? { warnings: [], accounting: { inventoryOut: [], cogsOut: [] } } : await moveStockForLines(client, {
    lines: effectiveLines, direction: 'OUT', movementType: 'SALES_INVOICE',
    sourceDocId: invoiceId, sourceDocNo: finalInvoiceNo, movementDate: invoiceDate,
  });

  // --- Build the complete balanced GL journal in one posting ---
  const arAccountId = await getAccountIdByCode(client, AR_CONTROL_ACCOUNT_CODE);
  const journalLines = [
    { accountId: arAccountId, debit: totalAmount, credit: 0, description: `AR - ${finalInvoiceNo}` },
  ];
  for (const l of effectiveLines) {
    journalLines.push({
      accountId: l.revenueAccountId, debit: 0, credit: l.line_total,
      description: l.description,
    });
  }
  for (const [taxAccountId, amount] of taxByAccount) {
    journalLines.push({ accountId: taxAccountId, debit: 0, credit: amount, description: 'Sales tax' });
  }
  if (!deliveryOrderId) journalLines.push(...saleCostLines(stock.accounting));

  const { journalId } = await postJournal(
    client,
    { journalDate: invoiceDate, source: 'AR', sourceDocId: invoiceId,
      description: `Sales Invoice ${finalInvoiceNo}`, createdBy, prefix: 'SI' },
    journalLines
  );

  await client.query(
    `UPDATE sales_invoice SET journal_id = $1 WHERE invoice_id = $2`,
    [journalId, invoiceId]
  );

  if (deliveryOrderId) {
    await client.query(
      `UPDATE delivery_order SET is_fully_invoiced = TRUE WHERE delivery_order_id = $1`,
      [deliveryOrderId]
    );
  }


  return { invoiceId, invoiceNo: finalInvoiceNo, subtotal, taxAmount, totalAmount, journalId, stockWarnings: stock.warnings, deliveryOrderId: deliveryOrderId || null };
}

module.exports = { createAndPostInvoice };
