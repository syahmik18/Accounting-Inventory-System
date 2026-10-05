const { v4: uuidv4 } = require('uuid');
const { getStockItem } = require('./stock');

async function listTaxCodes(clientOrPool, { direction, includeInactive = false } = {}) {
  const { rows } = await clientOrPool.query(
    `SELECT tax_code_id, code, description, direction, rate, tax_account_id, is_default, is_active
       FROM tax_code
      WHERE ($1::tax_direction IS NULL OR direction = $1)
        AND ($2::boolean OR is_active = TRUE)
      ORDER BY direction, code`,
    [direction || null, includeInactive]
  );
  return rows;
}

async function getTaxCode(client, taxCodeId) {
  if (!taxCodeId) return null;
  const { rows } = await client.query(
    `SELECT tax_code_id, code, description, direction, rate, tax_account_id, is_default, is_active
       FROM tax_code WHERE tax_code_id = $1`,
    [taxCodeId]
  );
  return rows[0] || null;
}

async function getDefaultTaxCode(client, direction) {
  const { rows } = await client.query(
    `SELECT tax_code_id, code, description, direction, rate, tax_account_id
       FROM tax_code WHERE direction = $1 AND is_default = TRUE AND is_active = TRUE LIMIT 1`,
    [direction]
  );
  return rows[0] || null;
}

async function createTaxCode(client, { code, description, direction, rate, taxAccountId, isDefault }) {
  if (!code || !description) throw new Error('Tax code and description are required');
  if (direction !== 'SALES' && direction !== 'PURCHASE') throw new Error('Direction must be SALES or PURCHASE');
  if (!taxAccountId) throw new Error('A tax account is required');
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0) throw new Error('Rate must be zero or greater');

  const taxCodeId = uuidv4();
  if (isDefault) {
    // Only one default per direction - clear any existing one first so
    // the partial unique index (uq_tax_code_default_per_direction) never
    // trips on a normal "set this as the new default" action.
    await client.query(`UPDATE tax_code SET is_default = FALSE WHERE direction = $1`, [direction]);
  }
  const { rows } = await client.query(
    `INSERT INTO tax_code (tax_code_id, code, description, direction, rate, tax_account_id, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING tax_code_id, code, description, direction, rate, tax_account_id, is_default, is_active`,
    [taxCodeId, code.trim(), description.trim(), direction, r, taxAccountId, !!isDefault]
  );
  return rows[0];
}

async function updateTaxCode(client, taxCodeId, { code, description, rate, taxAccountId, isDefault }) {
  if (!code || !description) throw new Error('Tax code and description are required');
  if (!taxAccountId) throw new Error('A tax account is required');
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0) throw new Error('Rate must be zero or greater');

  const existing = await getTaxCode(client, taxCodeId);
  if (!existing) throw new Error(`Tax code ${taxCodeId} not found`);

  if (isDefault) {
    await client.query(`UPDATE tax_code SET is_default = FALSE WHERE direction = $1`, [existing.direction]);
  }
  const { rows } = await client.query(
    `UPDATE tax_code SET code = $1, description = $2, rate = $3, tax_account_id = $4, is_default = $5
      WHERE tax_code_id = $6
      RETURNING tax_code_id, code, description, direction, rate, tax_account_id, is_default, is_active`,
    [code.trim(), description.trim(), r, taxAccountId, !!isDefault, taxCodeId]
  );
  return rows[0];
}

async function setTaxCodeActive(client, taxCodeId, isActive) {
  const { rows } = await client.query(
    `UPDATE tax_code SET is_active = $1 WHERE tax_code_id = $2
     RETURNING tax_code_id, code, is_active`,
    [isActive, taxCodeId]
  );
  if (rows.length === 0) throw new Error(`Tax code ${taxCodeId} not found`);
  return rows[0];
}

/**
 * Resolve a line's tax: given a tax_code_id (possibly null/blank), look
 * up its rate and GL account, and compute the tax amount for this line.
 * Returns zero tax if no code is set - a line is never forced to charge
 * tax it wasn't given a code for.
 */
async function resolveLineTax(client, { taxCodeId, lineAmount }) {
  if (!taxCodeId) return { taxCodeId: null, rate: 0, taxAccountId: null, taxAmount: 0 };
  const taxCode = await getTaxCode(client, taxCodeId);
  if (!taxCode) throw new Error(`Tax code ${taxCodeId} not found`);
  const taxAmount = Number(lineAmount) * Number(taxCode.rate) / 100;
  return { taxCodeId: taxCode.tax_code_id, rate: Number(taxCode.rate), taxAccountId: taxCode.tax_account_id, taxAmount };
}

/**
 * Decide which tax code applies to a line, in priority order:
 *   1. An explicit choice made on the line itself (always wins - the
 *      user can still override, this just removes the need to).
 *   2. The stock item's default for this direction, if the line has an
 *      item and it has one configured.
 *   3. The tax master's single default code for this direction, so a
 *      brand-new item with no default yet still gets a sensible tax
 *      rate instead of silently charging zero.
 * Returns null only if none of the three apply (e.g. no default code
 * exists yet for this direction) - resolveLineTax() then correctly
 * treats that as zero tax rather than guessing.
 */
async function resolveTaxCodeForLine(client, { stockItemId, explicitTaxCodeId, direction }) {
  if (explicitTaxCodeId) return explicitTaxCodeId;
  if (stockItemId) {
    const item = await getStockItem(client, stockItemId);
    const fromItem = direction === 'SALES' ? item?.default_sales_tax_code_id : item?.default_purchase_tax_code_id;
    if (fromItem) return fromItem;
  }
  const fallback = await getDefaultTaxCode(client, direction);
  return fallback ? fallback.tax_code_id : null;
}

module.exports = {
  listTaxCodes, getTaxCode, getDefaultTaxCode,
  createTaxCode, updateTaxCode, setTaxCodeActive,
  resolveLineTax, resolveTaxCodeForLine,
};
