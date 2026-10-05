const { Pool, types } = require('pg');

// -----------------------------------------------------------------------
// Postgres DATE columns (e.g. invoice_date, due_date) have no time or
// timezone component - they're just a calendar date. But node-postgres's
// default type parser converts DATE into a JS `Date` object anchored at
// LOCAL midnight. When Express later calls .toISOString() to serialize
// that Date to JSON, it converts to UTC - so in Malaysia (UTC+8), midnight
// on 2026-09-01 becomes 2026-08-31T16:00:00.000Z, and any code that reads
// the first 10 characters of that string gets the wrong day, every time.
//
// The fix: tell pg not to parse DATE (OID 1082) into a JS Date at all -
// just hand back the raw 'YYYY-MM-DD' string Postgres already sends over
// the wire. This fixes every date field everywhere in one place, rather
// than patching every .toISOString()/.slice(0,10) call across the app.
// OID 1082 = 'date'. (TIMESTAMP/TIMESTAMPTZ columns are unaffected -
// those genuinely have a time component and should keep normal Date parsing.)
types.setTypeParser(1082, (val) => val);

const baseCfg = {
  host: process.env.PGHOST || 'localhost',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
};

// -----------------------------------------------------------------------
// Multi-company support (see src/routes/system.js): each company is a
// separate Postgres database, and the whole app works against exactly one
// of them at a time - like opening a different .FDB file in SQL Account.
// `activePool` is the real pg Pool for whichever database is open right
// now. Every route/model file in this app already does `const { pool } =
// require('../db')` at startup, which captures a reference once. So
// instead of exporting the real Pool, we export a small stable proxy
// object with the same `query`/`connect` shape that always forwards to
// whatever `activePool` currently is - switching companies just means
// reassigning `activePool` here, with zero changes anywhere else.
// -----------------------------------------------------------------------
let activeDbName = process.env.PGDATABASE || 'accounting_sample';
let activePool = new Pool({ ...baseCfg, database: activeDbName, max: 10, idleTimeoutMillis: 30000 });

const pool = {
  query: (...args) => activePool.query(...args),
  connect: (...args) => activePool.connect(...args),
};

function currentDatabase() { return activeDbName; }

/** Switch the whole app over to a different company's database. */
async function setActiveDatabase(dbName) {
  if (dbName === activeDbName) return;
  const next = new Pool({ ...baseCfg, database: dbName, max: 10, idleTimeoutMillis: 30000 });
  await next.query('SELECT 1'); // fail fast (bad name/creds) before swapping anything
  const old = activePool;
  activePool = next;
  activeDbName = dbName;
  old.end().catch(() => { /* draining old connections, nothing to do if it errors */ });
}

/**
 * Run a function inside a single DB transaction.
 * Any thrown error automatically rolls back.
 * This is used everywhere a journal entry gets created, because
 * partial posting (e.g. invoice saved but journal not posted) is the
 * single most damaging bug class in accounting software.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction, baseCfg, currentDatabase, setActiveDatabase };
