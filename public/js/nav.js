/* nav.js — single source of truth for navigation, used by the sidebar, palette and tabs. */
import { html, raw } from './core.js';
import { ico } from './icons.js';

export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', href: '#/dashboard' },
  { id: 'sales', label: 'Sales', icon: 'sales', href: '#/sales', children: [
    ['Overview', '#/sales', 'overview'], ['Quotations', '#/sales/quotations', 'quotations'], ['Sales orders', '#/sales/orders', 'orders'], ['Delivery orders', '#/sales/deliveries', 'deliveries'],
    ['Invoices', '#/sales/invoices', 'invoices'], ['Cash sales', '#/sales/cash-sales', 'cash-sales'], ['Debit notes', '#/sales/debit-notes', 'debit-notes'], ['Credit notes', '#/sales/credit-notes', 'credit-notes'], ['Receipts', '#/sales/receipts', 'receipts'] ] },
  { id: 'purchases', label: 'Purchases', icon: 'purchases', href: '#/purchases', children: [
    ['Overview', '#/purchases', 'overview'], ['Requests', '#/purchases/requests', 'requests'], ['Purchase orders', '#/purchases/orders', 'orders'], ['Goods received', '#/purchases/grn', 'grn'],
    ['Supplier invoices', '#/purchases/invoices', 'invoices'], ['Cash purchases', '#/purchases/cash-purchases', 'cash-purchases'], ['Payments', '#/purchases/payments', 'payments'] ] },
  { id: 'customers', label: 'Customers', icon: 'customers', href: '#/customers' },
  { id: 'suppliers', label: 'Suppliers', icon: 'suppliers', href: '#/suppliers' },
  { id: 'inventory', label: 'Inventory', icon: 'inventory', href: '#/inventory', children: [['Overview', '#/inventory', 'overview'], ['Stock items', '#/inventory/items', 'items']] },
  { id: 'accounting', label: 'Accounting', icon: 'accounting', href: '#/accounting', children: [
    ['Overview', '#/accounting', 'overview'], ['Chart of accounts', '#/accounting/accounts', 'accounts'], ['Payment vouchers', '#/accounting/payment-vouchers', 'payment-vouchers'], ['Official receipts', '#/accounting/official-receipts', 'official-receipts'] ] },
  { id: 'reports', label: 'Reports', icon: 'reports', href: '#/reports', children: [
    ['Document register', '#/reports', 'register'], ['Receivable aging', '#/reports/ar-aging', 'ar-aging'], ['Payable aging', '#/reports/ap-aging', 'ap-aging'], ['Ledger integrity', '#/reports/integrity', 'integrity'] ] },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '#/settings', children: [['Company', '#/settings', 'company'], ['Tax codes', '#/settings/tax-codes', 'tax-codes'], ['Appearance', '#/settings/appearance', 'appearance']] },
];

/** document-history doc_type → list route (used by search and the register) */
export const DOC_ROUTES = {
  QUOTATION: 'sales/quotations', SALES_ORDER: 'sales/orders', DELIVERY_ORDER: 'sales/deliveries', SALES_INVOICE: 'sales/invoices', CASH_SALE: 'sales/cash-sales',
  DEBIT_NOTE: 'sales/debit-notes', CREDIT_NOTE: 'sales/credit-notes', RECEIPT: 'sales/receipts',
  PURCHASE_REQUEST: 'purchases/requests', PURCHASE_ORDER: 'purchases/orders', GRN: 'purchases/grn', PURCHASE_INVOICE: 'purchases/invoices', CASH_PURCHASE: 'purchases/cash-purchases', PAYMENT: 'purchases/payments',
};
export const DOC_LABEL = {
  QUOTATION: 'Quotation', SALES_ORDER: 'Sales order', DELIVERY_ORDER: 'Delivery order', SALES_INVOICE: 'Invoice', CASH_SALE: 'Cash sale', DEBIT_NOTE: 'Debit note', CREDIT_NOTE: 'Credit note', RECEIPT: 'Receipt',
  PURCHASE_REQUEST: 'Purchase request', PURCHASE_ORDER: 'Purchase order', GRN: 'Goods received', PURCHASE_INVOICE: 'Supplier invoice', CASH_PURCHASE: 'Cash purchase', PAYMENT: 'Payment',
};
export const DOC_ICON = {
  QUOTATION: 'file', SALES_ORDER: 'clipboard', DELIVERY_ORDER: 'suppliers', SALES_INVOICE: 'sales', CASH_SALE: 'banknote', DEBIT_NOTE: 'arrowUp', CREDIT_NOTE: 'arrowDown', RECEIPT: 'wallet',
  PURCHASE_REQUEST: 'clipboard', PURCHASE_ORDER: 'cart', GRN: 'inbox', PURCHASE_INVOICE: 'purchases', CASH_PURCHASE: 'banknote', PAYMENT: 'card',
};
export const DOC_TONE = { SALES_INVOICE: 'info', RECEIPT: 'ok', PAYMENT: 'warn', PURCHASE_INVOICE: 'bad', CASH_SALE: 'ok', CASH_PURCHASE: 'warn', CREDIT_NOTE: 'bad', DEBIT_NOTE: 'info', GRN: 'info' };

/** horizontal jump-tabs shown on every Sales / Purchases page (handy when the sidebar is collapsed) */
export function moduleTabs(mod, active) {
  const g = NAV.find((n) => n.id === mod);
  if (!g || !g.children) return '';
  return html`<div class="chips" role="navigation" aria-label="${g.label} sections" style="padding:0 2px">${g.children.map(([l, h, k]) => html`<a class="chip ${k === active ? 'on' : ''}" href="${h}" style="text-decoration:none">${l}</a>`)}</div>`;
}
export const flowIcon = (n) => raw(ico(n));
