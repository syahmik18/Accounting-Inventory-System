function groupCostLines(entries = []) {
  const map = new Map();
  for (const e of entries) {
    const amount = Number(e.amount || 0);
    if (!(amount > 0)) continue;
    const key = e.accountId;
    const row = map.get(key) || { accountId: key, amount: 0, description: e.description || null };
    row.amount = Math.round((row.amount + amount + Number.EPSILON) * 100) / 100;
    map.set(key, row);
  }
  return [...map.values()];
}

function saleCostLines(accounting) {
  const cogs = groupCostLines(accounting.cogsOut).map(x => ({
    accountId: x.accountId, debit: x.amount, credit: 0, description: x.description || 'Cost of Goods Sold',
  }));
  const inventory = groupCostLines(accounting.inventoryOut).map(x => ({
    accountId: x.accountId, debit: 0, credit: x.amount, description: x.description || 'Inventory issued',
  }));
  return [...cogs, ...inventory];
}


module.exports = { saleCostLines };
