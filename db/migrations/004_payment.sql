-- =====================================================================
-- MIGRATION: Payment (to supplier) module
-- Mirrors the receipt/receipt_allocation pattern for the AP side.
-- =====================================================================

CREATE TABLE payment (
    payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_no      VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    payment_date    DATE NOT NULL,
    bank_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    amount          NUMERIC(18,2) NOT NULL,
    payment_method  VARCHAR(30),
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocation (
    allocation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID NOT NULL REFERENCES payment(payment_id) ON DELETE CASCADE,
    purchase_invoice_id UUID NOT NULL REFERENCES purchase_invoice(purchase_invoice_id),
    amount_applied  NUMERIC(18,2) NOT NULL
);
