const { v4: uuidv4 } = require('uuid');

// Credit terms must never be blank on a customer/supplier record - if
// omitted or invalid, silently fall back to 30 days rather than reject
// the save. This mirrors the DB-level NOT NULL DEFAULT 30 constraint
// (migration 014) at the application layer too, so the fallback still
// applies even before that constraint would catch it.
function resolveCreditTermsDays(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 30;
}

/**
 * List partners, optionally filtered by type. 'CUSTOMER'/'VENDOR' also
 * match partners saved as 'BOTH', since a BOTH partner should appear in
 * either list - it's the same real-world business, just one that both
 * sells to you and buys from you.
 */
async function listPartners(clientOrPool, { type, includeInactive = false, search = '', page = null, pageSize = 50 } = {}) {
  const q=String(search||'').trim(); const hasPagination=page!==null&&page!==undefined; const safePage=Math.max(Number(page)||1,1); const safePageSize=Math.min(Math.max(Number(pageSize)||50,1),100);
  const conditions=[]; const params=[];
  if(type){ params.push(type); conditions.push(`(partner_type=$${params.length} OR partner_type='BOTH')`); }
  if(!includeInactive) conditions.push('is_active=TRUE');
  if(q){ params.push(`%${q}%`); const p=`$${params.length}`; conditions.push(`(partner_code ILIKE ${p} OR partner_name ILIKE ${p} OR tax_id ILIKE ${p} OR brn_no ILIKE ${p} OR phone ILIKE ${p} OR email ILIKE ${p})`); }
  const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
  if(!hasPagination){ const {rows}=await clientOrPool.query(`SELECT partner_id,partner_code,partner_name,partner_type,tax_id,brn_no,sst_no,address,contact_person,phone,email,credit_terms_days,is_active FROM partner ${where} ORDER BY partner_name`,params); return rows; }
  const offset=(safePage-1)*safePageSize; params.push(safePageSize,offset);
  const {rows}=await clientOrPool.query(`SELECT partner_id,partner_code,partner_name,partner_type,tax_id,brn_no,sst_no,address,contact_person,phone,email,credit_terms_days,is_active,COUNT(*) OVER()::int AS total_count FROM partner ${where} ORDER BY partner_name,partner_code LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  const totalCount=rows.length?rows[0].total_count:0;
  return {items:rows.map(({total_count,...item})=>item),totalCount,page:safePage,pageSize:safePageSize,totalPages:Math.max(Math.ceil(totalCount/safePageSize),1)};
}

async function getPartner(clientOrPool, partnerId) {
  const { rows } = await clientOrPool.query(
    `SELECT partner_id, partner_code, partner_name, partner_type, tax_id, brn_no, sst_no,
            address, contact_person, phone, email, credit_terms_days, is_active
       FROM partner WHERE partner_id = $1`,
    [partnerId]
  );
  return rows[0] || null;
}

async function createPartner(client, {
  partnerCode, partnerName, partnerType, taxId, brnNo, sstNo,
  address, contactPerson, phone, email, creditTermsDays,
}) {
  if (!partnerCode || !partnerName || !partnerType) {
    throw new Error('Partner code, name, and type are required');
  }
  const partnerId = uuidv4();
  const { rows } = await client.query(
    `INSERT INTO partner
       (partner_id, partner_code, partner_name, partner_type, tax_id, brn_no, sst_no,
        address, contact_person, phone, email, credit_terms_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING partner_id, partner_code, partner_name, partner_type, tax_id, brn_no, sst_no,
               address, contact_person, phone, email, credit_terms_days, is_active`,
    [partnerId, partnerCode, partnerName, partnerType, taxId || null, brnNo || null, sstNo || null,
     address || null, contactPerson || null, phone || null, email || null,
     resolveCreditTermsDays(creditTermsDays)]
  );
  return rows[0];
}

async function updatePartner(client, partnerId, {
  partnerCode, partnerName, partnerType, taxId, brnNo, sstNo,
  address, contactPerson, phone, email, creditTermsDays,
}) {
  const { rows } = await client.query(
    `UPDATE partner SET
       partner_code = $1, partner_name = $2, partner_type = $3, tax_id = $4,
       brn_no = $5, sst_no = $6, address = $7, contact_person = $8, phone = $9,
       email = $10, credit_terms_days = $11
     WHERE partner_id = $12
     RETURNING partner_id, partner_code, partner_name, partner_type, tax_id, brn_no, sst_no,
               address, contact_person, phone, email, credit_terms_days, is_active`,
    [partnerCode, partnerName, partnerType, taxId || null, brnNo || null, sstNo || null,
     address || null, contactPerson || null, phone || null, email || null,
     resolveCreditTermsDays(creditTermsDays), partnerId]
  );
  if (rows.length === 0) throw new Error('Partner not found');
  return rows[0];
}

// Soft delete, same reasoning as stock items and tax codes: a partner
// may already be referenced by historical documents via partner_id, so a
// real DELETE could break those records or fail on the foreign key.
// Deactivating removes it from pick-lists on new documents while keeping
// every past document's partner_id intact.
async function setPartnerActive(client, partnerId, isActive) {
  const { rows } = await client.query(
    `UPDATE partner SET is_active = $1 WHERE partner_id = $2
     RETURNING partner_id, partner_code, partner_name, partner_type, is_active`,
    [isActive, partnerId]
  );
  if (rows.length === 0) throw new Error('Partner not found');
  return rows[0];
}

async function searchPartners(clientOrPool, { type = null, search = '', limit = 20 } = {}) {
  const q = String(search || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const params = []; const conditions = ['is_active = TRUE'];
  if (type) { params.push(type); conditions.push(`(partner_type = $${params.length} OR partner_type = 'BOTH')`); }
  if (q) { params.push(`%${q}%`); const p = `$${params.length}`; conditions.push(`(partner_code ILIKE ${p} OR partner_name ILIKE ${p} OR tax_id ILIKE ${p} OR brn_no ILIKE ${p} OR phone ILIKE ${p} OR email ILIKE ${p})`); }
  params.push(safeLimit);
  const lim = `$${params.length}`;
  const rank = q ? `CASE WHEN partner_code ILIKE $${type ? 2 : 1} THEN 0 WHEN partner_name ILIKE $${type ? 2 : 1} THEN 1 ELSE 2 END,` : '';
  const { rows } = await clientOrPool.query(`SELECT partner_id,partner_code,partner_name,partner_type,tax_id,brn_no,sst_no,phone,email,credit_terms_days FROM partner WHERE ${conditions.join(' AND ')} ORDER BY ${rank} partner_name LIMIT ${lim}`, params);
  return rows;
}

module.exports = { listPartners, searchPartners, getPartner, createPartner, updatePartner, setPartnerActive };
