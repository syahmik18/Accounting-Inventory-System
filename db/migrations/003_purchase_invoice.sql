-- =====================================================================
-- MIGRATION: Purchase Invoice module (Accounts Payable)
-- Run against your EXISTING accounting_sample database - only adds
-- new tables/rows, nothing existing is touched.
-- =====================================================================

-- New expense account for SST paid on purchases. Malaysia's SST is not
-- a value-added tax with input credit for most businesses (unlike GST/VAT),
-- so it's posted as a real cost rather than a claimable asset. If your
-- setup does reclaim it in some cases, point purchase lines at an asset
-- account instead - the posting logic doesn't change, only the account.
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control_account)
VALUES ('6100', 'SST on Purchases (Non-Claimable)', 'EXPENSE', 'DR', FALSE);

CREATE TABLE purchase_invoice (
    purchase_invoice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_no      VARCHAR(30) UNIQUE NOT NULL,       -- the SUPPLIER's own invoice number
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    invoice_date    DATE NOT NULL,
    due_date        DATE NOT NULL,
    status          invoice_status NOT NULL DEFAULT 'DRAFT',  -- reuses the same enum as sales
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_invoice_line (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_invoice_id UUID NOT NULL REFERENCES purchase_invoice(purchase_invoice_id) ON DELETE CASCADE,
    item_code       VARCHAR(50),
    description     VARCHAR(255) NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
    expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id)
);

CREATE INDEX idx_purchase_invoice_line_pi ON purchase_invoice_line(purchase_invoice_id);
