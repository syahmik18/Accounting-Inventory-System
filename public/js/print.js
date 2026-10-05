/* print.js — A4 print / save-as-PDF sheet built from the same view model the drawer uses. */
import { $, html, raw, esc, str, company, fmtDate, today, title } from './core.js';

const plain = (v) => str(v).replace(/<a [^>]*>([^<]*)<\/a>/g, '$1');
export function printDocument({ cfg, det, view, party, pname, no }) {
  const co = company();
  const total = view.totals.find((t) => t[2]);
  const ids = [co.tin && `TIN ${co.tin}`, co.brn && `BRN ${co.brn}`, co.sst && `SST ${co.sst}`].filter(Boolean).join(' · ');
  const pids = party ? [party.tax_id && `TIN ${party.tax_id}`, party.brn_no && `BRN ${party.brn_no}`, party.sst_no && `SST ${party.sst_no}`].filter(Boolean).join(' · ') : '';
  const sheet = html`<div class="ps">
    <div class="ps-head"><div class="ps-co"><h1>${co.name}</h1>${co.address ? html`<div>${co.address}</div>` : ''}<div>${[co.phone, co.email].filter(Boolean).join(' · ')}</div>${ids ? html`<div>${ids}</div>` : ''}</div>
      <div class="ps-doc"><h2>${cfg.label}</h2><div><b>${no}</b></div><div>Status: ${title(det.status)}</div></div></div>
    <div class="ps-meta"><div class="ps-box"><b>${cfg.party}</b><div style="font-size:14px;font-weight:600">${pname || '—'}</div>${party ? html`<div>${party.address || ''}</div><div>${[party.phone, party.email].filter(Boolean).join(' · ')}</div><div>${pids}</div>` : ''}</div>
      <div class="ps-box">${view.meta.map(([k, v]) => html`<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#555">${k}</span><span>${raw(plain(v))}</span></div>`)}</div></div>
    <table><thead><tr>${view.cols.map((c) => html`<th class="${c.num ? 'r' : ''}">${c.h}</th>`)}</tr></thead>
      <tbody>${view.rows.map((r) => html`<tr>${r.map((c, i) => html`<td class="${view.cols[i] && view.cols[i].num ? 'r' : ''}">${raw(plain(c))}</td>`)}</tr>`)}</tbody></table>
    <div class="ps-tot">${view.totals.map(([k, v, s]) => html`<div class="${s ? 'g' : ''}"><span>${k}</span><span>${raw(plain(v))}</span></div>`)}</div>
    <div class="ps-sign"><div>Prepared by</div><div>Authorised signature / company stamp</div></div>
    <div class="ps-foot"><span>Printed ${fmtDate(today())}</span><span>Computer-generated document</span></div></div>`;
  const root = $('#print-root');
  root.innerHTML = str(sheet);
  const done = () => { root.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  const prev = document.title; document.title = `${cfg.label} ${no}`;
  setTimeout(() => { window.print(); document.title = prev; }, 60);
}
