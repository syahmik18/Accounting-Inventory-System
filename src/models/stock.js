const { v4: uuidv4 } = require('uuid');
const { postJournal } = require('./journal');

const MOVEMENT_TYPES = new Set([
  'PURCHASE_INVOICE', 'CASH_PURCHASE', 'GRN', 'DELIVERY_ORDER', 'SALES_INVOICE', 'CASH_SALE', 'CREDIT_NOTE', 'ADJUSTMENT', 'REVERSAL'
]);

const STOCK_LIST_SORTS = Object.freeze({
  item_code: 'item_code',
  item_name: 'item_name',
  current_qty: 'current_qty',
  ref_cost: 'ref_cost',
  ref_price: 'ref_price',
});

const STOCK_SELECT = `
  SELECT stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty,
         barcode, serial_number, min_qty, is_active, default_expense_account_id,
         default_revenue_account_id, default_inventory_account_id, default_cogs_account_id,
         default_sales_tax_code_id, default_purchase_tax_code_id, inventory_value, average_cost, costing_method
    FROM stock_item
`;

/**
 * List stock items. The unpaged form is kept for existing document-entry screens
 * that need a local cache. The paged/search form is used by maintenance screens
 * so large stock masters never have to be downloaded and rendered in full.
 */
async function listStockItems(clientOrPool, {
  includeInactive = false,
  search = '',
  page = null,
  pageSize = 50,
  sortBy = 'item_code',
  sortDir = 'asc',
} = {}) {
  const normalizedSearch = String(search || '').trim();
  const hasPagination = page !== null && page !== undefined;
  const safePageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const safeSortBy = STOCK_LIST_SORTS[sortBy] || STOCK_LIST_SORTS.item_code;
  const safeSortDir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const params = [includeInactive];
  const conditions = ['($1::boolean OR is_active = TRUE)'];

  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    const p = `$${params.length}`;
    conditions.push(`(item_code ILIKE ${p} OR item_name ILIKE ${p} OR barcode ILIKE ${p})`);
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`;

  if (!hasPagination) {
    const { rows } = await clientOrPool.query(
      `${STOCK_SELECT} ${whereSql} ORDER BY ${safeSortBy} ${safeSortDir}, item_code ASC`,
      params
    );
    return rows;
  }

  const offset = (safePage - 1) * safePageSize;

  params.push(safePageSize, offset);
  const { rows } = await clientOrPool.query(
    `SELECT stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty,
            barcode, serial_number, min_qty, is_active, default_expense_account_id,
            default_revenue_account_id, default_inventory_account_id, default_cogs_account_id,
            default_sales_tax_code_id, default_purchase_tax_code_id, inventory_value, average_cost, costing_method,
            COUNT(*) OVER()::int AS total_count
       FROM stock_item
      ${whereSql}
      ORDER BY ${safeSortBy} ${safeSortDir}, item_code ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const totalCount = rows.length ? rows[0].total_count : 0;
  return {
    items: rows.map(({ total_count, ...item }) => item),
    totalCount,
    page: safePage,
    pageSize: safePageSize,
    totalPages: Math.max(Math.ceil(totalCount / safePageSize), 1),
  };
}


async function searchStockItems(clientOrPool, { search = '', limit = 20 } = {}) {
  const query = String(search || '').trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const params = [safeLimit];

  if (!query) {
    const { rows } = await clientOrPool.query(
      `SELECT stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty,
              barcode, serial_number, min_qty, is_active, default_expense_account_id,
              default_revenue_account_id, default_inventory_account_id, default_cogs_account_id,
              default_sales_tax_code_id, default_purchase_tax_code_id, inventory_value, average_cost, costing_method
         FROM stock_item
        WHERE is_active = TRUE
        ORDER BY item_code ASC
        LIMIT $1`,
      params
    );
    return rows;
  }

  const contains = `%${query}%`;
  const prefix = `${query}%`;
  params.unshift(contains, prefix);
  const { rows } = await clientOrPool.query(
    `SELECT stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty,
            barcode, serial_number, min_qty, is_active, default_expense_account_id,
            default_revenue_account_id, default_inventory_account_id, default_cogs_account_id,
            default_sales_tax_code_id, default_purchase_tax_code_id, inventory_value, average_cost, costing_method
       FROM stock_item
      WHERE is_active = TRUE
        AND (item_code ILIKE $1 OR item_name ILIKE $1 OR barcode ILIKE $1)
      ORDER BY
        CASE
          WHEN item_code ILIKE $2 THEN 0
          WHEN barcode ILIKE $2 THEN 1
          WHEN item_name ILIKE $2 THEN 2
          ELSE 3
        END,
        CASE
          WHEN item_code ILIKE $1 THEN 0
          WHEN barcode ILIKE $1 THEN 1
          ELSE 2
        END,
        item_code ASC
      LIMIT $3`,
    params
  );
  return rows;
}

const COSTING_METHODS = new Set(['FIXED', 'AVERAGE', 'FIFO']);

