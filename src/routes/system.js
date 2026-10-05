// ---------------------------------------------------------------------------
// Housekeeping: multiple companies, each its own Postgres database - the
// same idea as SQL Account's "Create New Database / Backup / Restore" screen,
// where each company is a separate .FDB file. Here each company is a
// separate `CREATE DATABASE`, built by replaying db/schema.sql plus every
// file in db/migrations/ against a brand-new, empty database. The whole
// running app then works against exactly one company's database at a time
// (src/db.js's setActiveDatabase) - opening a different company is like
// opening a different file, not simultaneous multi-tenant access.
//
// Requires the `pg_dump` and `psql` client binaries on PATH for backup and
// restore, and a Postgres role with CREATEDB privilege for create/restore/
// remove.
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { baseCfg, currentDatabase } = require('../db');
const { hashPassword } = require('./auth');
const { getControlPool, maintPool } = require('../control-db');


// Resolve a PostgreSQL client tool. Order: PG_BIN_DIR if set, then (Windows
// only) the newest C:\Program Files\PostgreSQL\<version>\bin that contains the
// tool, then plain PATH lookup.
function detectWindowsBinDir(name) {
  try {
    const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
    const versions = fs.readdirSync(root).filter((v) => /^\d+/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a));
    for (const v of versions) {
      const dir = path.join(root, v, 'bin');
      if (fs.existsSync(path.join(dir, `${name}.exe`))) return dir;
    }
  } catch { /* folder not present */ }
  return null;
}
function pgTool(name) {
  const dir = process.env.PG_BIN_DIR || (process.platform === 'win32' ? detectWindowsBinDir(name) : null);
  if (!dir) return name;
  return path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
}
const missingTool = (name) => (process.env.PG_BIN_DIR
  ? `${name} was not found at "${pgTool(name)}". Check that PG_BIN_DIR points to your PostgreSQL bin folder (the one that contains ${name}.exe).`
  : `${name} was not found. PG_BIN_DIR is not set in the terminal that started this server, and ${name} is not on PATH. Set PG_BIN_DIR to your PostgreSQL bin folder, then restart the server from that same terminal.`);

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function slugify(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'company';
  return /^[a-z]/.test(base) ? base : `c${base}`;
}

async function uniqueDbName(base) {
  const cp = await getControlPool();
  let candidate = `co_${base}`, n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await cp.query('SELECT 1 FROM company_registry WHERE db_name = $1', [candidate]);
    if (r.rowCount === 0) return candidate;
    candidate = `co_${base}_${++n}`;
  }
}

