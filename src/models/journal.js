const { v4: uuidv4 } = require('uuid');

/**
 * Generates the next sequential journal number for a given prefix/year.
 *
 * Uses an atomic upsert against journal_counter rather than counting
 * existing rows: COUNT(*) WHERE journal_no LIKE ... lets two concurrent
 * posts read the same count and both try to insert the same journal_no
 * (UNIQUE), so the second one fails with a raw constraint error instead
 * of a clean business error. INSERT ... ON CONFLICT DO UPDATE takes a
 * row lock on the counter row for the duration of the transaction, so
 * concurrent callers serialize here instead of colliding downstream.
 */
async function nextJournalNo(client, prefix = 'JV') {
  const year = new Date().getFullYear();
  const { rows } = await client.query(
    `INSERT INTO journal_counter (prefix, year, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (prefix, year)
     DO UPDATE SET last_seq = journal_counter.last_seq + 1
     RETURNING last_seq`,
    [prefix, year]
  );
  const seq = String(rows[0].last_seq).padStart(6, '0');
  return `${prefix}-${year}-${seq}`;
}

async function getOpenPeriod(client, date) {
  const { rows } = await client.query(
    `SELECT period_id FROM fiscal_period
      WHERE $1 BETWEEN start_date AND end_date AND is_closed = FALSE`,
    [date]
  );
  if (rows.length === 0) {
    throw new Error(`No open fiscal period covers date ${date}`);
  }
  return rows[0].period_id;
}

/**
 * Create and post a balanced journal entry in one atomic operation.
 *
 * @param client   - a pg client already inside a transaction (see db.withTransaction)
 * @param entry    - { journalDate, source, sourceDocId, description, createdBy, allowInactiveAccounts }
 * @param lines    - [{ accountId, debit, credit, description }, ...]
 *
 * Throws if debits != credits. This is the ONLY function in the codebase
 * that should ever write to journal_entry/journal_line - every module
 * (AR, AP, cash sale, bank) calls through here rather than inserting
 * GL rows directly, so there is exactly one place double-entry rules
 * are enforced.
 */