async function createStockItem(client, {
  itemCode, itemName, unit, refCost, refPrice, barcode, serialNumber, openingQty,
  defaultExpenseAccountId, defaultRevenueAccountId, defaultInventoryAccountId,
  defaultCogsAccountId, defaultSalesTaxCodeId, defaultPurchaseTaxCodeId, costingMethod,
}) {
  if (!itemCode || !itemName) throw new Error('Stock item code and name are required');
  const qty = Number(openingQty || 0);
  const cost = Number(refCost || 0);
  const price = Number(refPrice || 0);
  const method = costingMethod ? String(costingMethod).toUpperCase() : 'AVERAGE';
  if (!COSTING_METHODS.has(method)) throw new Error('Costing method must be Fixed, Average or FIFO');
  const defaults = await resolveInventoryDefaults(client, { defaultInventoryAccountId, defaultCogsAccountId });
  if (!Number.isFinite(qty) || qty < 0) throw new Error('Balance quantity must be zero or greater');
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Reference cost must be zero or greater');
  if (!Number.isFinite(price) || price < 0) throw new Error('Reference price must be zero or greater');
  if (qty > 0 && cost <= 0) throw new Error('Opening stock quantity requires a Reference Cost greater than zero');

  const itemId = uuidv4();
  const openingValue = roundMoney(qty * cost);
  const { rows } = await client.query(
    `INSERT INTO stock_item
       (stock_item_id,item_code,item_name,unit,ref_cost,ref_price,current_qty,inventory_value,average_cost,costing_method,
        barcode,serial_number,default_expense_account_id,default_revenue_account_id,
        default_inventory_account_id,default_cogs_account_id,default_sales_tax_code_id,default_purchase_tax_code_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING stock_item_id,item_code,item_name,unit,ref_cost,ref_price,current_qty,inventory_value,average_cost,costing_method,
               barcode,serial_number,is_active,default_expense_account_id,default_revenue_account_id,
               default_inventory_account_id,default_cogs_account_id,default_sales_tax_code_id,default_purchase_tax_code_id`,
    [itemId, itemCode.trim(), itemName.trim(), (unit || 'UNIT').trim(), cost, price, qty, openingValue,
     qty > 0 ? cost : 0, method, barcode?.trim() || null, serialNumber?.trim() || null,
     defaultExpenseAccountId || null, defaultRevenueAccountId || null,
     defaults.inventoryAccountId, defaults.cogsAccountId,
     defaultSalesTaxCodeId || null, defaultPurchaseTaxCodeId || null]
  );

  if (qty > 0) {
    await client.query(
      `INSERT INTO stock_movement
         (movement_id, stock_item_id, movement_date, movement_type, source_doc_no,
          quantity_in, balance_after, note, unit_cost, value_in, value_out)
       VALUES ($1,$2,CURRENT_DATE,'ADJUSTMENT',$3,$4,$4,$5,$6,$7,0)`,
      [uuidv4(), itemId, 'OPENING', qty, 'Opening stock', cost, openingValue]
    );
    if (method === 'FIFO') {
      await client.query(
        `INSERT INTO stock_lot (lot_id, stock_item_id, source_doc_no, received_date, unit_cost, qty_received, qty_remaining, is_active_layer)
         VALUES ($1,$2,'OPENING',CURRENT_DATE,$3,$4,$4,TRUE)`,
        [uuidv4(), itemId, cost, qty]
      );
    }

    const openingEquityAccountId = await getAccountIdByCode(client, '3050');
    await postJournal(client, {
      journalDate: new Date().toISOString().slice(0,10),
      source: 'ADJUSTMENT', sourceDocId: itemId,
      description: `Opening stock for ${itemCode.trim()}`, createdBy: 'system', prefix: 'OB',
    }, [
      { accountId: defaults.inventoryAccountId, debit: openingValue, credit: 0, description: `Opening inventory - ${itemCode.trim()}` },
      { accountId: openingEquityAccountId, debit: 0, credit: openingValue, description: `Opening inventory offset - ${itemCode.trim()}` },
    ]);
  }
  return rows[0];
}

async function getAccountIdByCode(client, code) {
  const { rows } = await client.query(`SELECT account_id FROM chart_of_accounts WHERE account_code=$1 AND is_active=TRUE`, [code]);
  if (!rows.length) throw new Error(`Account code ${code} not found or inactive`);
  return rows[0].account_id;
}

async function resolveInventoryDefaults(client, { defaultInventoryAccountId, defaultCogsAccountId }) {
  const inventoryId = defaultInventoryAccountId || await getAccountIdByCode(client, '1200');
  const cogsId = defaultCogsAccountId || await getAccountIdByCode(client, '5000');
  const { rows } = await client.query(
    `SELECT account_id, account_type, is_active FROM chart_of_accounts WHERE account_id = ANY($1::uuid[])`,
    [[inventoryId, cogsId]]
  );
  const map = new Map(rows.map(r => [r.account_id, r]));
  if (!map.has(inventoryId) || !map.get(inventoryId).is_active || map.get(inventoryId).account_type !== 'ASSET') {
    throw new Error('Inventory account must be an active Asset account');
  }
  if (!map.has(cogsId) || !map.get(cogsId).is_active || map.get(cogsId).account_type !== 'EXPENSE') {
    throw new Error('COGS account must be an active Expense account');
  }
  return { inventoryAccountId: inventoryId, cogsAccountId: cogsId };
}

/**
 * Update a stock item's master data - description, code, unit, reference
 * cost/price, barcode, serial number, and default accounts.
 *
 * Deliberately does NOT accept current_qty: the balance quantity is a
 * calculated field, the running total of every stock_movement row for
 * this item. Letting an edit form overwrite it directly would let the
 * displayed balance drift out of sync with the movement ledger that's
 * supposed to explain it - exactly the kind of silent data-integrity
 * gap this whole project is meant to avoid. If the balance is ever
 * genuinely wrong (miscount, damage, etc.), that's a stock adjustment -
 * a new ADJUSTMENT movement row - not an edit to the master record.
 */
