const { postReversal } = require('./journal');
const { refreshPurchaseOrderStatus } = require('./purchaseOrder');

const CONFIG = {
  QUOTATION: { table:'quotation', idCol:'quotation_id', noCol:'quotation_no', statusCol:'status', statusVoid:"'CANCELLED'::quotation_status" },
  SALES_ORDER: { table:'sales_order', idCol:'sales_order_id', noCol:'order_no', statusCol:'status', statusVoid:"'CANCELLED'::sales_order_status" },
  PURCHASE_REQUEST: { table:'purchase_request', idCol:'pr_id', noCol:'pr_no', statusCol:'status', statusVoid:"'CANCELLED'::pr_status" },
  PURCHASE_ORDER: { table:'purchase_order', idCol:'po_id', noCol:'po_no', statusCol:'status', statusVoid:"'CANCELLED'::po_status" },
  INVOICE: { table:'sales_invoice', idCol:'invoice_id', noCol:'invoice_no', statusCol:'status', statusVoid:"'VOID'::invoice_status", journalCol:'journal_id', lineTable:'sales_invoice_line', lineParent:'invoice_id', stockDirection:'OUT' },
  CASH_SALE: { table:'cash_sale', idCol:'cash_sale_id', noCol:'cash_sale_no', statusCol:'status', statusVoid:"'VOID'::document_status", journalCol:'journal_id', lineTable:'cash_sale_line', lineParent:'cash_sale_id', stockDirection:'OUT' },
  PURCHASE_INVOICE: { table:'purchase_invoice', idCol:'purchase_invoice_id', noCol:'invoice_no', statusCol:'status', statusVoid:"'VOID'::invoice_status", journalCol:'journal_id', lineTable:'purchase_invoice_line', lineParent:'purchase_invoice_id', stockDirection:'IN' },
  CASH_PURCHASE: { table:'cash_purchase', idCol:'cash_purchase_id', noCol:'cash_purchase_no', statusCol:'status', statusVoid:"'VOID'::document_status", journalCol:'journal_id', lineTable:'cash_purchase_line', lineParent:'cash_purchase_id', stockDirection:'IN' },
  RECEIPT: { table:'receipt', idCol:'receipt_id', noCol:'receipt_no', statusCol:'status', statusVoid:"'VOID'::document_status", journalCol:'journal_id' },
  PAYMENT: { table:'payment', idCol:'payment_id', noCol:'payment_no', statusCol:'status', statusVoid:"'VOID'::document_status", journalCol:'journal_id' },
  GRN: { table:'goods_received_note', idCol:'grn_id', noCol:'grn_no', statusCol:'status', statusVoid:"'VOID'::document_status", journalCol:'journal_id', lineTable:'grn_line', lineParent:'grn_id', stockDirection:'IN' },
  DELIVERY_ORDER: { table:'delivery_order', idCol:'delivery_order_id', noCol:'delivery_no', statusCol:'status', statusVoid:"'CANCELLED'::delivery_order_status", journalCol:'journal_id', lineTable:'delivery_order_line', lineParent:'delivery_order_id', stockDirection:'OUT' },
  CREDIT_NOTE: { table:'credit_note', idCol:'credit_note_id', noCol:'note_no', statusCol:'status', statusVoid:"'VOID'::sales_note_status", journalCol:'journal_id', lineTable:'credit_note_line', lineParent:'credit_note_id', stockDirection:'IN' },
  DEBIT_NOTE: { table:'debit_note', idCol:'debit_note_id', noCol:'note_no', statusCol:'status', statusVoid:"'VOID'::sales_note_status", journalCol:'journal_id' },
};

function getDate(doc) {
  return doc.invoice_date || doc.sale_date || doc.purchase_date || doc.received_date || doc.delivery_date || doc.note_date || doc.order_date || doc.request_date || new Date().toISOString().slice(0,10);
}

