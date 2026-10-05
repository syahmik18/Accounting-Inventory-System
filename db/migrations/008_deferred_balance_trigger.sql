-- =====================================================================
-- MIGRATION: Fix trg_check_journal_balanced - it still wasn't checking
-- anything real after migration 005.
--
-- Run against your EXISTING database - only replaces one trigger,
-- nothing else is touched.
--
-- WHAT WAS WRONG
-- Migration 005 changed the trigger to AFTER INSERT OR UPDATE OF
-- is_posted, to fix the original bug where an UPDATE-only trigger never
-- fired on INSERT at all. That part was right. But it's still a PLAIN
-- (non-deferred) AFTER trigger, and postJournal() inserts the
-- journal_entry header - already is_posted = TRUE - BEFORE inserting any
-- journal_line rows (they're added afterward in a loop of separate
-- statements). A plain AFTER trigger fires the instant that header INSERT
-- completes, which is before any of those lines exist. The check queries
-- journal_line WHERE journal_id = NEW.journal_id, finds zero rows, sees
-- SUM=0 on both sides, and passes - regardless of what gets inserted
-- next. Confirmed by testing: an unbalanced entry (DR 100 / CR 50)
-- inserted in postJournal()'s exact order committed successfully with no
-- error raised.
--
-- THE FIX
-- Make it a DEFERRABLE CONSTRAINT TRIGGER, INITIALLY DEFERRED. This
-- changes *when* Postgres runs the trigger: instead of immediately after
-- each row-level INSERT, it queues and fires right before COMMIT - by
-- which point every journal_line for that transaction has actually been
-- inserted, so the balance check means something. A failing check still
-- rolls back the whole transaction (header + lines together), exactly
-- like before - only the timing changed.
--
-- This needed no change to postJournal() or any application code -
-- purely a trigger definition fix.
-- =====================================================================

DROP TRIGGER IF EXISTS trg_check_journal_balanced ON journal_entry;

CREATE CONSTRAINT TRIGGER trg_check_journal_balanced
    AFTER INSERT OR UPDATE OF is_posted ON journal_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.is_posted = TRUE)
    EXECUTE FUNCTION fn_check_journal_balanced();
