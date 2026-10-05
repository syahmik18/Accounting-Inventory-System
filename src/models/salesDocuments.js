const { v4: uuidv4 } = require('uuid');
const { moveStockForLines } = require('./stock');
const { resolveLineTax, resolveTaxCodeForLine, getTaxCode } = require('./tax');
const { postJournal } = require('./journal');
const { saleCostLines } = require('./inventoryAccounting');
const { nextDocumentNo } = require('./documentNumber');

const AR_CONTROL_ACCOUNT_CODE = '1100';

async function getAccountIdByCode(client, code) {
  const { rows } = await client.query(`SELECT account_id FROM chart_of_accounts WHERE account_code = $1`, [code]);
  if (!rows.length) throw new Error(`Account code ${code} not found`);
  return rows[0].account_id;
}

async function resolveSalesTaxes(client, lines = []) {
  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    l.quantity = Number(l.quantity || 0);
    l.unitPrice = Number(l.unitPrice || 0);
    if (!(l.quantity > 0)) throw new Error(`Quantity must be greater than zero for ${l.description || 'line item'}`);
    if (l.unitPrice < 0) throw new Error(`Unit price cannot be negative for ${l.description || 'line item'}`);
    l.lineTotal = l.quantity * l.unitPrice;
    subtotal += l.lineTotal;
    const taxCodeId = await resolveTaxCodeForLine(client, {
      stockItemId: l.stockItemId,
      explicitTaxCodeId: l.taxCodeId || null,
      direction: 'SALES',
    });
    const tax = await resolveLineTax(client, { taxCodeId, lineAmount: l.lineTotal });
    l.taxCodeId = tax.taxCodeId;
    l.taxRate = tax.rate;
    l.taxAmount = tax.taxAmount;
    taxAmount += tax.taxAmount;
  }
  return { subtotal, taxAmount, totalAmount: subtotal + taxAmount };
}