async function moveExistingStock(client, cfg, doc, movementType='REVERSAL') {
  if (!cfg.lineTable || !cfg.stockDirection) return [];
  const stock = require('./stock');
  const result = await stock.reverseStockForSourceDocument(client, {
    sourceDocId: doc[cfg.idCol],
    sourceDocNo: `REV-${doc[cfg.noCol]}`,
    movementDate: getDate(doc),
  });
  return result.warnings || [];
}

async function recomputeSalesOrderStatus(client, salesOrderId) {
  if (!salesOrderId) return;
  const { rows } = await client.query(`
    SELECT
      COALESCE(SUM(quantity),0) AS ordered_qty,
      COALESCE(SUM(quantity_delivered),0) AS delivered_qty
    FROM sales_order_line
    WHERE sales_order_id=$1
  `, [salesOrderId]);
  if (!rows.length) return;
  const ordered = Number(rows[0].ordered_qty);
  const delivered = Number(rows[0].delivered_qty);
  let status = 'OPEN';
  if (delivered > 0 && delivered + 0.0001 < ordered) status = 'PARTIALLY_DELIVERED';
  else if (ordered > 0 && delivered + 0.0001 >= ordered) status = 'DELIVERED';
  await client.query(`UPDATE sales_order SET status=$1::sales_order_status WHERE sales_order_id=$2`, [status, salesOrderId]);
}

async function recomputeInvoiceStatus(client, invoiceId) {
  if (!invoiceId) return;
  const { rows } = await client.query(`SELECT total_amount,paid_amount,credited_amount,debited_amount,status FROM sales_invoice WHERE invoice_id=$1 FOR UPDATE`, [invoiceId]);
  if (!rows.length) return;
  const x = rows[0];
  if (x.status === 'VOID') return;
  const balance = Number(x.total_amount)+Number(x.debited_amount)-Number(x.credited_amount)-Number(x.paid_amount);
  let status='POSTED';
  if (balance <= 0.005) status = Number(x.credited_amount)>0.005 && Number(x.paid_amount)<=0.005 ? 'CREDITED' : 'PAID';
  else if (Number(x.paid_amount)>0.005 || Number(x.credited_amount)>0.005 || Number(x.debited_amount)>0.005) status='PARTIALLY_PAID';
  await client.query(`UPDATE sales_invoice SET status=$1::invoice_status WHERE invoice_id=$2`, [status, invoiceId]);
}

