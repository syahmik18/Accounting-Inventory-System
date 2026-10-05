-- =====================================================================
-- MIGRATION 012: Tax Code master (SQL Accounting-style Tax Maintenance)
--
-- Two problems this solves together:
--
-- 1. Tax rate was a free-typed number per line, with no link to which
--    GL account it should post to - the account was hardcoded per
--    document type (SST_PAYABLE_ACCOUNT_CODE / SST_PURCHASE_ACCOUNT_CODE
--    constants in each model file). That meant every tax rate on every
--    line silently used the same one account, and typing "6" vs "0" had
--    no connection to anything configurable.
--
-- 2. Revenue/Expense account was manually re-picked on every single
--    line, even though a stock item already carries a default account
--    (migration 011). There was no way to actually SKIP re-entering it.
--
-- This migration adds a proper Tax Code master: each code has its own
-- rate AND its own GL account, scoped to a direction (SALES or
-- PURCHASE) since output tax (a liability owed) and input tax (a
-- non-claimable cost, see migration 003) are fundamentally different
-- postings and must never share one account.
--
-- Stock items get a default tax code per direction, mirroring the
-- existing default_expense_account_id/default_revenue_account_id
-- pattern from migration 011 exactly. Picking a stock item on a line
-- now resolves BOTH its account and its tax code automatically - no
-- manual dropdown needed for stock lines. Non-stock/service lines still
-- need a manual account and tax code, since there's no item to resolve
-- them from.
-- =====================================================================

CREATE TYPE tax_direction AS ENUM ('SALES', 'PURCHASE');

CREATE TABLE tax_code (
    tax_code_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(20) UNIQUE NOT NULL,
    description     VARCHAR(150) NOT NULL,
    direction       tax_direction NOT NULL,
    rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_account_id  UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tax_code_direction ON tax_code(direction, is_active);

-- Only one default code per direction, so auto-fill has a single
-- unambiguous fallback when a stock item has no default set of its own.
CREATE UNIQUE INDEX uq_tax_code_default_per_direction ON tax_code(direction) WHERE is_default;

ALTER TABLE stock_item
    ADD COLUMN default_sales_tax_code_id UUID REFERENCES tax_code(tax_code_id),
    ADD COLUMN default_purchase_tax_code_id UUID REFERENCES tax_code(tax_code_id);

-- tax_rate stays on each line (the resolved percentage actually charged,
-- frozen at posting time) - tax_code_id is added alongside it purely for
-- traceability back to which code produced that rate. If a code's rate
-- is edited later, past documents are unaffected either way.
ALTER TABLE sales_invoice_line ADD COLUMN tax_code_id UUID REFERENCES tax_code(tax_code_id);
ALTER TABLE cash_sale_line ADD COLUMN tax_code_id UUID REFERENCES tax_code(tax_code_id);
ALTER TABLE purchase_invoice_line ADD COLUMN tax_code_id UUID REFERENCES tax_code(tax_code_id);
ALTER TABLE cash_purchase_line ADD COLUMN tax_code_id UUID REFERENCES tax_code(tax_code_id);

-- Seed codes matching the accounts already in use, so existing behavior
-- (6% default) continues to work identically once the UI switches over.
INSERT INTO tax_code (code, description, direction, rate, tax_account_id, is_default)
VALUES
    ('SR-6', 'SST Output 6%', 'SALES', 6.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '2200'), TRUE),
    ('SR-0', 'Zero-Rated Sales', 'SALES', 0.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '2200'), FALSE),
    ('PR-6', 'SST Input 6% (Non-claimable)', 'PURCHASE', 6.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '6100'), TRUE),
    ('PR-0', 'Zero-Rated Purchase', 'PURCHASE', 0.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '6100'), FALSE);
