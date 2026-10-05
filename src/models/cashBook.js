const { v4: uuidv4 } = require('uuid');
const { postJournal, postReversal, getOpenPeriod } = require('./journal');

async function nextCashBookNo(client, type, date) {
  const year = Number(String(date).slice(0, 4));
  const { rows } = await client.query(
    `INSERT INTO cash_book_counter (document_type, year, last_seq)
     VALUES ($1,$2,1)
     ON CONFLICT (document_type, year)
     DO UPDATE SET last_seq = cash_book_counter.last_seq + 1
     RETURNING last_seq`,
    [type, year]
  );
  return `${type}-${year}-${String(rows[0].last_seq).padStart(6, '0')}`;
}

async function assertCashBankAccount(client, accountId) {
  const { rows } = await client.query(
    `SELECT reporting_role, account_type, is_active
       FROM account_reporting_role WHERE account_id = $1`, [accountId]
  );
  if (!rows.length) throw new Error('Cash/Bank account not found');
  if (!rows[0].is_active) throw new Error('Selected Cash/Bank account is inactive');
  if (!['CASH', 'BANK'].includes(rows[0].reporting_role)) {
    throw new Error('Selected account must be a Cash or Bank account.');
  }
}

async function normalizeLines(client, lines, type, cashAccountId) {
  if (!Array.isArray(lines) || !lines.length) throw new Error(`${type} requires at least one account line`);
  const out = [];
  let total = 0;
  for (const [index, raw] of lines.entries()) {
    const accountId = raw && raw.accountId;
    const amount = Number(raw && raw.amount);
    if (!accountId) throw new Error(`Line ${index + 1}: account is required`);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Line ${index + 1}: amount must be greater than zero`);
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) throw new Error(`Line ${index + 1}: amount cannot have more than 2 decimals`);
    if (accountId === cashAccountId) throw new Error(`Line ${index + 1}: the Cash/Bank account cannot also be the offset account`);
    const { rows } = await client.query(
      `SELECT reporting_role, is_control_account, account_type, is_active, account_code, account_name,
              is_cash_account, is_inventory_account, is_receivable_account, is_payable_account, is_grir_account
         FROM account_reporting_role WHERE account_id = $1`, [accountId]
    );
    if (!rows.length) throw new Error(`Line ${index + 1}: account not found`);
    const a = rows[0];
    if (!a.is_active) throw new Error(`Line ${index + 1}: account ${a.account_code} is inactive`);
    if (a.is_cash_account) throw new Error(`Line ${index + 1}: ${a.account_code} ${a.account_name} is a Cash/Bank account. Internal transfers must not be entered as PV/OR expense or income lines.`);
    if (a.is_control_account || a.is_receivable_account || a.is_payable_account || a.is_grir_account) {
      throw new Error(`Line ${index + 1}: ${a.account_code} ${a.account_name} is a control account and cannot be used as a PV/OR offset account.`);
    }
    if (a.is_inventory_account) throw new Error(`Line ${index + 1}: ${a.account_code} ${a.account_name} is an Inventory account and cannot be used as a PV/OR offset account.`);
    out.push({ accountId, description: raw.description ? String(raw.description).trim() : null, amount: Math.round(amount * 100) / 100 });
    total += amount;
  }
  if (!(total > 0)) throw new Error(`${type} total must be greater than zero`);
  return { lines: out, total: Math.round(total * 100) / 100 };
}

async function createPaymentVoucher(client, input = {}) {
  const pvDate = input.pvDate;
  if (!pvDate) throw new Error('PV date is required');
  await getOpenPeriod(client, pvDate);
  const cashAccount = await assertCashBankAccount(client, input.cashAccountId);
  const direction = { cashAccountId: cashAccount.account_id };
  const { lines, total } = await normalizeLines(client, input.lines, 'PV', direction.cashAccountId);
  const pvNo = String(input.pvNo || '').trim() || await nextCashBookNo(client, 'PV', pvDate);
  const pvId = uuidv4();

  await client.query(
    `INSERT INTO payment_voucher (pv_id,pv_no,pv_date,payee,cash_account_id,total_amount,description,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'POSTED',$8)`,
    [pvId,pvNo,pvDate,input.payee||null,cashAccount.account_id,total,input.description||null,input.createdBy||'ui']
  );
  for (const l of lines) {
    await client.query(
      `INSERT INTO payment_voucher_line (pv_line_id,pv_id,account_id,description,amount,line_no)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(),pvId,l.accountId,l.description,l.amount,l.lineNo]
    );
  }
  const journalLines = [
    ...lines.map(l => ({ accountId:l.accountId, debit:l.amount, credit:0, description:l.description || pvNo })),
    { accountId:cashAccount.account_id, debit:0, credit:total, description:pvNo },
  ];
  const { journalId, journalNo } = await postJournal(client, {
    journalDate: pvDate, source:'BANK', sourceDocId:pvId, description:input.description || `Payment Voucher ${pvNo}`,
    createdBy:input.createdBy || 'ui', prefix:'PV'
  }, journalLines);
  await client.query(`UPDATE payment_voucher SET journal_id=$1 WHERE pv_id=$2`,[journalId,pvId]);
  return { pvId,pvNo,journalId,journalNo,totalAmount:total };
}