async function voidDocument(client, type, id, {createdBy='ui', reason='Document voided'}={}) {
  const cfg = CONFIG[type];
  if (!cfg) throw new Error(`Unsupported document type ${type}`);
  const { rows } = await client.query(`SELECT * FROM ${cfg.table} WHERE ${cfg.idCol}=$1 FOR UPDATE`, [id]);
  if (!rows.length) throw new Error(`${type} not found`);
  const doc = rows[0];
  if (doc[cfg.statusCol] === 'VOID' || doc[cfg.statusCol] === 'CANCELLED') throw new Error('Document is already void/cancelled');

  if (type === 'QUOTATION' && doc.status !== 'OPEN') throw new Error('Only an open quotation can be cancelled');
  if (type === 'SALES_ORDER') {
    const { rows: delivered } = await client.query(`SELECT COALESCE(SUM(quantity_delivered),0) AS qty FROM sales_order_line WHERE sales_order_id=$1`, [id]);
    if (Number(delivered[0].qty) > 0) throw new Error('A Sales Order with delivered quantity cannot be cancelled');
  }
  if (type === 'PURCHASE_REQUEST' && doc.status === 'CONVERTED') throw new Error('A converted Purchase Request cannot be cancelled');
  if (type === 'PURCHASE_ORDER') {
    const { rows: received } = await client.query(`SELECT COALESCE(SUM(quantity_received),0) AS qty FROM purchase_order_line WHERE po_id=$1`, [id]);
    if (Number(received[0].qty) > 0) throw new Error('A Purchase Order with received quantity cannot be cancelled');
  }
  if (type === 'GRN' && doc.is_fully_invoiced) throw new Error('Cannot void a Goods Received Note that has already been invoiced');
  if (type === 'DELIVERY_ORDER' && doc.is_fully_invoiced) throw new Error('Cannot void a Delivery Order that has already been invoiced');

  // A parent invoice cannot be voided while financial dependants still exist.
  // Otherwise reversing the parent journal would leave receipts / CN / DN or
  // payment allocations standing against a voided invoice.
  if (type === 'INVOICE') {
    const { rows: deps } = await client.query(`
      SELECT 1 FROM receipt_allocation WHERE invoice_id=$1
      UNION ALL
      SELECT 1 FROM credit_note WHERE original_invoice_id=$1
      UNION ALL
      SELECT 1 FROM debit_note WHERE original_invoice_id=$1
      LIMIT 1`, [id]);
    if (deps.length) throw new Error('Sales Invoice has receipts or Credit/Debit Notes linked to it. Reverse/delete those dependent documents first.');
  }
  if (type === 'PURCHASE_INVOICE') {
    const { rows: deps } = await client.query(`
      SELECT 1 FROM payment_allocation WHERE purchase_invoice_id=$1
      LIMIT 1`, [id]);
    if (deps.length) throw new Error('Purchase Invoice has payments allocated to it. Reverse/delete those dependent payments first.');
  }

  if (type === 'INVOICE' && doc.delivery_order_id) {
    await client.query(`UPDATE delivery_order SET is_fully_invoiced=FALSE WHERE delivery_order_id=$1`, [doc.delivery_order_id]);
  }
  if (type === 'PURCHASE_INVOICE' && doc.grn_id) {
    await client.query(`UPDATE goods_received_note SET is_fully_invoiced=FALSE WHERE grn_id=$1`, [doc.grn_id]);
  }

  if (type === 'DELIVERY_ORDER') {
    const { rows: ls } = await client.query(`SELECT sales_order_line_id, quantity FROM delivery_order_line WHERE delivery_order_id=$1 AND sales_order_line_id IS NOT NULL`, [id]);
    for (const l of ls) {
      await client.query(`UPDATE sales_order_line SET quantity_delivered=GREATEST(quantity_delivered-$1,0) WHERE line_id=$2`, [Number(l.quantity), l.sales_order_line_id]);
    }
    // DO posts COGS/Inventory in v27, so its financial journal must be reversed
    // together with the exact stock valuation used by its original movement.
    if (cfg.journalCol && doc[cfg.journalCol]) await postReversal(client, doc[cfg.journalCol], { createdBy, reason });
    await moveExistingStock(client, cfg, {...doc, date:getDate(doc)}, 'REVERSAL');
    await client.query(`UPDATE delivery_order SET status='CANCELLED'::delivery_order_status WHERE delivery_order_id=$1`, [id]);
    await recomputeSalesOrderStatus(client, doc.sales_order_id);
  } else if (type === 'GRN') {
    const { rows: ls } = await client.query(`SELECT po_line_id, quantity_received FROM grn_line WHERE grn_id=$1 AND po_line_id IS NOT NULL`, [id]);
    for (const l of ls) {
      await client.query(`UPDATE purchase_order_line SET quantity_received=GREATEST(quantity_received-$1,0) WHERE line_id=$2`, [Number(l.quantity_received), l.po_line_id]);
    }
    // A GRN is the first purchase-side document that posts to the GL, so voiding
    // it must reverse both stock and the original GR/IR journal.
    if (cfg.journalCol && doc[cfg.journalCol]) await postReversal(client, doc[cfg.journalCol], { createdBy, reason });
    await moveExistingStock(client, cfg, {...doc, date:getDate(doc)}, 'REVERSAL');
    await client.query(`UPDATE goods_received_note SET status='VOID'::document_status WHERE grn_id=$1`, [id]);
    await refreshPurchaseOrderStatus(client, doc.po_id);
  } else {
    if (cfg.journalCol && doc[cfg.journalCol]) await postReversal(client, doc[cfg.journalCol], { createdBy, reason });
    const shouldReverseStock = !!cfg.stockDirection && !(type === 'INVOICE' && doc.delivery_order_id) && !(type === 'PURCHASE_INVOICE' && doc.grn_id) && !(type === 'CREDIT_NOTE' && !doc.return_goods);
    if (shouldReverseStock) await moveExistingStock(client, cfg, {...doc, date:getDate(doc)}, 'REVERSAL');

    if (type === 'CREDIT_NOTE' || type === 'DEBIT_NOTE') {
      const amount = Number(doc.total_amount || 0);
      if (doc.original_invoice_id) {
        const col = type === 'CREDIT_NOTE' ? 'credited_amount' : 'debited_amount';
        await client.query(`UPDATE sales_invoice SET ${col}=GREATEST(${col}-$1,0) WHERE invoice_id=$2`, [amount, doc.original_invoice_id]);
        await recomputeInvoiceStatus(client, doc.original_invoice_id);
      }
    }
    if (type === 'RECEIPT') {
      const { rows: allocs } = await client.query(`SELECT invoice_id, amount_applied FROM receipt_allocation WHERE receipt_id=$1`, [id]);
      for (const a of allocs) {
        await client.query(`UPDATE sales_invoice SET paid_amount=GREATEST(paid_amount-$1,0) WHERE invoice_id=$2`, [Number(a.amount_applied), a.invoice_id]);
        await recomputeInvoiceStatus(client, a.invoice_id);
      }
    }
    if (type === 'PAYMENT') {
      const { rows: allocs } = await client.query(`SELECT purchase_invoice_id, amount_applied FROM payment_allocation WHERE payment_id=$1`, [id]);
      for (const a of allocs) await client.query(`UPDATE purchase_invoice SET paid_amount=GREATEST(paid_amount-$1,0), status=CASE WHEN (paid_amount-$1)<=0.005 THEN 'POSTED'::invoice_status ELSE 'PARTIALLY_PAID'::invoice_status END WHERE purchase_invoice_id=$2`, [Number(a.amount_applied), a.purchase_invoice_id]);
    }
    await client.query(`UPDATE ${cfg.table} SET ${cfg.statusCol}=${cfg.statusVoid} WHERE ${cfg.idCol}=$1`, [id]);
  }
  return { type, id, status:'VOID' };
}

