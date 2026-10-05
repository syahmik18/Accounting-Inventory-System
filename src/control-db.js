const { Pool } = require('pg');
const { baseCfg } = require('./db');

// -----------------------------------------------------------------------
// The list of companies (and which Postgres database each one lives in)
// can't be stored inside any one company's database - that row would
// vanish the moment you dropped that company. So it lives in its own
// small "control" database instead, alongside whichever company database
// happens to be active right now.
// -----------------------------------------------------------------------
const CONTROL_DB = process.env.LEDGER_CONTROL_DB || 'ledger_control';
const MAINT_DB = process.env.PG_MAINTENANCE_DB || 'postgres';

function maintPool() { return new Pool({ ...baseCfg, database: MAINT_DB, max: 2 }); }

let controlPool = null;
let ready = null;

async function ensureControlDatabase() {
  const maint = maintPool();
  try {
    const r = await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [CONTROL_DB]);
    if (r.rowCount === 0) await maint.query(`CREATE DATABASE "${CONTROL_DB}"`);
  } finally {
    await maint.end();
  }
}

async function getControlPool() {
  if (controlPool) return controlPool;
  if (!ready) {
    ready = (async () => {
      await ensureControlDatabase();
      controlPool = new Pool({ ...baseCfg, database: CONTROL_DB, max: 4 });
      await controlPool.query(`
        CREATE TABLE IF NOT EXISTS company_registry (
          company_id    TEXT PRIMARY KEY,
          db_name       TEXT UNIQUE NOT NULL,
          company_name  TEXT NOT NULL,
          remark        TEXT,
          country       TEXT,
          version       TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      // Added with the login screen. NULL means the default password (ADMIN).
      await controlPool.query('ALTER TABLE company_registry ADD COLUMN IF NOT EXISTS admin_password_hash TEXT');
      return controlPool;
    })();
  }
  return ready;
}

async function ensureDefaultCompanyRegistered(dbName) {
  const cp = await getControlPool();
  const r = await cp.query('SELECT 1 FROM company_registry WHERE db_name = $1', [dbName]);
  if (r.rowCount) return;
  const label = dbName.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  await cp.query(
    'INSERT INTO company_registry (company_id, db_name, company_name, remark) VALUES ($1,$2,$3,$4) ON CONFLICT (db_name) DO NOTHING',
    [dbName, dbName, label, 'Existing database'],
  );
}

module.exports = { getControlPool, maintPool, MAINT_DB, CONTROL_DB, ensureDefaultCompanyRegistered };
