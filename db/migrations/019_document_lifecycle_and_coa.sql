-- Safe lifecycle controls + user-maintainable Chart of Accounts.
DO $$
BEGIN
  CREATE TYPE document_status AS ENUM ('POSTED','VOID');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE cash_sale ADD COLUMN IF NOT EXISTS status document_status NOT NULL DEFAULT 'POSTED';
ALTER TABLE cash_purchase ADD COLUMN IF NOT EXISTS status document_status NOT NULL DEFAULT 'POSTED';
ALTER TABLE receipt ADD COLUMN IF NOT EXISTS status document_status NOT NULL DEFAULT 'POSTED';
ALTER TABLE payment ADD COLUMN IF NOT EXISTS status document_status NOT NULL DEFAULT 'POSTED';
ALTER TABLE goods_received_note ADD COLUMN IF NOT EXISTS status document_status NOT NULL DEFAULT 'POSTED';

ALTER TABLE stock_movement DROP CONSTRAINT IF EXISTS stock_movement_movement_type_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_movement_type_check
  CHECK (movement_type IN ('PURCHASE_INVOICE','CASH_PURCHASE','GRN','DELIVERY_ORDER','SALES_INVOICE','CASH_SALE','CREDIT_NOTE','ADJUSTMENT','REVERSAL'));

CREATE INDEX IF NOT EXISTS idx_cash_sale_status_date ON cash_sale(status, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_purchase_status_date ON cash_purchase(status, purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipt_status_date ON receipt(status, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_payment_status_date ON payment(status, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_grn_status_date ON goods_received_note(status, received_date DESC);
