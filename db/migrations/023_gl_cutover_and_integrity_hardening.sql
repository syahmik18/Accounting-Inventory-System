-- =====================================================================
-- MIGRATION 023: GL / Inventory cut-over + integrity hardening
--
-- Purpose:
--   1. Establish a one-time Inventory opening/cut-over balance in the GL
--      so the stock valuation already carried by stock_item has a matching
--      Inventory Asset balance. This does NOT rewrite historical journals.
--   2. Record the cut-over timestamp so legacy documents created before the
--      hardening release are audited as legacy findings rather than being
--      mistaken for newly-created posting failures.
--   3. Add indexes specifically for the Trial Balance aggregation path.
--
-- The opening entry is:
--      DR Inventory Asset accounts   /   CR Opening Balance Equity
--   or the exact opposite if the pre-existing GL balance is higher than the
--   carried inventory valuation. The amount posted is only the difference.
--
-- This migration is idempotent: once the singleton cut-over marker exists,
-- running the migration again creates no second opening journal.
-- =====================================================================

CREATE TABLE IF NOT EXISTS gl_hardening_cutover (
    cutover_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (cutover_id = TRUE),
    cutover_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cutover_date DATE NOT NULL,
    opening_inventory_journal_id UUID REFERENCES journal_entry(journal_id)
);

CREATE INDEX IF NOT EXISTS idx_journal_entry_posted_date_partial
    ON journal_entry (journal_date, journal_id)
    WHERE is_posted = TRUE;

CREATE INDEX IF NOT EXISTS idx_journal_line_account_journal_amounts
    ON journal_line (account_id, journal_id)
    INCLUDE (debit, credit);

DO $$
DECLARE
    v_cutover_date DATE;
    v_period_id INTEGER;
    v_equity_account UUID;
    v_journal_id UUID;
    v_journal_no VARCHAR(30);
    v_seq INTEGER;
    v_year INTEGER;
    v_net_delta NUMERIC(18,2);
    r RECORD;