async function postJournal(client, entry, lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('A journal entry needs at least two lines');
  }

  const normalized = lines.map((l, i) => {
    const debit = Number(l.debit || 0);
    const credit = Number(l.credit || 0);
    if (!l.accountId) throw new Error(`Journal line ${i + 1}: account is required`);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) throw new Error(`Journal line ${i + 1}: amount is invalid`);
    if (debit < 0 || credit < 0) throw new Error(`Journal line ${i + 1}: debit/credit cannot be negative`);
    if (debit > 0 && credit > 0) throw new Error(`Journal line ${i + 1}: cannot contain both debit and credit`);
    const dr = Math.round((debit + Number.EPSILON) * 100) / 100;
    const cr = Math.round((credit + Number.EPSILON) * 100) / 100;
    if (dr <= 0 && cr <= 0) throw new Error(`Journal line ${i + 1}: amount must be greater than zero`);
    return { ...l, debit: dr, credit: cr };
  });

  const accountIds = [...new Set(normalized.map(l => l.accountId))];
  const { rows: accountRows } = await client.query(
    `SELECT account_id, is_active FROM chart_of_accounts WHERE account_id = ANY($1::uuid[])`,
    [accountIds]
  );
  const accounts = new Map(accountRows.map(r => [r.account_id, r]));
  for (const id of accountIds) {
    if (!accounts.has(id)) throw new Error(`Journal account ${id} not found`);
    // Reversals must remain possible even after an account is deactivated.
    // Historical postings are immutable; deactivation only prevents new
    // business postings, it must never block the audit-trail reversal.
    if (!entry.allowInactiveAccounts && !accounts.get(id).is_active) {
      throw new Error(`Journal account ${id} is inactive`);
    }
  }

  const totalDebitCents = normalized.reduce((sum, l) => sum + Math.round(l.debit * 100), 0);
  const totalCreditCents = normalized.reduce((sum, l) => sum + Math.round(l.credit * 100), 0);
  if (totalDebitCents <= 0 || totalCreditCents <= 0) throw new Error('Journal must contain both debit and credit amounts');
  if (totalDebitCents !== totalCreditCents) {
    throw new Error(`Journal does not balance: DR ${(totalDebitCents / 100).toFixed(2)} vs CR ${(totalCreditCents / 100).toFixed(2)}`);
  }

  const periodId = await getOpenPeriod(client, entry.journalDate);
  const journalNo = await nextJournalNo(client, entry.prefix || 'JV');
  const journalId = uuidv4();

  await client.query(
    `INSERT INTO journal_entry
       (journal_id, journal_no, journal_date, period_id, source,
        source_doc_id, description, is_posted, created_by, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, TRUE, $8, now())`,
    [journalId, journalNo, entry.journalDate, periodId, entry.source,
      entry.sourceDocId || null, entry.description || null, entry.createdBy || 'system']
  );

  let lineNo = 1;
  for (const line of normalized) {
    await client.query(
      `INSERT INTO journal_line
         (line_id, journal_id, account_id, debit, credit, description, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), journalId, line.accountId, line.debit, line.credit, line.description || null, lineNo++]
    );
  }

  return { journalId, journalNo };
}

/**
 * Reverse a posted journal by posting a new, opposite journal - never by
 * editing or deleting the original. This is the only sanctioned way to
 * undo a posting mistake: posted journals stay insert-only forever, so
 * the audit trail always shows both the original error and the fix.
 *
 * @param client        - a pg client already inside a transaction
 * @param journalId     - the journal_id being reversed
 * @param opts          - { reversalDate, createdBy, reason }
 *
 * Throws if the journal doesn't exist, or has already been reversed
 * (checked via journal_entry.reversal_of_journal_id - one reversal per
 * original, same as SQL Accounting only lets you reverse a document once).
 */
async function postReversal(client, journalId, { reversalDate, createdBy, reason } = {}) {
  const { rows: origRows } = await client.query(
    `SELECT journal_id, journal_no, journal_date, source, source_doc_id, description
       FROM journal_entry WHERE journal_id = $1`,
    [journalId]
  );
  if (origRows.length === 0) throw new Error(`Journal ${journalId} not found`);
  const original = origRows[0];

  const { rows: alreadyReversed } = await client.query(
    `SELECT journal_id FROM journal_entry WHERE reversal_of_journal_id = $1`,
    [journalId]
  );
  if (alreadyReversed.length > 0) {
    throw new Error(`Journal ${original.journal_no} has already been reversed`);
  }

  const { rows: origLines } = await client.query(
    `SELECT account_id, debit, credit, description FROM journal_line
      WHERE journal_id = $1 ORDER BY line_no`,
    [journalId]
  );
  if (origLines.length === 0) throw new Error(`Journal ${original.journal_no} has no lines to reverse`);

  // Flip every debit/credit - a mechanical mirror image, not a new
  // business judgment call, which is exactly why this can be a generic
  // helper instead of something each module reimplements.
  const reversalLines = origLines.map((l) => ({
    accountId: l.account_id,
    debit: Number(l.credit || 0),
    credit: Number(l.debit || 0),
    description: l.description,
  }));

  const { journalId: reversalJournalId, journalNo: reversalJournalNo } = await postJournal(
    client,
    {
      journalDate: reversalDate || new Date().toISOString().slice(0, 10),
      source: 'ADJUSTMENT',
      sourceDocId: original.source_doc_id,
      description: reason
        ? `Reversal of ${original.journal_no}: ${reason}`
        : `Reversal of ${original.journal_no}`,
      createdBy,
      prefix: 'RV',
      allowInactiveAccounts: true,
    },
    reversalLines
  );

  await client.query(
    `UPDATE journal_entry SET reversal_of_journal_id = $1 WHERE journal_id = $2`,
    [journalId, reversalJournalId]
  );

  return { reversalJournalId, reversalJournalNo, originalJournalNo: original.journal_no };
}

/** Trial balance as of a given date: sum of debits/credits per account. */
async function getTrialBalance(client, asOfDate) {
  const { rows } = await client.query(
    `WITH account_totals AS (
       SELECT jl.account_id,
              SUM(jl.debit)  AS total_debit,
              SUM(jl.credit) AS total_credit
         FROM journal_line jl
         JOIN journal_entry je ON je.journal_id=jl.journal_id
        WHERE je.is_posted=TRUE
          AND je.journal_date <= $1
        GROUP BY jl.account_id
     ), report_rows AS (
       SELECT coa.account_code, coa.account_name, coa.account_type,
              COALESCE(at.total_debit,0)::numeric(18,2) AS total_debit,
              COALESCE(at.total_credit,0)::numeric(18,2) AS total_credit
         FROM chart_of_accounts coa
         LEFT JOIN account_totals at ON at.account_id=coa.account_id
     )
     SELECT *,
            SUM(total_debit) OVER()::numeric(18,2) AS report_total_debit,
            SUM(total_credit) OVER()::numeric(18,2) AS report_total_credit
       FROM report_rows
      ORDER BY account_code`,
    [asOfDate]
  );
  const totalDebit = rows.length ? Number(rows[0].report_total_debit) : 0;
  const totalCredit = rows.length ? Number(rows[0].report_total_credit) : 0;
  return {
    rows: rows.map(({ report_total_debit, report_total_credit, ...row }) => row),
    totalDebit,
    totalCredit,
    isBalanced: Math.round(totalDebit * 100) === Math.round(totalCredit * 100),
  };
}

module.exports = { postJournal, postReversal, getTrialBalance, getOpenPeriod, nextJournalNo };
