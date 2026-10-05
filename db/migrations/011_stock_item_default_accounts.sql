-- =====================================================================
-- MIGRATION 011: Default GL accounts on the stock item master.
--
-- Until now, every line on every document (Purchase Invoice, Cash
-- Purchase, Sales Invoice, Cash Sale, Purchase Order...) required the
-- user to manually pick an Expense or Revenue account, every single
-- time, even for the same item bought/sold repeatedly. That's exactly
-- the kind of repetitive data entry real accounting software eliminates
-- by letting the item master remember its own default account - SQL
-- Accounting does the same thing on its Item Maintenance screen.
--
-- Both are nullable and both stay fully overridable per line: picking a
-- stock item just pre-fills the account dropdown, it never locks it.
-- =====================================================================

ALTER TABLE stock_item
    ADD COLUMN default_expense_account_id UUID REFERENCES chart_of_accounts(account_id),
    ADD COLUMN default_revenue_account_id UUID REFERENCES chart_of_accounts(account_id);
