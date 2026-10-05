const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
const { nextDocumentNo } = require('./documentNumber');

const AP_CONTROL_ACCOUNT_CODE = '2100';

async function getAccountIdByCode(client, code) {
  const { rows } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = $1`, [code]
  );
  if (rows.length === 0) throw new Error(`Account code ${code} not found`);
  return rows[0].account_id;
}

/**
 * Record a payment made to a supplier and allocate it against one or more
 * open purchase invoices. Direct mirror of createReceiptWithAllocation()
 * with the flow reversed:
 *   DR  Accounts Payable       (amount)
 *   CR  Bank/Cash account      (amount)
 * Then updates each purchase invoice's paid_amount and status.
 */
async function createPaymentWithAllocation(client, { paymentNo, partnerId, paymentDate, bankAccountId, amount, paymentMethod, allocations, createdBy }) {
  const finalPaymentNo = String(paymentNo || '').trim() || await nextDocumentNo(client, 'PAYMENT', paymentDate);
  const allocatedTotal = allocations.reduce((s, a) => s + a.amount, 0);
  if (Math.abs(allocatedTotal - amount) > 0.005) {
    throw new Error(`Allocated amount (${allocatedTotal}) does not match payment amount (${amount})`);
  }

  const paymentId = uuidv4();
  await client.query(
    `INSERT INTO payment (payment_id, payment_no, partner_id, payment_date, bank_account_id, amount, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [paymentId, finalPaymentNo, partnerId, paymentDate, bankAccountId, amount, paymentMethod || 'BANK_TRANSFER']
  );

  for (const a of allocations) {
    await client.query(
      `INSERT INTO payment_allocation (allocation_id, payment_id, purchase_invoice_id, amount_applied)
       VALUES ($1,$2,$3,$4)`,
      [uuidv4(), paymentId, a.purchaseInvoiceId, a.amount]
    );

    const { rows } = await client.query(
      `UPDATE purchase_invoice
          SET paid_amount = paid_amount + $1,
              status = CASE
                         WHEN paid_amount + $1 >= total_amount THEN 'PAID'
                         ELSE 'PARTIALLY_PAID'
                       END::invoice_status
        WHERE purchase_invoice_id = $2
        RETURNING invoice_no`,
      [a.amount, a.purchaseInvoiceId]
    );
    if (rows.length === 0) throw new Error(`Purchase invoice ${a.purchaseInvoiceId} not found`);
  }

  const apAccountId = await getAccountIdByCode(client, AP_CONTROL_ACCOUNT_CODE);
  const { journalId } = await postJournal(
    client,
    { journalDate: paymentDate, source: 'AP', sourceDocId: paymentId,
      description: `Payment ${finalPaymentNo}`, createdBy, prefix: 'PV' },
    [
      { accountId: apAccountId, debit: amount, credit: 0, description: `Payment ${finalPaymentNo}` },
      { accountId: bankAccountId, debit: 0, credit: amount, description: `Payment ${finalPaymentNo}` },
    ]
  );

  await client.query(`UPDATE payment SET journal_id = $1 WHERE payment_id = $2`, [journalId, paymentId]);

  return { paymentId, paymentNo: finalPaymentNo, journalId };
}

module.exports = { createPaymentWithAllocation };
