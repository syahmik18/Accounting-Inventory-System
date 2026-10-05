-- =====================================================================
-- MIGRATION: Cash Sale module
-- Run this against your existing accounting_sample database - it only
-- ADDS tables, nothing existing is touched.
-- =====================================================================

CREATE TABLE cash_sale (
    cash_sale_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_sale_no    VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID REFERENCES partner(partner_id),  -- nullable: walk-in customer
    sale_date       DATE NOT NULL,
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'CASH',  -- CASH / BANK_TRANSFER / CARD
    cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id), -- which Cash/Bank account received it
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cash_sale_line (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_sale_id    UUID NOT NULL REFERENCES cash_sale(cash_sale_id) ON DELETE CASCADE,
    item_code       VARCHAR(50),
    description     VARCHAR(255) NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id)
);

CREATE INDEX idx_cash_sale_line_sale ON cash_sale_line(cash_sale_id);