async function insertLines(client, table, id, lines) {
  const sql = {
    quotation_line: `INSERT INTO quotation_line
      (line_id, quotation_id, item_code, stock_item_id, description, quantity, unit_price, line_total, tax_rate, tax_amount, tax_code_id, line_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    sales_order_line: `INSERT INTO sales_order_line
      (line_id, sales_order_id, item_code, stock_item_id, description, quantity, unit_price, line_total, quantity_delivered, tax_rate, tax_amount, tax_code_id, line_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12)`,
  }[table];
  if (!sql) throw new Error('Unsupported line table');
  let lineNo = 1;
  for (const l of lines) {
    await client.query(sql, [uuidv4(), id, l.itemCode || null, l.stockItemId || null, l.description,
      l.quantity, l.unitPrice, l.lineTotal, l.taxRate || 0, l.taxAmount || 0, l.taxCodeId || null, lineNo++]);
  }
}

async function createQuotation(client, { quotationNo, partnerId, quotationDate, validUntil, lines, createdBy }) {
  if (!partnerId) throw new Error('Customer is required');
  if (!lines?.length) throw new Error('At least one line is required');
  const totals = await resolveSalesTaxes(client, lines);
  const id = uuidv4();
  const finalQuotationNo = String(quotationNo || '').trim() || await nextDocumentNo(client, 'QUOTATION', quotationDate);
  await client.query(`INSERT INTO quotation
    (quotation_id, quotation_no, partner_id, quotation_date, valid_until, status, subtotal, tax_amount, total_amount, created_by)
    VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9)`,
    [id, finalQuotationNo, partnerId, quotationDate, validUntil || null, totals.subtotal, totals.taxAmount, totals.totalAmount, createdBy || 'system']);
  await insertLines(client, 'quotation_line', id, lines);
  return { quotationId: id, quotationNo: finalQuotationNo, ...totals, status: 'OPEN' };
}

async function createSalesOrder(client, { orderNo, partnerId, quotationId, orderDate, expectedDate, lines, createdBy }) {
  let effectiveLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  let effectivePartnerId = partnerId || null;

  if (quotationId) {
    const qh = await client.query(`SELECT quotation_id, partner_id, status FROM quotation WHERE quotation_id=$1 FOR UPDATE`, [quotationId]);
    if (!qh.rows.length) throw new Error('Quotation not found');
    if (qh.rows[0].status !== 'OPEN') throw new Error('Quotation is not open for conversion');
    effectivePartnerId = effectivePartnerId || qh.rows[0].partner_id;
    if (effectivePartnerId !== qh.rows[0].partner_id) throw new Error('Customer does not match the quotation');
    if (!effectiveLines.length) {
      const ql = await client.query(`SELECT item_code, stock_item_id, description, quantity, unit_price, tax_rate, tax_amount, tax_code_id
        FROM quotation_line WHERE quotation_id=$1 ORDER BY line_no`, [quotationId]);
      effectiveLines = ql.rows.map(l => ({
        itemCode: l.item_code, stockItemId: l.stock_item_id, description: l.description,
        quantity: Number(l.quantity), unitPrice: Number(l.unit_price), taxRate: Number(l.tax_rate || 0),
        taxAmount: Number(l.tax_amount || 0), taxCodeId: l.tax_code_id,
      }));
    }
  }
  if (!effectivePartnerId) throw new Error('Customer is required');
  if (!effectiveLines.length) throw new Error('At least one line is required');
  const totals = await resolveSalesTaxes(client, effectiveLines);
  const id = uuidv4();
  const finalOrderNo = String(orderNo || '').trim() || await nextDocumentNo(client, 'SALES_ORDER', orderDate);
  await client.query(`INSERT INTO sales_order
    (sales_order_id, order_no, quotation_id, partner_id, order_date, expected_date, status, subtotal, tax_amount, total_amount, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10)`,
    [id, finalOrderNo, quotationId || null, effectivePartnerId, orderDate, expectedDate || null, totals.subtotal, totals.taxAmount, totals.totalAmount, createdBy || 'system']);
  await insertLines(client, 'sales_order_line', id, effectiveLines);
  if (quotationId) await client.query(`UPDATE quotation SET status='CONVERTED' WHERE quotation_id=$1 AND status='OPEN'`, [quotationId]);
  return { salesOrderId: id, orderNo: finalOrderNo, ...totals, status: 'OPEN', quotationId: quotationId || null };
}

async function getSalesOrder(client, id) {
  const h = await client.query(`SELECT so.*, p.partner_name FROM sales_order so JOIN partner p ON p.partner_id=so.partner_id WHERE so.sales_order_id=$1`, [id]);
  if (!h.rows.length) return null;
  const l = await client.query(`SELECT * FROM sales_order_line WHERE sales_order_id=$1 ORDER BY line_no`, [id]);
  return { ...h.rows[0], lines: l.rows };
}

async function getDeliveryOrder(client, id) {
  const h = await client.query(`SELECT d.*, p.partner_name, so.order_no
    FROM delivery_order d JOIN partner p ON p.partner_id=d.partner_id JOIN sales_order so ON so.sales_order_id=d.sales_order_id
    WHERE d.delivery_order_id=$1`, [id]);
  if (!h.rows.length) return null;
  const l = await client.query(`SELECT * FROM delivery_order_line WHERE delivery_order_id=$1 ORDER BY line_no`, [id]);
  return { ...h.rows[0], lines: l.rows };
}

async function listOpenDeliveryOrders(client) {
  const { rows } = await client.query(`SELECT d.delivery_order_id,d.delivery_no,d.sales_order_id,so.order_no,d.partner_id,p.partner_name,
    d.delivery_date,d.status,d.subtotal,d.tax_amount,d.total_amount,d.is_fully_invoiced
    FROM delivery_order d JOIN sales_order so ON so.sales_order_id=d.sales_order_id JOIN partner p ON p.partner_id=d.partner_id
    WHERE d.status='POSTED' AND d.is_fully_invoiced=FALSE ORDER BY d.delivery_date DESC,d.delivery_no DESC`);
  return rows;
}

async function createDeliveryOrder(client, { deliveryNo, salesOrderId, deliveryDate, notes, lines, createdBy }) {
  await client.query(`SELECT sales_order_id FROM sales_order WHERE sales_order_id=$1 FOR UPDATE`, [salesOrderId]);
  const so = await getSalesOrder(client, salesOrderId);
  if (!so) throw new Error('Sales Order not found');
  if (!lines?.length) throw new Error('At least one line is required');
  const soById = new Map(so.lines.map(x => [x.line_id, x]));
  const normalized = [];

  const usedSalesOrderLines = new Set();
  for (const l of lines) {
    if (!l.salesOrderLineId) throw new Error(`Each Delivery Order line must reference its Sales Order line`);
    const match = soById.get(l.salesOrderLineId);
    if (!match) throw new Error(`Line ${l.description || ''} is not on the selected Sales Order`);
    if (usedSalesOrderLines.has(match.line_id)) throw new Error(`Sales Order line ${match.line_id} appears more than once in this Delivery Order`);
    usedSalesOrderLines.add(match.line_id);
    const remaining = Number(match.quantity) - Number(match.quantity_delivered);
    const qty = Number(l.quantity);
    if (!(qty > 0) || qty > remaining) throw new Error(`Delivery quantity exceeds outstanding quantity for ${match.description}`);
    if ((l.stockItemId || null) !== (match.stock_item_id || null)) throw new Error(`Stock item does not match Sales Order line ${match.line_id}`);
    const lineTotal = qty * Number(match.unit_price);
    normalized.push({ soLine: match, quantity: qty, unitPrice: Number(match.unit_price), itemCode: match.item_code,
      stockItemId: match.stock_item_id, description: match.description, taxCodeId: match.tax_code_id,
      taxRate: Number(match.tax_rate || 0), taxAmount: lineTotal * Number(match.tax_rate || 0) / 100, lineTotal });
  }

  const subtotal = normalized.reduce((s,x)=>s+x.lineTotal,0);
  const taxAmount = normalized.reduce((s,x)=>s+x.taxAmount,0);
  const totalAmount = subtotal + taxAmount;
  const id = uuidv4();
  const finalDeliveryNo = String(deliveryNo || '').trim() || await nextDocumentNo(client, 'DELIVERY_ORDER', deliveryDate);
  await client.query(`INSERT INTO delivery_order
    (delivery_order_id, delivery_no, sales_order_id, partner_id, delivery_date, status, subtotal, tax_amount, total_amount, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,'POSTED',$6,$7,$8,$9,$10)`,
    [id,finalDeliveryNo,salesOrderId,so.partner_id,deliveryDate,subtotal,taxAmount,totalAmount,notes||null,createdBy||'system']);
  let n=1;
  for(const x of normalized){
    await client.query(`INSERT INTO delivery_order_line
      (line_id,delivery_order_id,sales_order_line_id,item_code,stock_item_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,tax_code_id,line_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [uuidv4(),id,x.soLine.line_id,x.itemCode,x.stockItemId,x.description,x.quantity,x.unitPrice,x.lineTotal,x.taxRate,x.taxAmount,x.taxCodeId||null,n++]);
    await client.query(`UPDATE sales_order_line SET quantity_delivered=quantity_delivered+$1 WHERE line_id=$2`,[x.quantity,x.soLine.line_id]);
  }
  const stock = await moveStockForLines(client,{lines:normalized,direction:'OUT',movementType:'DELIVERY_ORDER',sourceDocId:id,sourceDocNo:finalDeliveryNo,movementDate:deliveryDate});
  const costLines = saleCostLines(stock.accounting);
  let journalId = null;
  if (costLines.length) {
    const posted = await postJournal(client, {
      journalDate: deliveryDate, source:'AR', sourceDocId:id,
      description:`Inventory cost for Delivery Order ${finalDeliveryNo}`, createdBy, prefix:'DO'
    }, costLines);
    journalId = posted.journalId;
    await client.query(`UPDATE delivery_order SET journal_id=$1 WHERE delivery_order_id=$2`, [journalId,id]);
  }
  await client.query(`UPDATE sales_order SET status=CASE
    WHEN NOT EXISTS (SELECT 1 FROM sales_order_line WHERE sales_order_id=$1 AND quantity_delivered < quantity)
      THEN 'DELIVERED'::sales_order_status
    ELSE 'PARTIALLY_DELIVERED'::sales_order_status END WHERE sales_order_id=$1`,[salesOrderId]);
  return {deliveryOrderId:id,deliveryNo:finalDeliveryNo,subtotal,taxAmount,totalAmount,journalId,stockWarnings:stock.warnings||[]};
}

