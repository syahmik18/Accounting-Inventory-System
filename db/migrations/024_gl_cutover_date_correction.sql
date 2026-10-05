-- =====================================================================
-- MIGRATION 024: Correct the GL hardening cut-over date
--
-- Migration 023 used the fiscal-period start date for the opening journal
-- so that the journal could post in an open period. The amount, however,
-- represents the live inventory value at migration time. The opening
-- journal therefore must be dated on the actual hardening cut-over date,
-- not at the beginning of the fiscal period.
--
-- This migration only changes the one journal created by 023. Historical
-- transaction journals are never rewritten.
-- =====================================================================

DO $$
DECLARE
    v_cutover_at TIMESTAMPTZ;
    v_cutover_date DATE;
    v_journal_id UUID;
    v_period_id INTEGER;
BEGIN
    SELECT cutover_at, opening_inventory_journal_id
      INTO v_cutover_at, v_journal_id
      FROM gl_hardening_cutover
     WHERE cutover_id = TRUE;

    IF v_cutover_at IS NULL OR v_journal_id IS NULL THEN
        RETURN;
    END IF;

    v_cutover_date := v_cutover_at::DATE;

    SELECT period_id
      INTO v_period_id
      FROM fiscal_period
     WHERE v_cutover_date BETWEEN start_date AND end_date
       AND is_closed = FALSE
     ORDER BY start_date DESC
     LIMIT 1;

    IF v_period_id IS NULL THEN
        RAISE EXCEPTION 'GL hardening cut-over date % is not inside an open fiscal period', v_cutover_date;
    END IF;

    UPDATE journal_entry
       SET journal_date = v_cutover_date,
           period_id = v_period_id
     WHERE journal_id = v_journal_id;

    UPDATE gl_hardening_cutover
       SET cutover_date = v_cutover_date
     WHERE cutover_id = TRUE;
END $$;