async function updateStockItem(client, stockItemId, {
  itemCode, itemName, unit, refCost, refPrice, barcode, serialNumber,
  defaultExpenseAccountId, defaultRevenueAccountId, defaultInventoryAccountId,
  defaultCogsAccountId, defaultSalesTaxCodeId, defaultPurchaseTaxCodeId,
}) {
  if (!itemCode || !itemName) throw new Error('Stock item code and name are required');
  const cost = Number(refCost || 0);
  const price = Number(refPrice || 0);
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Reference cost must be zero or greater');
  if (!Number.isFinite(price) || price < 0) throw new Error('Reference price must be zero or greater');

  const defaults = await resolveInventoryDefaults(client, { defaultInventoryAccountId, defaultCogsAccountId });
  const { rows } = await client.query(
    `UPDATE stock_item
        SET item_code = $1, item_name = $2, unit = $3, ref_cost = $4, ref_price = $5,
            barcode = $6, serial_number = $7,
            default_expense_account_id = $8, default_revenue_account_id = $9,
            default_inventory_account_id = $10, default_cogs_account_id = $11,
            default_sales_tax_code_id = $12, default_purchase_tax_code_id = $13
      WHERE stock_item_id = $14
      RETURNING stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty, inventory_value, average_cost, costing_method,
                barcode, serial_number, is_active, default_expense_account_id, default_revenue_account_id,
                default_inventory_account_id, default_cogs_account_id, default_sales_tax_code_id, default_purchase_tax_code_id`,
    [itemCode.trim(), itemName.trim(), (unit || 'UNIT').trim(), cost, price,
     barcode?.trim() || null, serialNumber?.trim() || null,
     defaultExpenseAccountId || null, defaultRevenueAccountId || null,
     defaults.inventoryAccountId, defaults.cogsAccountId,
     defaultSalesTaxCodeId || null, defaultPurchaseTaxCodeId || null, stockItemId]
  );
  if (rows.length === 0) throw new Error(`Stock item ${stockItemId} not found`);
  return rows[0];
}

/**
 * Activate/deactivate a stock item - the "delete" button, but a soft one.
 *
 * A real DELETE isn't safe here: stock_item_id is referenced by every
 * historical line (sales_invoice_line, purchase_invoice_line, grn_line,
 * stock_movement, etc.) that ever used this item. Deleting the row
 * would either be blocked by those foreign keys, or - worse, if
 * cascaded - silently erase line detail on invoices you've already
 * posted and reported on. Deactivating keeps every past document intact
 * and just removes the item from pick-lists on new documents, the same
 * way SQL Accounting handles retiring an item.
 */
async function setStockItemActive(client, stockItemId, isActive) {
  const { rows } = await client.query(
    `UPDATE stock_item SET is_active = $1 WHERE stock_item_id = $2
     RETURNING stock_item_id, item_code, item_name, is_active`,
    [isActive, stockItemId]
  );
  if (rows.length === 0) throw new Error(`Stock item ${stockItemId} not found`);
  return rows[0];
}

async function getStockSnapshot(client) {
  const { rows } = await client.query(
    `SELECT stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty, barcode, serial_number,
            min_qty, is_active, default_expense_account_id, default_revenue_account_id,
            default_sales_tax_code_id, default_purchase_tax_code_id
       FROM stock_item
      WHERE is_active = TRUE
      ORDER BY item_code`
  );
  return rows;
}

/**
 * Move stock atomically. The stock_item row is locked before calculating the
 * new balance so two simultaneous sales cannot overwrite one another.
 * Negative balances are intentionally allowed; callers receive a warning
 * when a sale exceeds available quantity.
 */
function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
function roundQty(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}
function roundCost(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
}

/**
 * Costing methods (migration 028).
 *
 * A stock item values its inventory and cost of goods sold one of three
 * ways, chosen per item in Maintain Item:
 *
 *   AVERAGE (default, unchanged from before) - every receipt is blended
 *     into one moving weighted-average cost; every issue leaves at that
 *     average. This is the state.avg bookkeeping already in this file.
 *
 *   FIXED - the item's Reference Cost (maintained by hand on the item
 *     master) is what every ISSUE (sale, delivery) draws down at. A
 *     supplier's invoice price never changes that - only editing the item
 *     does. Receiving stock still capitalises the actual purchase price
 *     (it has to, or the Inventory debit wouldn't match what was paid) -
 *     "fixed" governs cost of goods sold, not what a receipt is worth.
 *
 *   FIFO - each receipt is kept as its own "lot" (stock_lot) at the price
 *     it actually cost. An issue eats into the oldest lot(s) first; once a
 *     lot is used up the next-oldest lot's cost takes over. stock_item's
 *     current_qty/inventory_value/average_cost stay authoritative for
 *     reporting (average_cost becomes "the weighted cost of what's left"),
 *     but stock_lot is what actually drives the cost of each sale.
 *
 * Whichever method is used, the OUTCOME handed back to the caller is the
 * same shape - { usedUnitCost, valueIn, valueOut } - so moveStockForLines
 * and the journal postings built from it don't need to know which method
 * produced the number.
 */

/** FIFO receipt: opens a new cost layer. Always the item's actual cost - never blended. */
async function fifoReceive(client, { stockItemId, quantity, unitCost, movementDate, sourceDocId, sourceDocNo }) {
  await client.query(
    `INSERT INTO stock_lot (lot_id, stock_item_id, source_doc_id, source_doc_no, received_date, unit_cost, qty_received, qty_remaining, is_active_layer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,TRUE)`,
    [uuidv4(), stockItemId, sourceDocId || null, sourceDocNo || null, movementDate, unitCost, quantity]
  );
}

