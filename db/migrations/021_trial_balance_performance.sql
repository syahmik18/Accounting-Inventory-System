-- Phase 2 stabilization: faster Trial Balance dashboard queries.
-- Safe to run after 020_cash_book_pv_or.sql.

CREATE INDEX IF NOT EXISTS idx_journal_entry_posted_date_id
    ON journal_entry (is_posted, journal_date, journal_id);

CREATE INDEX IF NOT EXISTS idx_journal_line_journal_account_amounts
    ON journal_line (journal_id, account_id)
    INCLUDE (debit, credit);