async function getSalesInvoiceForNote(client, invoiceId) {
  const h = await client.query(`SELECT invoice_id,invoice_no,partner_id,invoice_date,due_date,status,subtotal,tax_amount,total_amount,paid_amount,
    credited_amount,debited_amount FROM sales_invoice WHERE invoice_id=$1 FOR UPDATE`,[invoiceId]);
  if(!h.rows.length)return null;
  const l=await client.query(`SELECT line_id,item_code,stock_item_id,description,quantity,unit_price,tax_rate,tax_code_id,line_total,revenue_account_id
    FROM sales_invoice_line WHERE invoice_id=$1 ORDER BY line_id`,[invoiceId]);
  return {...h.rows[0],lines:l.rows.map(r=>({...r,tax_amount:Number(r.line_total||0)*Number(r.tax_rate||0)/100}))};
}

async function recomputeInvoiceStatus(client, invoiceId) {
  const {rows}=await client.query(`SELECT total_amount,paid_amount,credited_amount,debited_amount FROM sales_invoice WHERE invoice_id=$1 FOR UPDATE`,[invoiceId]);
  if(!rows.length)throw new Error('Sales Invoice not found');
  const x=rows[0];
  const balance=Number(x.total_amount)+Number(x.debited_amount)-Number(x.credited_amount)-Number(x.paid_amount);
  let status='POSTED';
  if(balance<=0.005) status=Number(x.credited_amount)>0&&Number(x.paid_amount)<=0.005?'CREDITED':'PAID';
  else if(Number(x.paid_amount)>0.005||Number(x.credited_amount)>0.005||Number(x.debited_amount)>0.005) status='PARTIALLY_PAID';
  await client.query(`UPDATE sales_invoice SET status=$1::invoice_status WHERE invoice_id=$2`,[status,invoiceId]);
  return {...x,balance,status};
}

