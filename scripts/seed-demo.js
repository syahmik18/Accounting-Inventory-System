#!/usr/bin/env node
/**
 * Optional demo data for trying out the v39 Liquid Glass UI.
 *
 *   npm start                      # in one terminal
 *   npm run seed:demo -- --yes     # in another
 *
 * Everything is created through the real REST API, so every document goes
 * through the normal posting rules (double-entry, stock movements, GR/IR ...).
 * The only direct database writes are the fiscal periods it needs for the
 * back-dated months.
 *
 * Safety: refuses to run when the database already has sales invoices, unless
 * you pass --force. Never run this against real books.
 */
const { pool } = require('../src/db');

const BASE = process.env.API_BASE || 'http://localhost:3000/api';
const args = new Set(process.argv.slice(2));

if (!args.has('--yes')) {
  console.log('This will add DEMO customers, suppliers, items and documents to the connected database.');
  console.log('Re-run with --yes to continue (add --force if the database already contains invoices).');
  process.exit(0);
}

const p2 = (x) => String(x).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const monthsAgo = (m, day) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - m); d.setDate(day); return d; };
const dateIn = (m, day) => {
  const now = new Date();
  const d = monthsAgo(m, m === 0 ? Math.min(day, now.getDate()) : day);
  return d > now ? ymd(now) : ymd(d); // never post into the future
};

