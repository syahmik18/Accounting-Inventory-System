-- Phase 2: Cash Book standalone Payment Voucher (PV) and Official Receipt (OR)
-- These documents are NOT invoice allocations. They post directly to GL.

CREATE TABLE IF NOT EXISTS cash_book_counter (
    document_type VARCHAR(2) NOT NULL,
    year INTEGER NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (document_type, year),
    CHECK (document_type IN ('PV','OR'))
);

CREATE TABLE IF NOT EXISTS payment_voucher (
    pv_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pv_no VARCHAR(30) UNIQUE NOT NULL,
    pv_date DATE NOT NULL,
    payee VARCHAR(150),
    cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
    description TEXT,
    status document_status NOT NULL DEFAULT 'POSTED',
    journal_id UUID REFERENCES journal_entry(journal_id),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_voucher_line (
    pv_line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pv_id UUID NOT NULL REFERENCES payment_voucher(pv_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    description VARCHAR(255),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    line_no INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_voucher_line_no
    ON payment_voucher_line(pv_id, line_no);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_date
    ON payment_voucher(pv_date DESC, pv_no DESC);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_journal
    ON payment_voucher(journal_id);

CREATE TABLE IF NOT EXISTS official_receipt (
    or_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    or_no VARCHAR(30) UNIQUE NOT NULL,
    or_date DATE NOT NULL,
    payer VARCHAR(150),
    cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
    description TEXT,
    status document_status NOT NULL DEFAULT 'POSTED',
    journal_id UUID REFERENCES journal_entry(journal_id),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS official_receipt_line (
    or_line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    or_id UUID NOT NULL REFERENCES official_receipt(or_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    description VARCHAR(255),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    line_no INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_official_receipt_line_no
    ON official_receipt_line(or_id, line_no);
CREATE INDEX IF NOT EXISTS idx_official_receipt_date
    ON official_receipt(or_date DESC, or_no DESC);
CREATE INDEX IF NOT EXISTS idx_official_receipt_journal
    ON official_receipt(journal_id);
