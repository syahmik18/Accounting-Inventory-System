-- Sales document flow + scalable partner search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE stock_movement DROP CONSTRAINT IF EXISTS stock_movement_movement_type_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_movement_type_check
  CHECK (movement_type IN ('PURCHASE_INVOICE','CASH_PURCHASE','GRN','DELIVERY_ORDER','SALES_INVOICE','CASH_SALE','ADJUSTMENT'));

CREATE TYPE quotation_status AS ENUM ('OPEN','CONVERTED','EXPIRED','CANCELLED');
CREATE TYPE sales_order_status AS ENUM ('OPEN','PARTIALLY_DELIVERED','DELIVERED','CLOSED','CANCELLED');
CREATE TYPE delivery_order_status AS ENUM ('POSTED','CANCELLED');
CREATE TYPE sales_note_status AS ENUM ('POSTED','VOID');

CREATE TABLE quotation (
    quotation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    quotation_date DATE NOT NULL,
    valid_until DATE,
    status quotation_status NOT NULL DEFAULT 'OPEN',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE quotation_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id UUID NOT NULL REFERENCES quotation(quotation_id) ON DELETE CASCADE,
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_quotation_partner_date ON quotation(partner_id, quotation_date DESC);
CREATE INDEX idx_quotation_line_quotation ON quotation_line(quotation_id);
CREATE INDEX idx_quotation_line_stock_item ON quotation_line(stock_item_id);

CREATE TABLE sales_order (
    sales_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(30) UNIQUE NOT NULL,
    quotation_id UUID REFERENCES quotation(quotation_id),
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    order_date DATE NOT NULL,
    expected_date DATE,
    status sales_order_status NOT NULL DEFAULT 'OPEN',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sales_order_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_order_id UUID NOT NULL REFERENCES sales_order(sales_order_id) ON DELETE CASCADE,
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    quantity_delivered NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_sales_order_partner_date ON sales_order(partner_id, order_date DESC);
CREATE INDEX idx_sales_order_status ON sales_order(status);
CREATE INDEX idx_sales_order_line_order ON sales_order_line(sales_order_id);
CREATE INDEX idx_sales_order_line_stock_item ON sales_order_line(stock_item_id);

CREATE TABLE delivery_order (
    delivery_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_no VARCHAR(30) UNIQUE NOT NULL,
    sales_order_id UUID NOT NULL REFERENCES sales_order(sales_order_id),
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    delivery_date DATE NOT NULL,
    status delivery_order_status NOT NULL DEFAULT 'POSTED',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE delivery_order_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_order_id UUID NOT NULL REFERENCES delivery_order(delivery_order_id) ON DELETE CASCADE,
    sales_order_line_id UUID REFERENCES sales_order_line(line_id),
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_delivery_order_partner_date ON delivery_order(partner_id, delivery_date DESC);
CREATE INDEX idx_delivery_order_so ON delivery_order(sales_order_id);
CREATE INDEX idx_delivery_order_line_do ON delivery_order_line(delivery_order_id);
CREATE INDEX idx_delivery_order_line_stock_item ON delivery_order_line(stock_item_id);

ALTER TABLE sales_invoice ADD COLUMN IF NOT EXISTS delivery_order_id UUID REFERENCES delivery_order(delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_delivery_order ON sales_invoice(delivery_order_id);

CREATE TABLE debit_note (
    debit_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    note_date DATE NOT NULL,
    status sales_note_status NOT NULL DEFAULT 'POSTED',
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    return_goods BOOLEAN NOT NULL DEFAULT FALSE,
    journal_id UUID REFERENCES journal_entry(journal_id),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE debit_note_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    debit_note_id UUID NOT NULL REFERENCES debit_note(debit_note_id) ON DELETE CASCADE,
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_debit_note_partner_date ON debit_note(partner_id, note_date DESC);
CREATE INDEX idx_debit_note_line_note ON debit_note_line(debit_note_id);
CREATE INDEX idx_debit_note_line_stock_item ON debit_note_line(stock_item_id);

CREATE TABLE credit_note (
    credit_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    note_date DATE NOT NULL,
    status sales_note_status NOT NULL DEFAULT 'POSTED',
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    return_goods BOOLEAN NOT NULL DEFAULT FALSE,
    journal_id UUID REFERENCES journal_entry(journal_id),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_note_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_id UUID NOT NULL REFERENCES credit_note(credit_note_id) ON DELETE CASCADE,
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_credit_note_partner_date ON credit_note(partner_id, note_date DESC);
CREATE INDEX idx_credit_note_line_note ON credit_note_line(credit_note_id);
CREATE INDEX idx_credit_note_line_stock_item ON credit_note_line(stock_item_id);

CREATE INDEX IF NOT EXISTS idx_partner_code_trgm ON partner USING gin (partner_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_name_trgm ON partner USING gin (partner_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_tax_id_trgm ON partner USING gin (tax_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_brn_no_trgm ON partner USING gin (brn_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_phone_trgm ON partner USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_email_trgm ON partner USING gin (email gin_trgm_ops);
