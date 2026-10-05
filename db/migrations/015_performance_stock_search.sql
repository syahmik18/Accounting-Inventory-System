-- Performance upgrade: server-side stock search/pagination support.
-- Safe to run on an existing database. pg_trgm is a standard PostgreSQL
-- contrib extension and enables efficient ILIKE '%term%' searches.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_stock_item_active_code
    ON stock_item(item_code) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_stock_item_code_trgm
    ON stock_item USING gin (item_code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_stock_item_name_trgm
    ON stock_item USING gin (item_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_stock_item_barcode_trgm
    ON stock_item USING gin (barcode gin_trgm_ops);

-- Common document/report access paths as the dataset grows.
CREATE INDEX IF NOT EXISTS idx_sales_invoice_date_no
    ON sales_invoice(invoice_date DESC, invoice_no DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_date_no
    ON purchase_invoice(invoice_date DESC, invoice_no DESC);
CREATE INDEX IF NOT EXISTS idx_cash_sale_date_no
    ON cash_sale(sale_date DESC, cash_sale_no DESC);

CREATE INDEX IF NOT EXISTS idx_journal_entry_posted_date
    ON journal_entry(is_posted, journal_date);
CREATE INDEX IF NOT EXISTS idx_journal_entry_source_doc
    ON journal_entry(source, source_doc_id);
CREATE INDEX IF NOT EXISTS idx_partner_name
    ON partner(partner_name);
CREATE INDEX IF NOT EXISTS idx_partner_type_active
    ON partner(partner_type, is_active);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_partner_date
    ON sales_invoice(partner_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_line_stock_item
    ON sales_invoice_line(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_receipt_partner_date
    ON receipt(partner_id, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_sale_partner_date
    ON cash_sale(partner_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_sale_line_stock_item
    ON cash_sale_line(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_partner_date
    ON purchase_invoice(partner_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_line_stock_item
    ON purchase_invoice_line(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_payment_partner_date
    ON payment(partner_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipt_allocation_invoice
    ON receipt_allocation(invoice_id);
CREATE INDEX IF NOT EXISTS idx_receipt_allocation_receipt
    ON receipt_allocation(receipt_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocation_purchase_invoice
    ON payment_allocation(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocation_payment
    ON payment_allocation(payment_id);
