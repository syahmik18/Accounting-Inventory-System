-- Sales delivery -> invoice transfer support.
-- A Delivery Order is the physical stock event; a linked Sales Invoice
-- clears the delivery for billing and must NOT deduct stock a second time.

ALTER TABLE delivery_order
  ADD COLUMN IF NOT EXISTS is_fully_invoiced BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_delivery_order_invoicing
  ON delivery_order(is_fully_invoiced, delivery_date DESC);

-- Match purchase-side GRN behavior: one posted DO can be transferred to
-- one Sales Invoice. Existing rows are left untouched and available until
-- their first successful invoice transfer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoice_delivery_order
  ON sales_invoice(delivery_order_id)
  WHERE delivery_order_id IS NOT NULL;

-- Recover the flag for any DO that may already have been linked by an
-- earlier version of the application.
UPDATE delivery_order d
   SET is_fully_invoiced = TRUE
 WHERE EXISTS (
   SELECT 1 FROM sales_invoice si
   WHERE si.delivery_order_id = d.delivery_order_id
 );
