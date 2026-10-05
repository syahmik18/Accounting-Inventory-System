-- =====================================================================
-- MIGRATION 028: Per-item costing method (Fixed / Average / FIFO)
--
-- Adds:
--   stock_item.costing_method   - which valuation method this item uses
--   stock_lot                   - FIFO cost layers ("batches"), one row per
--                                  receipt (GRN, purchase invoice, cash
--                                  purchase, or opening stock)
--   stock_lot_consumption       - which lot(s) an outgoing movement drew
--                                  from and how much, so a later void can
--                                  precisely restore quantity to the same
--                                  lot instead of guessing
--
-- Existing items default to AVERAGE (today's behaviour), so nothing about
-- an existing database changes until someone opens an item and switches
-- its costing method.
-- =====================================================================

ALTER TABLE stock_item
  ADD COLUMN IF NOT EXISTS costing_method VARCHAR(10) NOT NULL DEFAULT 'AVERAGE'
    CHECK (costing_method IN ('FIXED', 'AVERAGE', 'FIFO'));

CREATE TABLE IF NOT EXISTS stock_lot (
    lot_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_item_id   UUID NOT NULL REFERENCES stock_item(stock_item_id),
    source_doc_id   UUID,
    source_doc_no   VARCHAR(50),
    received_date   DATE NOT NULL,
    unit_cost       NUMERIC(18,6) NOT NULL CHECK (unit_cost >= 0),
    qty_received    NUMERIC(18,4) NOT NULL CHECK (qty_received > 0),
    qty_remaining   NUMERIC(18,4) NOT NULL CHECK (qty_remaining >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The FIFO consumption order: oldest received_date first, ties broken by
-- insertion order. Partial index keeps it tiny - only rows still carrying
-- quantity are ever scanned for consumption.
CREATE INDEX IF NOT EXISTS idx_stock_lot_fifo_order
  ON stock_lot(stock_item_id, received_date, created_at)
  WHERE qty_remaining > 0;
CREATE INDEX IF NOT EXISTS idx_stock_lot_source ON stock_lot(source_doc_id);

CREATE TABLE IF NOT EXISTS stock_lot_consumption (
    consumption_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_id               UUID NOT NULL REFERENCES stock_lot(lot_id),
    stock_item_id        UUID NOT NULL REFERENCES stock_item(stock_item_id),
    consumed_by_doc_id    UUID,
    consumed_by_doc_no    VARCHAR(50),
    quantity              NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
    unit_cost             NUMERIC(18,6) NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_lot_consumption_lot ON stock_lot_consumption(lot_id);
CREATE INDEX IF NOT EXISTS idx_stock_lot_consumption_doc ON stock_lot_consumption(consumed_by_doc_id);
