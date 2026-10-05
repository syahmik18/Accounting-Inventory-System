const DOCUMENT_NUMBER_SPECS = Object.freeze({
  QUOTATION:       { prefix: 'QT',  table: 'quotation',           column: 'quotation_no' },
  SALES_ORDER:     { prefix: 'SO',  table: 'sales_order',         column: 'order_no' },
  DELIVERY_ORDER:  { prefix: 'DO',  table: 'delivery_order',      column: 'delivery_no' },
  SALES_INVOICE:   { prefix: 'SI',  table: 'sales_invoice',       column: 'invoice_no' },
  DEBIT_NOTE:     { prefix: 'DN',  table: 'debit_note',           column: 'note_no' },
  CREDIT_NOTE:    { prefix: 'CN',  table: 'credit_note',           column: 'note_no' },
  CASH_SALE:      { prefix: 'CS',  table: 'cash_sale',             column: 'cash_sale_no' },
  RECEIPT:        { prefix: 'OR',  table: 'receipt',               column: 'receipt_no' },
  PURCHASE_REQUEST:{ prefix: 'PR', table: 'purchase_request',      column: 'pr_no' },
  PURCHASE_ORDER: { prefix: 'PO',  table: 'purchase_order',        column: 'po_no' },
  GRN:            { prefix: 'GRN', table: 'goods_received_note',   column: 'grn_no' },
  PURCHASE_INVOICE:{ prefix: 'PI', table: 'purchase_invoice',      column: 'invoice_no' },
  CASH_PURCHASE:  { prefix: 'CP',  table: 'cash_purchase',         column: 'cash_purchase_no' },
  PAYMENT:        { prefix: 'PV',  table: 'payment',               column: 'payment_no' },
});

function extractYear(documentDate) {
  const date = String(documentDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Document date must be in YYYY-MM-DD format');
  }
  return Number(date.slice(0, 4));
}

async function nextDocumentNo(client, documentType, documentDate) {
  const spec = DOCUMENT_NUMBER_SPECS[documentType];
  if (!spec) throw new Error(`Unsupported document number type: ${documentType}`);
  const year = extractYear(documentDate);

  await client.query(
    `INSERT INTO document_number_counter (document_type, year, last_seq)
     VALUES ($1,$2,0)
     ON CONFLICT (document_type, year) DO NOTHING`,
    [documentType, year]
  );

  const { rows } = await client.query(
    `SELECT last_seq FROM document_number_counter
      WHERE document_type = $1 AND year = $2
      FOR UPDATE`,
    [documentType, year]
  );
  if (!rows.length) throw new Error(`Document number counter ${documentType}/${year} could not be initialized`);

  let seq = BigInt(rows[0].last_seq) + 1n;
  while (true) {
    const candidate = `${spec.prefix}-${year}-${seq.toString().padStart(6, '0')}`;
    const existing = await client.query(
      `SELECT 1 FROM ${spec.table} WHERE ${spec.column} = $1 LIMIT 1`,
      [candidate]
    );
    if (!existing.rows.length) {
      await client.query(
        `UPDATE document_number_counter SET last_seq = $1
          WHERE document_type = $2 AND year = $3`,
        [seq.toString(), documentType, year]
      );
      return candidate;
    }
    seq += 1n;
  }
}

function suppliedOrAuto(value, autoGenerator) {
  const supplied = String(value || '').trim();
  return supplied || autoGenerator();
}

module.exports = { DOCUMENT_NUMBER_SPECS, nextDocumentNo, suppliedOrAuto };
