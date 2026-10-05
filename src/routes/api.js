const express = require('express');
const router = express.Router();

// Express 4 does not automatically forward rejected async route handlers to
// error middleware. Wrap every route/middleware function registered on this
// router so a malformed request or transient DB error cannot take down the
// process. Existing try/catch handlers remain valid and simply resolve normally.
const wrapAsync = (fn) => (req, res, next) => {
  try {
    return Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    return next(err);
  }
};
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = router[method].bind(router);
  router[method] = (path, ...handlers) => original(path, ...handlers.map(wrapAsync));
}
const { pool, withTransaction } = require('../db');
const { createAndPostCashSale } = require('../models/cashSale');
const { createAndPostPurchaseInvoice } = require('../models/purchaseInvoice');
const { createPaymentWithAllocation } = require('../models/payment');
const { createAndPostInvoice } = require('../models/salesInvoice');
const { createReceiptWithAllocation } = require('../models/receipt');
const { getTrialBalance, postReversal } = require('../models/journal');
const { getGLIntegrity } = require('../models/integrity');
const { createPurchaseRequest, setPurchaseRequestStatus } = require('../models/purchaseRequest');
const { createPurchaseOrder } = require('../models/purchaseOrder');
const { createAndPostGRN } = require('../models/goodsReceivedNote');
const { createAndPostCashPurchase } = require('../models/cashPurchase');
const { listStockItems, searchStockItems, createStockItem, updateStockItem, setStockItemActive, setCostingMethod, getStockItem, getStockItemLookup, getStockMovements } = require('../models/stock');
const { listTaxCodes, createTaxCode, updateTaxCode, setTaxCodeActive } = require('../models/tax');
const { listPartners, searchPartners, getPartner, createPartner, updatePartner, setPartnerActive } = require('../models/partner');
const { createQuotation, createSalesOrder, getSalesOrder, getDeliveryOrder, listOpenDeliveryOrders, createDeliveryOrder, createSalesNote } = require('../models/salesDocuments');
const { voidDocument, deleteDocument } = require('../models/documentActions');
const { createPaymentVoucher, createOfficialReceipt, listPaymentVouchers, listOfficialReceipts, getPaymentVoucher, getOfficialReceipt, voidPaymentVoucher, voidOfficialReceipt, deletePaymentVoucher, deleteOfficialReceipt } = require('../models/cashBook');

