const { v4: uuidv4 } = require('uuid');
const { nextDocumentNo } = require('./documentNumber');

/**
 * Purchase Request - step 1 of the procurement cycle.
 * Deliberately has NO journal posting: a request is not yet an economic
 * event (nothing has been bought, received, or committed to a vendor),
 * so there is nothing for the GL to record. It exists purely so a
 * Purchase Order can point back to "why was this ordered."
 */
async function createPurchaseRequest(client, { prNo, requestedBy, requestDate, notes, lines }) {
  const prId = uuidv4();
  const finalPrNo = String(prNo || '').trim() || await nextDocumentNo(client, 'PURCHASE_REQUEST', requestDate);
  await client.query(
    `INSERT INTO purchase_request (pr_id, pr_no, requested_by, request_date, status, notes)
     VALUES ($1,$2,$3,$4,'PENDING_APPROVAL',$5)`,
    [prId, finalPrNo, requestedBy, requestDate, notes || null]
  );

  let lineNo = 1;
  for (const l of lines) {
    await client.query(
      `INSERT INTO purchase_request_line
         (line_id, pr_id, item_code, stock_item_id, description, quantity, estimated_unit_price, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv4(), prId, l.itemCode || null, l.stockItemId || null, l.description, l.quantity, l.estimatedUnitPrice || 0, lineNo++]
    );
  }

  return { prId, prNo: finalPrNo, status: 'PENDING_APPROVAL' };
}

async function setPurchaseRequestStatus(client, prId, status, approvedBy) {
  if (!['APPROVED', 'REJECTED', 'CANCELLED'].includes(status)) {
    throw new Error(`Invalid purchase request status transition: ${status}`);
  }
  const { rows } = await client.query(
    `UPDATE purchase_request
        SET status = $1::pr_status,
            approved_by = CASE WHEN $1::text = 'APPROVED' THEN $2 ELSE approved_by END,
            approved_at = CASE WHEN $1::text = 'APPROVED' THEN now() ELSE approved_at END
      WHERE pr_id = $3 AND status = 'PENDING_APPROVAL'
      RETURNING pr_id, pr_no, status`,
    [status, approvedBy || null, prId]
  );
  if (rows.length === 0) {
    throw new Error(`Purchase request ${prId} not found or not awaiting approval`);
  }
  return rows[0];
}

module.exports = { createPurchaseRequest, setPurchaseRequestStatus };
