const express = require('express');
const compression = require('compression');
const apiRoutes = require('./routes/api');
const uiExtraRoutes = require('./routes/ui-extras');
const systemRoutes = require('./routes/system');
const { router: authRoutes, requireSession, housekeepingGuard } = require('./routes/auth');
const { currentDatabase } = require('./db');
const { ensureDefaultCompanyRegistered } = require('./control-db');

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const app = express();
// v39 performance: gzip every text response (HTML/CSS/JS/JSON) and let the browser
// revalidate static files with ETags (fast 304s, but never a stale UI after an upgrade).
app.use(compression({ threshold: 512 }));
app.use(express.json());
app.use(express.static('public', {
  etag: true, lastModified: true, maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
// Housekeeping (multi-company: create/switch/backup/restore databases) is mounted
// first, same reasoning as below - its literal /system/... paths must not be
// swallowed by any /:id-style route declared in the routers mounted after it.
app.use('/api', authRoutes);                       // login / logout / me / change-password
app.use('/api/system', housekeepingGuard);         // database setup: local machine, or a logged-in session
app.use('/api', systemRoutes);
// Everything below this line needs a valid login session.
app.use('/api', requireSession);
// v39: additive, read-only UI support routes. Mounted first so literal paths such as
// /purchase-invoices/open are not swallowed by the /:id routes in api.js.
app.use('/api', uiExtraRoutes);
app.use('/api', apiRoutes);

// Final Express error boundary. API route handlers are wrapped so rejected
// async handlers reach this middleware instead of becoming unhandled rejections.
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return next(err);
  if (err && err.code === '22P02') {
    return res.status(400).json({ error: 'Invalid request parameter' });
  }
  res.status(err && Number.isInteger(err.statusCode) ? err.statusCode : 500)
    .json({ error: 'Internal server error' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Accounting sample API listening on :${PORT}`));

// Make the database this server was already pointed at (via PGDATABASE) show
// up in the Settings > Database company list too, so switching back to it
// after opening a different company is a click, not a server restart.
ensureDefaultCompanyRegistered(currentDatabase())
  .catch((err) => console.error('Could not auto-register the default company:', err.message));

module.exports = app;
