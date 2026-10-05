/* ==========================================================================
   charts.js — dependency-free SVG charts (≈4 KB gzipped). Responsive via
   ResizeObserver, interactive tooltips, theme-aware through CSS variables.
   ========================================================================== */
import { esc, rm, compact, num, fmt, html, raw } from './core.js';

export const PALETTE = ['var(--blue)', 'var(--cyan)', 'var(--green)', 'var(--amber)', 'var(--violet)', 'var(--red)'];
let uid = 0;

/* monotone cubic path through points (no overshoot on financial series) */
function curve(p) {
  const n = p.length;
  if (n === 0) return '';
  if (n === 1) return `M${p[0][0]},${p[0][1]}`;
  if (n === 2) return `M${p[0][0]},${p[0][1]}L${p[1][0]},${p[1][1]}`;
  const dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; dy[i] = p[i + 1][1] - p[i][1]; m[i] = dy[i] / (dx[i] || 1); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < n - 1; i++) { const h = dx[i] / 3; d += `C${p[i][0] + h},${p[i][1] + t[i] * h} ${p[i + 1][0] - h},${p[i + 1][1] - t[i + 1] * h} ${p[i + 1][0]},${p[i + 1][1]}`; }
  return d;
}

function niceScale(min, max, ticks = 4) {
  if (max === min) { max = max + 1; min = min - (min === 0 ? 0 : 1); }
  const span = max - min; const step0 = span / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(6));
  return { lo, hi, ticks: out };
}

function observe(el, draw) {
  draw();
  if (el._ro) el._ro.disconnect();
  let w = el.clientWidth, t;
  el._ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) < 2) return; w = el.clientWidth; clearTimeout(t); t = setTimeout(draw, 80); });
  el._ro.observe(el);
}
export const disposeChart = (el) => { if (el && el._ro) { el._ro.disconnect(); el._ro = null; } };

function tip(el) {
  let t = el.querySelector('.ctip');
  if (!t) { t = document.createElement('div'); t.className = 'ctip glass-float'; el.appendChild(t); }
  return t;
}

/* ---------- sparkline ---------- */
export function spark(values, { color = 'var(--blue)', w = 140, h = 44 } = {}) {
  const v = values.map(num); if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), rng = max - min || 1, id = `sp${++uid}`;
  const pts = v.map((y, i) => [2 + (i * (w - 4)) / (v.length - 1), h - 4 - ((y - min) / rng) * (h - 10)]);
  const d = curve(pts);
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color};stop-opacity:.34"/><stop offset="1" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs><path d="${d}L${w - 2},${h}L2,${h}Z" fill="url(#${id})"/><path d="${d}" fill="none" style="stroke:${color}" stroke-width="2.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/><circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="3" style="fill:${color}"/></svg>`;
}