async function createSalesNote(client,{type,noteNo,partnerId,originalInvoiceId,noteDate,lines,returnGoods,createdBy}){
  if(type!=='DEBIT'&&type!=='CREDIT')throw new Error('Note type must be DEBIT or CREDIT');
  if(!partnerId)throw new Error('Customer is required');
  if(!originalInvoiceId)throw new Error(`${type==='DEBIT'?'Debit':'Credit'} Note must reference a Sales Invoice`);
  const invoice=await getSalesInvoiceForNote(client,originalInvoiceId);
  if(!invoice)throw new Error('Original Sales Invoice not found');
  if(invoice.status==='VOID')throw new Error('Cannot create a note against a void Sales Invoice');
  if(invoice.partner_id!==partnerId)throw new Error('Customer does not match the original Sales Invoice');
  if(!lines?.length)throw new Error('At least one line is required');

  const invoiceLines=new Map(invoice.lines.map(l=>[l.line_id,l]));
  let subtotal=0,taxAmount=0;const normalized=[];
  for(const l of lines){
    const source=invoiceLines.get(l.salesInvoiceLineId||l.invoiceLineId||l.lineId);
    if(!source)throw new Error('Every note line must reference an original Sales Invoice line');
    const qty=Number(l.quantity); if(!(qty>0))throw new Error(`Quantity must be greater than zero for ${source.description}`);
    const unitPrice=Number(l.unitPrice??source.unit_price); if(unitPrice<0)throw new Error('Unit price cannot be negative');
    if(type==='CREDIT'&&returnGoods&&source.stock_item_id){
      const used=await client.query(`SELECT COALESCE(SUM(cnl.quantity),0) AS qty FROM credit_note_line cnl JOIN credit_note cn ON cn.credit_note_id=cnl.credit_note_id
        WHERE cn.original_invoice_id=$1 AND cnl.sales_invoice_line_id=$2 AND cn.status='POSTED'`,[originalInvoiceId,source.line_id]);
      const already=Number(used.rows[0].qty||0); if(qty>Number(source.quantity)-already)throw new Error(`Credit return quantity exceeds remaining quantity for ${source.description}`);
    }
    const lineTotal=qty*unitPrice; const rate=Number(source.tax_rate||0); const lineTax=lineTotal*rate/100;
    subtotal+=lineTotal; taxAmount+=lineTax;
    normalized.push({source,quantity:qty,unitPrice,lineTotal,taxRate:rate,taxAmount:lineTax,taxCodeId:source.tax_code_id,revenueAccountId:source.revenue_account_id,
      itemCode:source.item_code,stockItemId:source.stock_item_id,description:source.description});
  }
  const totalAmount=subtotal+taxAmount;
  const currentBalance=Number(invoice.total_amount)+Number(invoice.debited_amount)-Number(invoice.credited_amount)-Number(invoice.paid_amount);
  if(type==='CREDIT'&&totalAmount>currentBalance+0.005)throw new Error(`Credit Note total RM${totalAmount.toFixed(2)} exceeds the invoice's remaining balance RM${Math.max(currentBalance,0).toFixed(2)}`);
  const finalNoteNo = String(noteNo || '').trim() || await nextDocumentNo(client, type === 'DEBIT' ? 'DEBIT_NOTE' : 'CREDIT_NOTE', noteDate);

  const table=type==='DEBIT'?'debit_note':'credit_note',idCol=type==='DEBIT'?'debit_note_id':'credit_note_id',lineTable=type==='DEBIT'?'debit_note_line':'credit_note_line',lineFk=type==='DEBIT'?'debit_note_id':'credit_note_id',id=uuidv4();
  await client.query(`INSERT INTO ${table} (${idCol},note_no,partner_id,original_invoice_id,note_date,status,subtotal,tax_amount,total_amount,return_goods,created_by)
    VALUES ($1,$2,$3,$4,$5,'POSTED',$6,$7,$8,$9,$10)`,[id,finalNoteNo,partnerId,originalInvoiceId,noteDate,subtotal,taxAmount,totalAmount,type==='CREDIT'?!!returnGoods:false,createdBy||'system']);
  let n=1;
  for(const x of normalized)await client.query(`INSERT INTO ${lineTable}
    (line_id,${lineFk},sales_invoice_line_id,item_code,stock_item_id,description,quantity,unit_price,line_total,revenue_account_id,tax_rate,tax_amount,tax_code_id,line_no)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[uuidv4(),id,x.source.line_id,x.itemCode||null,x.stockItemId||null,x.description,x.quantity,x.unitPrice,x.lineTotal,x.revenueAccountId,x.taxRate,x.taxAmount,x.taxCodeId||null,n++]);

  let returnStock={warnings:[],accounting:{inventoryIn:[]}};
  if(type==='CREDIT'&&returnGoods){returnStock=await moveStockForLines(client,{lines:normalized,direction:'IN',movementType:'CREDIT_NOTE',sourceDocId:id,sourceDocNo:finalNoteNo,movementDate:noteDate});}

  const arAccountId=await getAccountIdByCode(client,AR_CONTROL_ACCOUNT_CODE);const glByAccount=new Map();
  const addGL=(accountId,debit,credit,description)=>{if(!accountId)return;const row=glByAccount.get(accountId)||{accountId,debit:0,credit:0,description};row.debit+=debit;row.credit+=credit;glByAccount.set(accountId,row);};
  for(const x of normalized){
    if(type==='DEBIT')addGL(x.revenueAccountId,0,x.lineTotal,`Debit note - ${x.description}`);else addGL(x.revenueAccountId,x.lineTotal,0,`Credit note - ${x.description}`);
    if(x.taxAmount>0){const tc=await getTaxCode(client,x.taxCodeId);if(tc?.tax_account_id){if(type==='DEBIT')addGL(tc.tax_account_id,0,x.taxAmount,'Sales tax adjustment');else addGL(tc.tax_account_id,x.taxAmount,0,'Sales tax adjustment');}}
  }
  if(type==='DEBIT')addGL(arAccountId,totalAmount,0,`AR - ${finalNoteNo}`);else addGL(arAccountId,0,totalAmount,`AR - ${finalNoteNo}`);
  if(type==='CREDIT'&&returnGoods){
    for(const x of (returnStock.accounting.inventoryIn||[])) addGL(x.accountId,x.amount,0,`Inventory returned - ${x.description||finalNoteNo}`);
    for(const x of (returnStock.accounting.inventoryIn||[])) if(x.cogsAccountId) addGL(x.cogsAccountId,0,x.amount,`COGS reversal - ${x.description||finalNoteNo}`);
  }
  const {journalId}=await postJournal(client,{journalDate:noteDate,source:'AR',sourceDocId:id,description:`${type==='DEBIT'?'Debit':'Credit'} Note ${finalNoteNo} against ${invoice.invoice_no}`,createdBy,prefix:type==='DEBIT'?'DN':'CN'},[...glByAccount.values()]);
  await client.query(`UPDATE ${table} SET journal_id=$1 WHERE ${idCol}=$2`,[journalId,id]);
  if(type==='DEBIT')await client.query(`UPDATE sales_invoice SET debited_amount=debited_amount+$1 WHERE invoice_id=$2`,[totalAmount,originalInvoiceId]);
  else await client.query(`UPDATE sales_invoice SET credited_amount=credited_amount+$1 WHERE invoice_id=$2`,[totalAmount,originalInvoiceId]);
  const invoiceStatus=await recomputeInvoiceStatus(client,originalInvoiceId);
  const warnings=returnStock.warnings||[];
  return {id,noteNo:finalNoteNo,originalInvoiceId,subtotal,taxAmount,totalAmount,journalId,invoiceStatus,stockWarnings:warnings};
}

module.exports={createQuotation,createSalesOrder,getSalesOrder,getDeliveryOrder,listOpenDeliveryOrders,createDeliveryOrder,createSalesNote,getSalesInvoiceForNote};
