// ---------------------------------------------------------------------------
// Login, like SQL Account: pick a company (database), enter user + password.
// Each company has one ADMIN user whose password is stored (scrypt-hashed) in
// the control database's company_registry. A NULL hash means the default
// password, ADMIN. Sessions live in memory: restarting the server logs
// everyone out, and because the whole server works on one company database at
// a time, logging in to a different company invalidates other sessions.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { currentDatabase, setActiveDatabase } = require('../db');
const { getControlPool } = require('../control-db');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const COOKIE = 'ledger_session';
const TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { user, companyId, companyName, dbName, expires }

/* ---------- passwords ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
function verifyPassword(pw, stored) {
  if (!stored) return crypto.timingSafeEqual(sha(pw), sha('ADMIN')); // default password
  const [saltHex, hashHex] = stored.split(':');
  const h = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}

/* ---------- sessions ---------- */
function tokenOf(req) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return m ? m.slice(COOKIE.length + 1) : null;
}
function sessionFor(req) {
  const t = tokenOf(req); const s = t && sessions.get(t);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(t); return null; }
  return s;
}
function requireSession(req, res, next) {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: 'Please log in', code: 'auth' });
  if (s.dbName !== currentDatabase()) return res.status(401).json({ error: 'Another company was opened on this server. Please log in again.', code: 'company_changed' });
  req.session = s;
  next();
}

// Database setup is reachable from the login page (before anyone is logged in),
// but only from the machine running the server. From anywhere else a login is
// required first. Listing companies (for the dropdown) is always allowed.
const isLoopback = (req) => !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function housekeepingGuard(req, res, next) {
  if (req.method === 'GET' && req.path === '/companies') return next();
  if (sessionFor(req) || isLoopback(req)) return next();
  res.status(403).json({ error: 'Database setup from another computer requires logging in first.' });
}

/* ---------- brute-force slowdown ---------- */
const fails = new Map(); // ip -> { n, until }
const ipOf = (req) => req.socket.remoteAddress || 'unknown';

router.post('/auth/login', wrap(async (req, res) => {
  const ip = ipOf(req); const f = fails.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.` });

  const { companyId, user, password } = req.body || {};
  const cp = await getControlPool();
  const r = companyId ? await cp.query('SELECT company_id, db_name, company_name, admin_password_hash FROM company_registry WHERE company_id = $1', [companyId]) : { rowCount: 0, rows: [] };
  const c = r.rows[0];
  const ok = c && String(user || '').trim().toUpperCase() === 'ADMIN' && verifyPassword(password || '', c.admin_password_hash);
  if (!ok) {
    const n = (f ? f.n : 0) + 1;
    fails.set(ip, { n, until: n >= 5 ? Date.now() + 30000 : 0 });
    return res.status(401).json({ error: 'Invalid company, user or password' });
  }
  fails.delete(ip);

  try { await setActiveDatabase(c.db_name); }
  catch (err) { return res.status(500).json({ error: `Could not open this company's database: ${err.message}` }); }

  for (const [t, s] of sessions) if (s.expires < Date.now()) sessions.delete(t);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user: 'ADMIN', companyId: c.company_id, companyName: c.company_name, dbName: c.db_name, expires: Date.now() + TTL_MS });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`);
  res.json({ user: 'ADMIN', companyId: c.company_id, companyName: c.company_name });
}));

router.get('/auth/me', requireSession, (req, res) => {
  const { user, companyId, companyName } = req.session;
  res.json({ user, companyId, companyName });
});

router.post('/auth/logout', (req, res) => {
  const t = tokenOf(req); if (t) sessions.delete(t);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

router.post('/auth/change-password', requireSession, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const cp = await getControlPool();
  const r = await cp.query('SELECT admin_password_hash FROM company_registry WHERE company_id = $1', [req.session.companyId]);
  if (!r.rowCount || !verifyPassword(currentPassword || '', r.rows[0].admin_password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  await cp.query('UPDATE company_registry SET admin_password_hash = $1 WHERE company_id = $2', [hashPassword(newPassword), req.session.companyId]);
  res.json({ ok: true });
}));

module.exports = { router, requireSession, housekeepingGuard, hashPassword };