async function assertNoLaterStock(client, stockItemIds, createdAt, sourceDocId) {
  const ids=[...new Set(stockItemIds.filter(Boolean))];
  if (!ids.length) return;
  const { rows } = await client.query(`SELECT 1 FROM stock_movement WHERE stock_item_id = ANY($1::uuid[]) AND source_doc_id <> $2 AND created_at > $3 LIMIT 1`, [ids, sourceDocId, createdAt]);
  if (rows.length) throw new Error('Cannot physically delete this document because later stock movements depend on its balance history. Void it instead to preserve the stock ledger.');
}

async function restoreStockFromDocument(client, cfg, doc) {
  if (!cfg.lineTable || !cfg.stockDirection) return;
  const { rows } = await client.query(`SELECT DISTINCT stock_item_id FROM ${cfg.lineTable} WHERE ${cfg.lineParent}=$1 AND stock_item_id IS NOT NULL`, [doc[cfg.idCol]]);
  const ids=rows.map(r=>r.stock_item_id);
  await assertNoLaterStock(client, ids, doc.created_at, doc[cfg.idCol]);
  const stock=require('./stock');
  // Use the original movement values rather than today's moving-average cost.
  // The reversal movement is removed again as part of the hard delete bundle.
  await stock.reverseStockForSourceDocument(client,{sourceDocId:doc[cfg.idCol],sourceDocNo:`DEL-${doc[cfg.noCol]}`,movementDate:getDate(doc)});
  await client.query(`DELETE FROM stock_movement WHERE source_doc_id=$1`, [doc[cfg.idCol]]);
}