async function applySchema(targetPool) {
  // db/schema.sql is a full, up-to-date snapshot of the schema (it already
  // includes every change from db/migrations/*.sql - e.g. cash_sale from
  // migration 002, costing_method from 028, etc). Those migration files are
  // a historical changelog for catching up an already-running OLDER database;
  // replaying them on top of schema.sql double-creates the same objects.
  const root = path.join(__dirname, '..', '..');
  await targetPool.query(fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8'));
}

async function dropDatabase(dbName) {
  const maint = maintPool();
  try { await maint.query(`DROP DATABASE IF EXISTS "${dbName}"`); } finally { await maint.end(); }
}

router.get('/system/companies', wrap(async (req, res) => {
  const cp = await getControlPool();
  const r = await cp.query('SELECT company_id, db_name, company_name, remark, country, version, created_at FROM company_registry ORDER BY created_at');
  res.json({ active: currentDatabase(), companies: r.rows });
}));

router.post('/system/companies', wrap(async (req, res) => {
  const { companyName, remark, country, adminPassword } = req.body || {};
  if (!companyName || !String(companyName).trim()) return res.status(400).json({ error: 'Company name is required' });
  const dbName = await uniqueDbName(slugify(companyName));

  const maint = maintPool();
  try { await maint.query(`CREATE DATABASE "${dbName}"`); } finally { await maint.end(); }

  const fresh = new Pool({ ...baseCfg, database: dbName, max: 2 });
  try {
    await applySchema(fresh);
  } catch (err) {
    await fresh.end().catch(() => {});
    await dropDatabase(dbName);
    return res.status(500).json({ error: `Could not set up the new database: ${err.message}` });
  }
  await fresh.end();

  const cp = await getControlPool();
  const { version } = require('../../package.json');
  await cp.query(
    'INSERT INTO company_registry (company_id, db_name, company_name, remark, country, version, admin_password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [dbName, dbName, companyName.trim(), remark || null, country || null, version, hashPassword(adminPassword || 'ADMIN')],
  );
  res.status(201).json({ companyId: dbName, dbName, companyName: companyName.trim(), remark, country });
}));

router.delete('/system/companies/:id', wrap(async (req, res) => {
  const cp = await getControlPool();
  const r = await cp.query('SELECT db_name FROM company_registry WHERE company_id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Unknown company' });
  const { db_name } = r.rows[0];
  if (db_name === currentDatabase()) return res.status(400).json({ error: 'Open a different company before removing this one' });
  await dropDatabase(db_name);
  await cp.query('DELETE FROM company_registry WHERE company_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

router.get('/system/companies/:id/backup', wrap(async (req, res) => {
  const cp = await getControlPool();
  const r = await cp.query('SELECT db_name FROM company_registry WHERE company_id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Unknown company' });
  const { db_name } = r.rows[0];

  // Dump to a temp file first and only start the download once pg_dump has
  // succeeded. Streaming straight to the response meant a failed pg_dump left
  // the browser with an empty/invalid download and no way to see why.
  const tmp = path.join(os.tmpdir(), `${db_name}-${Date.now()}.sql`);
  const cleanup = () => fs.unlink(tmp, () => {});
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(pgTool('pg_dump'), [
        '-h', String(baseCfg.host), '-p', String(baseCfg.port), '-U', String(baseCfg.user),
        '--no-owner', '--no-privileges', '-f', tmp, '-d', db_name,
      ], { env: { ...process.env, PGPASSWORD: baseCfg.password } });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => reject(new Error(err.code === 'ENOENT'
        ? missingTool('pg_dump')
        : err.message)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `pg_dump exited with code ${code}`))));
    });
  } catch (err) {
    cleanup();
    console.error('pg_dump failed:', err.message);
    return res.status(500).json({ error: `Backup failed: ${err.message}` });
  }
  res.download(tmp, `${db_name}.sql`, cleanup);
}));

router.post('/system/companies/restore', express.raw({ type: '*/*', limit: '300mb' }), wrap(async (req, res) => {
  const companyName = (req.query.companyName || '').toString().trim();
  const remark = (req.query.remark || '').toString();
  if (!companyName) return res.status(400).json({ error: 'Company name is required' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No backup file received' });

  const dbName = await uniqueDbName(slugify(companyName));
  const maint = maintPool();
  try { await maint.query(`CREATE DATABASE "${dbName}"`); } finally { await maint.end(); }

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(pgTool('psql'), [
        '-h', String(baseCfg.host), '-p', String(baseCfg.port), '-U', String(baseCfg.user),
        '-v', 'ON_ERROR_STOP=1', '-d', dbName, '-f', '-',
      ], { env: { ...process.env, PGPASSWORD: baseCfg.password } });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? missingTool('psql') : err.message)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `psql exited with code ${code}`))));
      child.stdin.write(req.body);
      child.stdin.end();
    });
  } catch (err) {
    await dropDatabase(dbName);
    return res.status(500).json({ error: `Restore failed: ${err.message}` });
  }

  const cp = await getControlPool();
  await cp.query(
    'INSERT INTO company_registry (company_id, db_name, company_name, remark) VALUES ($1,$2,$3,$4)',
    [dbName, dbName, companyName, remark || null],
  );
  res.status(201).json({ companyId: dbName, dbName, companyName });
}));

module.exports = router;
