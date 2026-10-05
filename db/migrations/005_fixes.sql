-- =====================================================================
-- MIGRATION: Correctness fixes found in code review
-- 1. trg_check_journal_balanced was BEFORE UPDATE OF is_posted, but every
--    module INSERTs journal_entry with is_posted = TRUE directly - an
--    UPDATE-only trigger never fires on INSERT, so the DB-level balance
--    guard was dead code. The app-layer check in postJournal() was the
--    only thing actually protecting balance.
-- 2. nextJournalNo() counted existing rows (COUNT(*) ... LIKE) to guess
--    the next sequence number. Two concurrent posts can read the same
--    count and both try to insert the same journal_no, which is UNIQUE -
--    one request fails with a raw constraint error instead of a clean
--    business error. Replaced with an atomic per-prefix/year counter.
-- 3. Adds reversal_of_journal_id so postReversal() can link a correction
--    back to the journal it reverses, and so we can prevent reversing
--    the same journal twice.
-- =====================================================================

-- --- Fix 1: trigger must also fire on INSERT, not just UPDATE ---
DROP TRIGGER IF EXISTS trg_check_journal_balanced ON journal_entry;

CREATE TRIGGER trg_check_journal_balanced
    AFTER INSERT OR UPDATE OF is_posted ON journal_entry
    FOR EACH ROW
    WHEN (NEW.is_posted = TRUE)
    EXECUTE FUNCTION fn_check_journal_balanced();

-- Note: this is now AFTER INSERT (not BEFORE), because journal_line rows
-- for a brand-new journal_entry don't exist yet at BEFORE INSERT time -
-- postJournal() inserts the header first, then the lines, all within the
-- same DB transaction, so the AFTER trigger still runs before COMMIT and
-- still rolls back the whole insert (header + lines) if it fails.

-- --- Fix 2: atomic journal number counter ---
CREATE TABLE journal_counter (
    prefix      VARCHAR(10) NOT NULL,
    year        INTEGER NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (prefix, year)
);

-- --- Fix 3: reversal linkage ---
ALTER TABLE journal_entry
    ADD COLUMN reversal_of_journal_id UUID REFERENCES journal_entry(journal_id);

CREATE INDEX idx_journal_entry_reversal_of ON journal_entry(reversal_of_journal_id);
