-- v9: sales tax on pre-invoice documents + invoice-linked debit/credit notes.
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'CREDITED';

ALTER TABLE stock_movement DROP CONSTRAINT IF EXISTS stock_movement_movement_type_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_movement_type_check
  CHECK (movement_type IN ('PURCHASE_INVOICE','CASH_PURCHASE','GRN','DELIVERY_ORDER','SALES_INVOICE','CASH_SALE','CREDIT_NOTE','ADJUSTMENT'));

ALTER TABLE sales_invoice
  ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS debited_amount NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE quotation ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE quotation_line
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_code(tax_code_id);

ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_order_line
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_code(tax_code_id);

ALTER TABLE delivery_order
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE delivery_order_line
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_code(tax_code_id);

ALTER TABLE debit_note
  ADD COLUMN IF NOT EXISTS original_invoice_id UUID REFERENCES sales_invoice(invoice_id),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE credit_note
  ADD COLUMN IF NOT EXISTS original_invoice_id UUID REFERENCES sales_invoice(invoice_id),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE debit_note_line
  ADD COLUMN IF NOT EXISTS sales_invoice_line_id UUID REFERENCES sales_invoice_line(line_id),
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_code(tax_code_id);
ALTER TABLE credit_note_line
  ADD COLUMN IF NOT EXISTS sales_invoice_line_id UUID REFERENCES sales_invoice_line(line_id),
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES tax_code(tax_code_id);

CREATE INDEX IF NOT EXISTS idx_debit_note_original_invoice ON debit_note(original_invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_original_invoice ON credit_note(original_invoice_id);
CREATE INDEX IF NOT EXISTS idx_debit_note_line_invoice_line ON debit_note_line(sales_invoice_line_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_line_invoice_line ON credit_note_line(sales_invoice_line_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_adjustments ON sales_invoice(credited_amount, debited_amount);

UPDATE delivery_order SET total_amount = subtotal WHERE total_amount = 0 AND subtotal <> 0;
UPDATE sales_invoice si
   SET credited_amount = COALESCE((SELECT SUM(cn.total_amount) FROM credit_note cn WHERE cn.original_invoice_id = si.invoice_id AND cn.status='POSTED'),0),
       debited_amount = COALESCE((SELECT SUM(dn.total_amount) FROM debit_note dn WHERE dn.original_invoice_id = si.invoice_id AND dn.status='POSTED'),0);