let seed = 20260920;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => Math.round(a + rnd() * (b - a));

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data && data.error}`);
  return data;
}

async function main() {
  const existing = await pool.query('SELECT COUNT(*)::int AS c FROM sales_invoice');
  if (existing.rows[0].c > 0 && !args.has('--force')) {
    console.log('The database already has sales invoices. Refusing to seed (use --force to override).');
    process.exit(1);
  }

  // Fiscal periods for the last 8 months + this month
  for (let i = 8; i >= 0; i--) {
    const s = monthsAgo(i, 1);
    const start = ymd(s);
    const end = ymd(new Date(s.getFullYear(), s.getMonth() + 1, 0));
    await pool.query(
      `INSERT INTO fiscal_period (period_name, start_date, end_date) VALUES ($1,$2,$3) ON CONFLICT (period_name) DO NOTHING`,
      [start.slice(0, 7), start, end]);
  }

  const accounts = await call('GET', '/accounts');
  const acc = (code) => accounts.find((a) => a.account_code === code);
  const extra = [['6200', 'Rent Expense'], ['6300', 'Utilities'], ['6400', 'Marketing & Advertising'], ['6500', 'Transportation'], ['6900', 'Miscellaneous Expense']];
  for (const [code, name] of extra) {
    if (!acc(code)) await call('POST', '/accounts', { accountCode: code, accountName: name, accountType: 'EXPENSE' });
  }
  if (!acc('4100')) await call('POST', '/accounts', { accountCode: '4100', accountName: 'Service Revenue', accountType: 'REVENUE' });
  const A = Object.fromEntries((await call('GET', '/accounts')).map((a) => [a.account_code, a.account_id]));
  const taxes = await call('GET', '/tax-codes');
  const SR6 = taxes.find((t) => t.code === 'SR-6').tax_code_id;
  const PR6 = taxes.find((t) => t.code === 'PR-6').tax_code_id;
  const PR0 = taxes.find((t) => t.code === 'PR-0').tax_code_id;

  // Partners
  const customers = [];
  const custNames = ['Aurora Trading Sdn Bhd', 'Bintang Retail Sdn Bhd', 'Cahaya Digital Enterprise', 'Delima Furnishings Sdn Bhd', 'Evergreen Cafe Group', 'Fajar Logistics Sdn Bhd', 'Gemilang Clinic', 'Harmoni Learning Centre'];
  for (let i = 0; i < custNames.length; i++) {
    customers.push(await call('POST', '/partners', {
      partnerCode: `CUST${String(i + 1).padStart(3, '0')}`, partnerName: custNames[i], partnerType: 'CUSTOMER',
      creditTermsDays: pick([14, 30, 30, 45]), phone: `01${between(1, 9)}-${between(2000000, 9999999)}`,
      email: `accounts@${custNames[i].split(' ')[0].toLowerCase()}.com.my`, brnNo: `20${between(1500, 2400)}01${between(10000, 99999)}`,
      taxId: `C${between(10000000, 99999999)}`, address: `${between(1, 88)}, Jalan Perindustrian ${between(1, 12)}, 84000 Muar, Johor`, contactPerson: pick(['Aisyah', 'Farid', 'Mei Ling', 'Kumar', 'Nur Izzati']),
    }));
  }
  const suppliers = [];
  const supNames = ['Nusantara Wholesale Sdn Bhd', 'Prima Components Sdn Bhd', 'Sinar Packaging Enterprise', 'TechSource Distribution', 'Utama Office Supplies'];
  for (let i = 0; i < supNames.length; i++) {
    suppliers.push(await call('POST', '/partners', {
      partnerCode: `SUPP${String(i + 1).padStart(3, '0')}`, partnerName: supNames[i], partnerType: 'VENDOR', creditTermsDays: pick([30, 30, 45, 60]),
      phone: `03-${between(2000, 9999)} ${between(1000, 9999)}`, email: `sales@${supNames[i].split(' ')[0].toLowerCase()}.com.my`,
    }));
  }

  // Stock items
  const itemDefs = [
    ['LAP-14', 'Business Laptop 14"', 'UNIT', 2150, 2899, 12], ['MON-24', 'Monitor 24" IPS', 'UNIT', 410, 589, 20],
    ['KBD-WL', 'Wireless Keyboard', 'UNIT', 62, 109, 40], ['MSE-WL', 'Wireless Mouse', 'UNIT', 28, 49, 40],
    ['DOC-DK', 'USB-C Docking Station', 'UNIT', 188, 289, 15], ['PRN-LS', 'Laser Printer', 'UNIT', 520, 749, 8],
    ['TNR-BK', 'Toner Cartridge Black', 'UNIT', 96, 155, 30], ['PPR-A4', 'A4 Paper (500 sheets)', 'REAM', 9.2, 15.5, 200],
    ['CAB-HD', 'HDMI Cable 2m', 'PC', 7.5, 18, 80], ['SSD-1T', 'SSD 1TB NVMe', 'UNIT', 205, 329, 25],
  ];
  const items = [];
  for (const [code, name, unit, cost, price, qty] of itemDefs) {
    const it = await call('POST', '/stock-items', {
      itemCode: code, itemName: name, unit, refCost: cost, refPrice: price, openingQty: qty * 3,
      barcode: `9555${between(100000000, 999999999)}`,
      defaultRevenueAccountId: A['4000'], defaultExpenseAccountId: A['6000'],
      defaultInventoryAccountId: A['1200'], defaultCogsAccountId: A['5000'],
      defaultSalesTaxCodeId: SR6, defaultPurchaseTaxCodeId: PR0,
    });
    items.push({ ...it, refCost: cost, refPrice: price });
  }
  // Minimum quantities (drive low-stock alerts). Two items are deliberately near the floor.
  const mins = { 'LAP-14': 6, 'MON-24': 8, 'KBD-WL': 15, 'MSE-WL': 15, 'DOC-DK': 6, 'PRN-LS': 4, 'TNR-BK': 12, 'PPR-A4': 60, 'CAB-HD': 25, 'SSD-1T': 10 };
  for (const it of items) await call('PATCH', `/stock-items/${it.stock_item_id}/min-qty`, { minQty: mins[it.item_code] || 0 });

  const cashAcc = A['1010'];
  const line = (it, qty, price) => ({ stockItemId: it.stock_item_id, itemCode: it.item_code, description: it.item_name, quantity: qty, unitPrice: price ?? it.refPrice });

  // Historical activity, oldest first
  // opening capital so the bank account starts positive
  const equity = (await call('GET', '/accounts')).find((a) => a.account_type === 'EQUITY');
  if (equity) await call('POST', '/cash-book/official-receipts', { orDate: dateIn(7, 1), payer: 'Owner', cashAccountId: cashAcc, description: 'Share capital introduced', createdBy: 'seed', lines: [{ accountId: equity.account_id, description: 'Capital', amount: 120000 }] });

  for (let m = 6; m >= 0; m--) {
    // restock through PO -> GRN -> PI -> Payment
    const sup = pick(suppliers);
    const restock = [pick(items), pick(items), pick(items)].filter((v, i, a) => a.indexOf(v) === i);
    const po = await call('POST', '/purchase-orders', {
      partnerId: sup.partner_id, orderDate: dateIn(m, 2), expectedDate: dateIn(m, 6), createdBy: 'seed',
      lines: restock.map((it) => ({ stockItemId: it.stock_item_id, itemCode: it.item_code, description: it.item_name, quantity: between(12, 30), unitPrice: it.refCost, taxRate: 0 })),
    });
    const poFull = await call('GET', `/purchase-orders/${po.poId}`);
    const grn = await call('POST', '/goods-received-notes', {
      poId: po.poId, receivedDate: dateIn(m, 7), createdBy: 'seed',
      lines: poFull.lines.map((l) => ({ poLineId: l.line_id, stockItemId: l.stock_item_id, itemCode: l.item_code, description: l.description, quantityReceived: Number(l.quantity), unitPrice: Number(l.unit_price), expenseAccountId: l.expense_account_id })),
    });
    const grnFull = await call('GET', `/goods-received-notes/${grn.grnId}`);
    const grnLines = [...grnFull.lines].sort((a, b) => (a.line_id < b.line_id ? -1 : 1));
    const pi = await call('POST', '/purchase-invoices', {
      partnerId: sup.partner_id, grnId: grn.grnId, invoiceDate: dateIn(m, 9), dueDate: dateIn(m, 28), createdBy: 'seed',
      lines: grnLines.map((l) => ({ stockItemId: l.stock_item_id, itemCode: l.item_code, description: l.description, quantity: Number(l.quantity_received), unitPrice: Number(l.unit_price), taxCodeId: PR0 })),
    });
    if (m > 1) {
      await call('POST', '/payments', {
        partnerId: sup.partner_id, paymentDate: dateIn(m - 1, 3), bankAccountId: cashAcc, amount: pi.totalAmount,
        paymentMethod: 'BANK_TRANSFER', createdBy: 'seed', allocations: [{ purchaseInvoiceId: pi.purchaseInvoiceId, amount: pi.totalAmount }],
      });
    }

    // operating expenses (Payment Vouchers)
    const exp = [['6200', 'Office rental', between(2600, 3000)], ['6300', 'Electricity & water', between(320, 620)], ['6400', 'Online advertising', between(400, 1400)], ['6500', 'Delivery & fuel', between(180, 520)], ['6900', 'Sundry expenses', between(60, 260)]];
    await call('POST', '/cash-book/payment-vouchers', {
      pvDate: dateIn(m, 12), payee: 'Various payees', cashAccountId: cashAcc, description: `Operating expenses ${dateIn(m, 12).slice(0, 7)}`, createdBy: 'seed',
      lines: exp.map(([code, description, amount]) => ({ accountId: A[code], description, amount })),
    });

    // sales: invoices through the full chain for some, direct for others
    const invCount = between(9, 14);
    for (let k = 0; k < invCount; k++) {
      const cust = pick(customers);
      const day = between(3, 26);
      const lines = [pick(items), pick(items)].filter((v, i, a) => a.indexOf(v) === i).map((it) => line(it, between(1, 4)));
      try {
        const inv = await call('POST', '/invoices', {
          partnerId: cust.partner_id, invoiceDate: dateIn(m, day), dueDate: dateIn(m, Math.min(day + 14, 28)), createdBy: 'seed', lines,
        });
        // most (but not all) invoices get paid
        if (m > 1 && rnd() < 0.82) {
          await call('POST', '/receipts', {
            partnerId: cust.partner_id, receiptDate: dateIn(m, Math.min(day + between(5, 20), 28)), bankAccountId: cashAcc,
            amount: inv.totalAmount, paymentMethod: pick(['BANK_TRANSFER', 'BANK_TRANSFER', 'CHEQUE']), createdBy: 'seed',
            allocations: [{ invoiceId: inv.invoiceId, amount: inv.totalAmount }],
          });
        }
      } catch (e) { /* stock ran low in the demo - skip the sale */ }
    }
    for (let k = 0; k < between(5, 9); k++) {
      try {
        await call('POST', '/cash-sales', {
          partnerId: null, saleDate: dateIn(m, between(2, 27)), paymentMethod: pick(['CASH', 'CARD', 'BANK_TRANSFER']), cashAccountId: cashAcc, createdBy: 'seed',
          lines: [line(pick(items), between(1, 4))],
        });
      } catch (e) { /* skip */ }
    }
    // service revenue (non-stock line)
    await call('POST', '/invoices', {
      partnerId: pick(customers).partner_id, invoiceDate: dateIn(m, 15), dueDate: dateIn(m, 28), createdBy: 'seed',
      lines: [{ description: 'IT support & maintenance retainer', quantity: 1, unitPrice: between(800, 2200), taxCodeId: SR6, revenueAccountId: A['4100'] }],
    }).catch(() => {});
  }

  // Live pipeline for the current month so every list has something to show
  const c1 = customers[0], c2 = customers[1], c3 = customers[3];
  await call('POST', '/quotations', { partnerId: c1.partner_id, quotationDate: dateIn(0, 3), validUntil: dateIn(-1, 3) > ymd(new Date()) ? dateIn(-1, 3) : ymd(new Date()), createdBy: 'seed', lines: [line(items[0], 5), line(items[1], 5)] });
  const qt2 = await call('POST', '/quotations', { partnerId: c2.partner_id, quotationDate: dateIn(0, 4), createdBy: 'seed', lines: [line(items[4], 3)] });
  const so = await call('POST', '/sales-orders', { partnerId: c3.partner_id, orderDate: dateIn(0, 5), expectedDate: ymd(new Date()), createdBy: 'seed', lines: [line(items[2], 10), line(items[3], 10)] });
  const soFull = await call('GET', `/sales-orders/${so.salesOrderId}`);
  await call('POST', '/delivery-orders', {
    salesOrderId: so.salesOrderId, deliveryDate: dateIn(0, 6), createdBy: 'seed', notes: 'First drop',
    lines: soFull.lines.map((l) => ({ salesOrderLineId: l.line_id, stockItemId: l.stock_item_id, description: l.description, quantity: Number(l.quantity) / 2 })),
  });
  await call('POST', '/sales-orders', { quotationId: qt2.quotationId, partnerId: c2.partner_id, orderDate: dateIn(0, 6), createdBy: 'seed', lines: [] }).catch(() => {});
  await call('POST', '/purchase-requests', { requestedBy: 'Nadia', requestDate: dateIn(0, 8), notes: 'Restock printers and toner', lines: [{ stockItemId: items[5].stock_item_id, itemCode: items[5].item_code, description: items[5].item_name, quantity: 6, estimatedUnitPrice: items[5].refCost }, { stockItemId: items[6].stock_item_id, itemCode: items[6].item_code, description: items[6].item_name, quantity: 24, estimatedUnitPrice: items[6].refCost }] });
  const po2 = await call('POST', '/purchase-orders', { partnerId: suppliers[1].partner_id, orderDate: dateIn(0, 9), createdBy: 'seed', lines: [{ stockItemId: items[9].stock_item_id, itemCode: items[9].item_code, description: items[9].item_name, quantity: 20, unitPrice: items[9].refCost, taxRate: 0 }] });
  const po3 = await call('POST', '/purchase-orders', { partnerId: suppliers[3].partner_id, orderDate: dateIn(0, 10), createdBy: 'seed', lines: [{ stockItemId: items[4].stock_item_id, itemCode: items[4].item_code, description: items[4].item_name, quantity: 10, unitPrice: items[4].refCost, taxRate: 0 }] });
  const po3Full = await call('GET', `/purchase-orders/${po3.poId}`);
  await call('POST', '/goods-received-notes', { poId: po3.poId, receivedDate: dateIn(0, 11), createdBy: 'seed', lines: po3Full.lines.map((l) => ({ poLineId: l.line_id, stockItemId: l.stock_item_id, itemCode: l.item_code, description: l.description, quantityReceived: Number(l.quantity), unitPrice: Number(l.unit_price), expenseAccountId: l.expense_account_id })) });
  await call('POST', '/cash-purchases', { partnerId: null, purchaseDate: dateIn(0, 12), paymentMethod: 'CASH', cashAccountId: A['1000'] || cashAcc, createdBy: 'seed', lines: [{ description: 'Cleaning supplies', quantity: 1, unitPrice: 86.5, taxCodeId: PR0, expenseAccountId: A['6000'] }] }).catch(() => {});
  await call('POST', '/cash-book/official-receipts', { orDate: dateIn(0, 13), payer: 'Bank', cashAccountId: cashAcc, description: 'Interest received', createdBy: 'seed', lines: [{ accountId: A['4100'], description: 'Bank interest', amount: 42.18 }] }).catch(() => {});

  // Make one existing customer invoice overdue and partially paid for the Sales dashboard
  const overdue = await call('POST', '/invoices', { partnerId: customers[4].partner_id, invoiceDate: dateIn(2, 20), dueDate: dateIn(2, 28), createdBy: 'seed', lines: [line(items[7], 30)] }).catch(() => null);
  if (overdue) {
    await call('POST', '/receipts', { partnerId: customers[4].partner_id, receiptDate: dateIn(1, 5), bankAccountId: cashAcc, amount: 100, paymentMethod: 'BANK_TRANSFER', createdBy: 'seed', allocations: [{ invoiceId: overdue.invoiceId, amount: 100 }] });
  }

  console.log('Demo data created. Open http://localhost:3000');
  await pool.end();
}

main().catch(async (err) => { console.error('Seed failed:', err.message); try { await pool.end(); } catch (e) { /* ignore */ } process.exit(1); });
