const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
const { moveStockForLines, resolveLineAccount, getStockAccountingAccounts } = require('./stock');
const { resolveLineTax, resolveTaxCodeForLine } = require('./tax');
const { nextDocumentNo } = require('./documentNumber');

const AP_CONTROL_ACCOUNT_CODE = '2100';
const GRIR_CLEARING_ACCOUNT_CODE = '2150';

async function getAccountIdByCode(client, code) {
  const { rows } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = $1`, [code]
  );
  if (rows.length === 0) throw new Error(`Account code ${code} not found`);
  return rows[0].account_id;
}

/**
 * Create a purchase invoice (supplier bill) AND post its GL journal
 * atomically. This is the direct mirror of createAndPostInvoice() on the
 * sales side, with debit/credit sides flipped - with one branch:
 *
 * STANDALONE invoice (no grnId - e.g. a utility bill with no PO behind it):
 *   DR  Inventory (stock line)     (line subtotal) - uses the stock item
 *                                  Inventory account. Non-stock lines debit
 *                                  their explicitly selected Expense account.
 *   DR  <tax account> (per code)    (tax_amount) - treated as a real cost,
 *                                    not a claimable credit (see migration
 *                                    003 for why)
 *   CR  Accounts Payable            (total_amount)
 *
 * MATCHED invoice (grnId given - the invoice for goods already received
 * via a Goods Received Note):
 *   DR  GR/IR Clearing              (subtotal) - clears the accrual the
 *                                    GRN already booked, so the expense
 *                                    is NOT booked a second time here
 *   DR  <tax account> (per code)    (tax_amount) - the GRN never carries
 *                                    tax, so this is genuinely new
 *   CR  Accounts Payable            (total_amount)
 *
 * Either way, recognizing the liability here (not on payment) is
 * standard accrual accounting: the expense and the obligation exist the
 * moment the bill arrives, whether or not it's paid yet. Every line
 * still resolves its own account and tax code for the line record
 * itself (audit trail), even in the GRN branch where the journal posts
 * to GR/IR in aggregate rather than per-line.
 */
async function createAndPostPurchaseInvoice(client, { invoiceNo, partnerId, invoiceDate, dueDate, lines, createdBy, grnId }) {
  let subtotal = 0, taxAmount = 0;
  const taxByAccount = new Map();

  for (const l of lines) {
    const lineTotal = l.quantity * l.unitPrice;
    l.line_total = lineTotal;
    subtotal += lineTotal;

    if (l.stockItemId) {
      await getStockAccountingAccounts(client, l.stockItemId);
      l.expenseAccountId = null;
    } else {
      l.expenseAccountId = await resolveLineAccount(client, {
        stockItemId: null, manualAccountId: l.expenseAccountId, direction: 'PURCHASE',
      });
    }

    const resolvedTaxCodeId = grnId
      ? (l.taxCodeId || null)
      : await resolveTaxCodeForLine(client, {
          stockItemId: l.stockItemId, explicitTaxCodeId: l.taxCodeId, direction: 'PURCHASE',
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

  const finalInvoiceNo = String(invoiceNo || '').trim() || await nextDocumentNo(client, 'PURCHASE_INVOICE', invoiceDate);

  if (grnId) {
    const { rows: grnRows } = await client.query(
      `SELECT is_fully_invoiced, partner_id FROM goods_received_note WHERE grn_id = $1`, [grnId]
    );
    if (grnRows.length === 0) throw new Error(`Goods received note ${grnId} not found`);
    if (grnRows[0].is_fully_invoiced) throw new Error(`Goods received note ${grnId} is already fully invoiced`);
    if (grnRows[0].partner_id !== partnerId) throw new Error('Purchase invoice supplier must match the selected GRN supplier');

    // A matched PI is a transfer of the GRN into AP. The GRN is the source of truth
    // for item, quantity and price; the UI must not be able to silently create a
    // different receipt/billing line and break the GR/IR chain.
    const { rows: grnLines } = await client.query(
      `SELECT stock_item_id, item_code, description, quantity_received, unit_price, expense_account_id
         FROM grn_line WHERE grn_id = $1 ORDER BY line_id`, [grnId]
    );
    if (grnLines.length !== lines.length) throw new Error('Purchase invoice lines do not match the selected GRN');
    for (let i = 0; i < grnLines.length; i++) {
      const g = grnLines[i];
      const l = lines[i];
      if ((g.stock_item_id || null) !== (l.stockItemId || null) ||
          Number(g.quantity_received) !== Number(l.quantity) ||
          Number(g.unit_price) !== Number(l.unitPrice)) {
        throw new Error('Purchase invoice lines must match the selected GRN item, quantity and unit price');
      }
      l.itemCode = g.item_code || l.itemCode || null;
      l.description = g.description;
      l.stockItemId = g.stock_item_id || null;
      l.expenseAccountId = g.stock_item_id ? null : g.expense_account_id;
    }
  }

  const purchaseInvoiceId = uuidv4();
  await client.query(
    `INSERT INTO purchase_invoice
       (purchase_invoice_id, invoice_no, partner_id, invoice_date, due_date, status,
        subtotal, tax_amount, total_amount, paid_amount, grn_id)
     VALUES ($1,$2,$3,$4,$5,'POSTED',$6,$7,$8,0,$9)`,
    [purchaseInvoiceId, finalInvoiceNo, partnerId, invoiceDate, dueDate, subtotal, taxAmount, totalAmount, grnId || null]
  );

  for (const l of lines) {
    await client.query(
      `INSERT INTO purchase_invoice_line
         (line_id, purchase_invoice_id, item_code, stock_item_id, description, quantity, unit_price,
          tax_rate, line_total, expense_account_id, tax_code_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), purchaseInvoiceId, l.itemCode || null, l.stockItemId || null, l.description, l.quantity,
       l.unitPrice, l.taxRate || 0, l.line_total, l.expenseAccountId, l.taxCodeId]
    );
  }

  // --- Build balanced GL journal lines (mirror of sales invoice, sides flipped) ---
  const journalLines = [];
  if (grnId) {
    const grirAccountId = await getAccountIdByCode(client, GRIR_CLEARING_ACCOUNT_CODE);
    journalLines.push({
      accountId: grirAccountId, debit: subtotal, credit: 0,
      description: `Clear GR/IR - ${finalInvoiceNo}`,
    });
  } else {
    for (const l of lines) {
      if (l.stockItemId) {
        const r = await client.query(`SELECT default_inventory_account_id FROM stock_item WHERE stock_item_id=$1`, [l.stockItemId]);
        if (!r.rows.length || !r.rows[0].default_inventory_account_id) throw new Error(`Stock item ${l.stockItemId} has no inventory account`);
        journalLines.push({ accountId: r.rows[0].default_inventory_account_id, debit: l.line_total, credit: 0, description: l.description });
      } else {
        journalLines.push({ accountId: l.expenseAccountId, debit: l.line_total, credit: 0, description: l.description });
      }
    }
  }
  for (const [taxAccountId, amount] of taxByAccount) {
    journalLines.push({ accountId: taxAccountId, debit: amount, credit: 0, description: 'Purchase tax' });
  }
  const apAccountId = await getAccountIdByCode(client, AP_CONTROL_ACCOUNT_CODE);
  journalLines.push({ accountId: apAccountId, debit: 0, credit: totalAmount, description: `AP - ${finalInvoiceNo}` });

  const { journalId } = await postJournal(
    client,
    { journalDate: invoiceDate, source: 'AP', sourceDocId: purchaseInvoiceId,
      description: `Purchase Invoice ${finalInvoiceNo}`, createdBy, prefix: 'PI' },
    journalLines
  );

  await client.query(
    `UPDATE purchase_invoice SET journal_id = $1 WHERE purchase_invoice_id = $2`,
    [journalId, purchaseInvoiceId]
  );

  if (grnId) {
    await client.query(`UPDATE goods_received_note SET is_fully_invoiced = TRUE WHERE grn_id = $1`, [grnId]);
  }

  const stock = grnId
    ? { warnings: [] }
    : await moveStockForLines(client, {
        lines: lines.map(l => ({ ...l, unitCost: l.unitPrice })), direction: 'IN', movementType: 'PURCHASE_INVOICE',
        sourceDocId: purchaseInvoiceId, sourceDocNo: finalInvoiceNo, movementDate: invoiceDate,
      });

  return { purchaseInvoiceId, invoiceNo: finalInvoiceNo, subtotal, taxAmount, totalAmount, journalId, stockWarnings: stock.warnings };
}

module.exports = { createAndPostPurchaseInvoice };