/* ---------- line / area ---------- */
export function plot(el, { labels, series, kind = 'line', height = 280, forecastFrom = null, fmtVal = (v) => rm(v, 0), ticks = 4 }) {
  observe(el, () => {
    const W = Math.max(280, el.clientWidth || 600), H = height, l = 52, r = 14, t = 14, b = 28, iw = W - l - r, ih = H - t - b, n = labels.length;
    const all = series.flatMap((s) => s.values.map(num));
    const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all), ticks);
    const X = (i) => l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const Y = (v) => t + ih - ((v - sc.lo) / (sc.hi - sc.lo || 1)) * ih;
    const id = `pl${++uid}`;
    let g = `<g class="grid">${sc.ticks.map((v) => `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${l - 8}" y="${Y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}</g>`;
    const every = Math.ceil(n / Math.max(2, Math.floor(iw / 56)));
    g += labels.map((lb, i) => (i % every === 0 || i === n - 1 ? `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(lb)}</text>` : '')).join('');
    let defs = '', body = '';
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => [X(i), Y(num(v))]);
      const col = s.color || PALETTE[k % PALETTE.length];
      const split = forecastFrom != null && forecastFrom > 0 && forecastFrom < n ? forecastFrom : null;
      const solid = split ? pts.slice(0, split) : pts;
      const dash = split ? pts.slice(split - 1) : null;
      if (kind === 'area') {
        defs += `<linearGradient id="${id}${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${col};stop-opacity:.32"/><stop offset="1" style="stop-color:${col};stop-opacity:0"/></linearGradient>`;
        const base = Y(Math.max(0, sc.lo));
        body += `<path d="${curve(solid)}L${solid[solid.length - 1][0]},${base}L${solid[0][0]},${base}Z" fill="url(#${id}${k})"/>`;
        if (dash) body += `<path d="${curve(dash)}L${dash[dash.length - 1][0]},${base}L${dash[0][0]},${base}Z" fill="url(#${id}${k})" opacity=".45"/>`;
      }
      body += `<path d="${curve(solid)}" fill="none" style="stroke:${col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
      if (dash) body += `<path d="${curve(dash)}" fill="none" style="stroke:${col}" stroke-width="2.4" stroke-dasharray="6 6" stroke-linecap="round"/>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Chart"><defs>${defs}</defs>${g}${body}<line class="xh" y1="${t}" y2="${t + ih}" style="stroke:var(--ink-3)" stroke-dasharray="3 4" opacity="0"/>${series.map((s, k) => `<circle class="dt" r="4.5" style="fill:var(--solid);stroke:${s.color || PALETTE[k % PALETTE.length]}" stroke-width="2.4" opacity="0"/>`).join('')}<rect class="hit" x="${l}" y="${t}" width="${iw}" height="${ih}"/></svg>`;
    const svg = el.firstElementChild, T = tip(el), xh = svg.querySelector('.xh'), dts = svg.querySelectorAll('.dt');
    const move = (e) => {
      const rc = svg.getBoundingClientRect(); const px = ((e.clientX - rc.left) / rc.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - l) / iw) * (n - 1))));
      xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('opacity', '.6');
      dts.forEach((d, k) => { d.setAttribute('cx', X(i)); d.setAttribute('cy', Y(num(series[k].values[i]))); d.setAttribute('opacity', '1'); });
      const proj = forecastFrom != null && i >= forecastFrom;
      T.innerHTML = `<b>${esc(labels[i])}${proj ? ' · projected' : ''}</b>${series.map((s, k) => `<div><span><i style="background:${s.color || PALETTE[k % PALETTE.length]}"></i>${esc(s.name)}</span><span>${fmtVal(num(s.values[i]))}</span></div>`).join('')}`;
      T.classList.add('on');
      const tw = T.offsetWidth / 2; T.style.left = `${Math.max(tw + 4, Math.min(el.clientWidth - tw - 4, (X(i) / W) * rc.width))}px`; T.style.top = `${(Math.min(...series.map((s) => Y(num(s.values[i])))) / H) * rc.height}px`;
    };
    const out = () => { xh.setAttribute('opacity', '0'); dts.forEach((d) => d.setAttribute('opacity', '0')); T.classList.remove('on'); };
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerleave', out);
  });
}

/* ---------- grouped bars ---------- */
export function bars(el, { labels, series, height = 240, fmtVal = (v) => fmt(v, 0), stacked = false }) {
  observe(el, () => {
    const W = Math.max(280, el.clientWidth || 600), H = height, l = 48, r = 8, t = 12, b = 28, iw = W - l - r, ih = H - t - b, n = labels.length;
    const tot = (i) => series.reduce((s, x) => s + num(x.values[i]), 0);
    const maxV = stacked ? Math.max(...labels.map((_, i) => tot(i)), 0) : Math.max(...series.flatMap((s) => s.values.map(num)), 0);
    const sc = niceScale(0, maxV || 1, 4);
    const Y = (v) => t + ih - (v / (sc.hi || 1)) * ih;
    const gw = iw / n, bw = Math.min(30, (gw * 0.68) / (stacked ? 1 : series.length));
    let out = `<g class="grid">${sc.ticks.map((v) => `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${l - 8}" y="${Y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}</g>`;
    labels.forEach((lb, i) => {
      const cx = l + gw * i + gw / 2; out += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lb)}</text>`;
      let acc = 0;
      series.forEach((s, k) => {
        const v = Math.max(0, num(s.values[i])); const col = s.color || PALETTE[k % PALETTE.length];
        const x = stacked ? cx - bw / 2 : cx - (bw * series.length) / 2 + k * bw + 1;
        const y0 = stacked ? Y(acc + v) : Y(v), hh = stacked ? Y(acc) - Y(acc + v) : Y(0) - Y(v);
        acc += v;
        if (hh > 0) out += `<rect x="${x}" y="${y0}" width="${Math.max(2, bw - 2)}" height="${hh}" rx="5" style="fill:${col}" opacity=".92"/>`;
      });
      out += `<rect class="hit" data-i="${i}" x="${l + gw * i}" y="${t}" width="${gw}" height="${ih}"/>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Bar chart">${out}</svg>`;
    const svg = el.firstElementChild, T = tip(el);
    svg.addEventListener('pointermove', (e) => {
      const h = e.target.closest('[data-i]'); if (!h) return; const i = +h.dataset.i;
      T.innerHTML = `<b>${esc(labels[i])}</b>${series.map((s, k) => `<div><span><i style="background:${s.color || PALETTE[k % PALETTE.length]}"></i>${esc(s.name)}</span><span>${fmtVal(num(s.values[i]))}</span></div>`).join('')}`;
      T.classList.add('on'); const rc = svg.getBoundingClientRect(); const tw = T.offsetWidth / 2;
      T.style.left = `${Math.max(tw + 4, Math.min(el.clientWidth - tw - 4, ((l + gw * i + gw / 2) / W) * rc.width))}px`; T.style.top = `${(Math.min(...series.map((s) => Y(num(s.values[i])))) / H) * rc.height}px`;
    });
    svg.addEventListener('pointerleave', () => T.classList.remove('on'));
  });
}