BEGIN
    IF EXISTS (SELECT 1 FROM gl_hardening_cutover WHERE cutover_id = TRUE) THEN
        RETURN;
    END IF;

    -- Prefer today when today is inside an open period. If not, use the
    -- start date of the latest open fiscal period so the opening journal can
    -- still post successfully without forcing the user to reopen a period.
    SELECT period_id, start_date INTO v_period_id, v_cutover_date
      FROM fiscal_period
     WHERE CURRENT_DATE BETWEEN start_date AND end_date
       AND is_closed = FALSE
     ORDER BY start_date DESC
     LIMIT 1;

    IF v_period_id IS NULL THEN
        SELECT period_id, start_date INTO v_period_id, v_cutover_date
          FROM fiscal_period
         WHERE is_closed = FALSE
         ORDER BY start_date DESC
         LIMIT 1;
    END IF;

    IF v_period_id IS NULL THEN
        RAISE EXCEPTION 'GL hardening requires at least one open fiscal period';
    END IF;

    SELECT account_id INTO v_equity_account
      FROM chart_of_accounts
     WHERE account_code = '3050';

    IF v_equity_account IS NULL THEN
        RAISE EXCEPTION 'Opening Balance Equity account 3050 not found';
    END IF;

    CREATE TEMP TABLE tmp_inventory_gl_delta (
        account_id UUID PRIMARY KEY,
        delta NUMERIC(18,2) NOT NULL
    ) ON COMMIT DROP;

    -- Carrying value comes from the stock valuation ledger. Existing GL
    -- balance is measured as of the same cut-over date.
    INSERT INTO tmp_inventory_gl_delta (account_id, delta)
    WITH stock_values AS (
        SELECT default_inventory_account_id AS account_id,
               ROUND(SUM(inventory_value), 2) AS target_value
          FROM stock_item
         WHERE default_inventory_account_id IS NOT NULL
         GROUP BY default_inventory_account_id
    ),
    gl_values AS (
        SELECT jl.account_id,
               ROUND(SUM(jl.debit - jl.credit), 2) AS gl_value
          FROM journal_line jl
          JOIN journal_entry je ON je.journal_id = jl.journal_id
         WHERE je.is_posted = TRUE
           AND je.journal_date <= v_cutover_date
         GROUP BY jl.account_id
    )
    SELECT s.account_id,
           ROUND(COALESCE(s.target_value,0) - COALESCE(g.gl_value,0), 2) AS delta
      FROM stock_values s
      LEFT JOIN gl_values g ON g.account_id = s.account_id
     WHERE ABS(ROUND(COALESCE(s.target_value,0) - COALESCE(g.gl_value,0), 2)) > 0.01;

    SELECT ROUND(COALESCE(SUM(delta),0),2) INTO v_net_delta
      FROM tmp_inventory_gl_delta;

    SELECT last_seq INTO v_seq
      FROM journal_counter
     WHERE prefix = 'OB' AND year = EXTRACT(YEAR FROM v_cutover_date)::INTEGER
     FOR UPDATE;

    IF v_seq IS NULL THEN
        INSERT INTO journal_counter (prefix, year, last_seq)
        VALUES ('OB', EXTRACT(YEAR FROM v_cutover_date)::INTEGER, 1)
        RETURNING last_seq INTO v_seq;
    ELSE
        UPDATE journal_counter
           SET last_seq = last_seq + 1
         WHERE prefix = 'OB' AND year = EXTRACT(YEAR FROM v_cutover_date)::INTEGER
        RETURNING last_seq INTO v_seq;
    END IF;

    v_year := EXTRACT(YEAR FROM v_cutover_date)::INTEGER;
    v_journal_no := 'OB-' || v_year::TEXT || '-' || LPAD(v_seq::TEXT, 6, '0');
    v_journal_id := gen_random_uuid();

    IF EXISTS (SELECT 1 FROM tmp_inventory_gl_delta) THEN
        INSERT INTO journal_entry
            (journal_id, journal_no, journal_date, period_id, source,
             source_doc_id, description, is_posted, created_by, posted_at)
        VALUES
            (v_journal_id, v_journal_no, v_cutover_date, v_period_id, 'ADJUSTMENT',
             NULL, 'Inventory opening / GL hardening cut-over', TRUE, 'system', now());

        FOR r IN SELECT account_id, delta FROM tmp_inventory_gl_delta ORDER BY account_id LOOP
            IF r.delta > 0 THEN
                INSERT INTO journal_line
                    (line_id, journal_id, account_id, debit, credit, description, line_no)
                VALUES
                    (gen_random_uuid(), v_journal_id, r.account_id, r.delta, 0,
                     'Inventory cut-over balance', 1 + (SELECT COUNT(*) FROM journal_line WHERE journal_id = v_journal_id));
            ELSE
                INSERT INTO journal_line
                    (line_id, journal_id, account_id, debit, credit, description, line_no)
                VALUES
                    (gen_random_uuid(), v_journal_id, r.account_id, 0, ABS(r.delta),
                     'Inventory cut-over balance', 1 + (SELECT COUNT(*) FROM journal_line WHERE journal_id = v_journal_id));
            END IF;
        END LOOP;

        IF v_net_delta > 0 THEN
            INSERT INTO journal_line
                (line_id, journal_id, account_id, debit, credit, description, line_no)
            VALUES
                (gen_random_uuid(), v_journal_id, v_equity_account, 0, v_net_delta,
                 'Inventory cut-over offset', 1 + (SELECT COUNT(*) FROM journal_line WHERE journal_id = v_journal_id));
        ELSIF v_net_delta < 0 THEN
            INSERT INTO journal_line
                (line_id, journal_id, account_id, debit, credit, description, line_no)
            VALUES
                (gen_random_uuid(), v_journal_id, v_equity_account, ABS(v_net_delta), 0,
                 'Inventory cut-over offset', 1 + (SELECT COUNT(*) FROM journal_line WHERE journal_id = v_journal_id));
        END IF;

        INSERT INTO gl_hardening_cutover (cutover_id, cutover_at, cutover_date, opening_inventory_journal_id)
        VALUES (TRUE, now(), v_cutover_date, v_journal_id);
    ELSE
        INSERT INTO gl_hardening_cutover (cutover_id, cutover_at, cutover_date, opening_inventory_journal_id)
        VALUES (TRUE, now(), v_cutover_date, NULL);
    END IF;
END $$;

COMMENT ON TABLE gl_hardening_cutover IS
  'Singleton marker for the GL/inventory accounting hardening cut-over and its one-time opening inventory journal.';