/**
 * FIFO issue: eats into the oldest lot(s) with quantity left, oldest
 * received_date first. Locks the lots it touches (FOR UPDATE) so two
 * concurrent sales can't both think they're drawing from the same units.
 * Records exactly which lot(s) supplied this issue in stock_lot_consumption
 * so a later void can hand the quantity back to precisely those lots
 * instead of re-deriving FIFO order from scratch.
 */
async function fifoConsume(client, { stockItemId, quantity, sourceDocId, sourceDocNo }) {
  const { rows: lots } = await client.query(
    `SELECT lot_id, unit_cost, qty_remaining
       FROM stock_lot
      WHERE stock_item_id = $1 AND is_active_layer = TRUE AND qty_remaining > 0.0000001
      ORDER BY received_date ASC, created_at ASC
      FOR UPDATE`,
    [stockItemId]
  );
  let remaining = quantity;
  let valueOut = 0;
  const consumptionRows = [];
  for (const lot of lots) {
    if (remaining <= 0.0000001) break;
    const take = Math.min(remaining, Number(lot.qty_remaining));
    if (take <= 0) continue;
    const cost = Number(lot.unit_cost);
    valueOut = roundMoney(valueOut + take * cost);
    remaining = roundQty(remaining - take);
    await client.query(`UPDATE stock_lot SET qty_remaining = qty_remaining - $1 WHERE lot_id = $2`, [take, lot.lot_id]);
    consumptionRows.push([uuidv4(), lot.lot_id, stockItemId, sourceDocId || null, sourceDocNo || null, take, cost]);
  }
  if (remaining > 0.0000001) {
    throw new Error(`FIFO costing layer shortage for stock item ${stockItemId}: ${remaining.toFixed(4)} unit(s) have no active FIFO layer. The sale was not posted.`);
  }
  if (consumptionRows.length) {
    const placeholders = consumptionRows.map((_, i) => { const b = i * 7; return `(${Array.from({ length: 7 }, (_, j) => `$${b + j + 1}`).join(',')})`; }).join(',');
    await client.query(
      `INSERT INTO stock_lot_consumption (consumption_id, lot_id, stock_item_id, consumed_by_doc_id, consumed_by_doc_no, quantity, unit_cost)
       VALUES ${placeholders}`,
      consumptionRows.flat()
    );
  }
  return { valueOut, unitCost: quantity > 0 ? roundCost(valueOut / quantity) : 0 };
}

/** Undo everything a document did to FIFO lots - the mirror image of receive/consume, keyed by source_doc_id so it needs no FIFO re-derivation. */
async function fifoReverse(client, { stockItemId, sourceDocId, originalDirection, movementDate }) {
  if (originalDirection === 'OUT') {
    // This document consumed lots - hand the quantity straight back to them.
    const { rows: consumptions } = await client.query(
      `SELECT consumption_id, lot_id, quantity FROM stock_lot_consumption WHERE consumed_by_doc_id = $1 AND stock_item_id = $2`,
      [sourceDocId, stockItemId]
    );
    for (const c of consumptions) {
      await client.query(`UPDATE stock_lot SET qty_remaining = qty_remaining + $1 WHERE lot_id = $2`, [c.quantity, c.lot_id]);
    }
    if (consumptions.length) await client.query(`DELETE FROM stock_lot_consumption WHERE consumed_by_doc_id = $1 AND stock_item_id = $2`, [sourceDocId, stockItemId]);
  } else {
    // This document opened a lot - it may only be removed intact. If any of
    // it has since been sold, the lot can't simply disappear without also
    // unwinding whichever sale drew from it, so this document can't be
    // voided until that happens - the same rule a paper stock card would
    // force on you.
    const { rows: lots } = await client.query(
      `SELECT lot_id, qty_received, qty_remaining FROM stock_lot WHERE source_doc_id = $1 AND stock_item_id = $2 FOR UPDATE`,
      [sourceDocId, stockItemId]
    );
    for (const lot of lots) {
      if (Number(lot.qty_remaining) + 0.0000001 < Number(lot.qty_received)) {
        throw new Error('This stock has already been partly or fully sold under FIFO costing, so this document cannot be voided until the document(s) that sold it are voided first.');
      }
    }
    if (lots.length) await client.query(`DELETE FROM stock_lot WHERE source_doc_id = $1 AND stock_item_id = $2`, [sourceDocId, stockItemId]);
  }
}

/**
 * Costs one line of an IN or OUT movement per the item's costing method.
 * Pure cost calculation only - the caller still updates stock_item's
 * running qty/value/avg and writes the stock_movement row, exactly as it
 * did before there were multiple costing methods.
 */
