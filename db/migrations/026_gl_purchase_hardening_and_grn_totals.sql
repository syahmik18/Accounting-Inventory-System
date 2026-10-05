-- =====================================================================
-- MIGRATION 026: Purchase / inventory accounting hardening + GRN UI support
--
-- Stock-item purchase lines do not need the legacy expense_account_id field.
-- Their economic account comes from stock_item.default_inventory_account_id.
-- Non-stock lines still require an expense account. Existing rows are not
-- rewritten, preserving the historical audit trail.
-- =====================================================================

ALTER TABLE purchase_order_line
  ALTER COLUMN expense_account_id DROP NOT NULL;
ALTER TABLE grn_line
  ALTER COLUMN expense_account_id DROP NOT NULL;
ALTER TABLE purchase_invoice_line
  ALTER COLUMN expense_account_id DROP NOT NULL;
ALTER TABLE cash_purchase_line
  ALTER COLUMN expense_account_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_po_line_account_source') THEN
    ALTER TABLE purchase_order_line
      ADD CONSTRAINT ck_po_line_account_source
      CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_grn_line_account_source') THEN
    ALTER TABLE grn_line
      ADD CONSTRAINT ck_grn_line_account_source
      CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pi_line_account_source') THEN
    ALTER TABLE purchase_invoice_line
      ADD CONSTRAINT ck_pi_line_account_source
      CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_cp_line_account_source') THEN
    ALTER TABLE cash_purchase_line
      ADD CONSTRAINT ck_cp_line_account_source
      CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