// --- Stock / Inventory ---
router.get('/stock-items', async (req, res) => {
  try {
    const hasPaging = Object.prototype.hasOwnProperty.call(req.query, 'page') ||
      Object.prototype.hasOwnProperty.call(req.query, 'pageSize');
    res.json(await listStockItems(pool, {
      includeInactive: req.query.includeInactive === 'true',
      search: req.query.q || '',
      page: hasPaging ? req.query.page : null,
      pageSize: hasPaging ? req.query.pageSize : 50,
      sortBy: req.query.sortBy || 'item_code',
      sortDir: req.query.sortDir || 'asc',
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/stock-items/search', async (req, res) => {
  try {
    res.json(await searchStockItems(pool, {
      search: req.query.q || '',
      limit: req.query.limit || 20,
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/stock-items', async (req, res) => {
  try {
    res.status(201).json(await withTransaction(client => createStockItem(client, req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/stock-items/:id', async (req, res) => {
  try {
    res.json(await withTransaction(client => updateStockItem(client, req.params.id, req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Deliberately its own endpoint rather than a field on the general edit
// form above: switching costing method has real side effects (opening a
// FIFO lot for stock already on hand) that a plain field edit shouldn't
// trigger silently. See setCostingMethod() for what happens on each switch.
router.patch('/stock-items/:id/costing-method', async (req, res) => {
  try {
    res.json(await withTransaction(client => setCostingMethod(client, req.params.id, req.body.costingMethod)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// "Delete" is a soft delete (is_active = false) - see setStockItemActive()
// for why a real DELETE isn't safe once an item has any transaction history.
router.delete('/stock-items/:id', async (req, res) => {
  try {
    res.json(await withTransaction(client => setStockItemActive(client, req.params.id, false)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/stock-items/:id/reactivate', async (req, res) => {
  try {
    res.json(await withTransaction(client => setStockItemActive(client, req.params.id, true)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/stock-items/:id/lookup', async (req, res) => {
  try {
    const item = await getStockItemLookup(pool, req.params.id);
    if (!item) return res.status(404).json({ error: 'Stock item not found' });
    res.json(item);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/stock-items/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const item = await getStockItem(client, req.params.id);
    if (!item) return res.status(404).json({ error: 'Stock item not found' });
    res.json({ ...item, movements: await getStockMovements(client, req.params.id) });
  } catch (err) { res.status(400).json({ error: err.message }); }
  finally { client.release(); }
});

// --- Tax Codes ---
router.get('/tax-codes', async (req, res) => {
  try {
    res.json(await listTaxCodes(pool, {
      direction: req.query.direction || null,
      includeInactive: req.query.includeInactive === 'true',
    }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/tax-codes', async (req, res) => {
  try {
    res.status(201).json(await withTransaction(client => createTaxCode(client, req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/tax-codes/:id', async (req, res) => {
  try {
    res.json(await withTransaction(client => updateTaxCode(client, req.params.id, req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// "Delete" is a soft delete (is_active = false), same reasoning as stock
// items - a tax code may already be referenced by historical lines via
// tax_code_id, so a real DELETE could break those records or fail on the
// foreign key. Deactivating removes it from pick-lists on new documents
// while keeping every past document's tax_code_id intact.
router.delete('/tax-codes/:id', async (req, res) => {
  try {
    res.json(await withTransaction(client => setTaxCodeActive(client, req.params.id, false)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/tax-codes/:id/reactivate', async (req, res) => {
  try {
    res.json(await withTransaction(client => setTaxCodeActive(client, req.params.id, true)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Fiscal Periods (prevents posting into a date with no open period) ---
router.get('/fiscal-periods', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT period_id, period_name, start_date, end_date, is_closed FROM fiscal_period ORDER BY start_date');
    res.json(rows);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Opens the single calendar month right after the latest existing period (no
// gaps, no overlaps, no picking dates by hand) - same "next period" idea as
// closing a month in SQL Account.
router.post('/fiscal-periods/next', async (req, res) => {
  try {
    res.status(201).json(await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT end_date FROM fiscal_period ORDER BY end_date DESC LIMIT 1 FOR UPDATE');
      // Date.UTC's month argument is 0-indexed (0=Jan..11=Dec), but end_date's
      // middle component is a human month number (1-12) - subtract 1 or this
      // silently skips/duplicates a month at every Dec->Jan and leap-Feb boundary.
      const [ly, lm, ld] = rows.length ? rows[0].end_date.split('-').map(Number) : [];
      const start = rows.length
        ? new Date(Date.UTC(ly, lm - 1, ld) + 86400000)
        : new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1));
      const y = start.getUTCFullYear(), m = start.getUTCMonth();
      const startDate = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const endDate = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
      const periodName = `${y}-${String(m + 1).padStart(2, '0')}`;
      const { rows: created } = await client.query(
        'INSERT INTO fiscal_period (period_name, start_date, end_date) VALUES ($1,$2,$3) RETURNING period_id, period_name, start_date, end_date, is_closed',
        [periodName, startDate, endDate],
      );
      return created[0];
    }));
  } catch (err) {
    res.status(err.code === '23505' ? 409 : 400).json({ error: err.code === '23505' ? 'That period already exists' : err.message });
  }
});

router.patch('/fiscal-periods/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE fiscal_period SET is_closed = $1 WHERE period_id = $2 RETURNING period_id, period_name, start_date, end_date, is_closed',
      [!!req.body.is_closed, req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Fiscal period not found' });
    res.json(rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});



// --- Chart of Accounts ---
router.get('/accounts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    const where = [];
    if (!req.query.includeInactive || req.query.includeInactive !== 'true') where.push('c.is_active = TRUE');
    if (q) { params.push(`%${q}%`); where.push('(c.account_code ILIKE $1 OR c.account_name ILIKE $1)'); }
    const sql = `SELECT c.account_id, c.account_code, c.account_name, c.account_type, c.normal_balance, c.parent_id, c.is_control_account, c.is_active,
                        COALESCE(r.reporting_role, c.account_type::text) AS reporting_role,
                        COALESCE(r.is_cash_account, FALSE) AS is_cash_account,
                        COALESCE(r.is_inventory_account, FALSE) AS is_inventory_account,
                        COALESCE(r.is_receivable_account, FALSE) AS is_receivable_account,
                        COALESCE(r.is_payable_account, FALSE) AS is_payable_account,
                        COALESCE(r.is_grir_account, FALSE) AS is_grir_account,
                        COALESCE(r.is_cogs_account, FALSE) AS is_cogs_account
                   FROM chart_of_accounts c
                   LEFT JOIN account_reporting_role r ON r.account_id = c.account_id
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.account_code`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/accounts', async (req,res)=>{
  try {
    const { accountCode, accountName, accountType, parentId, isControlAccount } = req.body;
    if(!accountCode || !accountName || !accountType) throw new Error('Account code, name and type are required');
    const normal = ['ASSET','EXPENSE'].includes(accountType) ? 'DR' : 'CR';
    const { rows } = await pool.query(`INSERT INTO chart_of_accounts
      (account_code,account_name,account_type,parent_id,is_control_account,normal_balance)
      VALUES($1,$2,$3::account_type,$4,$5,$6)
      RETURNING account_id,account_code,account_name,account_type,normal_balance,parent_id,is_control_account,is_active`,
      [accountCode.trim(),accountName.trim(),accountType,parentId||null,!!isControlAccount,normal]);
    res.status(201).json(rows[0]);
  } catch(err){ res.status(400).json({error:err.message}); }
});

router.patch('/accounts/:id', async (req,res)=>{
  try {
    const { accountCode, accountName, accountType, parentId, isControlAccount } = req.body;
    if(!accountCode || !accountName || !accountType) throw new Error('Account code, name and type are required');
    const normal = ['ASSET','EXPENSE'].includes(accountType) ? 'DR' : 'CR';
    const { rows } = await pool.query(`UPDATE chart_of_accounts SET account_code=$1,account_name=$2,account_type=$3::account_type,parent_id=$4,is_control_account=$5,normal_balance=$6 WHERE account_id=$7
      RETURNING account_id,account_code,account_name,account_type,normal_balance,parent_id,is_control_account,is_active`,
      [accountCode.trim(),accountName.trim(),accountType,parentId||null,!!isControlAccount,normal,req.params.id]);
    if(!rows.length) return res.status(404).json({error:'Account not found'});
    res.json(rows[0]);
  } catch(err){ res.status(400).json({error:err.message}); }
});

router.delete('/accounts/:id', async (req,res)=>{
  try {
    const { rows } = await pool.query(`UPDATE chart_of_accounts SET is_active=FALSE WHERE account_id=$1 RETURNING account_id,account_code,account_name,is_active`, [req.params.id]);
    if(!rows.length) return res.status(404).json({error:'Account not found'});
    res.json(rows[0]);
  } catch(err){ res.status(400).json({error:err.message}); }
});
router.post('/accounts/:id/reactivate', async (req,res)=>{
  try { const {rows}=await pool.query(`UPDATE chart_of_accounts SET is_active=TRUE WHERE account_id=$1 RETURNING account_id,is_active`,[req.params.id]); if(!rows.length)return res.status(404).json({error:'Account not found'}); res.json(rows[0]); }
  catch(err){res.status(400).json({error:err.message});}
});

// Document lifecycle actions: Void preserves the audit trail by reversing
// accounting/stock effects; Delete is a guarded hard-delete for documents that
// have no downstream dependencies or later stock history.
router.post('/document-actions/:type/:id/void', async (req,res)=>{
  try { res.json(await withTransaction(c=>voidDocument(c,req.params.type,req.params.id,{createdBy:req.body.createdBy||'ui',reason:req.body.reason||'Document voided by user'}))); }
  catch(err){res.status(400).json({error:err.message});}
});

router.delete('/document-actions/:type/:id', async (req,res)=>{
  try { res.json(await withTransaction(c=>deleteDocument(c,req.params.type,req.params.id))); }
  catch(err){res.status(400).json({error:err.message});}
});

// --- Partners (Customers/Suppliers) ---
router.get('/partners', async (req, res) => {
  try {
    const hasPaging = Object.prototype.hasOwnProperty.call(req.query, 'page') || Object.prototype.hasOwnProperty.call(req.query, 'pageSize') || Object.prototype.hasOwnProperty.call(req.query, 'q');
    res.json(await listPartners(pool, { type:req.query.type||null, includeInactive:req.query.includeInactive==='true', search:req.query.q||'', page:hasPaging?req.query.page:null, pageSize:hasPaging?req.query.pageSize:50 }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/partners/search', async (req, res) => {
  try { res.json(await searchPartners(pool, { type: req.query.type || null, search: req.query.q || '', limit: req.query.limit || 20 })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/partners/:id', async (req, res) => {
  try {
    const partner = await getPartner(pool, req.params.id);
    if (!partner) return res.status(404).json({ error: 'Partner not found' });
    res.json(partner);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/partners', async (req, res) => {
  try {
    res.status(201).json(await withTransaction(client => createPartner(client, req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/partners/:id', async (req, res) => {
  try {
    res.json(await withTransaction(client => updatePartner(client, req.params.id, req.body)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/partners/:id', async (req, res) => {
  try {
    res.json(await withTransaction(client => setPartnerActive(client, req.params.id, false)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/partners/:id/reactivate', async (req, res) => {
  try {
    res.json(await withTransaction(client => setPartnerActive(client, req.params.id, true)));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- Sales document flow ---
router.get('/quotations', async (req,res)=>{ try { const {rows}=await pool.query(`SELECT q.quotation_id,q.quotation_no,q.partner_id,p.partner_name,q.quotation_date,q.valid_until,q.status,q.total_amount FROM quotation q JOIN partner p ON p.partner_id=q.partner_id ORDER BY q.quotation_date DESC,q.quotation_no DESC`); res.json(rows);}catch(e){res.status(400).json({error:e.message});}});
router.get('/quotations/open', async (req,res)=>{ try { const {rows}=await pool.query(`SELECT q.quotation_id,q.quotation_no,q.partner_id,p.partner_name,q.quotation_date,q.total_amount FROM quotation q JOIN partner p ON p.partner_id=q.partner_id WHERE q.status='OPEN' ORDER BY q.quotation_date DESC,q.quotation_no DESC`); res.json(rows);}catch(e){res.status(400).json({error:e.message});}});
router.get('/quotations/:id', async (req,res)=>{ try { const h=await pool.query(`SELECT q.*,p.partner_name FROM quotation q JOIN partner p ON p.partner_id=q.partner_id WHERE q.quotation_id=$1`,[req.params.id]); if(!h.rows.length)return res.status(404).json({error:'Quotation not found'}); const l=await pool.query(`SELECT * FROM quotation_line WHERE quotation_id=$1 ORDER BY line_no`,[req.params.id]); res.json({...h.rows[0],lines:l.rows}); }catch(e){res.status(400).json({error:e.message});}});
router.post('/quotations', async (req,res)=>{ try {res.status(201).json(await withTransaction(c=>createQuotation(c,req.body)));}catch(e){res.status(400).json({error:e.message});}});

router.get('/sales-orders', async (req,res)=>{ try { const {rows}=await pool.query(`SELECT so.sales_order_id,so.order_no,so.partner_id,p.partner_name,so.order_date,so.expected_date,so.status,so.total_amount FROM sales_order so JOIN partner p ON p.partner_id=so.partner_id ORDER BY so.order_date DESC,so.order_no DESC`);res.json(rows);}catch(e){res.status(400).json({error:e.message});}});
router.get('/sales-orders/open', async (req,res)=>{ try { const {rows}=await pool.query(`SELECT so.sales_order_id,so.order_no,so.partner_id,p.partner_name,so.order_date,so.expected_date,so.status,so.total_amount FROM sales_order so JOIN partner p ON p.partner_id=so.partner_id WHERE so.status IN ('OPEN','PARTIALLY_DELIVERED') ORDER BY so.order_date DESC,so.order_no DESC`);res.json(rows);}catch(e){res.status(400).json({error:e.message});}});
router.get('/sales-orders/:id', async (req,res)=>{ try {const d=await getSalesOrder(pool,req.params.id);if(!d)return res.status(404).json({error:'Sales Order not found'});res.json(d);}catch(e){res.status(400).json({error:e.message});}});
router.post('/sales-orders', async (req,res)=>{ try {res.status(201).json(await withTransaction(c=>createSalesOrder(c,req.body)));}catch(e){res.status(400).json({error:e.message});}});

router.get('/delivery-orders/open', async (req,res)=>{ try { res.json(await listOpenDeliveryOrders(pool)); } catch(e) { res.status(400).json({error:e.message}); } });
router.get('/delivery-orders', async (req,res)=>{ try { const {rows}=await pool.query(`SELECT d.delivery_order_id,d.delivery_no,d.sales_order_id,so.order_no,d.partner_id,p.partner_name,d.delivery_date,d.status,d.subtotal,d.is_fully_invoiced FROM delivery_order d JOIN sales_order so ON so.sales_order_id=d.sales_order_id JOIN partner p ON p.partner_id=d.partner_id ORDER BY d.delivery_date DESC,d.delivery_no DESC`);res.json(rows);}catch(e){res.status(400).json({error:e.message});}});
router.get('/delivery-orders/:id', async (req,res)=>{ try { const d=await getDeliveryOrder(pool,req.params.id); if(!d) return res.status(404).json({error:'Delivery Order not found'}); res.json(d); } catch(e) { res.status(400).json({error:e.message}); } });
router.post('/delivery-orders', async (req,res)=>{ try {res.status(201).json(await withTransaction(c=>createDeliveryOrder(c,req.body)));}catch(e){res.status(400).json({error:e.message});}});

router.get('/sales-notes', async (req,res)=>{ const type=req.query.type==='CREDIT'?'credit_note':'debit_note'; const id=type==='credit_note'?'credit_note_id':'debit_note_id'; try{const{rows}=await pool.query(`SELECT n.${id} AS note_id,n.note_no,n.partner_id,p.partner_name,n.original_invoice_id,si.invoice_no AS original_invoice_no,n.note_date,n.subtotal,n.tax_amount,n.total_amount,n.status FROM ${type} n JOIN partner p ON p.partner_id=n.partner_id LEFT JOIN sales_invoice si ON si.invoice_id=n.original_invoice_id ORDER BY n.note_date DESC,n.note_no DESC`);res.json(rows);}catch(e){res.status(400).json({error:e.message});} });
router.post('/sales-notes', async (req,res)=>{ try{res.status(201).json(await withTransaction(c=>createSalesNote(c,req.body)));}catch(e){res.status(400).json({error:e.message});} });

// --- Sales Invoice: list, create + auto-post to GL ---
router.get('/invoices/open-for-notes', async (req,res)=>{ try{const{rows}=await pool.query(`SELECT si.invoice_id,si.invoice_no,si.partner_id,p.partner_name,si.invoice_date,si.total_amount,si.paid_amount,si.credited_amount,si.debited_amount,(si.total_amount+si.debited_amount-si.credited_amount-si.paid_amount) AS outstanding FROM sales_invoice si JOIN partner p ON p.partner_id=si.partner_id WHERE si.status <> 'VOID' AND (si.total_amount+si.debited_amount-si.credited_amount-si.paid_amount) > 0.005 ORDER BY si.invoice_date DESC,si.invoice_no DESC`);res.json(rows);}catch(e){res.status(400).json({error:e.message});} });
router.get('/invoices', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT si.invoice_id, si.invoice_no, si.partner_id, p.partner_name, si.invoice_date, si.due_date,
            si.status, si.subtotal, si.tax_amount, si.total_amount, si.paid_amount, si.credited_amount, si.debited_amount,
            (si.total_amount + si.debited_amount - si.credited_amount - si.paid_amount) AS outstanding
       FROM sales_invoice si JOIN partner p ON p.partner_id = si.partner_id
      ORDER BY si.invoice_date DESC, si.invoice_no DESC`
  );
  res.json(rows);
});

router.post('/invoices', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      createAndPostInvoice(client, req.body)
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/invoices/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM sales_invoice WHERE invoice_id = $1`, [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(
    `SELECT * FROM sales_invoice_line WHERE invoice_id = $1`, [req.params.id]
  );
  res.json({ ...rows[0], lines });
});


// --- General Ledger / Cash Book: standalone PV / OR ---
router.get('/cash-book/payment-vouchers', async (req,res)=>{
  try { res.json(await listPaymentVouchers(pool)); } catch(err){ res.status(400).json({error:err.message}); }
});
router.get('/cash-book/payment-vouchers/:id', async (req,res)=>{
  try { const d=await getPaymentVoucher(pool,req.params.id); if(!d)return res.status(404).json({error:'Payment Voucher not found'}); res.json(d); } catch(err){res.status(400).json({error:err.message});}
});
router.post('/cash-book/payment-vouchers', async (req,res)=>{
  try { res.status(201).json(await withTransaction(c=>createPaymentVoucher(c,req.body))); } catch(err){res.status(400).json({error:err.message});}
});
router.post('/cash-book/payment-vouchers/:id/void', async (req,res)=>{
  try { res.json(await withTransaction(c=>voidPaymentVoucher(c,req.params.id,{createdBy:req.body.createdBy||'ui',reason:req.body.reason||'Payment Voucher voided by user'}))); } catch(err){res.status(400).json({error:err.message});}
});
router.delete('/cash-book/payment-vouchers/:id', async (req,res)=>{
  try { res.json(await withTransaction(c=>deletePaymentVoucher(c,req.params.id))); } catch(err){res.status(400).json({error:err.message});}
});

router.get('/cash-book/official-receipts', async (req,res)=>{
  try { res.json(await listOfficialReceipts(pool)); } catch(err){res.status(400).json({error:err.message}); }
});
router.get('/cash-book/official-receipts/:id', async (req,res)=>{
  try { const d=await getOfficialReceipt(pool,req.params.id); if(!d)return res.status(404).json({error:'Official Receipt not found'}); res.json(d); } catch(err){res.status(400).json({error:err.message});}
});
router.post('/cash-book/official-receipts', async (req,res)=>{
  try { res.status(201).json(await withTransaction(c=>createOfficialReceipt(c,req.body))); } catch(err){res.status(400).json({error:err.message});}
});
router.post('/cash-book/official-receipts/:id/void', async (req,res)=>{
  try { res.json(await withTransaction(c=>voidOfficialReceipt(c,req.params.id,{createdBy:req.body.createdBy||'ui',reason:req.body.reason||'Official Receipt voided by user'}))); } catch(err){res.status(400).json({error:err.message});}
});
router.delete('/cash-book/official-receipts/:id', async (req,res)=>{
  try { res.json(await withTransaction(c=>deleteOfficialReceipt(c,req.params.id))); } catch(err){res.status(400).json({error:err.message});}
});

// --- Receipt: record payment + allocate + auto-post to GL ---
router.post('/receipts', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      createReceiptWithAllocation(client, req.body)
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Cash Sale: list, create + auto-post to GL ---
router.get('/cash-sales', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cs.cash_sale_id, cs.cash_sale_no, cs.partner_id, p.partner_name, cs.sale_date, cs.payment_method,
            cs.cash_account_id, cs.subtotal, cs.tax_amount, cs.total_amount, cs.status
       FROM cash_sale cs LEFT JOIN partner p ON p.partner_id = cs.partner_id
      ORDER BY cs.sale_date DESC, cs.cash_sale_no DESC`
  );
  res.json(rows);
});

router.post('/cash-sales', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      createAndPostCashSale(client, req.body)
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/cash-sales/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM cash_sale WHERE cash_sale_id = $1`, [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(
    `SELECT * FROM cash_sale_line WHERE cash_sale_id = $1`, [req.params.id]
  );
  res.json({ ...rows[0], lines });
});

// --- Purchase Invoice: list, create + auto-post to GL ---
router.get('/purchase-invoices', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pi.purchase_invoice_id, pi.invoice_no, pi.partner_id, p.partner_name, pi.grn_id, pi.invoice_date, pi.due_date,
            pi.status, pi.subtotal, pi.tax_amount, pi.total_amount, pi.paid_amount
       FROM purchase_invoice pi JOIN partner p ON p.partner_id = pi.partner_id
      ORDER BY pi.invoice_date DESC, pi.invoice_no DESC`
  );
  res.json(rows);
});

router.post('/purchase-invoices', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      createAndPostPurchaseInvoice(client, req.body)
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/purchase-invoices/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM purchase_invoice WHERE purchase_invoice_id = $1`, [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(
    `SELECT * FROM purchase_invoice_line WHERE purchase_invoice_id = $1`, [req.params.id]
  );
  res.json({ ...rows[0], lines });
});

// --- Payment (to supplier): record + allocate + auto-post to GL ---
router.post('/payments', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      createPaymentWithAllocation(client, req.body)
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Purchase Requests: list, create, approve/reject (no GL) ---
router.get('/purchase-requests', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pr_id, pr_no, requested_by, request_date, status, notes
       FROM purchase_request ORDER BY request_date DESC, pr_no DESC`
  );
  res.json(rows);
});

router.post('/purchase-requests', async (req, res) => {
  try {
    const result = await withTransaction((client) => createPurchaseRequest(client, req.body));
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/purchase-requests/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM purchase_request WHERE pr_id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(
    `SELECT * FROM purchase_request_line WHERE pr_id = $1 ORDER BY line_no`, [req.params.id]
  );
  res.json({ ...rows[0], lines });
});

router.post('/purchase-requests/:id/approve', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      setPurchaseRequestStatus(client, req.params.id, 'APPROVED', req.body.approvedBy)
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/purchase-requests/:id/reject', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      setPurchaseRequestStatus(client, req.params.id, 'REJECTED', req.body.approvedBy)
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Purchase Orders: list, create (no GL - commitment only) ---
router.get('/purchase-orders', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT po.po_id, po.po_no, po.partner_id, p.partner_name, po.order_date, po.expected_date,
            po.status, po.total_amount
       FROM purchase_order po JOIN partner p ON p.partner_id = po.partner_id
      ORDER BY po.order_date DESC, po.po_no DESC`
  );
  res.json(rows);
});

router.post('/purchase-orders', async (req, res) => {
  try {
    const result = await withTransaction((client) => createPurchaseOrder(client, req.body));
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/purchase-orders/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM purchase_order WHERE po_id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(
    `SELECT * FROM purchase_order_line WHERE po_id = $1 ORDER BY line_no`, [req.params.id]
  );
  res.json({ ...rows[0], lines });
});

// --- Goods Received Notes: list, create + auto-post GR/IR accrual to GL ---
router.get('/goods-received-notes', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT grn.grn_id, grn.grn_no, grn.po_id, po.po_no, p.partner_name,
            grn.received_date, grn.total_value, grn.is_fully_invoiced, grn.status
       FROM goods_received_note grn
       JOIN purchase_order po ON po.po_id = grn.po_id
       JOIN partner p ON p.partner_id = grn.partner_id
      ORDER BY grn.received_date DESC, grn.grn_no DESC`
  );
  res.json(rows);
});

router.post('/goods-received-notes', async (req, res) => {
  try {
    const result = await withTransaction((client) => createAndPostGRN(client, req.body));
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/goods-received-notes/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM goods_received_note WHERE grn_id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(`SELECT * FROM grn_line WHERE grn_id = $1`, [req.params.id]);
  res.json({ ...rows[0], lines });
});

// --- Cash Purchases: list, create + auto-post to GL ---
router.get('/cash-purchases', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.cash_purchase_id, cp.cash_purchase_no, cp.partner_id, p.partner_name, cp.purchase_date, cp.payment_method,
            cp.cash_account_id, cp.subtotal, cp.tax_amount, cp.total_amount, cp.status
       FROM cash_purchase cp LEFT JOIN partner p ON p.partner_id = cp.partner_id
      ORDER BY cp.purchase_date DESC, cp.cash_purchase_no DESC`
  );
  res.json(rows);
});

router.post('/cash-purchases', async (req, res) => {
  try {
    const result = await withTransaction((client) => createAndPostCashPurchase(client, req.body));
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/cash-purchases/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM cash_purchase WHERE cash_purchase_id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const { rows: lines } = await pool.query(`SELECT * FROM cash_purchase_line WHERE cash_purchase_id = $1`, [req.params.id]);
  res.json({ ...rows[0], lines });
});

// --- Journal reversal: the only sanctioned way to undo a posted journal ---
router.post('/journals/:id/reverse', async (req, res) => {
  try {
    const result = await withTransaction((client) =>
      postReversal(client, req.params.id, req.body)
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Document history: a single, unified log across every document type,
//     filterable by doc type and date range, sortable by date. This is
//     what SQL Accounting's "document listing" screens do - one place
//     to find "what did we post around this date, of this kind." ---
router.get('/reports/document-history', async (req, res) => {
  const { type, from, to, sort, category } = req.query;
  const search = String(req.query.q || '').trim();
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 10), 200);
  const sortDir = sort === 'asc' ? 'ASC' : 'DESC';

  // 'category' scopes the query to one module's documents regardless of
  // the 'type' filter - Sales Reports only ever sees sales-side types,
  // Purchase Reports only ever sees purchase-side types. This is enforced
  // here (not just in the UI dropdown) so a scoped report can never leak
  // the other module's documents even if the frontend sent a bad type.
  const SALES_TYPES = ['QUOTATION', 'SALES_ORDER', 'DELIVERY_ORDER', 'SALES_INVOICE', 'CASH_SALE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'RECEIPT'];
  const PURCHASE_TYPES = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GRN', 'PURCHASE_INVOICE', 'CASH_PURCHASE', 'PAYMENT'];
  let categoryTypes = null;
  if (category === 'SALES') categoryTypes = SALES_TYPES;
  if (category === 'PURCHASE') categoryTypes = PURCHASE_TYPES;

  const searchParam = search ? `%${search}%` : null;
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(
    `WITH docs AS (
       SELECT 'SALES_INVOICE' AS doc_type, si.invoice_id AS doc_id, si.invoice_no AS doc_no, si.invoice_date AS doc_date,
              p.partner_name,
              (SELECT string_agg(description, ', ') FROM sales_invoice_line WHERE invoice_id = si.invoice_id) AS items_summary,
              si.status::text AS status, si.total_amount
         FROM sales_invoice si JOIN partner p ON p.partner_id = si.partner_id
       UNION ALL
       SELECT 'CASH_SALE', cs.cash_sale_id, cs.cash_sale_no, cs.sale_date, COALESCE(p.partner_name,'Walk-in Customer'),
              (SELECT string_agg(description, ', ') FROM cash_sale_line WHERE cash_sale_id = cs.cash_sale_id),
              cs.status::text, cs.total_amount
         FROM cash_sale cs LEFT JOIN partner p ON p.partner_id = cs.partner_id
       UNION ALL
       SELECT 'QUOTATION', q.quotation_id, q.quotation_no, q.quotation_date, p.partner_name,
              (SELECT string_agg(description, ', ') FROM quotation_line WHERE quotation_id=q.quotation_id),
              q.status::text, q.total_amount
         FROM quotation q JOIN partner p ON p.partner_id=q.partner_id
       UNION ALL
       SELECT 'SALES_ORDER', so.sales_order_id, so.order_no, so.order_date, p.partner_name,
              (SELECT string_agg(description, ', ') FROM sales_order_line WHERE sales_order_id=so.sales_order_id),
              so.status::text, so.total_amount
         FROM sales_order so JOIN partner p ON p.partner_id=so.partner_id
       UNION ALL
       SELECT 'DELIVERY_ORDER', d.delivery_order_id, d.delivery_no, d.delivery_date, p.partner_name,
              (SELECT string_agg(description, ', ') FROM delivery_order_line WHERE delivery_order_id=d.delivery_order_id),
              d.status::text, d.total_amount
         FROM delivery_order d JOIN partner p ON p.partner_id=d.partner_id
       UNION ALL
       SELECT 'PURCHASE_REQUEST', pr.pr_id, pr.pr_no, pr.request_date, NULL,
              (SELECT string_agg(description, ', ') FROM purchase_request_line WHERE pr_id=pr.pr_id),
              pr.status::text, COALESCE((SELECT SUM(quantity*estimated_unit_price) FROM purchase_request_line WHERE pr_id=pr.pr_id),0)
         FROM purchase_request pr
       UNION ALL
       SELECT 'PURCHASE_ORDER', po.po_id, po.po_no, po.order_date, p2.partner_name,
              (SELECT string_agg(description, ', ') FROM purchase_order_line WHERE po_id=po.po_id),
              po.status::text, po.total_amount
         FROM purchase_order po JOIN partner p2 ON p2.partner_id=po.partner_id
       UNION ALL
       SELECT 'GRN', g.grn_id, g.grn_no, g.received_date, p3.partner_name,
              (SELECT string_agg(description, ', ') FROM grn_line WHERE grn_id=g.grn_id),
              g.status::text, g.total_value
         FROM goods_received_note g JOIN partner p3 ON p3.partner_id=g.partner_id
       UNION ALL
       SELECT 'PURCHASE_INVOICE', pi.purchase_invoice_id, pi.invoice_no, pi.invoice_date, p.partner_name,
              (SELECT string_agg(description, ', ') FROM purchase_invoice_line WHERE purchase_invoice_id = pi.purchase_invoice_id),
              pi.status::text, pi.total_amount
         FROM purchase_invoice pi JOIN partner p ON p.partner_id = pi.partner_id
       UNION ALL
       SELECT 'CASH_PURCHASE', cp.cash_purchase_id, cp.cash_purchase_no, cp.purchase_date, COALESCE(p.partner_name,'Unregistered Vendor'),
              (SELECT string_agg(description, ', ') FROM cash_purchase_line WHERE cash_purchase_id = cp.cash_purchase_id),
              cp.status::text, cp.total_amount
         FROM cash_purchase cp LEFT JOIN partner p ON p.partner_id = cp.partner_id
       UNION ALL
       SELECT 'DEBIT_NOTE', dn.debit_note_id, dn.note_no, dn.note_date, p.partner_name,
              (SELECT string_agg(description, ', ') FROM debit_note_line WHERE debit_note_id=dn.debit_note_id),
              dn.status::text, dn.total_amount
         FROM debit_note dn JOIN partner p ON p.partner_id=dn.partner_id
       UNION ALL
       SELECT 'CREDIT_NOTE', cn.credit_note_id, cn.note_no, cn.note_date, p.partner_name,
              (SELECT string_agg(description, ', ') FROM credit_note_line WHERE credit_note_id=cn.credit_note_id),
              cn.status::text, cn.total_amount
         FROM credit_note cn JOIN partner p ON p.partner_id=cn.partner_id
       UNION ALL
       SELECT 'RECEIPT', r.receipt_id, r.receipt_no, r.receipt_date, p.partner_name,
              (SELECT string_agg('Applied to ' || si2.invoice_no, ', ') FROM receipt_allocation ra JOIN sales_invoice si2 ON si2.invoice_id=ra.invoice_id WHERE ra.receipt_id=r.receipt_id),
              r.status::text, r.amount
         FROM receipt r JOIN partner p ON p.partner_id=r.partner_id
       UNION ALL
       SELECT 'PAYMENT', pay.payment_id, pay.payment_no, pay.payment_date, p.partner_name,
              (SELECT string_agg('Applied to ' || pi2.invoice_no, ', ') FROM payment_allocation pa JOIN purchase_invoice pi2 ON pi2.purchase_invoice_id=pa.purchase_invoice_id WHERE pa.payment_id=pay.payment_id),
              pay.status::text, pay.amount
         FROM payment pay JOIN partner p ON p.partner_id=pay.partner_id
     ), filtered AS (
       SELECT *, COUNT(*) OVER() AS total_count, SUM(total_amount) OVER() AS total_amount_all
       FROM docs
       WHERE ($1::text IS NULL OR doc_type=$1)
         AND ($2::date IS NULL OR doc_date >= $2)
         AND ($3::date IS NULL OR doc_date <= $3)
         AND ($4::text[] IS NULL OR doc_type=ANY($4))
         AND ($5::text IS NULL OR doc_no ILIKE $5 OR partner_name ILIKE $5 OR COALESCE(items_summary,'') ILIKE $5)
     )
     SELECT * FROM filtered
     ORDER BY doc_date ${sortDir}, doc_no ${sortDir}
     LIMIT $6 OFFSET $7`,
    [type && type !== 'ALL' ? type : null, from || null, to || null, categoryTypes, searchParam, pageSize, offset]
  );
  const totalCount = rows.length ? Number(rows[0].total_count) : 0;
  const totalAmount = rows.length ? Number(rows[0].total_amount_all || 0) : 0;
  res.json({ documents: rows.map(({total_count,total_amount_all,...r})=>r), count: totalCount, totalCount, totalAmount, page, pageSize, totalPages: Math.max(Math.ceil(totalCount/pageSize),1) });
});

// --- Reports ---
router.get('/reports/trial-balance', async (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    const report = await getTrialBalance(client, asOf);
    res.json({ asOf, accounts: report.rows, totalDebit: report.totalDebit, totalCredit: report.totalCredit, isBalanced: report.isBalanced });
  } finally {
    client.release();
  }
});

router.get('/reports/gl-integrity', async (req, res) => {
  const client = await pool.connect();
  try {
    res.json(await getGLIntegrity(client));
  } finally {
    client.release();
  }
});

router.get('/reports/ar-aging', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.partner_name, si.invoice_no, si.due_date,
           (si.total_amount + si.debited_amount - si.credited_amount - si.paid_amount) AS outstanding,
           CASE
             WHEN si.due_date >= CURRENT_DATE THEN 'Current'
             WHEN CURRENT_DATE - si.due_date <= 30 THEN '1-30 days'
             WHEN CURRENT_DATE - si.due_date <= 60 THEN '31-60 days'
             ELSE '60+ days'
           END AS aging_bucket
      FROM sales_invoice si
      JOIN partner p ON p.partner_id = si.partner_id
     WHERE si.status IN ('POSTED','PARTIALLY_PAID')
       AND (si.total_amount + si.debited_amount - si.credited_amount - si.paid_amount) > 0
     ORDER BY si.due_date`);
  res.json(rows);
});

router.get('/reports/ap-aging', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.partner_name, pi.invoice_no, pi.due_date,
           (pi.total_amount - pi.paid_amount) AS outstanding,
           CASE
             WHEN pi.due_date >= CURRENT_DATE THEN 'Current'
             WHEN CURRENT_DATE - pi.due_date <= 30 THEN '1-30 days'
             WHEN CURRENT_DATE - pi.due_date <= 60 THEN '31-60 days'
             ELSE '60+ days'
           END AS aging_bucket
      FROM purchase_invoice pi
      JOIN partner p ON p.partner_id = pi.partner_id
     WHERE pi.status IN ('POSTED','PARTIALLY_PAID')
       AND (pi.total_amount - pi.paid_amount) > 0
     ORDER BY pi.due_date`);
  res.json(rows);
});

module.exports = router;
