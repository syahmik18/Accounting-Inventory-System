-- =====================================================================
-- MIGRATION 013: Customer/Supplier master details + Terms & Conditions
--
-- Two things this adds together:
--
-- 1. Malaysia-relevant business fields on partner - TIN (LHDN Tax
--    Identification Number, needed for MyInvois e-Invoice), BRN (SSM
--    Business Registration Number), and SST registration number, plus
--    address/contact details. All optional - a walk-in customer or a
--    quick cash supplier still doesn't need any of this filled in.
--
-- 2. A default Terms & Conditions text per partner, and a
--    terms_conditions column on each document type it can pre-fill.
--    Unlike account/tax code (migration 012), which the backend
--    resolves and enforces because there's only ever one correct
--    answer, Terms & Conditions is genuinely editable per document - a
--    rush order might need different payment terms than the customer's
--    usual default. So this is a client-side convenience only: the
--    document's own field is what's stored and posted, never
--    server-overridden from the partner record.
-- =====================================================================

-- The original schema already has partner.tax_id ("e.g. LHDN TIN for
-- MyInvois") sitting unused since the very first migration - that's the
-- TIN field, no need for a second one.
ALTER TABLE partner
    ADD COLUMN brn_no          VARCHAR(30),   -- SSM Business Registration Number
    ADD COLUMN sst_no          VARCHAR(30),   -- SST registration number, if registered
    ADD COLUMN address         TEXT,
    ADD COLUMN contact_person  VARCHAR(100),
    ADD COLUMN phone           VARCHAR(30),
    ADD COLUMN email           VARCHAR(150),
    ADD COLUMN default_terms   TEXT;          -- pre-fills new documents, stays editable per document

ALTER TABLE sales_invoice      ADD COLUMN terms_conditions TEXT;
ALTER TABLE cash_sale          ADD COLUMN terms_conditions TEXT;
ALTER TABLE purchase_invoice   ADD COLUMN terms_conditions TEXT;
ALTER TABLE cash_purchase      ADD COLUMN terms_conditions TEXT;
