-- =====================================================================
-- MIGRATION 014: Remove Terms & Conditions, make Credit Terms mandatory
--
-- Reverts migration 013's free-text Terms & Conditions feature - that
-- was a misread of what was actually wanted. What's needed instead:
-- credit_terms_days must never be blank (defaults to 30 if omitted),
-- and Due Date on invoices auto-calculates from it.
-- =====================================================================

-- Backfill any existing NULLs before locking the column down, then make
-- it impossible to ever be null again - "the column is must, cannot
-- leave it blank" - with 30 as the sensible fallback.
UPDATE partner SET credit_terms_days = 30 WHERE credit_terms_days IS NULL;
ALTER TABLE partner ALTER COLUMN credit_terms_days SET NOT NULL;
ALTER TABLE partner ALTER COLUMN credit_terms_days SET DEFAULT 30;

ALTER TABLE partner DROP COLUMN IF EXISTS default_terms;

ALTER TABLE sales_invoice      DROP COLUMN IF EXISTS terms_conditions;
ALTER TABLE cash_sale          DROP COLUMN IF EXISTS terms_conditions;
ALTER TABLE purchase_invoice   DROP COLUMN IF EXISTS terms_conditions;
ALTER TABLE cash_purchase      DROP COLUMN IF EXISTS terms_conditions;