async function createOfficialReceipt(client, input = {}) {
  const orDate = input.orDate;
  if (!orDate) throw new Error('OR date is required');
  await getOpenPeriod(client, orDate);
  const cashAccount = await assertCashBankAccount(client, input.cashAccountId);
  const direction = { cashAccountId: cashAccount.account_id };
  const { lines, total } = await normalizeLines(client, input.lines, 'OR', direction.cashAccountId);
  const orNo = String(input.orNo || '').trim() || await nextCashBookNo(client, 'OR', orDate);
  const orId = uuidv4();

  await client.query(
    `INSERT INTO official_receipt (or_id,or_no,or_date,payer,cash_account_id,total_amount,description,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'POSTED',$8)`,
    [orId,orNo,orDate,input.payer||null,cashAccount.account_id,total,input.description||null,input.createdBy||'ui']
  );
  for (const l of lines) {
    await client.query(
      `INSERT INTO official_receipt_line (or_line_id,or_id,account_id,description,amount,line_no)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(),orId,l.accountId,l.description,l.amount,l.lineNo]
    );
  }
  const journalLines = [
    { accountId:cashAccount.account_id, debit:total, credit:0, description:orNo },
    ...lines.map(l => ({ accountId:l.accountId, debit:0, credit:l.amount, description:l.description || orNo })),
  ];
  const { journalId, journalNo } = await postJournal(client, {
    journalDate: orDate, source:'BANK', sourceDocId:orId, description:input.description || `Official Receipt ${orNo}`,
    createdBy:input.createdBy || 'ui', prefix:'OR'
  }, journalLines);
  await client.query(`UPDATE official_receipt SET journal_id=$1 WHERE or_id=$2`,[journalId,orId]);
  return { orId,orNo,journalId,journalNo,totalAmount:total };
}

async function listPaymentVouchers(client) {
  const { rows } = await client.query(`
    SELECT pv.pv_id,pv.pv_no,pv.pv_date,pv.payee,pv.total_amount,pv.status,pv.cash_account_id,
           ca.account_code AS cash_account_code, ca.account_name AS cash_account_name
      FROM payment_voucher pv
      JOIN chart_of_accounts ca ON ca.account_id=pv.cash_account_id
     ORDER BY pv.pv_date DESC,pv.pv_no DESC`);
  return rows;
}
async function listOfficialReceipts(client) {
  const { rows } = await client.query(`
    SELECT o.or_id,o.or_no,o.or_date,o.payer,o.total_amount,o.status,o.cash_account_id,
           ca.account_code AS cash_account_code, ca.account_name AS cash_account_name
      FROM official_receipt o
      JOIN chart_of_accounts ca ON ca.account_id=o.cash_account_id
     ORDER BY o.or_date DESC,o.or_no DESC`);
  return rows;
}
async function getPaymentVoucher(client,id){
  const {rows}=await client.query(`SELECT pv.*,ca.account_code AS cash_account_code,ca.account_name AS cash_account_name FROM payment_voucher pv JOIN chart_of_accounts ca ON ca.account_id=pv.cash_account_id WHERE pv.pv_id=$1`,[id]);
  if(!rows.length)return null; const {rows:lines}=await client.query(`SELECT pvl.*,ca.account_code,ca.account_name FROM payment_voucher_line pvl JOIN chart_of_accounts ca ON ca.account_id=pvl.account_id WHERE pvl.pv_id=$1 ORDER BY pvl.line_no`,[id]); return {...rows[0],lines};
}
async function getOfficialReceipt(client,id){
  const {rows}=await client.query(`SELECT o.*,ca.account_code AS cash_account_code,ca.account_name AS cash_account_name FROM official_receipt o JOIN chart_of_accounts ca ON ca.account_id=o.cash_account_id WHERE o.or_id=$1`,[id]);
  if(!rows.length)return null; const {rows:lines}=await client.query(`SELECT orl.*,ca.account_code,ca.account_name FROM official_receipt_line orl JOIN chart_of_accounts ca ON ca.account_id=orl.account_id WHERE orl.or_id=$1 ORDER BY orl.line_no`,[id]); return {...rows[0],lines};
}

async function voidPaymentVoucher(client,id,{createdBy='ui',reason='Payment Voucher voided by user'}={}){
  const d=await getPaymentVoucher(client,id); if(!d)throw new Error('Payment Voucher not found'); if(d.status==='VOID')throw new Error('Payment Voucher is already void');
  if(!d.journal_id)throw new Error('Payment Voucher has no journal to reverse');
  const rv=await postReversal(client,d.journal_id,{reversalDate:d.pv_date,createdBy,reason});
  await client.query(`UPDATE payment_voucher SET status='VOID' WHERE pv_id=$1`,[id]);
  return {pvId:id,pvNo:d.pv_no,reversalJournalNo:rv.reversalJournalNo};
}
async function voidOfficialReceipt(client,id,{createdBy='ui',reason='Official Receipt voided by user'}={}){
  const d=await getOfficialReceipt(client,id); if(!d)throw new Error('Official Receipt not found'); if(d.status==='VOID')throw new Error('Official Receipt is already void');
  if(!d.journal_id)throw new Error('Official Receipt has no journal to reverse');
  const rv=await postReversal(client,d.journal_id,{reversalDate:d.or_date,createdBy,reason});
  await client.query(`UPDATE official_receipt SET status='VOID' WHERE or_id=$1`,[id]);
  return {orId:id,orNo:d.or_no,reversalJournalNo:rv.reversalJournalNo};
}
async function deletePaymentVoucher(client,id){const d=await getPaymentVoucher(client,id);if(!d)throw new Error('Payment Voucher not found');if(d.status!=='VOID')throw new Error('Void the Payment Voucher before deleting it');if(d.journal_id){await client.query(`DELETE FROM payment_voucher WHERE pv_id=$1`,[id]);await client.query(`DELETE FROM journal_entry WHERE journal_id=$1`,[d.journal_id]);}else await client.query(`DELETE FROM payment_voucher WHERE pv_id=$1`,[id]);return {deleted:true,pvNo:d.pv_no};}
async function deleteOfficialReceipt(client,id){const d=await getOfficialReceipt(client,id);if(!d)throw new Error('Official Receipt not found');if(d.status!=='VOID')throw new Error('Void the Official Receipt before deleting it');if(d.journal_id){await client.query(`DELETE FROM official_receipt WHERE or_id=$1`,[id]);await client.query(`DELETE FROM journal_entry WHERE journal_id=$1`,[d.journal_id]);}else await client.query(`DELETE FROM official_receipt WHERE or_id=$1`,[id]);return {deleted:true,orNo:d.or_no};}

module.exports={createPaymentVoucher,createOfficialReceipt,listPaymentVouchers,listOfficialReceipts,getPaymentVoucher,getOfficialReceipt,voidPaymentVoucher,voidOfficialReceipt,deletePaymentVoucher,deleteOfficialReceipt};
