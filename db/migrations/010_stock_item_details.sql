-- =====================================================================
-- MIGRATION 010: Stock item master details
-- Adds the core fields requested for SQL Accounting-style item maintenance:
-- description, code, unit, reference cost, reference price, balance qty,
-- barcode and serial number.
--
-- item_name remains the database field for Description. current_qty remains
-- the calculated Balance Qty and is not directly edited by transactions.
-- =====================================================================

ALTER TABLE stock_item
    ADD COLUMN ref_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN ref_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN barcode VARCHAR(100),
    ADD COLUMN serial_number VARCHAR(100);

CREATE INDEX idx_stock_item_barcode ON stock_item(barcode);
