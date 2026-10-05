-- =====================================================================
-- MIGRATION 027: Automatic document numbering for sales / purchase docs
--
-- Users may still type their own document number. When blank, the backend
-- atomically generates PREFIX-YYYY-000001 style numbering.
-- Cash Book PV / OR keeps its existing dedicated cash_book_counter because
-- those are separate cash-book document series.
-- =====================================================================

CREATE TABLE IF NOT EXISTS document_number_counter (
    document_type VARCHAR(40) NOT NULL,
    year          INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
    last_seq      BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    PRIMARY KEY (document_type, year)
);

-- Seed the counters from existing numbers that already follow the standard
-- PREFIX-YYYY-NNN... pattern. Custom numbers are preserved and never edited.
INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'QUOTATION', split_part(quotation_no, '-', 2)::INTEGER, MAX(split_part(quotation_no, '-', 3)::BIGINT)
FROM quotation
WHERE quotation_no ~ '^QT-[0-9]{4}-[0-9]+$'
GROUP BY split_part(quotation_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'SALES_ORDER', split_part(order_no, '-', 2)::INTEGER, MAX(split_part(order_no, '-', 3)::BIGINT)
FROM sales_order
WHERE order_no ~ '^SO-[0-9]{4}-[0-9]+$'
GROUP BY split_part(order_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'DELIVERY_ORDER', split_part(delivery_no, '-', 2)::INTEGER, MAX(split_part(delivery_no, '-', 3)::BIGINT)
FROM delivery_order
WHERE delivery_no ~ '^DO-[0-9]{4}-[0-9]+$'
GROUP BY split_part(delivery_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'SALES_INVOICE', split_part(invoice_no, '-', 2)::INTEGER, MAX(split_part(invoice_no, '-', 3)::BIGINT)
FROM sales_invoice
WHERE invoice_no ~ '^SI-[0-9]{4}-[0-9]+$'
GROUP BY split_part(invoice_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'DEBIT_NOTE', split_part(note_no, '-', 2)::INTEGER, MAX(split_part(note_no, '-', 3)::BIGINT)
FROM debit_note
WHERE note_no ~ '^DN-[0-9]{4}-[0-9]+$'
GROUP BY split_part(note_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'CREDIT_NOTE', split_part(note_no, '-', 2)::INTEGER, MAX(split_part(note_no, '-', 3)::BIGINT)
FROM credit_note
WHERE note_no ~ '^CN-[0-9]{4}-[0-9]+$'
GROUP BY split_part(note_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'CASH_SALE', split_part(cash_sale_no, '-', 2)::INTEGER, MAX(split_part(cash_sale_no, '-', 3)::BIGINT)
FROM cash_sale
WHERE cash_sale_no ~ '^CS-[0-9]{4}-[0-9]+$'
GROUP BY split_part(cash_sale_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'RECEIPT', split_part(receipt_no, '-', 2)::INTEGER, MAX(split_part(receipt_no, '-', 3)::BIGINT)
FROM receipt
WHERE receipt_no ~ '^OR-[0-9]{4}-[0-9]+$'
GROUP BY split_part(receipt_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'PURCHASE_REQUEST', split_part(pr_no, '-', 2)::INTEGER, MAX(split_part(pr_no, '-', 3)::BIGINT)
FROM purchase_request
WHERE pr_no ~ '^PR-[0-9]{4}-[0-9]+$'
GROUP BY split_part(pr_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'PURCHASE_ORDER', split_part(po_no, '-', 2)::INTEGER, MAX(split_part(po_no, '-', 3)::BIGINT)
FROM purchase_order
WHERE po_no ~ '^PO-[0-9]{4}-[0-9]+$'
GROUP BY split_part(po_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'GRN', split_part(grn_no, '-', 2)::INTEGER, MAX(split_part(grn_no, '-', 3)::BIGINT)
FROM goods_received_note
WHERE grn_no ~ '^GRN-[0-9]{4}-[0-9]+$'
GROUP BY split_part(grn_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'PURCHASE_INVOICE', split_part(invoice_no, '-', 2)::INTEGER, MAX(split_part(invoice_no, '-', 3)::BIGINT)
FROM purchase_invoice
WHERE invoice_no ~ '^PI-[0-9]{4}-[0-9]+$'
GROUP BY split_part(invoice_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'CASH_PURCHASE', split_part(cash_purchase_no, '-', 2)::INTEGER, MAX(split_part(cash_purchase_no, '-', 3)::BIGINT)
FROM cash_purchase
WHERE cash_purchase_no ~ '^CP-[0-9]{4}-[0-9]+$'
GROUP BY split_part(cash_purchase_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

INSERT INTO document_number_counter (document_type, year, last_seq)
SELECT 'PAYMENT', split_part(payment_no, '-', 2)::INTEGER, MAX(split_part(payment_no, '-', 3)::BIGINT)
FROM payment
WHERE payment_no ~ '^PV-[0-9]{4}-[0-9]+$'
GROUP BY split_part(payment_no, '-', 2)::INTEGER
ON CONFLICT (document_type, year) DO UPDATE
SET last_seq = GREATEST(document_number_counter.last_seq, EXCLUDED.last_seq);

CREATE INDEX IF NOT EXISTS idx_document_number_counter_year_type
    ON document_number_counter(year, document_type);
