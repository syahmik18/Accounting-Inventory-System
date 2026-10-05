/* boot.js — tiny synchronous script in <head> (no dependencies, ~1 KB).
   1) applies the saved theme / glass level before first paint (no flash)
   2) starts the dashboard's main data request immediately, in parallel with the JS modules
      (the dashboard picks it up from window.__early instead of waiting for the module chain). */
(function () {
  var ls = function (k, d) { try { var v = localStorage.getItem('lg.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  var t = ls('theme', 'system');
  if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var root = document.documentElement;
  root.setAttribute('data-theme', t);
  root.setAttribute('data-glass', ls('glass', 'balanced'));
  var h = location.hash;
  if (!h || h === '#' || /^#\/dashboard/.test(h)) {
    var base = '/api', id = ls('company', 'main'), list = ls('companies', null);
    if (list && list.length) for (var i = 0; i < list.length; i++) if (list[i].id === id) base = list[i].apiBase || '/api';
    try { window.__early = { overview: fetch(base + '/insights/overview?months=12').then(function (r) { if (!r.ok) throw new Error('early'); return r.json(); }) }; window.__early.overview.catch(function () { window.__early = null; }); } catch (e) { /* fall back to normal loading */ }
  }
  // Must be logged in: hide the app until the server confirms the session, else go to the login page.
  root.style.visibility = 'hidden';
  fetch('/api/auth/me').then(function (r) {
    if (r.status === 401) location.replace('/login.html'); else root.style.visibility = '';
  }).catch(function () { root.style.visibility = ''; });
  root.setAttribute('data-sb', ls('collapsed', false) || innerWidth <= 1100 ? 'c' : 'o');
})();
