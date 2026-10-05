-- =====================================================================
-- MIGRATION: Cash Purchase module
-- Step 5 of the procurement cycle - the "no PO, no GRN, just paid it"
-- path for petty cash / over-the-counter buys. Direct mirror of
-- cash_sale, sides flipped:
--
--   DR  Expense (per line)
--   DR  SST on Purchases        (tax portion, if any)
--   CR  Cash/Bank account       (whichever account paid)
--
-- Recognized and paid in the same document, same as cash_sale never
-- touches AR - this never touches AP.
-- =====================================================================

CREATE TABLE cash_purchase (
    cash_purchase_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_purchase_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID REFERENCES partner(partner_id),   -- nullable: unregistered/one-off vendor
    purchase_date   DATE NOT NULL,
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'CASH',
    cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cash_purchase_line (
    line_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_purchase_id    UUID NOT NULL REFERENCES cash_purchase(cash_purchase_id) ON DELETE CASCADE,
    item_code           VARCHAR(50),
    description         VARCHAR(255) NOT NULL,
    quantity            NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
    expense_account_id  UUID NOT NULL REFERENCES chart_of_accounts(account_id)
);

CREATE INDEX idx_cash_purchase_line_cp ON cash_purchase_line(cash_purchase_id);
