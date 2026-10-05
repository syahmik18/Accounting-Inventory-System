SELECT split_part(journal_no,'-',1) AS prefix, split_part(journal_no,'-',2)::int AS year,
       MAX(split_part(journal_no,'-',3)::int) AS highest_seq
  FROM journal_entry
 WHERE journal_no ~ '^[A-Z]+-[0-9]{4}-[0-9]+$'
 GROUP BY 1,2 ORDER BY 1,2;

INSERT INTO journal_counter (prefix, year, last_seq)
SELECT
  split_part(journal_no, '-', 1),
  split_part(journal_no, '-', 2)::int,
  MAX(split_part(journal_no, '-', 3)::int)
FROM journal_entry
WHERE journal_no ~ '^[A-Z]+-[0-9]{4}-[0-9]+$'
GROUP BY split_part(journal_no, '-', 1), split_part(journal_no, '-', 2)::int
ON CONFLICT (prefix, year) DO UPDATE SET last_seq = GREATEST(journal_counter.last_seq, EXCLUDED.last_seq);

SELECT * FROM journal_counter ORDER BY prefix, year;
