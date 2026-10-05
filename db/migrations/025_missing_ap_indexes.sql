-- =====================================================================
-- MIGRATION 025: Create the AP indexes that never existed
--
-- WHY THIS IS NEEDED
--
-- In the original db/schema.sql, a block of AR/AP lookup indexes was
-- positioned ABOVE the tables it referenced: it indexed `payment` and
-- `payment_allocation` at ~line 357, but those tables are not created
-- until ~line 489.
--
-- Because schema.sql was normally loaded WITHOUT -v ON_ERROR_STOP=1,
-- psql reported those three statements as errors and simply carried on.
-- The load "succeeded" and nothing downstream complained, so the three
-- indexes have never existed in any database built from that file.
--
-- One of them was additionally wrong even in intent:
--   CREATE INDEX idx_payment_allocation_invoice
--       ON payment_allocation(invoice_id);
-- `payment_allocation` has no `invoice_id` column. Its FK to the bill is
-- `purchase_invoice_id` (the AP side). `invoice_id` belongs to
-- `receipt_allocation` (the AR side). So even in correct file order that
-- statement would have failed. It is corrected below.
--
-- IMPACT / URGENCY
--
-- This is a PERFORMANCE fix only. No posted data is wrong, no balance is
-- affected, and the Trial Balance is unaffected. Payment lookups and
-- allocation joins have simply been doing sequential scans. Safe to run
-- at any time; idempotent via IF NOT EXISTS.
--
-- Fresh installs from the corrected schema.sql already include these and
-- do not need this migration.
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_payment_partner_date
    ON payment(partner_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_payment_allocation_payment
    ON payment_allocation(payment_id);

-- Corrected column: purchase_invoice_id, not invoice_id.
CREATE INDEX IF NOT EXISTS idx_payment_allocation_invoice
    ON payment_allocation(purchase_invoice_id);
