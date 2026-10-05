-- =====================================================================
-- SAMPLE ACCOUNTING SOFTWARE - PostgreSQL Schema
-- Double-entry core, modeled loosely on SQL Accounting's structure
-- (Chart of Accounts -> GL -> Sub-modules like AR/AP posting into GL)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1. CHART OF ACCOUNTS
-- ---------------------------------------------------------------------
CREATE TYPE account_type AS ENUM (
    'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'
);

CREATE TABLE chart_of_accounts (
    account_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_code    VARCHAR(20) UNIQUE NOT NULL,   -- e.g. '1000', '1000-01'
    account_name    VARCHAR(150) NOT NULL,
    account_type    account_type NOT NULL,
    parent_id       UUID REFERENCES chart_of_accounts(account_id),
    is_control_account BOOLEAN NOT NULL DEFAULT FALSE, -- e.g. AR/AP control accounts
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    normal_balance  CHAR(2) NOT NULL CHECK (normal_balance IN ('DR', 'CR')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_coa_type ON chart_of_accounts(account_type);
CREATE INDEX idx_coa_parent ON chart_of_accounts(parent_id);

-- ---------------------------------------------------------------------
-- 2. FISCAL PERIODS (prevents posting into closed periods)
-- ---------------------------------------------------------------------
CREATE TABLE fiscal_period (
    period_id       SERIAL PRIMARY KEY,
    period_name     VARCHAR(20) NOT NULL,   -- e.g. '2026-08'
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    is_closed       BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(period_name)
);

-- ---------------------------------------------------------------------
-- 3. JOURNAL / GENERAL LEDGER (the heart of double-entry)
-- ---------------------------------------------------------------------
CREATE TYPE journal_source AS ENUM (
    'GL', 'AR', 'AP', 'CASH_SALE', 'BANK', 'ADJUSTMENT'
);

CREATE TABLE journal_entry (
    journal_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_no      VARCHAR(30) UNIQUE NOT NULL,   -- e.g. 'JV-2026-000123'
    journal_date    DATE NOT NULL,
    period_id       INTEGER NOT NULL REFERENCES fiscal_period(period_id),
    source          journal_source NOT NULL DEFAULT 'GL',
    source_doc_id   UUID,               -- links back to invoice_id / payment_id etc.
    description     TEXT,
    is_posted       BOOLEAN NOT NULL DEFAULT FALSE,
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at       TIMESTAMPTZ,
    reversal_of_journal_id UUID REFERENCES journal_entry(journal_id)
);

CREATE TABLE journal_line (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_id      UUID NOT NULL REFERENCES journal_entry(journal_id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    debit           NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    description     VARCHAR(255),
    line_no         INTEGER NOT NULL,
    CHECK (NOT (debit > 0 AND credit > 0))  -- a line is either debit or credit, not both
);

CREATE INDEX idx_journal_line_journal ON journal_line(journal_id);
CREATE INDEX idx_journal_line_account ON journal_line(account_id);
CREATE INDEX idx_journal_entry_period ON journal_entry(period_id);
CREATE INDEX idx_journal_entry_reversal_of ON journal_entry(reversal_of_journal_id);
CREATE INDEX idx_journal_entry_posted_date ON journal_entry(is_posted, journal_date);
CREATE INDEX idx_journal_entry_source_doc ON journal_entry(source, source_doc_id);

-- Atomic per-prefix/year counter for journal numbering. An upsert-with-
-- increment is safe under concurrent posting (the UPDATE branch takes a
-- row lock), unlike counting existing rows and guessing the next one.
CREATE TABLE journal_counter (
    prefix      VARCHAR(10) NOT NULL,
    year        INTEGER NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (prefix, year)
);

-- Atomic per-document-type/year counter. Users may still enter a custom
-- document number; the backend uses this counter only when the field is blank.
CREATE TABLE document_number_counter (
    document_type VARCHAR(40) NOT NULL,
    year          INTEGER NOT NULL,
    last_seq      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (document_type, year)
);

-- ---------------------------------------------------------------------
-- 4. BUSINESS PARTNERS (customers / vendors)
-- ---------------------------------------------------------------------
CREATE TABLE partner (
    partner_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_code    VARCHAR(20) UNIQUE NOT NULL,
    partner_name    VARCHAR(150) NOT NULL,
    partner_type    VARCHAR(10) NOT NULL CHECK (partner_type IN ('CUSTOMER','VENDOR','BOTH')),
    tax_id          VARCHAR(50),          -- LHDN Tax Identification Number (TIN) for MyInvois
    brn_no          VARCHAR(30),          -- SSM Business Registration Number
    sst_no          VARCHAR(30),          -- SST registration number, if registered
    address         TEXT,
    contact_person  VARCHAR(100),
    phone           VARCHAR(30),
    email           VARCHAR(150),
    credit_terms_days INTEGER NOT NULL DEFAULT 30,  -- never blank; defaults to 30 if not set
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_partner_name ON partner(partner_name);
CREATE INDEX idx_partner_type_active ON partner(partner_type, is_active);

-- ---------------------------------------------------------------------
-- TAX CODES (SQL Accounting-style Tax Maintenance)
-- Each code has its own rate AND its own GL account, scoped to a
-- direction since output tax (liability owed) and input tax
-- (non-claimable cost, see SST_PURCHASE note near account 6100) are
-- fundamentally different postings and must never share one account.
-- ---------------------------------------------------------------------
CREATE TYPE tax_direction AS ENUM ('SALES', 'PURCHASE');

CREATE TABLE tax_code (
    tax_code_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(20) UNIQUE NOT NULL,
    description     VARCHAR(150) NOT NULL,
    direction       tax_direction NOT NULL,
    rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_account_id  UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tax_code_direction ON tax_code(direction, is_active);
CREATE UNIQUE INDEX uq_tax_code_default_per_direction ON tax_code(direction) WHERE is_default;

-- ---------------------------------------------------------------------
-- 9. INVENTORY / STOCK
-- Stock quantity and monetary valuation are maintained together.
-- Inventory uses moving-average costing; stock movements store exact cost/value
-- so inventory/COGS journals and reversals can remain audit-safe.
-- ---------------------------------------------------------------------
CREATE TABLE stock_item (
    stock_item_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_code           VARCHAR(50) UNIQUE NOT NULL,
    item_name           VARCHAR(150) NOT NULL,
    unit                VARCHAR(20) NOT NULL DEFAULT 'UNIT',
    ref_cost            NUMERIC(18,4) NOT NULL DEFAULT 0,
    ref_price            NUMERIC(18,4) NOT NULL DEFAULT 0,
    current_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
    barcode              VARCHAR(100),
    serial_number        VARCHAR(100),
    min_qty             NUMERIC(18,4) NOT NULL DEFAULT 0,
    default_expense_account_id UUID REFERENCES chart_of_accounts(account_id),
    default_revenue_account_id UUID REFERENCES chart_of_accounts(account_id),
    default_inventory_account_id UUID REFERENCES chart_of_accounts(account_id),
    default_cogs_account_id UUID REFERENCES chart_of_accounts(account_id),
    inventory_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
    average_cost        NUMERIC(18,6) NOT NULL DEFAULT 0,
    costing_method      VARCHAR(10) NOT NULL DEFAULT 'AVERAGE' CHECK (costing_method IN ('FIXED','AVERAGE','FIFO')),
    default_sales_tax_code_id UUID REFERENCES tax_code(tax_code_id),
    default_purchase_tax_code_id UUID REFERENCES tax_code(tax_code_id),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_item_active ON stock_item(is_active);
CREATE INDEX idx_stock_item_active_code ON stock_item(item_code) WHERE is_active = TRUE;

-- Fast server-side stock master search. Trigram indexes support ILIKE '%term%'
-- across code/name/barcode without forcing the browser to scan every row.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_stock_item_code_trgm ON stock_item USING gin (item_code gin_trgm_ops);
CREATE INDEX idx_stock_item_name_trgm ON stock_item USING gin (item_name gin_trgm_ops);
CREATE INDEX idx_stock_item_barcode_trgm ON stock_item USING gin (barcode gin_trgm_ops);

CREATE TABLE stock_movement (
    movement_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_item_id       UUID NOT NULL REFERENCES stock_item(stock_item_id),
    movement_date       DATE NOT NULL,
    movement_type       VARCHAR(30) NOT NULL CHECK (movement_type IN ('PURCHASE_INVOICE','CASH_PURCHASE','GRN','SALES_INVOICE','CASH_SALE','CREDIT_NOTE','ADJUSTMENT','REVERSAL')),
    source_doc_id       UUID,
    source_doc_no       VARCHAR(50),
    quantity_in         NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_in >= 0),
    quantity_out        NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_out >= 0),
    balance_after       NUMERIC(18,4) NOT NULL,
    note                VARCHAR(255),
    unit_cost            NUMERIC(18,6),
    value_in             NUMERIC(18,2) NOT NULL DEFAULT 0,
    value_out            NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT (quantity_in > 0 AND quantity_out > 0)),
    CHECK (quantity_in > 0 OR quantity_out > 0)
);

CREATE INDEX idx_stock_movement_item_date_desc ON stock_movement(stock_item_id, movement_date DESC, created_at DESC);
CREATE INDEX idx_stock_movement_source ON stock_movement(movement_type, source_doc_id);

-- FIFO cost layers ("batches") - see migration 028 for the full explanation.
CREATE TABLE stock_lot (
    lot_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_item_id   UUID NOT NULL REFERENCES stock_item(stock_item_id),
    source_doc_id   UUID,
    source_doc_no   VARCHAR(50),
    received_date   DATE NOT NULL,
    unit_cost       NUMERIC(18,6) NOT NULL CHECK (unit_cost >= 0),
    qty_received    NUMERIC(18,4) NOT NULL CHECK (qty_received > 0),
    qty_remaining   NUMERIC(18,4) NOT NULL CHECK (qty_remaining >= 0),
    is_active_layer BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_lot_fifo_order ON stock_lot(stock_item_id, received_date, created_at) WHERE is_active_layer = TRUE AND qty_remaining > 0;
CREATE INDEX idx_stock_lot_source ON stock_lot(source_doc_id);

CREATE TABLE stock_lot_consumption (
    consumption_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_id               UUID NOT NULL REFERENCES stock_lot(lot_id),
    stock_item_id        UUID NOT NULL REFERENCES stock_item(stock_item_id),
    consumed_by_doc_id    UUID,
    consumed_by_doc_no    VARCHAR(50),
    quantity              NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
    unit_cost             NUMERIC(18,6) NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_lot_consumption_lot ON stock_lot_consumption(lot_id);
CREATE INDEX idx_stock_lot_consumption_doc ON stock_lot_consumption(consumed_by_doc_id);

-- ---------------------------------------------------------------------
-- 5. AR: SALES INVOICES
-- ---------------------------------------------------------------------
CREATE TYPE invoice_status AS ENUM ('DRAFT','POSTED','PARTIALLY_PAID','PAID','CREDITED','VOID');

CREATE TABLE sales_invoice (
    invoice_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_no      VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    invoice_date    DATE NOT NULL,
    due_date        DATE NOT NULL,
    status          invoice_status NOT NULL DEFAULT 'DRAFT',
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,   -- SST
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
    credited_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    debited_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
    myinvois_uuid   VARCHAR(100),        -- LHDN e-Invoice reference once submitted
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_invoice_line (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES sales_invoice(invoice_id) ON DELETE CASCADE,
    item_code       VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description     VARCHAR(255) NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,     -- e.g. 6.00 for 6% SST
    line_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    tax_code_id     UUID REFERENCES tax_code(tax_code_id));

-- ---------------------------------------------------------------------
-- 6. RECEIPTS (payments received against invoices)
-- ---------------------------------------------------------------------
CREATE TYPE document_status AS ENUM ('POSTED','VOID');

CREATE TABLE receipt (
    receipt_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_no      VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    receipt_date    DATE NOT NULL,
    status          document_status NOT NULL DEFAULT 'POSTED',
    bank_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    amount          NUMERIC(18,2) NOT NULL,
    payment_method  VARCHAR(30),          -- CASH / BANK_TRANSFER / CHEQUE / CARD
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE receipt_allocation (
    allocation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id      UUID NOT NULL REFERENCES receipt(receipt_id) ON DELETE CASCADE,
    invoice_id      UUID NOT NULL REFERENCES sales_invoice(invoice_id),
    amount_applied  NUMERIC(18,2) NOT NULL
);

-- ---------------------------------------------------------------------
-- 6. CASH SALE (walk-in / point-of-sale — paid at time of sale, no AR)
-- ---------------------------------------------------------------------
CREATE TABLE cash_sale (
    cash_sale_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_sale_no    VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID REFERENCES partner(partner_id),  -- nullable: walk-in customer
    sale_date       DATE NOT NULL,
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'CASH',
    cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    status          document_status NOT NULL DEFAULT 'POSTED',
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cash_sale_line (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_sale_id    UUID NOT NULL REFERENCES cash_sale(cash_sale_id) ON DELETE CASCADE,
    item_code       VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description     VARCHAR(255) NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    tax_code_id     UUID REFERENCES tax_code(tax_code_id));

CREATE INDEX idx_cash_sale_line_sale ON cash_sale_line(cash_sale_id);

-- ---------------------------------------------------------------------
-- 8. PURCHASE INVOICE (Accounts Payable — supplier bill)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_invoice (
    purchase_invoice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_no      VARCHAR(30) UNIQUE NOT NULL,       -- the SUPPLIER's own invoice number
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    invoice_date    DATE NOT NULL,
    due_date        DATE NOT NULL,
    status          invoice_status NOT NULL DEFAULT 'DRAFT',
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_invoice_line (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_invoice_id UUID NOT NULL REFERENCES purchase_invoice(purchase_invoice_id) ON DELETE CASCADE,
    item_code       VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description     VARCHAR(255) NOT NULL,
    quantity        NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(18,2) NOT NULL DEFAULT 0,
    expense_account_id UUID REFERENCES chart_of_accounts(account_id),
    tax_code_id     UUID REFERENCES tax_code(tax_code_id));

CREATE INDEX idx_purchase_invoice_line_pi ON purchase_invoice_line(purchase_invoice_id);

-- ---------------------------------------------------------------------
-- 9a. PROCUREMENT CYCLE: Purchase Request -> Purchase Order -> Goods
--     Received Note, matched against Purchase Invoice above.
--
--     PR and PO carry no GL impact - they're a request and a commitment,
--     not yet an economic event. GRN is where the inventory / receipt
--     accrual is first recognized (goods physically received, before the
--     supplier's invoice even arrives), posted against a GR/IR clearing
--     account rather than straight to AP, since there's no actual bill
--     yet to owe against:
--
--       GRN:                DR Inventory / Expense CR GR/IR Clearing
--       Purchase Invoice
--         (matched to GRN):  DR GR/IR Clearing     CR Accounts Payable
--                            DR SST on Purchase     (if the invoice adds tax)
--
--     An invoice with no PO/GRN behind it (e.g. a utility bill) keeps
--     posting the old way: straight DR Expense / CR AP.
-- ---------------------------------------------------------------------
CREATE TYPE pr_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED');

-- NOTE: the AR/AP performance indexes that used to sit here have been
-- moved to the end of this file. They reference payment/payment_allocation,
-- which are not created until later, so loading this file with
-- ON_ERROR_STOP=1 aborted here.

CREATE TABLE purchase_request (
    pr_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pr_no           VARCHAR(30) UNIQUE NOT NULL,
    requested_by    VARCHAR(100) NOT NULL,
    request_date    DATE NOT NULL,
    status          pr_status NOT NULL DEFAULT 'DRAFT',
    notes           TEXT,
    approved_by     VARCHAR(100),
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_request_line (
    line_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pr_id               UUID NOT NULL REFERENCES purchase_request(pr_id) ON DELETE CASCADE,
    item_code           VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description         VARCHAR(255) NOT NULL,
    quantity            NUMERIC(18,4) NOT NULL DEFAULT 1,
    estimated_unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_no             INTEGER NOT NULL);

CREATE INDEX idx_pr_line_pr ON purchase_request_line(pr_id);

CREATE TYPE po_status AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

CREATE TABLE purchase_order (
    po_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_no           VARCHAR(30) UNIQUE NOT NULL,
    pr_id           UUID REFERENCES purchase_request(pr_id),
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    order_date      DATE NOT NULL,
    expected_date   DATE,
    status          po_status NOT NULL DEFAULT 'DRAFT',
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_line (
    line_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id               UUID NOT NULL REFERENCES purchase_order(po_id) ON DELETE CASCADE,
    item_code           VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description         VARCHAR(255) NOT NULL,
    quantity            NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
    expense_account_id  UUID REFERENCES chart_of_accounts(account_id),
    quantity_received   NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_no             INTEGER NOT NULL);

CREATE INDEX idx_po_line_po ON purchase_order_line(po_id);

CREATE TABLE goods_received_note (
    grn_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_no          VARCHAR(30) UNIQUE NOT NULL,
    po_id           UUID NOT NULL REFERENCES purchase_order(po_id),
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    received_date   DATE NOT NULL,
    status          document_status NOT NULL DEFAULT 'POSTED',
    total_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
    is_fully_invoiced BOOLEAN NOT NULL DEFAULT FALSE,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE grn_line (
    line_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id              UUID NOT NULL REFERENCES goods_received_note(grn_id) ON DELETE CASCADE,
    po_line_id          UUID REFERENCES purchase_order_line(line_id),
    item_code           VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description         VARCHAR(255) NOT NULL,
    quantity_received   NUMERIC(18,4) NOT NULL,
    unit_price          NUMERIC(18,4) NOT NULL,
    line_total          NUMERIC(18,2) NOT NULL,
    expense_account_id  UUID REFERENCES chart_of_accounts(account_id));

CREATE INDEX idx_grn_line_grn ON grn_line(grn_id);
CREATE INDEX idx_grn_po ON goods_received_note(po_id);

ALTER TABLE purchase_invoice
    ADD COLUMN grn_id UUID REFERENCES goods_received_note(grn_id);

-- ---------------------------------------------------------------------
-- 9b. CASH PURCHASE — step 5 of the procurement cycle, the "no PO, no
--     GRN, just paid it" path for petty cash / over-the-counter buys.
--     Direct mirror of cash_sale, sides flipped:
--       DR Expense (+ SST on Purchases if any)   CR Cash/Bank
-- ---------------------------------------------------------------------
CREATE TABLE cash_purchase (
    cash_purchase_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_purchase_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID REFERENCES partner(partner_id),
    purchase_date   DATE NOT NULL,
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'CASH',
    cash_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    status          document_status NOT NULL DEFAULT 'POSTED',
    subtotal        NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cash_purchase_line (
    line_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_purchase_id    UUID NOT NULL REFERENCES cash_purchase(cash_purchase_id) ON DELETE CASCADE,
    item_code           VARCHAR(50),
    stock_item_id       UUID REFERENCES stock_item(stock_item_id),
    description         VARCHAR(255) NOT NULL,
    quantity            NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
    expense_account_id  UUID REFERENCES chart_of_accounts(account_id),
    tax_code_id         UUID REFERENCES tax_code(tax_code_id));

CREATE INDEX idx_cash_purchase_line_cp ON cash_purchase_line(cash_purchase_id);

-- ---------------------------------------------------------------------
-- 10. PAYMENT (to supplier) — mirrors receipt/receipt_allocation for AP
-- ---------------------------------------------------------------------
CREATE TABLE payment (
    payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_no      VARCHAR(30) UNIQUE NOT NULL,
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    payment_date    DATE NOT NULL,
    status          document_status NOT NULL DEFAULT 'POSTED',
    bank_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    amount          NUMERIC(18,2) NOT NULL,
    payment_method  VARCHAR(30),
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocation (
    allocation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID NOT NULL REFERENCES payment(payment_id) ON DELETE CASCADE,
    purchase_invoice_id UUID NOT NULL REFERENCES purchase_invoice(purchase_invoice_id),
    amount_applied  NUMERIC(18,2) NOT NULL
);

-- ---------------------------------------------------------------------
-- 11. INTEGRITY GUARD: a posted journal must always balance.
--    Enforced at application layer (transaction) AND as a defense-in-depth
--    trigger here, since accounting correctness must never depend on the
--    app layer alone.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_check_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
    total_dr NUMERIC(18,2);
    total_cr NUMERIC(18,2);
BEGIN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
      INTO total_dr, total_cr
      FROM journal_line
     WHERE journal_id = NEW.journal_id;

    IF NEW.is_posted AND total_dr <> total_cr THEN
        RAISE EXCEPTION 'Journal % is not balanced: DR % <> CR %',
            NEW.journal_no, total_dr, total_cr;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER INSERT OR UPDATE, not just BEFORE UPDATE: every module inserts
-- journal_entry with is_posted = TRUE directly (see postJournal()), and
-- an UPDATE-only trigger never fires on INSERT - the original version
-- of this trigger was dead code for every real posting path.
--
-- IMPORTANT: this must be a DEFERRABLE CONSTRAINT TRIGGER, not a plain
-- AFTER trigger. postJournal() inserts the journal_entry header (with
-- is_posted = TRUE already set) FIRST, then inserts each journal_line
-- row afterward in a loop of separate statements. A plain AFTER trigger
-- fires immediately once that first INSERT completes - at that instant
-- zero journal_line rows exist yet for the new journal_id, so the check
-- always sees 0 = 0 and silently passes, no matter what lines get added
-- next. Confirmed by testing: an unbalanced entry (DR 100 / CR 50)
-- inserted in this exact order committed with no error under a plain
-- AFTER trigger.
--
-- DEFERRABLE INITIALLY DEFERRED changes *when* the trigger fires: instead
-- of immediately after the row-level INSERT, it queues and runs right
-- before COMMIT - by which point every journal_line for the transaction
-- has already been inserted, so the balance check is checking something
-- real. A failing check still rolls back the whole transaction (header +
-- lines), same as before - only the timing changed, not the semantics.
CREATE CONSTRAINT TRIGGER trg_check_journal_balanced
    AFTER INSERT OR UPDATE OF is_posted ON journal_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.is_posted = TRUE)
    EXECUTE FUNCTION fn_check_journal_balanced();

-- ---------------------------------------------------------------------
-- 8. SEED: minimal chart of accounts to get started
-- ---------------------------------------------------------------------
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control_account) VALUES
('1000', 'Cash in Hand',              'ASSET',     'DR', FALSE),
('1200', 'Inventory',                'ASSET',     'DR', FALSE),
('1010', 'Bank - Maybank Current',    'ASSET',     'DR', FALSE),
('1100', 'Accounts Receivable',       'ASSET',     'DR', TRUE),
('2100', 'Accounts Payable',          'LIABILITY', 'CR', TRUE),
('2150', 'GR/IR Clearing (Goods Received, Not Yet Invoiced)', 'LIABILITY', 'CR', TRUE),
('2200', 'SST Output Tax Payable',    'LIABILITY', 'CR', FALSE),
('3000', 'Owner''s Equity',           'EQUITY',    'CR', FALSE),
('3050', 'Opening Balance Equity',    'EQUITY',    'CR', FALSE),
('4000', 'Sales Revenue',             'REVENUE',   'CR', FALSE),
('5000', 'Cost of Goods Sold',        'EXPENSE',   'DR', FALSE),
('6000', 'General Expenses',          'EXPENSE',   'DR', FALSE),
('6100', 'SST on Purchases (Non-Claimable)', 'EXPENSE', 'DR', FALSE);

INSERT INTO fiscal_period (period_name, start_date, end_date) VALUES
('2026-08', '2026-08-01', '2026-08-31'),
('2026-09', '2026-09-01', '2026-09-30');

INSERT INTO tax_code (code, description, direction, rate, tax_account_id, is_default)
VALUES
    ('SR-6', 'SST Output 6%', 'SALES', 6.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '2200'), TRUE),
    ('SR-0', 'Zero-Rated Sales', 'SALES', 0.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '2200'), FALSE),
    ('PR-6', 'SST Input 6% (Non-claimable)', 'PURCHASE', 6.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '6100'), TRUE),
    ('PR-0', 'Zero-Rated Purchase', 'PURCHASE', 0.00,
        (SELECT account_id FROM chart_of_accounts WHERE account_code = '6100'), FALSE);


-- =====================================================================
-- SALES DOCUMENT FLOW + PARTNER SEARCH (same as migration 016)
-- =====================================================================

-- Sales document flow + scalable partner search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE stock_movement DROP CONSTRAINT IF EXISTS stock_movement_movement_type_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_movement_type_check
  CHECK (movement_type IN ('PURCHASE_INVOICE','CASH_PURCHASE','GRN','DELIVERY_ORDER','SALES_INVOICE','CASH_SALE','CREDIT_NOTE','ADJUSTMENT','REVERSAL'));

CREATE TYPE quotation_status AS ENUM ('OPEN','CONVERTED','EXPIRED','CANCELLED');
CREATE TYPE sales_order_status AS ENUM ('OPEN','PARTIALLY_DELIVERED','DELIVERED','CLOSED','CANCELLED');
CREATE TYPE delivery_order_status AS ENUM ('POSTED','CANCELLED');
CREATE TYPE sales_note_status AS ENUM ('POSTED','VOID');

CREATE TABLE quotation (
    quotation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    quotation_date DATE NOT NULL,
    valid_until DATE,
    status quotation_status NOT NULL DEFAULT 'OPEN',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE quotation_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id UUID NOT NULL REFERENCES quotation(quotation_id) ON DELETE CASCADE,
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_code_id UUID REFERENCES tax_code(tax_code_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_quotation_partner_date ON quotation(partner_id, quotation_date DESC);
CREATE INDEX idx_quotation_line_quotation ON quotation_line(quotation_id);
CREATE INDEX idx_quotation_line_stock_item ON quotation_line(stock_item_id);

CREATE TABLE sales_order (
    sales_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_no VARCHAR(30) UNIQUE NOT NULL,
    quotation_id UUID REFERENCES quotation(quotation_id),
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    order_date DATE NOT NULL,
    expected_date DATE,
    status sales_order_status NOT NULL DEFAULT 'OPEN',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sales_order_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_order_id UUID NOT NULL REFERENCES sales_order(sales_order_id) ON DELETE CASCADE,
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    quantity_delivered NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_code_id UUID REFERENCES tax_code(tax_code_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_sales_order_partner_date ON sales_order(partner_id, order_date DESC);
CREATE INDEX idx_sales_order_status ON sales_order(status);
CREATE INDEX idx_sales_order_line_order ON sales_order_line(sales_order_id);
CREATE INDEX idx_sales_order_line_stock_item ON sales_order_line(stock_item_id);

CREATE TABLE delivery_order (
    delivery_order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_no VARCHAR(30) UNIQUE NOT NULL,
    sales_order_id UUID NOT NULL REFERENCES sales_order(sales_order_id),
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    delivery_date DATE NOT NULL,
    status delivery_order_status NOT NULL DEFAULT 'POSTED',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    is_fully_invoiced BOOLEAN NOT NULL DEFAULT FALSE,
    journal_id UUID REFERENCES journal_entry(journal_id),
    notes TEXT,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE delivery_order_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_order_id UUID NOT NULL REFERENCES delivery_order(delivery_order_id) ON DELETE CASCADE,
    sales_order_line_id UUID REFERENCES sales_order_line(line_id),
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_code_id UUID REFERENCES tax_code(tax_code_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_delivery_order_partner_date ON delivery_order(partner_id, delivery_date DESC);
CREATE INDEX idx_delivery_order_so ON delivery_order(sales_order_id);
CREATE INDEX idx_delivery_order_line_do ON delivery_order_line(delivery_order_id);
CREATE INDEX idx_delivery_order_line_stock_item ON delivery_order_line(stock_item_id);
CREATE INDEX idx_delivery_order_invoicing ON delivery_order(is_fully_invoiced, delivery_date DESC);

ALTER TABLE sales_invoice ADD COLUMN IF NOT EXISTS delivery_order_id UUID REFERENCES delivery_order(delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_delivery_order ON sales_invoice(delivery_order_id);

CREATE TABLE debit_note (
    debit_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    original_invoice_id UUID REFERENCES sales_invoice(invoice_id),
    note_date DATE NOT NULL,
    status sales_note_status NOT NULL DEFAULT 'POSTED',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    return_goods BOOLEAN NOT NULL DEFAULT FALSE,
    journal_id UUID REFERENCES journal_entry(journal_id),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE debit_note_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    debit_note_id UUID NOT NULL REFERENCES debit_note(debit_note_id) ON DELETE CASCADE,
    sales_invoice_line_id UUID REFERENCES sales_invoice_line(line_id),
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_code_id UUID REFERENCES tax_code(tax_code_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_debit_note_partner_date ON debit_note(partner_id, note_date DESC);
CREATE INDEX idx_debit_note_line_note ON debit_note_line(debit_note_id);
CREATE INDEX idx_debit_note_line_stock_item ON debit_note_line(stock_item_id);

CREATE TABLE credit_note (
    credit_note_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_no VARCHAR(30) UNIQUE NOT NULL,
    partner_id UUID NOT NULL REFERENCES partner(partner_id),
    original_invoice_id UUID REFERENCES sales_invoice(invoice_id),
    note_date DATE NOT NULL,
    status sales_note_status NOT NULL DEFAULT 'POSTED',
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    return_goods BOOLEAN NOT NULL DEFAULT FALSE,
    journal_id UUID REFERENCES journal_entry(journal_id),
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE credit_note_line (
    line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_id UUID NOT NULL REFERENCES credit_note(credit_note_id) ON DELETE CASCADE,
    sales_invoice_line_id UUID REFERENCES sales_invoice_line(line_id),
    item_code VARCHAR(50),
    stock_item_id UUID REFERENCES stock_item(stock_item_id),
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    revenue_account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_code_id UUID REFERENCES tax_code(tax_code_id),
    line_no INTEGER NOT NULL
);
CREATE INDEX idx_credit_note_partner_date ON credit_note(partner_id, note_date DESC);
CREATE INDEX idx_credit_note_line_note ON credit_note_line(credit_note_id);
CREATE INDEX idx_credit_note_line_stock_item ON credit_note_line(stock_item_id);

CREATE INDEX IF NOT EXISTS idx_partner_code_trgm ON partner USING gin (partner_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_name_trgm ON partner USING gin (partner_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_tax_id_trgm ON partner USING gin (tax_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_brn_no_trgm ON partner USING gin (brn_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_phone_trgm ON partner USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_partner_email_trgm ON partner USING gin (email gin_trgm_ops);


-- =====================================================================
-- CASH BOOK (migration 020) — standalone Payment Voucher / Official
-- Receipt. These are NOT invoice allocations; they post directly to GL.
-- =====================================================================
CREATE TABLE cash_book_counter (
    document_type VARCHAR(2) NOT NULL,
    year INTEGER NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (document_type, year),
    CHECK (document_type IN ('PV','OR'))
);

CREATE TABLE payment_voucher (
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

CREATE TABLE payment_voucher_line (
    pv_line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pv_id UUID NOT NULL REFERENCES payment_voucher(pv_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    description VARCHAR(255),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    line_no INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_payment_voucher_line_no ON payment_voucher_line(pv_id, line_no);
CREATE INDEX idx_payment_voucher_date ON payment_voucher(pv_date DESC, pv_no DESC);
CREATE INDEX idx_payment_voucher_journal ON payment_voucher(journal_id);

CREATE TABLE official_receipt (
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

CREATE TABLE official_receipt_line (
    or_line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    or_id UUID NOT NULL REFERENCES official_receipt(or_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    description VARCHAR(255),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    line_no INTEGER NOT NULL
);

CREATE UNIQUE INDEX uq_official_receipt_line_no ON official_receipt_line(or_id, line_no);
CREATE INDEX idx_official_receipt_date ON official_receipt(or_date DESC, or_no DESC);
CREATE INDEX idx_official_receipt_journal ON official_receipt(journal_id);

-- =====================================================================
-- GL / INVENTORY HARDENING INDEXES (migrations 021, 022, 023)
-- The stock_item / stock_movement / delivery_order COLUMNS these support
-- are already declared inline in their table definitions above; only the
-- supporting indexes needed folding in here.
-- =====================================================================
CREATE INDEX idx_stock_item_inventory_account ON stock_item(default_inventory_account_id);
CREATE INDEX idx_stock_item_cogs_account ON stock_item(default_cogs_account_id);
CREATE INDEX idx_stock_movement_item_date_cost ON stock_movement(stock_item_id, movement_date, created_at);
CREATE INDEX idx_delivery_order_journal ON delivery_order(journal_id);

-- Trial Balance aggregation paths (021 + 023)
CREATE INDEX idx_journal_entry_posted_date_id ON journal_entry (is_posted, journal_date, journal_id);
CREATE INDEX idx_journal_line_journal_account_amounts ON journal_line (journal_id, account_id) INCLUDE (debit, credit);
CREATE INDEX idx_journal_entry_posted_date_partial ON journal_entry (journal_date, journal_id) WHERE is_posted = TRUE;
CREATE INDEX idx_journal_line_account_journal_amounts ON journal_line (account_id, journal_id) INCLUDE (debit, credit);

-- =====================================================================
-- GL HARDENING CUT-OVER MARKER (migration 023)
-- Structure only. The one-time opening Inventory journal that migration
-- 023 creates is deliberately NOT reproduced here: a fresh database has
-- no legacy stock to reconcile, so there is no difference to post. The
-- DO-block cut-over logic in 023/024 exists purely to bring an EXISTING
-- database onto the v27+ inventory model.
-- =====================================================================
CREATE TABLE gl_hardening_cutover (
    cutover_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (cutover_id = TRUE),
    cutover_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cutover_date DATE NOT NULL,
    opening_inventory_journal_id UUID REFERENCES journal_entry(journal_id)
);

-- A fresh database has no legacy data, so every document it will ever
-- contain is post-hardening. Seed the cut-over marker at install time so
-- the integrity checker applies its STRICT post-cut-over rules from day
-- one. Without this row, integrity.js's post-cut-over GRN inventory check
-- (guarded by "$1::timestamptz IS NOT NULL") silently matches nothing.
-- opening_inventory_journal_id stays NULL: there is no legacy stock
-- valuation to reconcile against the GL on a new database.
INSERT INTO gl_hardening_cutover (cutover_id, cutover_date)
VALUES (TRUE, CURRENT_DATE)
ON CONFLICT (cutover_id) DO NOTHING;

-- =====================================================================
-- AR / AP LOOKUP INDEXES
-- Relocated here from earlier in the file: they reference payment and
-- payment_allocation, which are declared further down, so in their old
-- position this file could not be loaded with ON_ERROR_STOP=1.
-- =====================================================================
CREATE INDEX idx_sales_invoice_partner_date ON sales_invoice(partner_id, invoice_date DESC);
CREATE INDEX idx_sales_invoice_line_stock_item ON sales_invoice_line(stock_item_id);
CREATE INDEX idx_receipt_partner_date ON receipt(partner_id, receipt_date DESC);
CREATE INDEX idx_receipt_allocation_invoice ON receipt_allocation(invoice_id);
CREATE INDEX idx_receipt_allocation_receipt ON receipt_allocation(receipt_id);
CREATE INDEX idx_cash_sale_partner_date ON cash_sale(partner_id, sale_date DESC);
CREATE INDEX idx_cash_sale_line_stock_item ON cash_sale_line(stock_item_id);
CREATE INDEX idx_purchase_invoice_partner_date ON purchase_invoice(partner_id, invoice_date DESC);
CREATE INDEX idx_purchase_invoice_line_stock_item ON purchase_invoice_line(stock_item_id);
CREATE INDEX idx_payment_partner_date ON payment(partner_id, payment_date DESC);
-- payment_allocation's FK column is purchase_invoice_id (the AP side),
-- not invoice_id (which is the AR/receipt_allocation side). The original
-- statement named a column that has never existed on this table.
CREATE INDEX idx_payment_allocation_invoice ON payment_allocation(purchase_invoice_id);
CREATE INDEX idx_payment_allocation_payment ON payment_allocation(payment_id);


-- Stock lines use the item master's Inventory / COGS accounts. Expense account
-- is only required for free-text non-stock lines; keep the database flexible for
-- historical stock lines that still carry the old expense account value.
ALTER TABLE purchase_order_line
  ADD CONSTRAINT ck_po_line_account_source CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL);
ALTER TABLE grn_line
  ADD CONSTRAINT ck_grn_line_account_source CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL);
ALTER TABLE purchase_invoice_line
  ADD CONSTRAINT ck_pi_line_account_source CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL);
ALTER TABLE cash_purchase_line
  ADD CONSTRAINT ck_cp_line_account_source CHECK (stock_item_id IS NOT NULL OR expense_account_id IS NOT NULL);

CREATE OR REPLACE VIEW account_reporting_role AS
WITH bank_refs AS (
  SELECT bank_account_id AS account_id FROM receipt
  UNION
  SELECT bank_account_id FROM payment
), cash_refs AS (
  SELECT cash_account_id AS account_id FROM cash_sale
  UNION
  SELECT cash_account_id FROM cash_purchase
  UNION
  SELECT cash_account_id FROM payment_voucher
  UNION
  SELECT cash_account_id FROM official_receipt
), inventory_refs AS (
  SELECT default_inventory_account_id AS account_id
    FROM stock_item
   WHERE default_inventory_account_id IS NOT NULL
), cogs_refs AS (
  SELECT default_cogs_account_id AS account_id
    FROM stock_item
   WHERE default_cogs_account_id IS NOT NULL
), base AS (
  SELECT c.account_id, c.account_code, c.account_name,
         c.account_type::text AS account_type, c.normal_balance, c.parent_id,
         c.is_control_account, c.is_active,
         EXISTS (SELECT 1 FROM bank_refs b WHERE b.account_id = c.account_id)
           OR (c.account_type='ASSET' AND lower(c.account_name) ~ '(bank|current account|checking|cheque|savings)') AS is_bank_account,
         EXISTS (SELECT 1 FROM cash_refs b WHERE b.account_id = c.account_id)
           OR (c.account_type='ASSET' AND lower(c.account_name) ~ '(cash|petty)') AS is_cash_account_name,
         EXISTS (SELECT 1 FROM inventory_refs i WHERE i.account_id = c.account_id)
           OR (c.account_type='ASSET' AND lower(c.account_name) ~ '(inventory|stock)') AS is_inventory_account,
         (c.account_type='ASSET' AND lower(c.account_name) ~ '(receivable|debtor|trade debt|customer balance|accounts? receivable)') AS is_receivable_account,
         (c.account_type='LIABILITY' AND lower(c.account_name) ~ '(payable|creditor|trade credit|accounts? payable)') AS is_payable_account,
         (c.account_type='LIABILITY' AND lower(c.account_name) ~ '(gr.?/?ir|goods received)') AS is_grir_account,
         (c.account_type='EXPENSE' AND (EXISTS (SELECT 1 FROM cogs_refs r WHERE r.account_id = c.account_id)
              OR lower(c.account_name) ~ '(cost of goods|cost of sales|(^|[^a-z])cogs([^a-z]|$))')) AS is_cogs_account,
         (c.account_type='ASSET' AND lower(c.account_name) ~ '(fixed asset|property|plant|equipment|vehicle|motor|machin|building|land|furniture|computer|intangible|long[- ]?term|non[- ]?current)') AS is_noncurrent_asset_name,
         (c.account_type='LIABILITY' AND lower(c.account_name) ~ '(long[- ]?term|term loan|hire purchase|lease liability|deferred tax|non[- ]?current)') AS is_noncurrent_liability_name
    FROM chart_of_accounts c
)
SELECT b.account_id, b.account_code, b.account_name, b.account_type, b.normal_balance, b.parent_id,
       b.is_control_account, b.is_active,
       (b.is_bank_account OR b.is_cash_account_name) AS is_cash_account,
       b.is_inventory_account, b.is_receivable_account, b.is_payable_account, b.is_grir_account, b.is_cogs_account,
       (b.account_type='ASSET' AND NOT b.is_noncurrent_asset_name) AS is_current_asset,
       (b.account_type='LIABILITY' AND NOT b.is_noncurrent_liability_name) AS is_current_liability,
       CASE
         WHEN b.is_bank_account THEN 'BANK'
         WHEN b.is_cash_account_name THEN 'CASH'
         WHEN b.is_inventory_account THEN 'INVENTORY'
         WHEN b.is_receivable_account THEN 'RECEIVABLE'
         WHEN b.is_payable_account THEN 'PAYABLE'
         WHEN b.is_grir_account THEN 'GRIR'
         WHEN b.is_cogs_account THEN 'COGS'
         WHEN b.account_type='REVENUE' THEN 'REVENUE'
         WHEN b.account_type='EXPENSE' THEN 'EXPENSE'
         WHEN b.account_type='EQUITY' THEN 'EQUITY'
         WHEN b.account_type='LIABILITY' THEN 'LIABILITY'
         WHEN b.account_type='ASSET' THEN 'ASSET'
         ELSE b.account_type
       END AS reporting_role
  FROM base b;
