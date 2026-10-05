-- =====================================================================
-- MIGRATION: Procurement cycle - Purchase Request -> Purchase Order ->
-- Goods Received Note, matched against the existing Purchase Invoice.
--
-- Full supplier-side flow is now:
--   1. Purchase Request  (internal ask - no GL impact, pure approval doc)
--   2. Purchase Order    (commitment to a vendor - no GL impact, same
--                          reason POs are off-balance-sheet in real
--                          accounting until goods/services actually
--                          arrive)
--   3. Goods Received Note (goods/services physically received - THIS
--                          is where the cost is first recognized, before
--                          the supplier's invoice even arrives)
--   4. Purchase Invoice  (already existed) - now optionally matched to a
--                          GRN. This is standard 3-way matching
--                          (PO / GRN / Invoice) used by real ERPs.
--   5. Cash Purchase     (separate migration 007) - bypasses this whole
--                          chain for small over-the-counter buys.
--
-- Why GRN posts to GL and PR/PO don't:
--   A PR/PO is a request or a promise - no economic event has happened
--   yet, so there is nothing to post. A GRN means the business now has
--   the goods/service AND owes the vendor for it, even though the
--   supplier's invoice hasn't been billed yet - that is a real accrual
--   and must hit the ledger. Because the invoice hasn't arrived, we
--   can't credit Accounts Payable yet (we don't have a legal AP
--   liability from a specific bill), so we credit a GR/IR (Goods
--   Received / Invoice Received) clearing account instead:
--
--     GRN:              DR Expense           CR GR/IR Clearing
--     Purchase Invoice
--       (matched to GRN): DR GR/IR Clearing   CR Accounts Payable
--                          DR SST on Purchase  (if tax was on the invoice
--                                               but not the GRN)
--
--   The GR/IR Clearing balance at any point in time tells you "goods
--   we've received but haven't been billed for yet" - a real, useful
--   number that plain AR/AP style posting can't give you.
-- =====================================================================

-- GR/IR clearing account - a liability, since it represents money we
-- owe once the invoice catches up, exactly like AP but not yet tied to
-- a specific supplier bill.
INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control_account)
VALUES ('2150', 'GR/IR Clearing (Goods Received, Not Yet Invoiced)', 'LIABILITY', 'CR', TRUE);

-- ---------------------------------------------------------------------
-- 1. PURCHASE REQUEST - internal ask, no GL posting
-- ---------------------------------------------------------------------
CREATE TYPE pr_status AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED');

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
    description         VARCHAR(255) NOT NULL,
    quantity            NUMERIC(18,4) NOT NULL DEFAULT 1,
    estimated_unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_no             INTEGER NOT NULL
);

CREATE INDEX idx_pr_line_pr ON purchase_request_line(pr_id);

-- ---------------------------------------------------------------------
-- 2. PURCHASE ORDER - commitment to a vendor, no GL posting
-- ---------------------------------------------------------------------
CREATE TYPE po_status AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

CREATE TABLE purchase_order (
    po_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_no           VARCHAR(30) UNIQUE NOT NULL,
    pr_id           UUID REFERENCES purchase_request(pr_id),   -- nullable: PO can be raised directly
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
    description         VARCHAR(255) NOT NULL,
    quantity            NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    line_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
    expense_account_id  UUID NOT NULL REFERENCES chart_of_accounts(account_id),
    quantity_received   NUMERIC(18,4) NOT NULL DEFAULT 0,
    line_no             INTEGER NOT NULL
);

CREATE INDEX idx_po_line_po ON purchase_order_line(po_id);

-- ---------------------------------------------------------------------
-- 3. GOODS RECEIVED NOTE - first point goods/services are recognized
--    in the GL, ahead of the supplier's invoice.
-- ---------------------------------------------------------------------
CREATE TABLE goods_received_note (
    grn_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_no          VARCHAR(30) UNIQUE NOT NULL,
    po_id           UUID NOT NULL REFERENCES purchase_order(po_id),
    partner_id      UUID NOT NULL REFERENCES partner(partner_id),
    received_date   DATE NOT NULL,
    total_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
    is_fully_invoiced BOOLEAN NOT NULL DEFAULT FALSE,   -- flips once a matched Purchase Invoice clears it
    journal_id      UUID REFERENCES journal_entry(journal_id),
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE grn_line (
    line_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id              UUID NOT NULL REFERENCES goods_received_note(grn_id) ON DELETE CASCADE,
    po_line_id          UUID REFERENCES purchase_order_line(line_id),
    item_code           VARCHAR(50),
    description         VARCHAR(255) NOT NULL,
    quantity_received   NUMERIC(18,4) NOT NULL,
    unit_price          NUMERIC(18,4) NOT NULL,
    line_total          NUMERIC(18,2) NOT NULL,
    expense_account_id  UUID NOT NULL REFERENCES chart_of_accounts(account_id)
);

CREATE INDEX idx_grn_line_grn ON grn_line(grn_id);
CREATE INDEX idx_grn_po ON goods_received_note(po_id);

-- ---------------------------------------------------------------------
-- 4. Link Purchase Invoice to the GRN it matches (nullable - an invoice
--    with no PO/GRN behind it, e.g. a utility bill, still posts the old
--    way: straight to Expense).
-- ---------------------------------------------------------------------
ALTER TABLE purchase_invoice
    ADD COLUMN grn_id UUID REFERENCES goods_received_note(grn_id);
