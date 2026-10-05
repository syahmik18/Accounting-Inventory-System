-- =====================================================================
-- MIGRATION 022: GL / Inventory accounting hardening
--
-- Purpose:
--   1. Give every stock item explicit Inventory Asset and COGS defaults.
--   2. Store moving-average inventory valuation on the stock master.
--   3. Store the exact cost/value of every stock movement so reversals can
--      restore the same accounting value instead of re-costing at today's
--      average.
--   4. Give Delivery Orders a journal_id because DO is the physical stock
--      issue event in this system and therefore must also recognize COGS.
--   5. Provide safe default GL accounts for a new installation / legacy data.
--
-- IMPORTANT:
--   Existing historical journals are NOT rewritten automatically. Their
--   original accounting remains intact. Existing stock is seeded into the
--   new valuation fields using the current reference cost as the cut-over
--   basis. From this migration onward, new stock-affecting documents carry
--   proper inventory / COGS postings.
-- =====================================================================

-- 1) Safe system accounts. Do not overwrite an existing account with the
--    same code: custom/user-created accounts must never be silently changed.
INSERT INTO chart_of_accounts
    (account_code, account_name, account_type, normal_balance, is_control_account)
VALUES
    ('1200', 'Inventory', 'ASSET', 'DR', FALSE),
    ('3050', 'Opening Balance Equity', 'EQUITY', 'CR', FALSE)
ON CONFLICT (account_code) DO NOTHING;

-- 2) Explicit inventory / COGS defaults on stock items.
ALTER TABLE stock_item
    ADD COLUMN IF NOT EXISTS default_inventory_account_id UUID REFERENCES chart_of_accounts(account_id),
    ADD COLUMN IF NOT EXISTS default_cogs_account_id UUID REFERENCES chart_of_accounts(account_id),
    ADD COLUMN IF NOT EXISTS inventory_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS average_cost NUMERIC(18,6) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_stock_item_inventory_account
    ON stock_item(default_inventory_account_id);
CREATE INDEX IF NOT EXISTS idx_stock_item_cogs_account
    ON stock_item(default_cogs_account_id);

-- Fill missing defaults only. If an existing stock item already has an
-- explicit mapping, preserve it.
UPDATE stock_item
SET default_inventory_account_id = COALESCE(
      default_inventory_account_id,
      (SELECT account_id FROM chart_of_accounts WHERE account_code = '1200')
    ),
    default_cogs_account_id = COALESCE(
      default_cogs_account_id,
      (SELECT account_id FROM chart_of_accounts WHERE account_code = '5000')
    )
WHERE default_inventory_account_id IS NULL
   OR default_cogs_account_id IS NULL;

-- 3) Cost/value columns on the stock movement ledger.
ALTER TABLE stock_movement
    ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(18,6),
    ADD COLUMN IF NOT EXISTS value_in NUMERIC(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS value_out NUMERIC(18,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_stock_movement_item_date_cost
    ON stock_movement(stock_item_id, movement_date, created_at);

-- 4) Backfill legacy movement valuation conservatively from the current
--    reference cost. We are deliberately NOT pretending this is an exact
--    historical FIFO/weighted-average reconstruction.
UPDATE stock_movement sm
SET unit_cost = COALESCE(sm.unit_cost, si.ref_cost, 0),
    value_in = CASE WHEN sm.value_in = 0 THEN ROUND(sm.quantity_in * COALESCE(si.ref_cost, 0), 2) ELSE sm.value_in END,
    value_out = CASE WHEN sm.value_out = 0 THEN ROUND(sm.quantity_out * COALESCE(si.ref_cost, 0), 2) ELSE sm.value_out END
FROM stock_item si
WHERE si.stock_item_id = sm.stock_item_id
  AND (sm.unit_cost IS NULL OR sm.value_in = 0 OR sm.value_out = 0);

-- Seed the opening valuation state from the live quantity and reference cost.
-- This gives the post-cut-over costing engine a deterministic starting point.
UPDATE stock_item
SET inventory_value = ROUND(current_qty * ref_cost, 2),
    average_cost = CASE WHEN current_qty > 0 THEN ref_cost ELSE 0 END;

-- 5) Delivery Orders are the physical stock issue event. Their journal is
--    therefore part of the document record and can be reversed on void.
ALTER TABLE delivery_order
    ADD COLUMN IF NOT EXISTS journal_id UUID REFERENCES journal_entry(journal_id);

CREATE INDEX IF NOT EXISTS idx_delivery_order_journal
    ON delivery_order(journal_id);

-- 6) Keep value columns non-negative by convention. The application validates
-- this on every movement; no new table-level constraint is added here because
-- legacy datasets may contain pre-cutover anomalies that should be audited
-- rather than make the migration fail.