async function costLine(client, { item, direction, quantity, suppliedUnitCost, currentAvg, movementDate, sourceDocId, sourceDocNo }) {
  const method = item.costing_method || 'AVERAGE';
  if (direction === 'IN') {
    // Receiving always capitalises what was actually paid - for every costing
    // method, Fixed included. A receipt has to debit Inventory for the same
    // amount the purchase document credits Cash/Accounts Payable for, or the
    // books simply don't balance; ledger integrity enforces exactly this.
    // "Fixed cost" governs what an ISSUE draws down at (below), not what a
    // receipt is worth - that's the whole point of it being fixed until
    // someone edits Maintain Item, rather than average recalculating itself.
    const cost = Number.isFinite(Number(suppliedUnitCost)) && Number(suppliedUnitCost) >= 0
      ? roundCost(Number(suppliedUnitCost)) : roundCost(Number(item.ref_cost || 0));
    if (cost < 0) throw new Error(`Invalid unit cost for ${item.item_code}`);
    if (method === 'FIFO') await fifoReceive(client, { stockItemId: item.stock_item_id, quantity, unitCost: cost, movementDate, sourceDocId, sourceDocNo });
    return { usedUnitCost: cost, valueIn: roundMoney(quantity * cost), valueOut: 0 };
  }
  // OUT
  if (method === 'FIXED') {
    const cost = Number(item.ref_cost || 0);
    return { usedUnitCost: cost, valueIn: 0, valueOut: roundMoney(quantity * cost) };
  }
  if (method === 'FIFO') {
    const { valueOut, unitCost } = await fifoConsume(client, { stockItemId: item.stock_item_id, quantity, sourceDocId, sourceDocNo });
    return { usedUnitCost: unitCost, valueIn: 0, valueOut };
  }
  const cost = currentAvg > 0 ? currentAvg : 0;
  return { usedUnitCost: cost, valueIn: 0, valueOut: roundMoney(quantity * cost) };
}