/* ---------- donut with legend ---------- */
export function donut(el, { items, center = null, fmtVal = (v) => rm(v, 0) }) {
  const data = items.filter((i) => num(i.value) > 0);
  const total = data.reduce((s, i) => s + num(i.value), 0);
  if (!total) { el.innerHTML = '<div class="empty" style="padding:32px"><p>No data for this period.</p></div>'; return; }
  el.classList.add('donut-host');
  const S = 200, c = S / 2, R = 92, r = 60; let a0 = -Math.PI / 2;
  const arcs = data.map((it, k) => {
    const frac = num(it.value) / total, a1 = a0 + Math.min(frac, 0.9999) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
    const d = `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
    const mid = (a0 + a1) / 2; a0 = a1;
    return `<path class="seg" data-k="${k}" d="${d}" style="fill:${it.color || PALETTE[k % PALETTE.length]};transform-origin:${c}px ${c}px;transition:transform .2s;--dx:${Math.cos(mid) * 4}px;--dy:${Math.sin(mid) * 4}px" stroke="var(--solid)" stroke-width="2"/>`;
  }).join('');
  el.innerHTML = `<div class="donut-wrap"><div class="chart"><svg viewBox="0 0 ${S} ${S}" width="200" height="200" role="img" aria-label="Breakdown">${arcs}<text x="${c}" y="${c - 2}" text-anchor="middle" style="font:700 19px var(--font);fill:var(--ink)">${center ? esc(center.value) : compact(total)}</text><text x="${c}" y="${c + 16}" text-anchor="middle" style="font:500 11px var(--font);fill:var(--ink-3)">${esc(center ? center.label : 'Total')}</text></svg></div>
    <div class="list">${data.map((it, k) => `<div data-k="${k}"><i style="background:${it.color || PALETTE[k % PALETTE.length]}"></i><span title="${esc(it.label)}">${esc(it.label)}</span><b>${fmtVal(num(it.value))}</b><span class="muted" style="flex:none;width:44px;text-align:right">${((num(it.value) / total) * 100).toFixed(0)}%</span></div>`).join('')}</div></div>`;
  const hi = (k, on) => { const s = el.querySelector(`.seg[data-k="${k}"]`), d = el.querySelector(`.list [data-k="${k}"]`); if (s) s.style.transform = on ? `translate(${s.style.getPropertyValue('--dx')},${s.style.getPropertyValue('--dy')})` : ''; d && d.classList.toggle('hl', on); };
  el.addEventListener('pointerover', (e) => { const t = e.target.closest('[data-k]'); if (t) hi(+t.dataset.k, true); });
  el.addEventListener('pointerout', (e) => { const t = e.target.closest('[data-k]'); if (t) hi(+t.dataset.k, false); });
}

/* ---------- horizontal bars (HTML, no SVG needed) ---------- */
export function hbar(items, { fmtVal = (v) => rm(v, 0), empty = 'Nothing to show yet.' } = {}) {
  const data = items.filter((i) => num(i.value) > 0); const max = Math.max(...data.map((i) => num(i.value)), 0);
  if (!data.length) return html`<div class="empty" style="padding:28px"><p>${empty}</p></div>`;
  return html`<div class="hbar">${data.map((i) => html`<div class="r"><span title="${i.label}">${i.label}</span><div class="trk"><i style="width:${Math.max(3, (num(i.value) / max) * 100).toFixed(1)}%"></i></div><b>${raw(fmtVal(num(i.value)))}</b></div>`)}</div>`;
}
export const legend = (items) => html`<div class="legend">${items.map((i, k) => html`<span><i style="background:${i.color || PALETTE[k % PALETTE.length]}"></i>${i.label}</span>`)}</div>`;
