const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');
const { refreshPurchaseOrderStatus } = require('./purchaseOrder');
const { moveStockForLines } = require('./stock');
const { nextDocumentNo } = require('./documentNumber');

const GRIR_CLEARING_ACCOUNT_CODE = '2150';

/**
 * Goods Received Note - step 3 of the procurement cycle, and the FIRST
 * step that posts to the GL. The moment goods/services are physically
 * received, the business owes the vendor for them - even though the
 * vendor's invoice hasn't arrived yet. That's a real accrual and has to
 * hit the ledger now, not whenever the paperwork catches up:
 *
 *   DR  Inventory (for stock lines) / Expense (for non-stock lines)
 *   CR  GR/IR Clearing               (total received value)
 *
 * We credit GR/IR Clearing rather than Accounts Payable because there
 * is no specific supplier bill yet to tie the liability to - AP should
 * only ever reflect real, billed invoices. The GR/IR balance is a
 * genuinely useful number on its own: "value received but not yet
 * billed."
 *
 * lines: [{ poLineId, description, quantityReceived, unitPrice, expenseAccountId }, ...]
 */
async function createAndPostGRN(client, { grnNo, poId, receivedDate, lines, createdBy }) {
  const { rows: poRows } = await client.query(
    `SELECT partner_id, status FROM purchase_order WHERE po_id = $1 FOR UPDATE`, [poId]
  );
  if (poRows.length === 0) throw new Error(`Purchase order ${poId} not found`);
  if (poRows[0].status === 'CLOSED' || poRows[0].status === 'CANCELLED') {
    throw new Error(`Purchase order is ${poRows[0].status} and cannot receive further goods`);
  }
  const partnerId = poRows[0].partner_id;
  if (!Array.isArray(lines) || !lines.length) throw new Error('At least one line is required');

  const { rows: poLines } = await client.query(
    `SELECT line_id, item_code, stock_item_id, description, quantity, quantity_received, unit_price, expense_account_id
       FROM purchase_order_line WHERE po_id = $1 ORDER BY line_no FOR UPDATE`, [poId]
  );
  const poById = new Map(poLines.map(x => [x.line_id, x]));
  const usedPoLines = new Set();
  for (const l of lines) {
    if (!l.poLineId) throw new Error('Each GRN line must reference a Purchase Order line');
    const poLine = poById.get(l.poLineId);
    if (!poLine) throw new Error(`GRN line does not belong to Purchase Order ${poId}`);
    if (usedPoLines.has(poLine.line_id)) throw new Error(`Purchase Order line ${poLine.line_id} appears more than once in this GRN`);
    usedPoLines.add(poLine.line_id);
    const qty = Number(l.quantityReceived);
    const remaining = Number(poLine.quantity) - Number(poLine.quantity_received);
    if (!(qty > 0) || qty > remaining) throw new Error(`Received quantity exceeds outstanding quantity for ${poLine.description}`);
    if ((l.stockItemId || null) !== (poLine.stock_item_id || null)) throw new Error(`Stock item does not match Purchase Order line ${poLine.line_id}`);
    if (Number(l.unitPrice) !== Number(poLine.unit_price)) throw new Error(`Unit price does not match Purchase Order line ${poLine.line_id}`);
    l.itemCode = poLine.item_code || null;
    l.description = poLine.description;
    l.stockItemId = poLine.stock_item_id || null;
    l.unitPrice = Number(poLine.unit_price);
    l.expenseAccountId = poLine.stock_item_id ? null : poLine.expense_account_id;
    if (!poLine.stock_item_id && !poLine.expense_account_id) {
      throw new Error(`Non-stock Purchase Order line ${poLine.line_id} has no expense account`);
    }
  }

  let totalValue = 0;
  for (const l of lines) {
    l.line_total = l.quantityReceived * l.unitPrice;
    totalValue += l.line_total;
  }
  if (totalValue <= 0) throw new Error('GRN must have at least one line with a positive received quantity');
  const finalGrnNo = String(grnNo || '').trim() || await nextDocumentNo(client, 'GRN', receivedDate);

  const grnId = uuidv4();
  await client.query(
    `INSERT INTO goods_received_note
       (grn_id, grn_no, po_id, partner_id, received_date, total_value, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [grnId, finalGrnNo, poId, partnerId, receivedDate, totalValue, createdBy || 'system']
  );

  const journalLines = [];
  for (const l of lines) {
    await client.query(
      `INSERT INTO grn_line
         (line_id, grn_id, po_line_id, item_code, stock_item_id, description, quantity_received,
          unit_price, line_total, expense_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uuidv4(), grnId, l.poLineId || null, l.itemCode || null, l.stockItemId || null, l.description,
       l.quantityReceived, l.unitPrice, l.line_total, l.expenseAccountId]
    );

    if (l.poLineId) {
      await client.query(
        `UPDATE purchase_order_line SET quantity_received = quantity_received + $1 WHERE line_id = $2`,
        [l.quantityReceived, l.poLineId]
      );
    }

    if (l.stockItemId) {
      const r = await client.query(`SELECT default_inventory_account_id FROM stock_item WHERE stock_item_id=$1`, [l.stockItemId]);
      if (!r.rows.length || !r.rows[0].default_inventory_account_id) throw new Error(`Stock item ${l.stockItemId} has no inventory account`);
      journalLines.push({ accountId: r.rows[0].default_inventory_account_id, debit: l.line_total, credit: 0, description: l.description });
    } else {
      journalLines.push({ accountId: l.expenseAccountId, debit: l.line_total, credit: 0, description: l.description });
    }
  }

  const { rows: grirRows } = await client.query(
    `SELECT account_id FROM chart_of_accounts WHERE account_code = $1`, [GRIR_CLEARING_ACCOUNT_CODE]
  );
  if (grirRows.length === 0) throw new Error(`GR/IR clearing account ${GRIR_CLEARING_ACCOUNT_CODE} not found`);
  journalLines.push({ accountId: grirRows[0].account_id, debit: 0, credit: totalValue, description: `GRN ${finalGrnNo}` });

  const { journalId } = await postJournal(
    client,
    { journalDate: receivedDate, source: 'AP', sourceDocId: grnId,
      description: `Goods Received ${finalGrnNo}`, createdBy, prefix: 'GRN' },
    journalLines
  );

  await client.query(`UPDATE goods_received_note SET journal_id = $1 WHERE grn_id = $2`, [journalId, grnId]);

  const stock = await moveStockForLines(client, {
    lines: lines.map(l => ({ stockItemId: l.stockItemId, quantity: l.quantityReceived, description: l.description })),
    direction: 'IN', movementType: 'GRN',
    sourceDocId: grnId, sourceDocNo: finalGrnNo, movementDate: receivedDate,
  });

  await refreshPurchaseOrderStatus(client, poId);

  return { grnId, grnNo: finalGrnNo, totalValue, journalId, stockWarnings: stock.warnings };
}

module.exports = { createAndPostGRN };
