-- =====================================================================
-- MIGRATION 029: Dashboard semantic roles + FIFO state hardening
--
-- No document, journal, stock quantity, or valuation is rewritten.
-- Adds a FIFO active-layer marker and a read-only reporting-role view used by
-- the Glass dashboard / Assistant and account pickers so analytics do not
-- depend on account-number prefixes.
-- =====================================================================

ALTER TABLE stock_lot
  ADD COLUMN IF NOT EXISTS is_active_layer BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE stock_lot sl
   SET is_active_layer = (si.costing_method = 'FIFO' AND sl.qty_remaining > 0.0000001)
  FROM stock_item si
 WHERE si.stock_item_id = sl.stock_item_id;

DROP INDEX IF EXISTS idx_stock_lot_fifo_order;

CREATE INDEX IF NOT EXISTS idx_stock_lot_active_fifo_order
  ON stock_lot(stock_item_id, received_date, created_at)
  WHERE is_active_layer = TRUE AND qty_remaining > 0.0000001;

CREATE INDEX IF NOT EXISTS idx_stock_item_inventory_account
  ON stock_item(default_inventory_account_id)
  WHERE default_inventory_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_item_cogs_account
  ON stock_item(default_cogs_account_id)
  WHERE default_cogs_account_id IS NOT NULL;

DROP VIEW IF EXISTS account_reporting_role;

CREATE OR REPLACE VIEW account_reporting_role AS
WITH bank_refs AS (
  SELECT bank_account_id AS account_id FROM receipt
  UNION
  SELECT bank_account_id FROM payment
), cash_refs AS (
  SELECT cash_account_id AS account_id FROM cash_sale
  UNION
  SELECT cash_account_id FROM cash_purchase
  UNION
  SELECT cash_account_id FROM payment_voucher
  UNION
  SELECT cash_account_id FROM official_receipt
), inventory_refs AS (
  SELECT default_inventory_account_id AS account_id
    FROM stock_item
   WHERE default_inventory_account_id IS NOT NULL
), cogs_refs AS (
  SELECT default_cogs_account_id AS account_id
    FROM stock_item
   WHERE default_cogs_account_id IS NOT NULL
), base AS (
  SELECT c.account_id, c.account_code, c.account_name,
         c.account_type::text AS account_type, c.normal_balance, c.parent_id,
         c.is_control_account, c.is_active,
         EXISTS (SELECT 1 FROM bank_refs b WHERE b.account_id = c.account_id)
           OR (c.account_type='ASSET' AND lower(c.account_name) ~ '(bank|current account|checking|cheque|savings)') AS is_bank_account,
         EXISTS (SELECT 1 FROM cash_refs b WHERE b.account_id = c.account_id)
           OR (c.account_type='ASSET' AND lower(c.account_name) ~ '(cash|petty)') AS is_cash_account_name,
         EXISTS (SELECT 1 FROM inventory_refs i WHERE i.account_id = c.account_id)
           OR (c.account_type='ASSET' AND lower(c.account_name) ~ '(inventory|stock)') AS is_inventory_account,
         (c.account_type='ASSET' AND lower(c.account_name) ~ '(receivable|debtor|trade debt|customer balance|accounts? receivable)') AS is_receivable_account,
         (c.account_type='LIABILITY' AND lower(c.account_name) ~ '(payable|creditor|trade credit|accounts? payable)') AS is_payable_account,
         (c.account_type='LIABILITY' AND lower(c.account_name) ~ '(gr.?/?ir|goods received)') AS is_grir_account,
         (c.account_type='EXPENSE' AND (EXISTS (SELECT 1 FROM cogs_refs r WHERE r.account_id = c.account_id)
              OR lower(c.account_name) ~ '(cost of goods|cost of sales|(^|[^a-z])cogs([^a-z]|$))')) AS is_cogs_account,
         (c.account_type='ASSET' AND lower(c.account_name) ~ '(fixed asset|property|plant|equipment|vehicle|motor|machin|building|land|furniture|computer|intangible|long[- ]?term|non[- ]?current)') AS is_noncurrent_asset_name,
         (c.account_type='LIABILITY' AND lower(c.account_name) ~ '(long[- ]?term|term loan|hire purchase|lease liability|deferred tax|non[- ]?current)') AS is_noncurrent_liability_name
    FROM chart_of_accounts c
)
SELECT b.account_id, b.account_code, b.account_name, b.account_type, b.normal_balance, b.parent_id,
       b.is_control_account, b.is_active,
       (b.is_bank_account OR b.is_cash_account_name) AS is_cash_account,
       b.is_inventory_account, b.is_receivable_account, b.is_payable_account, b.is_grir_account, b.is_cogs_account,
       (b.account_type='ASSET' AND NOT b.is_noncurrent_asset_name) AS is_current_asset,
       (b.account_type='LIABILITY' AND NOT b.is_noncurrent_liability_name) AS is_current_liability,
       CASE
         WHEN b.is_bank_account THEN 'BANK'
         WHEN b.is_cash_account_name THEN 'CASH'
         WHEN b.is_inventory_account THEN 'INVENTORY'
         WHEN b.is_receivable_account THEN 'RECEIVABLE'
         WHEN b.is_payable_account THEN 'PAYABLE'
         WHEN b.is_grir_account THEN 'GRIR'
         WHEN b.is_cogs_account THEN 'COGS'
         WHEN b.account_type='REVENUE' THEN 'REVENUE'
         WHEN b.account_type='EXPENSE' THEN 'EXPENSE'
         WHEN b.account_type='EQUITY' THEN 'EQUITY'
         WHEN b.account_type='LIABILITY' THEN 'LIABILITY'
         WHEN b.account_type='ASSET' THEN 'ASSET'
         ELSE b.account_type
       END AS reporting_role
  FROM base b;