async function deleteJournalBundle(client, journalId) {
  if (!journalId) return;
  const { rows: rev } = await client.query(`SELECT journal_id FROM journal_entry WHERE reversal_of_journal_id=$1`, [journalId]);
  const ids=[journalId,...rev.map(r=>r.journal_id)];
  await client.query(`DELETE FROM journal_entry WHERE journal_id = ANY($1::uuid[])`, [ids]);
}

async function deleteDocument(client, type, id) {
  const cfg=CONFIG[type];
  if (!cfg) throw new Error(`Unsupported document type ${type}`);
  const { rows }=await client.query(`SELECT * FROM ${cfg.table} WHERE ${cfg.idCol}=$1 FOR UPDATE`,[id]);
  if (!rows.length) throw new Error(`${type} not found`);
  const doc=rows[0];

  if (['INVOICE','CASH_SALE','PURCHASE_INVOICE','CASH_PURCHASE','RECEIPT','PAYMENT','CREDIT_NOTE','DEBIT_NOTE'].includes(type) && (doc.status==='VOID')) throw new Error('Voided documents cannot be hard-deleted; keep the audit trail and use the existing reversal.');
  if (type==='QUOTATION') { const q=await client.query(`SELECT 1 FROM sales_order WHERE quotation_id=$1 LIMIT 1`,[id]); if(q.rows.length) throw new Error('Quotation has downstream Sales Orders. Delete those first, or cancel the quotation.'); }
  if (type==='SALES_ORDER') { const q=await client.query(`SELECT 1 FROM delivery_order WHERE sales_order_id=$1 LIMIT 1`,[id]); if(q.rows.length) throw new Error('Sales Order has Delivery Orders. Delete those first.'); }
  if (type==='PURCHASE_REQUEST') { const q=await client.query(`SELECT 1 FROM purchase_order WHERE pr_id=$1 LIMIT 1`,[id]); if(q.rows.length) throw new Error('Purchase Request has downstream Purchase Orders. Delete those first.'); }
  if (type==='PURCHASE_ORDER') { const q=await client.query(`SELECT 1 FROM goods_received_note WHERE po_id=$1 LIMIT 1`,[id]); if(q.rows.length) throw new Error('Purchase Order has Goods Received Notes. Delete those first.'); }
  if (type==='GRN' && doc.is_fully_invoiced) throw new Error('GRN is already matched to a Purchase Invoice. Delete the invoice first.');
  if (type==='DELIVERY_ORDER' && doc.is_fully_invoiced) throw new Error('Delivery Order is already invoiced. Delete the Sales Invoice first.');
  if (type==='INVOICE') {
    const q=await client.query(`SELECT 1 FROM receipt_allocation WHERE invoice_id=$1 UNION ALL SELECT 1 FROM credit_note WHERE original_invoice_id=$1 UNION ALL SELECT 1 FROM debit_note WHERE original_invoice_id=$1 LIMIT 1`,[id]);
    if(q.rows.length) throw new Error('Sales Invoice has receipts or Credit/Debit Notes linked to it. Delete those dependent documents first.');
    if(doc.delivery_order_id) await client.query(`UPDATE delivery_order SET is_fully_invoiced=FALSE WHERE delivery_order_id=$1`,[doc.delivery_order_id]);
  }
  if(type==='PURCHASE_INVOICE'){const q=await client.query(`SELECT 1 FROM payment_allocation WHERE purchase_invoice_id=$1 LIMIT 1`,[id]);if(q.rows.length)throw new Error('Purchase Invoice has payments allocated to it. Delete those payments first.');if(doc.grn_id)await client.query(`UPDATE goods_received_note SET is_fully_invoiced=FALSE WHERE grn_id=$1`,[doc.grn_id]);}
  if(type==='RECEIPT'){/* allocations cascade; no hard delete if linked invoice state must remain explicit */}
  if(type==='PAYMENT'){/* allocations cascade */}
  if(type==='CREDIT_NOTE'||type==='DEBIT_NOTE'){
    if(!doc.original_invoice_id) throw new Error('This note has no original invoice link and cannot be safely hard-deleted.');
    const amount=Number(doc.total_amount||0);
    const col=type==='CREDIT_NOTE'?'credited_amount':'debited_amount';
    await client.query(`UPDATE sales_invoice SET ${col}=GREATEST(${col}-$1,0) WHERE invoice_id=$2`,[amount,doc.original_invoice_id]);
    await recomputeInvoiceStatus(client,doc.original_invoice_id);
  }
  if(type==='RECEIPT'){
    const {rows:allocs}=await client.query(`SELECT invoice_id,amount_applied FROM receipt_allocation WHERE receipt_id=$1`,[id]);
    for(const a of allocs){await client.query(`UPDATE sales_invoice SET paid_amount=GREATEST(paid_amount-$1,0) WHERE invoice_id=$2`,[Number(a.amount_applied),a.invoice_id]);await recomputeInvoiceStatus(client,a.invoice_id);}
  }
  if(type==='PAYMENT'){
    const {rows:allocs}=await client.query(`SELECT purchase_invoice_id,amount_applied FROM payment_allocation WHERE payment_id=$1`,[id]);
    for(const a of allocs) await client.query(`UPDATE purchase_invoice SET paid_amount=GREATEST(paid_amount-$1,0), status=CASE WHEN (paid_amount-$1)<=0.005 THEN 'POSTED'::invoice_status ELSE 'PARTIALLY_PAID'::invoice_status END WHERE purchase_invoice_id=$2`,[Number(a.amount_applied),a.purchase_invoice_id]);
  }

  if(type==='DELIVERY_ORDER'){
    const {rows:ls}=await client.query(`SELECT sales_order_line_id,quantity FROM delivery_order_line WHERE delivery_order_id=$1 AND sales_order_line_id IS NOT NULL`,[id]);
    await restoreStockFromDocument(client,cfg,doc);
    for(const l of ls) await client.query(`UPDATE sales_order_line SET quantity_delivered=GREATEST(quantity_delivered-$1,0) WHERE line_id=$2`,[Number(l.quantity),l.sales_order_line_id]);
    await recomputeSalesOrderStatus(client,doc.sales_order_id);
  } else if(type==='GRN'){
    const {rows:ls}=await client.query(`SELECT po_line_id,quantity_received FROM grn_line WHERE grn_id=$1 AND po_line_id IS NOT NULL`,[id]);
    await restoreStockFromDocument(client,cfg,doc);
    for(const l of ls) await client.query(`UPDATE purchase_order_line SET quantity_received=GREATEST(quantity_received-$1,0) WHERE line_id=$2`,[Number(l.quantity_received),l.po_line_id]);
    await refreshPurchaseOrderStatus(client, doc.po_id);
  } else if(cfg.stockDirection && !(type==='INVOICE'&&doc.delivery_order_id) && !(type==='PURCHASE_INVOICE'&&doc.grn_id) && !(type==='CREDIT_NOTE'&&!doc.return_goods)){
    await restoreStockFromDocument(client,cfg,doc);
  }

  // Remove the document row before its journal. Document rows hold the FK
  // to journal_entry, so deleting the journal first violates that FK.
  if(cfg.journalCol && doc[cfg.journalCol]) {
    await client.query(`DELETE FROM ${cfg.table} WHERE ${cfg.idCol}=$1`,[id]);
    await deleteJournalBundle(client,doc[cfg.journalCol]);
  } else {
    await client.query(`DELETE FROM ${cfg.table} WHERE ${cfg.idCol}=$1`,[id]);
  }
  return {type,id,deleted:true};
}

module.exports = { voidDocument, deleteDocument, recomputeSalesOrderStatus, CONFIG };