async function setCostingMethod(client, stockItemId, newMethod) {
  const method = String(newMethod || '').toUpperCase();
  if (!COSTING_METHODS.has(method)) throw new Error('Costing method must be Fixed, Average or FIFO');
  const [item] = await loadStockRowsForUpdate(client, [stockItemId]);
  if (!item) throw new Error('Stock item not found');
  if (item.costing_method === method) return getStockItemLookup(client, stockItemId);

  // FIFO carries stateful cost layers and consumption history. Once an item
  // has FIFO layer history, switching away or rebuilding FIFO later would make
  // historical reversals ambiguous. Fixed <-> Average remain freely changeable.
  const { rows: fifoHistory } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM stock_lot WHERE stock_item_id = $1)
            OR EXISTS (SELECT 1 FROM stock_lot_consumption WHERE stock_item_id = $1) AS has_fifo_history`,
    [stockItemId]
  );
  const hasFifoHistory = fifoHistory[0]?.has_fifo_history === true;
  if (item.costing_method === 'FIFO' && method !== 'FIFO' && hasFifoHistory) {
    throw new Error(`Costing method for ${item.item_code} cannot leave FIFO after FIFO layers or sales history exist. Keep FIFO for this item, or create a new stock item for a different costing method.`);
  }
  if (item.costing_method !== 'FIFO' && method === 'FIFO' && hasFifoHistory) {
    throw new Error(`FIFO history already exists for ${item.item_code}. Re-entering FIFO would mix old layers with a new conversion layer. Keep the current method or start FIFO on a new stock item.`);
  }

  if (method === 'FIFO' && item.costing_method !== 'FIFO') {
    const qty = Number(item.current_qty || 0);
    if (qty > 0.0000001) {
      const currentValue = Number(item.inventory_value || 0);
      const cost = qty > 0 ? roundCost(currentValue / qty) : roundCost(Number(item.ref_cost || 0));
      await client.query(
        `INSERT INTO stock_lot (lot_id, stock_item_id, source_doc_no, received_date, unit_cost, qty_received, qty_remaining, is_active_layer)
         VALUES ($1,$2,'COSTING METHOD CHANGE',CURRENT_DATE,$3,$4,$4,TRUE)`,
        [uuidv4(), stockItemId, cost, qty]
      );
    }
  } else if (item.costing_method === 'FIFO' && method !== 'FIFO') {
    await client.query(`UPDATE stock_lot SET is_active_layer=FALSE WHERE stock_item_id=$1`, [stockItemId]);
  }

  const { rows } = await client.query(
    `UPDATE stock_item SET costing_method = $1 WHERE stock_item_id = $2
     RETURNING stock_item_id, item_code, costing_method`,
    [method, stockItemId]
  );
  return rows[0];
}

async function validateStockAccountingAccounts(client, stockItemId, itemCode = stockItemId) {
  const { rows } = await client.query(
    `SELECT si.is_active AS stock_item_active,
            si.default_inventory_account_id, si.default_cogs_account_id,
            inv.account_type AS inventory_account_type, inv.is_active AS inventory_active,
            cogs.account_type AS cogs_account_type, cogs.is_active AS cogs_active
       FROM stock_item si
       LEFT JOIN chart_of_accounts inv ON inv.account_id = si.default_inventory_account_id
       LEFT JOIN chart_of_accounts cogs ON cogs.account_id = si.default_cogs_account_id
      WHERE si.stock_item_id = $1`,
    [stockItemId]
  );
  if (!rows.length) throw new Error(`Stock item ${itemCode} not found`);
  const r = rows[0];
  if (r.stock_item_active !== true) throw new Error(`Stock item "${itemCode}" is inactive`);
  if (!r.default_inventory_account_id || !r.inventory_active || r.inventory_account_type !== 'ASSET') {
    throw new Error(`Stock item "${itemCode}" must have an active Asset Inventory account configured before it can be used.`);
  }
  if (!r.default_cogs_account_id || !r.cogs_active || r.cogs_account_type !== 'EXPENSE') {
    throw new Error(`Stock item "${itemCode}" must have an active Expense COGS account configured before it can be used.`);
  }
  return { inventoryAccountId: r.default_inventory_account_id, cogsAccountId: r.default_cogs_account_id };
}

async function loadStockRowsForUpdate(client, ids) {
  const orderedIds = [...new Set(ids.filter(Boolean))].sort();
  if (!orderedIds.length) return [];
  const { rows } = await client.query(
    `SELECT si.stock_item_id, si.item_code, si.item_name, si.unit, si.current_qty,
            si.ref_cost, si.inventory_value, si.average_cost, si.costing_method,
            si.default_inventory_account_id, si.default_cogs_account_id,
            inv.account_type AS inventory_account_type, inv.is_active AS inventory_active,
            cogs.account_type AS cogs_account_type, cogs.is_active AS cogs_active
       FROM stock_item si
       LEFT JOIN chart_of_accounts inv ON inv.account_id = si.default_inventory_account_id
       LEFT JOIN chart_of_accounts cogs ON cogs.account_id = si.default_cogs_account_id
      WHERE si.stock_item_id = ANY($1::uuid[]) AND si.is_active = TRUE
      ORDER BY si.stock_item_id
      FOR UPDATE OF si`,
    [orderedIds]
  );
  for (const row of rows) {
    if (!row.default_inventory_account_id || row.inventory_active !== true || row.inventory_account_type !== 'ASSET') {
      throw new Error(`Stock item "${row.item_code}" must have an active Asset Inventory account configured before it can be used.`);
    }
    if (!row.default_cogs_account_id || row.cogs_active !== true || row.cogs_account_type !== 'EXPENSE') {
      throw new Error(`Stock item "${row.item_code}" must have an active Expense COGS account configured before it can be used.`);
    }
  }
  const found = new Set(rows.map(r => r.stock_item_id));
  if (rows.length !== orderedIds.length) {
    const missing = orderedIds.find(id => !found.has(id));
    throw new Error(`Stock item ${missing} not found or inactive`);
  }
  return rows;
}

/**
 * Move stock and maintain moving-average inventory valuation.
 *
 * IN:
 *   quantity increases stock and inventory value at the supplied unit cost.
 * OUT:
 *   quantity decreases stock and inventory value at the current moving
 *   average cost. The exact value used is persisted on stock_movement so a
 *   later reversal can restore the original amount instead of today's cost.
 */
async function moveStock(client, {
  stockItemId, quantity, direction, movementType, sourceDocId, sourceDocNo,
  movementDate, note, unitCost,
}) {
  const qty = Number(quantity);
  if (!stockItemId || !Number.isFinite(qty) || qty <= 0) return null;
  // A single line is just moveStockForLines with one entry - kept as its
  // own function only because callers ask for one item at a time; the
  // costing logic (Fixed / Average / FIFO) lives in exactly one place.
  const { movements } = await moveStockForLines(client, {
    lines: [{ stockItemId, quantity: qty, unitCost, description: note }],
    direction, movementType, sourceDocId, sourceDocNo, movementDate,
  });
  return movements[0] || null;
}

async function moveStockForLines(client, {
  lines, direction, movementType, sourceDocId, sourceDocNo, movementDate,
}) {
  const usableLines = (lines || []).filter(l => l.stockItemId && Number.isFinite(Number(l.quantity)) && Number(l.quantity) > 0);
  if (!usableLines.length) return { warnings: [], movements: [], accounting: { inventoryIn: [], inventoryOut: [], cogsOut: [] } };
  if (direction !== 'IN' && direction !== 'OUT') throw new Error('Stock movement direction must be IN or OUT');
  if (!MOVEMENT_TYPES.has(movementType)) throw new Error(`Unsupported stock movement type ${movementType}`);

  // Lock every item first. The actual movements are then processed in source
  // line order so moving-average cost stays deterministic.
  const itemRows = await loadStockRowsForUpdate(client, usableLines.map(l => l.stockItemId));
  const itemsById = new Map(itemRows.map(item => [item.stock_item_id, item]));
  const state = new Map(itemRows.map(item => [item.stock_item_id, {
    qty: Number(item.current_qty),
    value: Number(item.inventory_value || 0),
    avg: Number(item.average_cost || 0),
    item,
  }]));

  const warnings = [];
  const movements = [];
  const movementRows = [];
  const finalState = new Map();
  const accounting = { inventoryIn: [], inventoryOut: [], cogsOut: [] };

  for (const l of usableLines) {
    const item = itemsById.get(l.stockItemId);
    const s = state.get(l.stockItemId);
    const qty = Number(l.quantity);

    if (direction === 'OUT' && qty > s.qty + 0.0000001) {
      throw new Error(`Insufficient stock for ${item.item_code}: available ${s.qty}, requested ${qty}`);
    }

    const before = s.qty;
    // eslint-disable-next-line no-await-in-loop -- must stay sequential: each
    // line's FIFO consumption depends on lot balances left by the line before it.
    const { usedUnitCost, valueIn, valueOut } = await costLine(client, {
      item, direction, quantity: qty, suppliedUnitCost: l.unitCost, currentAvg: s.avg,
      movementDate, sourceDocId, sourceDocNo,
    });

    if (direction === 'IN') {
      s.qty = s.qty + qty;
      s.value = roundMoney(s.value + valueIn);
    } else {
      s.qty = s.qty - qty;
      s.value = roundMoney(s.value - valueOut);
      if (s.value < -0.01) throw new Error(`Inventory valuation would become negative for ${item.item_code}`);
      if (Math.abs(s.qty) < 0.0000001) { s.qty = 0; s.value = 0; }
    }

    s.avg = s.qty > 0 ? roundCost(s.value / s.qty) : 0;
    finalState.set(l.stockItemId, s);

    if (direction === 'OUT') {
      accounting.inventoryOut.push({
        accountId: item.default_inventory_account_id,
        amount: valueOut,
        description: l.description || item.item_name,
      });
      accounting.cogsOut.push({
        accountId: item.default_cogs_account_id,
        amount: valueOut,
        description: l.description || item.item_name,
      });
    } else {
      accounting.inventoryIn.push({
        accountId: item.default_inventory_account_id,
        cogsAccountId: item.default_cogs_account_id,
        amount: valueIn,
        description: l.description || item.item_name,
      });
    }

    const result = {
      stockItemId: l.stockItemId,
      itemCode: item.item_code,
      itemName: item.item_name,
      before,
      quantity: qty,
      after: s.qty,
      unitCost: usedUnitCost,
      valueIn,
      valueOut,
      inventoryAccountId: item.default_inventory_account_id,
      cogsAccountId: item.default_cogs_account_id,
      warning: null,
    };
    movements.push(result);

    movementRows.push([
      uuidv4(), l.stockItemId, movementDate, movementType,
      sourceDocId || null, sourceDocNo || null,
      direction === 'IN' ? qty : 0,
      direction === 'OUT' ? qty : 0,
      s.qty,
      l.description || null,
      usedUnitCost,
      valueIn,
      valueOut,
    ]);
  }

  for (const [stockItemId, s] of finalState) {
    await client.query(
      `UPDATE stock_item SET current_qty=$1, inventory_value=$2, average_cost=$3 WHERE stock_item_id=$4`,
      [s.qty, s.value, s.avg, stockItemId]
    );
  }

  const placeholders = movementRows.map((_, rowIndex) => {
    const base = rowIndex * 13;
    return `(${Array.from({ length: 13 }, (_, i) => `$${base + i + 1}`).join(',')})`;
  }).join(',');
  const flatParams = movementRows.flat();
  await client.query(
    `INSERT INTO stock_movement
       (movement_id, stock_item_id, movement_date, movement_type, source_doc_id,
        source_doc_no, quantity_in, quantity_out, balance_after, note,
        unit_cost, value_in, value_out)
     VALUES ${placeholders}`,
    flatParams
  );

  return { warnings, movements, accounting };
}

async function reverseStockForSourceDocument(client, { sourceDocId, movementDate, sourceDocNo }) {
  const { rows: originals } = await client.query(
    `SELECT stock_item_id, movement_date, movement_type, source_doc_no,
            quantity_in, quantity_out, balance_after, note, unit_cost, value_in, value_out
       FROM stock_movement
      WHERE source_doc_id=$1
      ORDER BY created_at DESC`,
    [sourceDocId]
  );
  if (!originals.length) return { warnings: [], movements: [] };

  const ids = originals.map(r => r.stock_item_id);
  const itemRows = await loadStockRowsForUpdate(client, ids);
  const byId = new Map(itemRows.map(r => [r.stock_item_id, r]));
  const final = new Map(itemRows.map(r => [r.stock_item_id, {
    qty: Number(r.current_qty), value: Number(r.inventory_value || 0), avg: Number(r.average_cost || 0), item: r,
  }]));

  const movements = [];
  const rowsToInsert = [];
  for (const o of originals) {
    const s = final.get(o.stock_item_id);
    const qtyIn = Number(o.quantity_in || 0);
    const qtyOut = Number(o.quantity_out || 0);
    const reversalQty = qtyIn > 0 ? qtyIn : qtyOut;
    const reversalDirection = qtyIn > 0 ? 'OUT' : 'IN';
    const reversalValue = qtyIn > 0 ? Number(o.value_in || 0) : Number(o.value_out || 0);
    const unitCost = reversalQty > 0 ? reversalValue / reversalQty : 0;

    if (reversalDirection === 'OUT') {
      if (reversalQty > s.qty + 0.0000001) {
        throw new Error(`Cannot reverse stock movement for ${s.item.item_code}: available ${s.qty}, required ${reversalQty}`);
      }
      s.qty -= reversalQty;
      s.value = roundMoney(s.value - reversalValue);
    } else {
      s.qty += reversalQty;
      s.value = roundMoney(s.value + reversalValue);
    }
    {
      // eslint-disable-next-line no-await-in-loop -- one document's few lot
      // rows; not worth a second pass just to parallelise this.
      // Reversal follows stored FIFO history, not today's method.
      await fifoReverse(client, {
        stockItemId: o.stock_item_id, sourceDocId,
        originalDirection: qtyIn > 0 ? 'IN' : 'OUT', // the ORIGINAL movement's direction, not this reversal's
        movementDate: movementDate || o.movement_date,
      });
    }
    if (s.value < -0.01) throw new Error(`Inventory valuation would become negative while reversing ${s.item.item_code}`);
    if (Math.abs(s.qty) < 0.0000001) { s.qty = 0; s.value = 0; }
    s.avg = s.qty > 0 ? roundCost(s.value / s.qty) : 0;

    rowsToInsert.push([
      uuidv4(), o.stock_item_id, movementDate || o.movement_date, 'REVERSAL',
      sourceDocId, sourceDocNo || `REVERSAL`, reversalDirection === 'IN' ? reversalQty : 0,
      reversalDirection === 'OUT' ? reversalQty : 0, s.qty,
      `Reversal of ${o.source_doc_no || sourceDocId}`, unitCost,
      reversalDirection === 'IN' ? reversalValue : 0,
      reversalDirection === 'OUT' ? reversalValue : 0,
    ]);
    movements.push({ stockItemId:o.stock_item_id, quantity:reversalQty, direction:reversalDirection, value:reversalValue });
  }

  for (const [stockItemId, s] of final) {
    await client.query(`UPDATE stock_item SET current_qty=$1, inventory_value=$2, average_cost=$3 WHERE stock_item_id=$4`, [s.qty,s.value,s.avg,stockItemId]);
  }
  const placeholders = rowsToInsert.map((_, i) => {
    const base=i*13; return `(${Array.from({length:13},(_,j)=>`$${base+j+1}`).join(',')})`;
  }).join(',');
  await client.query(
    `INSERT INTO stock_movement
      (movement_id,stock_item_id,movement_date,movement_type,source_doc_id,source_doc_no,
       quantity_in,quantity_out,balance_after,note,unit_cost,value_in,value_out)
     VALUES ${placeholders}`,
    rowsToInsert.flat()
  );
  return { warnings:[], movements };
}

async function getStockItemLookup(client, stockItemId) {
  const { rows } = await client.query(
    `SELECT stock_item_id, item_code, item_name, unit, ref_cost, ref_price, current_qty,
            barcode, serial_number, min_qty, is_active, default_expense_account_id,
            default_revenue_account_id, default_inventory_account_id, default_cogs_account_id,
            default_sales_tax_code_id, default_purchase_tax_code_id, inventory_value, average_cost, costing_method
       FROM stock_item WHERE stock_item_id = $1`,
    [stockItemId]
  );
  return rows[0] || null;
}

async function getStockItem(client, stockItemId) {
  // Was missing inventory_value/average_cost/costing_method/COGS+inventory account
  // columns until this fix, which meant the item detail screen always showed
  // RM 0.00 for average cost and stock value - a pre-existing display bug,
  // now folded into the same STOCK_SELECT every other stock-item read uses.
  const { rows } = await client.query(`${STOCK_SELECT} WHERE stock_item_id = $1`, [stockItemId]);
  return rows[0] || null;
}

async function getStockMovements(client, stockItemId) {
  const { rows } = await client.query(
    `SELECT movement_id, movement_date, movement_type, source_doc_id, source_doc_no,
            quantity_in, quantity_out, balance_after, note, created_at
       FROM stock_movement
      WHERE stock_item_id = $1
      ORDER BY movement_date DESC, created_at DESC`, [stockItemId]
  );
  return rows;
}

/**
 * Resolve which GL account a document line should post to.
 *
 * If the line has a stock item, its default account for the given
 * direction is used - no manual account entry on the line at all,
 * since the item master already carries this (migration 011). If the
 * item has no default account configured for that direction, this
 * fails loudly rather than silently posting to nothing or guessing:
 * the fix is to set a default on the item, not to re-add a manual
 * dropdown that defeats the point of having item defaults.
 *
 * If the line has no stock item (a free-text service/non-stock line),
 * there's nothing to resolve from, so a manually supplied account is
 * required instead - this is the one remaining case where the caller
 * must provide an account directly.
 */
async function resolveLineAccount(client, { stockItemId, manualAccountId, direction }) {
  const expectedType = direction === 'SALES' ? 'REVENUE' : 'EXPENSE';
  if (stockItemId) {
    const item = await getStockItem(client, stockItemId);
    if (!item) throw new Error(`Stock item ${stockItemId} not found`);
    if (item.is_active !== true) throw new Error(`Stock item "${item.item_code}" is inactive`);
    const accountId = direction === 'SALES' ? item.default_revenue_account_id : item.default_expense_account_id;
    if (!accountId) {
      const label = direction === 'SALES' ? 'revenue' : 'expense';
      throw new Error(`Stock item "${item.item_code}" has no default ${label} account set — add one in Stock Item Maintenance before using it on a ${direction === 'SALES' ? 'sales' : 'purchase'} document.`);
    }
    const { rows: accountRows } = await client.query(
      `SELECT account_type,is_active FROM chart_of_accounts WHERE account_id=$1`, [accountId]
    );
    if (!accountRows.length || !accountRows[0].is_active) throw new Error(`Default ${direction === 'SALES' ? 'revenue' : 'expense'} account for ${item.item_code} is missing or inactive`);
    if (accountRows[0].account_type !== expectedType) throw new Error(`Default ${direction === 'SALES' ? 'revenue' : 'expense'} account for ${item.item_code} must be ${expectedType}`);
    return accountId;
  }
  if (!manualAccountId) throw new Error('An account is required for non-stock lines.');
  const { rows: manualRows } = await client.query(
    `SELECT account_type, is_active FROM chart_of_accounts WHERE account_id=$1`, [manualAccountId]
  );
  if (!manualRows.length) throw new Error(`Account ${manualAccountId} not found`);
  if (!manualRows[0].is_active) throw new Error(`Account ${manualAccountId} is inactive`);
  if (manualRows[0].account_type !== expectedType) throw new Error(`Non-stock ${direction === 'SALES' ? 'sales' : 'purchase'} lines must use an active ${expectedType} account`);
  return manualAccountId;
}

async function getStockAccountingAccounts(client, stockItemId) {
  const item = await getStockItem(client, stockItemId);
  if (!item) throw new Error(`Stock item ${stockItemId} not found`);
  return validateStockAccountingAccounts(client, stockItemId, item.item_code);
}

module.exports = {
  listStockItems,
  searchStockItems,
  createStockItem,
  updateStockItem,
  setStockItemActive,
  setCostingMethod,
  getStockSnapshot,
  moveStock,
  moveStockForLines,
  reverseStockForSourceDocument,
  getStockItem,
  getStockItemLookup,
  getStockMovements,
  resolveLineAccount,
  validateStockAccountingAccounts,
  getStockAccountingAccounts,
};
