-- =====================================================================
-- MIGRATION 009: Stock / Inventory quantity tracking
--
-- Quantity is moved automatically by business documents:
--   GRN               + stock (PO-backed physical receipt)
--   Purchase Invoice  + stock (standalone/direct purchase only)
--   Cash Purchase     + stock
--   Sales Invoice     - stock
--   Cash Sale         - stock
--
-- Negative stock is allowed. Sales returning a projected negative balance
-- produce a warning to the UI but are still posted.
-- =====================================================================

CREATE TABLE stock_item (
    stock_item_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_code           VARCHAR(50) UNIQUE NOT NULL,
    item_name           VARCHAR(150) NOT NULL,
    unit                VARCHAR(20) NOT NULL DEFAULT 'UNIT',
    current_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
    min_qty             NUMERIC(18,4) NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_item_active ON stock_item(is_active);

CREATE TABLE stock_movement (
    movement_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_item_id       UUID NOT NULL REFERENCES stock_item(stock_item_id),
    movement_date       DATE NOT NULL,
    movement_type       VARCHAR(30) NOT NULL CHECK (movement_type IN ('PURCHASE_INVOICE','CASH_PURCHASE','GRN','SALES_INVOICE','CASH_SALE','ADJUSTMENT')),
    source_doc_id       UUID,
    source_doc_no       VARCHAR(50),
    quantity_in         NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_in >= 0),
    quantity_out        NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_out >= 0),
    balance_after       NUMERIC(18,4) NOT NULL,
    note                VARCHAR(255),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT (quantity_in > 0 AND quantity_out > 0)),
    CHECK (quantity_in > 0 OR quantity_out > 0)
);

CREATE INDEX idx_stock_movement_item_date ON stock_movement(stock_item_id, movement_date, created_at);
CREATE INDEX idx_stock_movement_source ON stock_movement(movement_type, source_doc_id);

ALTER TABLE sales_invoice_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);
ALTER TABLE cash_sale_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);
ALTER TABLE purchase_invoice_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);
ALTER TABLE cash_purchase_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);
ALTER TABLE purchase_order_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);
ALTER TABLE grn_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);

ALTER TABLE purchase_request_line ADD COLUMN stock_item_id UUID REFERENCES stock_item(stock_item_id);
