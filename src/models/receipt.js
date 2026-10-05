const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
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
 * Record a receipt from a customer and allocate it against one or more
 * open invoices. Posts:
 *   DR  Bank/Cash account       (amount)
 *   CR  Accounts Receivable     (amount)
 * Then updates each invoice's paid_amount and status.
 *
 * allocations: [{ invoiceId, amount }, ...] must sum to receipt amount.
 */
async function createReceiptWithAllocation(client, { receiptNo, partnerId, receiptDate, bankAccountId, amount, paymentMethod, allocations, createdBy }) {
  const finalReceiptNo = String(receiptNo || '').trim() || await nextDocumentNo(client, 'RECEIPT', receiptDate);
  const allocatedTotal = allocations.reduce((s, a) => s + a.amount, 0);
  if (Math.abs(allocatedTotal - amount) > 0.005) {
    throw new Error(`Allocated amount (${allocatedTotal}) does not match receipt amount (${amount})`);
  }

  const receiptId = uuidv4();
  await client.query(
    `INSERT INTO receipt (receipt_id, receipt_no, partner_id, receipt_date, bank_account_id, amount, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [receiptId, finalReceiptNo, partnerId, receiptDate, bankAccountId, amount, paymentMethod || 'BANK_TRANSFER']
  );

  for (const a of allocations) {
    await client.query(
      `INSERT INTO receipt_allocation (allocation_id, receipt_id, invoice_id, amount_applied)
       VALUES ($1,$2,$3,$4)`,
      [uuidv4(), receiptId, a.invoiceId, a.amount]
    );

    const { rows } = await client.query(
      `SELECT invoice_id, invoice_no, total_amount, paid_amount, credited_amount, debited_amount, status
         FROM sales_invoice
        WHERE invoice_id = $1
        FOR UPDATE`, [a.invoiceId]
    );
    if (rows.length === 0) throw new Error(`Invoice ${a.invoiceId} not found`);
    const inv = rows[0];
    const outstanding = Number(inv.total_amount) + Number(inv.debited_amount) - Number(inv.credited_amount) - Number(inv.paid_amount);
    if (Number(a.amount) > outstanding + 0.005) {
      throw new Error(`Receipt allocation RM${Number(a.amount).toFixed(2)} exceeds invoice ${inv.invoice_no} outstanding RM${Math.max(outstanding,0).toFixed(2)}`);
    }
    const newPaid = Number(inv.paid_amount) + Number(a.amount);
    const newBalance = Number(inv.total_amount) + Number(inv.debited_amount) - Number(inv.credited_amount) - newPaid;
    const status = newBalance <= 0.005
      ? (Number(inv.credited_amount) > 0 && Number(inv.paid_amount) <= 0.005 ? 'CREDITED' : 'PAID')
      : 'PARTIALLY_PAID';
    await client.query(
      `UPDATE sales_invoice SET paid_amount=$1, status=$2::invoice_status WHERE invoice_id=$3`,
      [newPaid, status, a.invoiceId]
    );
  }

  const arAccountId = await getAccountIdByCode(client, AR_CONTROL_ACCOUNT_CODE);
  const { journalId } = await postJournal(
    client,
    { journalDate: receiptDate, source: 'AR', sourceDocId: receiptId,
      description: `Receipt ${finalReceiptNo}`, createdBy, prefix: 'OR' },
    [
      { accountId: bankAccountId, debit: amount, credit: 0, description: `Receipt ${finalReceiptNo}` },
      { accountId: arAccountId, debit: 0, credit: amount, description: `Receipt ${finalReceiptNo}` },
    ]
  );

  await client.query(`UPDATE receipt SET journal_id = $1 WHERE receipt_id = $2`, [journalId, receiptId]);

  return { receiptId, receiptNo: finalReceiptNo, journalId };
}

module.exports = { createReceiptWithAllocation };
