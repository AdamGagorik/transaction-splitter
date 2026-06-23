(function () {
'use strict';

/* ── Constants ─────────────────────────────────────────────────────── */

const FRAC_OPTS = ['1', '1/2', '1/3', '2/3', '1/4', '3/4'];
const FRAC_VAL  = { '1': 1, '1/2': 0.5, '1/3': 1/3, '2/3': 2/3, '1/4': 0.25, '3/4': 0.75 };
const LS_KEY    = 'txn-splitter-v3';
// Populated from config.json at startup.
let DEFAULT_PEOPLE     = [];
let DEFAULT_CATEGORIES = [];
let DEFAULT_PAYEES     = [];
let DEFAULT_YNAB       = { budgetName: '', purchaseAcct: '', payableAcct: '', receivableAcct: '' };

/* ── State ─────────────────────────────────────────────────────────── */

let rows       = [];
let people     = [];
let categories = [];
let payees     = [];

/* ── Pure helpers ──────────────────────────────────────────────────── */

function newRow() {
  return { amount: '', taxed: false, rateOverride: '', payee: DEFAULT_PAYEES[0] || '', category: DEFAULT_CATEGORIES[0] || '', memo: '', splits: [{ assignee: DEFAULT_PEOPLE[0] || '', fraction: '1' }] };
}

function rowSplits(r) {
  if (Array.isArray(r.splits) && r.splits.length > 0) return r.splits;
  return [{ assignee: r.assignee || '', fraction: r.fraction || '1' }];
}

function applyEqualFractions(splits) {
  const map = { 1: '1', 2: '1/2', 3: '1/3', 4: '1/4' };
  const frac = map[splits.length] || '1/4';
  splits.forEach(s => { s.fraction = frac; });
}

function curDefaultRate() {
  const v = parseFloat(document.getElementById('default-tax-input').value);
  return isFinite(v) ? v : 0;
}

function formatCurrency(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits === '') return '';
  const cents = parseInt(digits, 10);
  if (!isFinite(cents) || cents === 0) return '';
  return (cents / 100).toFixed(2);
}

function moneyDisplay(s) {
  if (s == null || s === '') return '';
  const n = parseFloat(s);
  return isFinite(n) && n !== 0 ? n.toFixed(2) : '';
}

function setCaretEnd(el) {
  try { const n = el.value.length; el.setSelectionRange(n, n); } catch (_) {}
}

function applyMoneyFormat(el) {
  const f = formatCurrency(el.value);
  if (f !== el.value) { el.value = f; setCaretEnd(el); }
}

/* ── Penny reconciliation ──────────────────────────────────────────── */

function strSeed(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reconcileCents(values, exactTotal, seedStr) {
  const cents = values.map(v => Math.round(v * 100));
  const target = Math.round(exactTotal * 100);
  let diff = target - cents.reduce((a, b) => a + b, 0);
  const n = cents.length;
  if (n > 0 && diff !== 0) {
    const step = diff > 0 ? 1 : -1;
    let eligible = [];
    for (let i = 0; i < n; i++) {
      if (values[i] > 1e-9 && (step > 0 || cents[i] > 0)) eligible.push(i);
    }
    if (eligible.length === 0) eligible = [...Array(n).keys()];
    const rng = mulberry32(strSeed(seedStr));
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    let count = Math.abs(diff), k = 0;
    while (count-- > 0) { cents[eligible[k % eligible.length]] += step; k++; }
  }
  return cents;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(v) {
  const n = Number(v);
  return isFinite(n) ? '$' + n.toFixed(2) : '$0.00';
}

function norm(s, fallback) {
  const str = s == null ? '' : String(s);
  return str.trim() || fallback;
}

function rowRate(r) {
  if (!r.taxed) return 0;
  const ov = parseFloat(r.rateOverride);
  const pct = (r.rateOverride !== '' && r.rateOverride != null && isFinite(ov))
    ? ov
    : curDefaultRate();
  return (isFinite(pct) ? pct : 0) / 100;
}

function computeRow(r) {
  const amount = parseFloat(r.amount) || 0;
  const rate   = rowRate(r);
  const rawSplits = rowSplits(r);
  const rawWeights = rawSplits.map(s => FRAC_VAL[s.fraction] ?? 1);
  const weightSum  = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const splits = rawSplits.map((s, i) => {
    const frac  = rawWeights[i] / weightSum;
    const eff   = amount * frac;
    const tax   = rate * eff;
    const total = eff + tax;
    return { eff, tax, total };
  });
  const eff   = splits.reduce((s, c) => s + c.eff,   0);
  const tax   = splits.reduce((s, c) => s + c.tax,   0);
  const total = splits.reduce((s, c) => s + c.total, 0);
  return { eff, tax, total, splits };
}

/* ── Full rebuild ──────────────────────────────────────────────────── */

function fullRender() {
  buildMainTable();
  buildCategoryTable();
  buildSummaryTable();
  persist();
  (window._txnSplit?.refreshHooks ?? []).forEach(fn => fn());
}

/* ── Partial update ────────────────────────────────────────────────── */

function partialUpdate() {
  refreshMainComputeds();
  buildCategoryTable();
  buildSummaryTable();
  persist();
}

/* ── Combo-box ─────────────────────────────────────────────────────── */

function attachCombo(input, options) {
  const wrap = input.closest('.combo-wrap');
  const list = wrap && wrap.querySelector('.combo-list');
  if (!list) return;

  function openList() {
    const rect = input.getBoundingClientRect();
    list.style.top   = (rect.bottom + 2) + 'px';
    list.style.left  = rect.left + 'px';
    list.style.width = Math.max(rect.width, 120) + 'px';
    if (list.parentElement !== document.body) document.body.appendChild(list);
    list.style.display = 'block';
  }

  function closeList() {
    list.style.display = 'none';
    if (list.parentElement === document.body) wrap.appendChild(list);
  }

  function render(filter) {
    const f = (filter || '').toLowerCase().trim();
    const hits = f ? options.filter(o => o.toLowerCase().includes(f)) : options;
    if (!hits.length) { closeList(); return; }
    list.innerHTML = hits.map(o => `<li data-val="${esc(o)}">${esc(o)}</li>`).join('');
    openList();
  }

  function highlight(dir) {
    const items = [...list.querySelectorAll('li')];
    if (!items.length) return;
    let idx = items.findIndex(li => li.classList.contains('combo-hi'));
    if (idx >= 0) items[idx].classList.remove('combo-hi');
    if (idx < 0) {
      idx = dir === 'down' ? 0 : items.length - 1;
    } else {
      idx = Math.max(0, Math.min(items.length - 1, dir === 'down' ? idx + 1 : idx - 1));
    }
    items[idx].classList.add('combo-hi');
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  function pick(val) {
    input.value = val;
    closeList();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', () => render(''));
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('blur',  () => setTimeout(() => { closeList(); }, 200));
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape')    { closeList(); }
    if (e.key === 'ArrowDown') { if (list.style.display === 'none') render(''); highlight('down'); e.preventDefault(); }
    if (e.key === 'ArrowUp')   { highlight('up'); e.preventDefault(); }
    if (e.key === 'Enter') {
      const hi = list.querySelector('.combo-hi') || list.querySelector('li');
      if (hi && list.style.display !== 'none') { pick(hi.dataset.val); e.preventDefault(); }
    }
  });
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pick(li.dataset.val); }
  });
  list.addEventListener('touchstart', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pick(li.dataset.val); }
  }, { passive: false });
}

function attachAllCombos(container) {
  container.querySelectorAll('[data-combo="people"]').forEach(el => attachCombo(el, people));
  container.querySelectorAll('[data-combo="payees"]').forEach(el => attachCombo(el, payees));
  container.querySelectorAll('[data-combo="categories"]').forEach(el => attachCombo(el, categories));
}

function attachCardButtons(container) {
  container.querySelectorAll('.dup-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.dup, 10);
      if (!isNaN(idx) && rows[idx]) {
        const src = rows[idx];
        rows.splice(idx + 1, 0, { ...src, _collapsed: false, splits: rowSplits(src).map(s => ({ ...s })) });
        fullRender();
        const el = document.querySelector(`[data-row="${idx + 1}"][data-col="amount"]`);
        if (el) { el.focus(); el.select(); }
      }
    });
  });
  container.querySelectorAll('.eq-split-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.eqSplit, 10);
      if (!isNaN(idx) && rows[idx]) {
        if (!rows[idx].splits) rows[idx].splits = rowSplits(rows[idx]);
        applyEqualFractions(rows[idx].splits);
        fullRender();
      }
    });
  });
}

function shortCategory(cat) {
  if (!cat) return '';
  const parts = cat.split(':');
  return parts[parts.length - 1].trim();
}

function rowSummary(r, c) {
  const prefix = (r.memo || '').trim() || shortCategory(r.category);
  const asgns  = rowSplits(r).map(s => s.assignee).filter(Boolean);
  const who    = [prefix, ...asgns].filter(Boolean).join(' · ');
  return who ? `${who} — ${fmt(c.total)}` : fmt(c.total);
}

/* ── Main table ────────────────────────────────────────────────────── */

function buildMainTable() {
  const container = document.getElementById('main-cards');
  const comp      = rows.map(computeRow);
  let sumTot = 0;
  comp.forEach(c => { sumTot += c.total; });

  const html = rows.map((r, i) => {
    const c         = comp[i];
    const splits    = rowSplits(r);
    const collapsed = r._collapsed ? ' collapsed' : '';
    const arrow     = r._collapsed ? '▶' : '▼';

    const splitsHtml = splits.map((s, j) => {
      const sc       = c.splits[j] || { total: 0 };
      const fracOpts = FRAC_OPTS.map(f =>
        `<option value="${f}"${s.fraction === f ? ' selected' : ''}>${f}</option>`
      ).join('');
      const rmBtn = splits.length > 1
        ? `<button class="remove-split-btn" data-remove-split="${i}" data-split="${j}" title="Remove person">✕</button>`
        : '';
      return `<div class="split-row">
        <div class="row-field">
          <span class="row-lbl">Person</span>
          <div class="combo-wrap">
            <input type="text" class="combo-input" data-row="${i}" data-split="${j}" data-col="assignee" data-combo="people" value="${esc(s.assignee)}" autocomplete="off" placeholder="Person">
            <ul class="combo-list"></ul>
          </div>
        </div>
        <div class="row-field">
          <span class="row-lbl">Fraction</span>
          <select class="frac-sel" data-row="${i}" data-split="${j}" data-col="fraction">${fracOpts}</select>
        </div>
        <div class="row-field">
          <span class="row-lbl">Owes</span>
          <span class="row-computed-val" data-cr="${i}" data-split="${j}" data-cc="tot">${fmt(sc.total)}</span>
        </div>
        ${rmBtn}
      </div>`;
    }).join('');

    return `<div class="row-card" data-card-idx="${i}">
      <div class="row-card-hdr" data-toggle="${i}">
        <span class="row-toggle">${arrow}</span>
        <span class="row-card-summary" data-rh="${i}">${esc(rowSummary(r, c))}</span>
        <button class="dup-btn" data-dup="${i}" title="Duplicate row">⎘</button>
        <button class="remove-btn" data-remove="${i}" title="Remove row">✕</button>
      </div>
      <div class="row-card-body${collapsed}">
        <div class="row-line">
          <div class="row-field" style="flex:1;min-width:0">
            <span class="row-lbl">Memo</span>
            <input type="text" class="memo-input" data-row="${i}" data-col="memo" value="${esc(r.memo || '')}" placeholder="Optional description" autocomplete="off">
          </div>
        </div>
        <div class="row-line">
          <div class="row-field">
            <span class="row-lbl">Amount</span>
            <input type="text" inputmode="decimal" class="num-input"
              value="${esc(moneyDisplay(r.amount))}" placeholder="0.00"
              data-row="${i}" data-col="amount">
          </div>
          <div class="row-field" style="flex-direction:row;align-items:center;gap:6px;padding-bottom:3px">
            <input type="checkbox" class="tax-check" data-row="${i}" data-col="taxed"${r.taxed ? ' checked' : ''}>
            <span class="row-lbl" style="text-transform:none;letter-spacing:0;font-size:12px">Taxed?</span>
          </div>
          <div class="row-field">
            <span class="row-lbl">Rate %</span>
            <input type="text" inputmode="decimal" class="num-input rate-input"
              value="${esc(r.rateOverride)}" data-row="${i}" data-col="rateOverride"
              placeholder="${curDefaultRate()}"${r.taxed ? '' : ' disabled'}>
          </div>
          <div class="row-field">
            <span class="row-lbl">Tax</span>
            <span class="row-computed-val" data-cr="${i}" data-cc="tax">${fmt(c.tax)}</span>
          </div>
        </div>
        <div class="splits-section">
          ${splitsHtml}
          <button class="add-split-btn" data-add-split="${i}">+ Add Person</button>
          ${splits.length > 1 ? `<button class="eq-split-btn" data-eq-split="${i}">= Equal</button>` : ''}
        </div>
        <div class="row-line">
          <div class="row-field">
            <span class="row-lbl">Payee</span>
            <div class="combo-wrap">
              <input type="text" class="combo-input" data-row="${i}" data-col="payee" data-combo="payees" value="${esc(r.payee)}" autocomplete="off" placeholder="Payee">
              <ul class="combo-list"></ul>
            </div>
          </div>
          <div class="row-field" style="flex:1;min-width:0">
            <span class="row-lbl">Category</span>
            <div class="combo-wrap combo-full">
              <input type="text" class="combo-input" data-row="${i}" data-col="category" data-combo="categories" value="${esc(r.category)}" autocomplete="off" placeholder="Category">
              <ul class="combo-list"></ul>
            </div>
          </div>
        </div>
        <div class="row-line" style="justify-content:flex-end">
          <div class="row-field" style="align-items:flex-end">
            <span class="row-lbl">Total</span>
            <span class="row-computed-val" data-cr="${i}" data-cc="rtot" style="font-size:16px;color:#1e293b">${fmt(c.total)}</span>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = html;
  attachAllCombos(container);
  attachCardButtons(container);

  const totLine = document.getElementById('cards-total-line');
  const totEl   = document.getElementById('tot-tot');
  if (totLine) totLine.style.display = rows.length ? '' : 'none';
  if (totEl)   totEl.textContent = fmt(sumTot);
}

function refreshMainComputeds() {
  const comp = rows.map(computeRow);
  let sumTot = 0;

  rows.forEach((r, i) => {
    const c = comp[i];
    sumTot += c.total;

    const q = (cc, split) => split === undefined
      ? document.querySelector(`[data-cr="${i}"][data-cc="${cc}"]:not([data-split])`)
      : document.querySelector(`[data-cr="${i}"][data-split="${split}"][data-cc="${cc}"]`);

    const ct = q('tax');  if (ct) ct.textContent = fmt(c.tax);
    const cr = q('rtot'); if (cr) cr.textContent = fmt(c.total);

    c.splits.forEach((sc, j) => {
      const st = q('tot', j); if (st) st.textContent = fmt(sc.total);
    });

    const hdr = document.querySelector(`[data-rh="${i}"]`);
    if (hdr) hdr.textContent = rowSummary(r, c);
  });

  const totEl = document.getElementById('tot-tot');
  if (totEl) totEl.textContent = fmt(sumTot);
}

function rebuildCardSplits(idx) {
  const card = document.querySelector(`[data-card-idx="${idx}"]`);
  if (!card) { fullRender(); return; }

  const r = rows[idx];
  const c = computeRow(r);
  const splits = rowSplits(r);

  const splitsHtml = splits.map((s, j) => {
    const sc       = c.splits[j] || { total: 0 };
    const fracOpts = FRAC_OPTS.map(f =>
      `<option value="${f}"${s.fraction === f ? ' selected' : ''}>${f}</option>`
    ).join('');
    const rmBtn = splits.length > 1
      ? `<button class="remove-split-btn" data-remove-split="${idx}" data-split="${j}" title="Remove person">✕</button>`
      : '';
    return `<div class="split-row">
      <div class="row-field">
        <span class="row-lbl">Person</span>
        <div class="combo-wrap">
          <input type="text" class="combo-input" data-row="${idx}" data-split="${j}" data-col="assignee" data-combo="people" value="${esc(s.assignee)}" autocomplete="off" placeholder="Person">
          <ul class="combo-list"></ul>
        </div>
      </div>
      <div class="row-field">
        <span class="row-lbl">Fraction</span>
        <select class="frac-sel" data-row="${idx}" data-split="${j}" data-col="fraction">${fracOpts}</select>
      </div>
      <div class="row-field">
        <span class="row-lbl">Owes</span>
        <span class="row-computed-val" data-cr="${idx}" data-split="${j}" data-cc="tot">${fmt(sc.total)}</span>
      </div>
      ${rmBtn}
    </div>`;
  }).join('');

  const section = card.querySelector('.splits-section');
  section.innerHTML = splitsHtml + `<button class="add-split-btn" data-add-split="${idx}">+ Add Person</button>` + (splits.length > 1 ? `<button class="eq-split-btn" data-eq-split="${idx}">= Equal</button>` : '');
  attachAllCombos(section);

  refreshMainComputeds();
  buildCategoryTable();
  buildSummaryTable();
  persist();
}

/* ── Category pivot table ──────────────────────────────────────────── */

function buildCategoryTable() {
  const emptyEl   = document.getElementById('cat-empty');
  const contentEl = document.getElementById('cat-content');

  if (rows.length === 0) {
    emptyEl.style.display = '';
    contentEl.style.display = 'none';
    return;
  }

  const comp = rows.map(computeRow);
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  const catOrder  = [], catSet  = new Set();
  const asgnOrder = [], asgnSet = new Set();
  const effByCat = {}, taxByCat = {};
  rows.forEach((r, i) => {
    const cat = norm(r.category, '(uncategorized)');
    if (!catSet.has(cat)) { catSet.add(cat); catOrder.push(cat); effByCat[cat] = 0; taxByCat[cat] = 0; }
    rowSplits(r).forEach(s => {
      const asgn = norm(s.assignee, '(unassigned)');
      if (!asgnSet.has(asgn)) { asgnSet.add(asgn); asgnOrder.push(asgn); }
    });
  });

  // Track eff and tax separately per (asgn, cat)
  const Meff = {}, Mtax = {};
  asgnOrder.forEach(a => { Meff[a] = {}; Mtax[a] = {}; catOrder.forEach(c => { Meff[a][c] = 0; Mtax[a][c] = 0; }); });
  rows.forEach((r, i) => {
    const cat = norm(r.category, '(uncategorized)');
    rowSplits(r).forEach((s, j) => {
      const sc   = comp[i].splits[j];
      const asgn = norm(s.assignee, '(unassigned)');
      Meff[asgn][cat] += sc.eff;
      Mtax[asgn][cat] += sc.tax;
      effByCat[cat]   += sc.eff;
      taxByCat[cat]   += sc.tax;
    });
  });

  const cats = catOrder.filter(c => (effByCat[c] + taxByCat[c]) > 1e-9);

  if (cats.length === 0) {
    emptyEl.style.display = '';
    contentEl.style.display = 'none';
    return;
  }

  const fmtC = cents => '$' + (cents / 100).toFixed(2);
  const ncols = asgnOrder.length + 2; // label + assignees + total

  // Reconcile per-(asgn, cat) eff and total (eff+tax) cents
  const ReffC = {}, RtotC = {};
  asgnOrder.forEach(a => { ReffC[a] = {}; RtotC[a] = {}; });
  cats.forEach(c => {
    const effVals = asgnOrder.map(a => Meff[a][c]);
    const totVals = asgnOrder.map(a => Meff[a][c] + Mtax[a][c]);
    const effR = reconcileCents(effVals, effByCat[c], 'eff:' + c);
    const totR = reconcileCents(totVals, effByCat[c] + taxByCat[c], 'tot:' + c);
    asgnOrder.forEach((a, i) => { ReffC[a][c] = effR[i]; RtotC[a][c] = totR[i]; });
  });

  // Combine tip+fee per category, then distribute to assignees proportional to their share
  const grandTot = cats.reduce((s, c) => s + effByCat[c] + taxByCat[c], 0);
  const tipExact = cats.map(c => grandTot > 1e-9 ? (effByCat[c] + taxByCat[c]) / grandTot * tipVal : 0);
  const feeExact = cats.map(c => grandTot > 1e-9 ? (effByCat[c] + taxByCat[c]) / grandTot * feeVal : 0);
  const tipCents = reconcileCents(tipExact, grandTot > 1e-9 ? tipVal : 0, 'tip');
  const feeCents = reconcileCents(feeExact, grandTot > 1e-9 ? feeVal : 0, 'fee');
  // Distribute tip and fee separately within each category proportionally by assignee share
  const RtipC = {}, RfeeC = {};
  asgnOrder.forEach(a => { RtipC[a] = {}; RfeeC[a] = {}; });
  cats.forEach((c, i) => {
    const catTotC = asgnOrder.reduce((s, a) => s + RtotC[a][c], 0);
    const tipVals = asgnOrder.map(a => catTotC > 0 ? (RtotC[a][c] / catTotC) * (tipCents[i] / 100) : 0);
    const feeVals = asgnOrder.map(a => catTotC > 0 ? (RtotC[a][c] / catTotC) * (feeCents[i] / 100) : 0);
    const tipR = reconcileCents(tipVals, tipCents[i] / 100, 'tip:' + c);
    const feeR = reconcileCents(feeVals, feeCents[i] / 100, 'fee:' + c);
    asgnOrder.forEach((a, j) => { RtipC[a][c] = tipR[j]; RfeeC[a][c] = feeR[j]; });
  });

  // Build header: (blank) | asgn… | Total
  let hdr = '<tr><th class="th-left"></th>';
  asgnOrder.forEach(a => { hdr += `<th>${esc(a)}</th>`; });
  hdr += '<th>Total</th></tr>';
  document.getElementById('cat-matrix-thead').innerHTML = hdr;

  // Build body: 5 rows per category, then 5 grand-total rows
  const cell  = (v, cls = '')  => `<td class="computed${cls ? ' ' + cls : ''}">${v !== 0 ? fmtC(v) : '<span class="muted">—</span>'}</td>`;
  const cellS = (v, cls = '')  => `<td class="computed strong${cls ? ' ' + cls : ''}">${fmtC(v)}</td>`;
  const sep   = () => `<tr class="cat-separator"><td colspan="${ncols}"></td></tr>`;

  // Per-asgn grand accumulators
  const asgnEffC = {}; asgnOrder.forEach(a => { asgnEffC[a] = 0; });
  const asgnTotC = {}; asgnOrder.forEach(a => { asgnTotC[a] = 0; });
  const asgnTipC = {}; asgnOrder.forEach(a => { asgnTipC[a] = 0; });
  const asgnFeeC = {}; asgnOrder.forEach(a => { asgnFeeC[a] = 0; });

  let body = '';
  cats.forEach((c, i) => {
    const effTot = asgnOrder.reduce((s, a) => s + ReffC[a][c], 0);
    const totTot = asgnOrder.reduce((s, a) => s + RtotC[a][c], 0);
    const taxTot = totTot - effTot;
    const tipTot = tipCents[i];
    const feeTot = feeCents[i];
    const sumTot = totTot + tipTot + feeTot;

    // Cat Σ row — shows sum, collapses detail rows
    body += `<tr class="cat-head-row" data-cat-toggle="${i}"><td class="td-left cat-name-label">${esc(c)}</td>`;
    asgnOrder.forEach(a => {
      const aSum = RtotC[a][c] + RtipC[a][c] + RfeeC[a][c];
      body += cellS(aSum);
      asgnEffC[a] += ReffC[a][c]; asgnTotC[a] += RtotC[a][c];
      asgnTipC[a] += RtipC[a][c]; asgnFeeC[a] += RfeeC[a][c];
    });
    body += cellS(sumTot) + '</tr>';

    // Subtotal row
    body += `<tr data-cat-body="${i}"><td class="td-left cat-sub-label">Subtotal</td>`;
    asgnOrder.forEach(a => { body += cell(ReffC[a][c]); });
    body += cell(effTot) + '</tr>';

    // Tax row
    body += `<tr data-cat-body="${i}"><td class="td-left cat-sub-label">Tax</td>`;
    asgnOrder.forEach(a => { body += cell(RtotC[a][c] - ReffC[a][c]); });
    body += cell(taxTot) + '</tr>';

    // Tip row
    body += `<tr data-cat-body="${i}"><td class="td-left cat-sub-label">Tip</td>`;
    asgnOrder.forEach(a => { body += cell(RtipC[a][c]); });
    body += cell(tipTot) + '</tr>';

    // Fee row
    body += `<tr data-cat-body="${i}"><td class="td-left cat-sub-label">Fee</td>`;
    asgnOrder.forEach(a => { body += cell(RfeeC[a][c]); });
    body += cell(feeTot) + '</tr>';

    if (i < cats.length - 1) body += sep();
  });

  // Grand total rows
  const gEffC = asgnOrder.reduce((s, a) => s + asgnEffC[a], 0);
  const gTotC = asgnOrder.reduce((s, a) => s + asgnTotC[a], 0);
  const gTaxC = gTotC - gEffC;
  const gTipC = tipCents.reduce((s, v) => s + v, 0);
  const gFeeC = feeCents.reduce((s, v) => s + v, 0);
  const gSumC = gTotC + gTipC + gFeeC;

  body += sep();

  body += `<tr class="cat-grand-row cat-grand-start"><td class="td-left cat-name-label">Total</td>`;
  asgnOrder.forEach(a => { body += cellS(asgnTotC[a] + asgnTipC[a] + asgnFeeC[a]); });
  body += cellS(gSumC) + '</tr>';

  body += `<tr class="cat-grand-row"><td class="td-left cat-sub-label">Subtotal</td>`;
  asgnOrder.forEach(a => { body += cell(asgnEffC[a]); });
  body += cell(gEffC) + '</tr>';

  body += `<tr class="cat-grand-row"><td class="td-left cat-sub-label">Tax</td>`;
  asgnOrder.forEach(a => { body += cell(asgnTotC[a] - asgnEffC[a]); });
  body += cell(gTaxC) + '</tr>';

  body += `<tr class="cat-grand-row"><td class="td-left cat-sub-label">Tip</td>`;
  asgnOrder.forEach(a => { body += cell(asgnTipC[a]); });
  body += cell(gTipC) + '</tr>';

  body += `<tr class="cat-grand-row"><td class="td-left cat-sub-label">Fee</td>`;
  asgnOrder.forEach(a => { body += cell(asgnFeeC[a]); });
  body += cell(gFeeC) + '</tr>';

  document.getElementById('cat-matrix-tbody').innerHTML = body;

  // Grouped view (unchanged)
  const effCents = reconcileCents(cats.map(c => effByCat[c]), cats.reduce((s, c) => s + effByCat[c], 0), 'eff');
  const idxOf = {}; cats.forEach((c, i) => { idxOf[c] = i; });
  const line = (label, cents) => `<div class="grp-line"><span>${label}</span><span>${fmtC(cents)}</span></div>`;
  let g = '';
  cats.forEach((c, i) => {
    const subC   = effCents[i];
    const totC   = asgnOrder.reduce((s, a) => s + RtotC[a][c], 0);
    const txC    = totC - subC;
    const tpC    = tipCents[i];
    const feC    = feeCents[i];
    const finalC = totC + tpC + feC;
    g += `<div class="grp">
      <div class="grp-head"><span>${esc(c)}</span><span>${fmtC(finalC)}</span></div>
      ${line('Subtotal', subC)}
      ${line('Tax', txC)}
      ${line('Total', totC)}
      ${line('Tip', tpC)}
      ${line('Fee', feC)}
    </div>`;
  });
  document.getElementById('cat-grouped').innerHTML = g;

  emptyEl.style.display = 'none';
  contentEl.style.display = '';
}

/* ── Per-assignee summary ───────────────────────────────────────────── */

function buildSummaryTable() {
  const emptyEl = document.getElementById('sum-empty');
  const tableEl = document.getElementById('sum-table');

  if (rows.length === 0) {
    emptyEl.style.display = '';
    tableEl.style.display = 'none';
    document.getElementById('sum-tbody').innerHTML = '';
    return;
  }

  const comp   = rows.map(computeRow);
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  const asgnOrder = [], asgnSet = new Set(), asgnSub = {};
  rows.forEach((r, i) => {
    rowSplits(r).forEach((s, j) => {
      const sc   = comp[i].splits[j];
      const asgn = norm(s.assignee, '(unassigned)');
      if (!asgnSet.has(asgn)) { asgnSet.add(asgn); asgnOrder.push(asgn); asgnSub[asgn] = 0; }
      asgnSub[asgn] += sc.total;
    });
  });

  const grandTotal = asgnOrder.reduce((s, a) => s + asgnSub[a], 0);

  const tipExact = asgnOrder.map(a => grandTotal > 1e-9 ? asgnSub[a] / grandTotal * tipVal : 0);
  const feeExact = asgnOrder.map(a => grandTotal > 1e-9 ? asgnSub[a] / grandTotal * feeVal : 0);
  const tipCents = reconcileCents(tipExact, grandTotal > 1e-9 ? tipVal : 0, 'sum-tip');
  const feeCents = reconcileCents(feeExact, grandTotal > 1e-9 ? feeVal : 0, 'sum-fee');

  let html = '';

  asgnOrder.forEach((asgn, idx) => {
    const sub   = asgnSub[asgn];
    const share = grandTotal > 1e-9 ? sub / grandTotal : 0;
    const tip   = tipCents[idx] / 100;
    const fee   = feeCents[idx] / 100;
    const final = sub + tip + fee;
    html += `<tr>
      <td class="td-left">${esc(asgn)}</td>
      <td class="computed" style="white-space:nowrap">${fmt(sub)}</td>
      <td class="computed" style="white-space:nowrap">${(share * 100).toFixed(1)}%</td>
      <td class="computed" style="white-space:nowrap">${fmt(tip)}</td>
      <td class="computed" style="white-space:nowrap">${fmt(fee)}</td>
      <td class="computed" style="white-space:nowrap">${fmt(final)}</td>
      <td class="td-center" style="white-space:nowrap"><button class="btn-secondary" style="font-size:11px;padding:3px 9px" data-copy-person="${esc(asgn)}">Copy</button></td>
    </tr>`;
  });

  const shareTotPct = grandTotal > 1e-9 ? '100.0%' : '0.0%';
  html += `<tr class="totals-row">
    <td class="td-left">TOTAL</td>
    <td class="computed" style="white-space:nowrap">${fmt(grandTotal)}</td>
    <td class="computed" style="white-space:nowrap">${shareTotPct}</td>
    <td class="computed" style="white-space:nowrap">${fmt(tipVal)}</td>
    <td class="computed" style="white-space:nowrap">${fmt(feeVal)}</td>
    <td class="computed" style="white-space:nowrap">${fmt(grandTotal + tipVal + feeVal)}</td>
    <td class="td-center" style="white-space:nowrap"><button class="btn-secondary" style="font-size:11px;padding:3px 9px" id="copy-all-btn">Copy</button></td>
  </tr>`;

  document.getElementById('sum-tbody').innerHTML = html;
  emptyEl.style.display = 'none';
  tableEl.style.display = '';
}

/* ── Persistence ────────────────────────────────────────────────────── */

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      rows,
      defaultTaxRate: document.getElementById('default-tax-input').value,
      tip: document.getElementById('tip-input').value,
      fee: document.getElementById('fee-input').value
    }));
  } catch (_) { /* storage quota */ }
}

function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!Array.isArray(state.rows)) return false;
    rows = state.rows.map(r => {
      let taxed, rateOverride;
      if (('taxed' in r) || ('rateOverride' in r)) {
        taxed = !!r.taxed;
        rateOverride = r.rateOverride != null ? String(r.rateOverride) : '';
      } else {
        const tr = parseFloat(r.taxRate);
        if (isFinite(tr) && tr > 0) { taxed = true;  rateOverride = String(+(tr * 100).toFixed(4)); }
        else                        { taxed = false; rateOverride = ''; }
      }
      const splits = Array.isArray(r.splits) && r.splits.length > 0
        ? r.splits.map(s => ({
            assignee: String(s.assignee ?? ''),
            fraction: FRAC_OPTS.includes(s.fraction) ? s.fraction : '1'
          }))
        : [{ assignee: String(r.assignee ?? ''), fraction: FRAC_OPTS.includes(r.fraction) ? r.fraction : '1' }];
      return {
        amount:     String(r.amount ?? ''),
        taxed,
        rateOverride,
        payee:      String(r.payee ?? DEFAULT_PAYEES[0] ?? ''),
        category:   String(r.category ?? ''),
        memo:       String(r.memo ?? ''),
        splits,
        _collapsed: !!r._collapsed
      };
    });
    const dr = parseFloat(state.defaultTaxRate);
    document.getElementById('default-tax-input').value = isFinite(dr) ? String(dr) : '7';
    document.getElementById('tip-input').value = moneyDisplay(state.tip);
    document.getElementById('fee-input').value = moneyDisplay(state.fee);
    return true;
  } catch (_) { return false; }
}

/* ── Two-click confirm helper ───────────────────────────────────────── */

function wireTwoClickBtn(btnId, defaultLabel, armedLabel, action) {
  const btn = document.getElementById(btnId);
  let armed = false, timer = null;
  function reset() {
    armed = false;
    btn.textContent = defaultLabel;
    btn.classList.remove('btn-danger');
    if (timer) { clearTimeout(timer); timer = null; }
  }
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = armedLabel;
      btn.classList.add('btn-danger');
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    action();
  });
}

/* ── Event wiring ───────────────────────────────────────────────────── */

const mainCards = document.getElementById('main-cards');

function applyCell(el) {
  const idx  = parseInt(el.dataset.row, 10);
  const col  = el.dataset.col;
  if (isNaN(idx) || !col || !rows[idx]) return false;
  const r = rows[idx];

  if (el.dataset.split !== undefined) {
    const j = parseInt(el.dataset.split, 10);
    const splits = rowSplits(r);
    if (isNaN(j) || !splits[j]) return false;
    if (!r.splits) r.splits = splits;
    switch (col) {
      case 'assignee': r.splits[j].assignee = el.value; break;
      case 'fraction': r.splits[j].fraction = el.value; break;
      default: return false;
    }
    return true;
  }

  switch (col) {
    case 'amount':       r.amount       = el.value;   break;
    case 'rateOverride': r.rateOverride = el.value;   break;
    case 'payee':        r.payee        = el.value;   break;
    case 'category':     r.category     = el.value;   break;
    case 'memo':         r.memo         = el.value;   break;
    case 'taxed':        r.taxed        = el.checked; break;
    default: return false;
  }
  return true;
}

mainCards.addEventListener('input', e => {
  const el  = e.target;
  const col = el.dataset.col;
  if (col === 'amount') applyMoneyFormat(el);
  if (col === 'amount' || col === 'rateOverride') {
    if (applyCell(el)) partialUpdate();
  }
  if (col === 'memo') {
    if (applyCell(el)) { refreshMainComputeds(); persist(); }
  }
});

mainCards.addEventListener('change', e => {
  const el  = e.target;
  const col = el.dataset.col;
  if (!applyCell(el)) return;
  if (col === 'taxed') {
    const ov = mainCards.querySelector(`[data-row="${el.dataset.row}"][data-col="rateOverride"]`);
    if (ov) ov.disabled = !el.checked;
  }
  partialUpdate();
});

mainCards.addEventListener('click', e => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn && !e.target.closest('[data-remove-split]')) {
    const idx = parseInt(removeBtn.dataset.remove, 10);
    if (!isNaN(idx)) { rows.splice(idx, 1); fullRender(); }
    return;
  }
  const removeSplit = e.target.closest('[data-remove-split]');
  if (removeSplit) {
    const idx  = parseInt(removeSplit.dataset.removeSplit, 10);
    const sidx = parseInt(removeSplit.dataset.split, 10);
    if (!isNaN(idx) && !isNaN(sidx) && rows[idx]) {
      const splits = rowSplits(rows[idx]);
      if (splits.length > 1) {
        splits.splice(sidx, 1);
        rows[idx].splits = splits;
        applyEqualFractions(splits);
        rebuildCardSplits(idx);
      }
    }
    return;
  }
  const addSplit = e.target.closest('[data-add-split]');
  if (addSplit) {
    const idx = parseInt(addSplit.dataset.addSplit, 10);
    if (!isNaN(idx) && rows[idx]) {
      if (!rows[idx].splits) rows[idx].splits = rowSplits(rows[idx]);
      const splits   = rows[idx].splits;
      const usedNames = new Set(splits.map(s => s.assignee));
      const nextPerson = people.find(p => !usedNames.has(p)) || DEFAULT_PEOPLE.find(p => !usedNames.has(p)) || '';
      splits.push({ assignee: nextPerson, fraction: '1' });
      applyEqualFractions(splits);
      rebuildCardSplits(idx);
    }
    return;
  }
  const hdr = e.target.closest('[data-toggle]');
  if (hdr) {
    const idx = parseInt(hdr.dataset.toggle, 10);
    if (isNaN(idx) || !rows[idx]) return;
    rows[idx]._collapsed = !rows[idx]._collapsed;
    const card   = hdr.closest('.row-card');
    const body   = card.querySelector('.row-card-body');
    const toggle = card.querySelector('.row-toggle');
    body.classList.toggle('collapsed', rows[idx]._collapsed);
    if (toggle) toggle.textContent = rows[idx]._collapsed ? '▶' : '▼';
    persist();
  }
});

document.getElementById('cat-matrix-tbody').addEventListener('click', e => {
  const row = e.target.closest('tr[data-cat-toggle]');
  if (!row) return;
  const idx = row.dataset.catToggle;
  const collapsed = row.classList.toggle('cat-collapsed');
  document.querySelectorAll(`#cat-matrix-tbody tr[data-cat-body="${idx}"]`).forEach(r => {
    r.style.display = collapsed ? 'none' : '';
  });
});

document.getElementById('add-row-btn').addEventListener('click', () => {
  const prev = rows.length ? rows[rows.length - 1] : null;
  const row  = prev
    ? { ...prev, amount: '', rateOverride: '', _collapsed: false, splits: rowSplits(prev).map(s => ({ ...s })) }
    : newRow();
  rows.push(row);
  fullRender();
  const newIdx = rows.length - 1;
  const el = document.querySelector(`[data-row="${newIdx}"][data-col="amount"]`);
  if (el) { el.focus(); el.select(); }
});

wireTwoClickBtn('clear-btn', 'Clear All', 'Tap again to clear', () => {
  rows = [];
  setRoster(people,     DEFAULT_PEOPLE);
  setRoster(categories, DEFAULT_CATEGORIES);
  setRoster(payees,     DEFAULT_PAYEES);
  document.getElementById('default-tax-input').value = '7';
  document.getElementById('tip-input').value = '';
  document.getElementById('fee-input').value = '';
  try { localStorage.removeItem(LS_KEY); } catch (_) {}
  renderPeople();
  renderCategories();
  renderPayees();
  fullRender();
});

document.getElementById('default-tax-input').addEventListener('input', () => { partialUpdate(); });

function onTipFee(e) { applyMoneyFormat(e.target); buildCategoryTable(); buildSummaryTable(); persist(); }
document.getElementById('tip-input').addEventListener('input', onTipFee);
document.getElementById('fee-input').addEventListener('input', onTipFee);

/* ── Export ── */
document.getElementById('pdf-btn').addEventListener('click', () => { window.print(); });

/* ── Per-person clipboard copy ── */

function buildEmailData() {
  const comp   = rows.map(computeRow);
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  const aOrder = [], aSub = {};
  const cOrder = [], cEff = {}, cTax = {};
  rows.forEach((r, i) => {
    const c = norm(r.category, '(uncategorized)');
    if (!(c in cEff)) { cEff[c] = 0; cTax[c] = 0; cOrder.push(c); }
    rowSplits(r).forEach((s, j) => {
      const sc = comp[i].splits[j];
      const a  = norm(s.assignee, '(unassigned)');
      if (!(a in aSub)) { aSub[a] = 0; aOrder.push(a); }
      aSub[a]  += sc.total;
      cEff[c]  += sc.eff;
      cTax[c]  += sc.tax;
    });
  });

  const grand   = aOrder.reduce((s, a) => s + aSub[a], 0);
  const shareOf = v => grand > 1e-9 ? v / grand : 0;
  const cats    = cOrder.filter(c => (cEff[c] + cTax[c]) > 1e-9);

  const tipExact    = aOrder.map(a => grand > 1e-9 ? aSub[a] / grand * tipVal : 0);
  const feeExact    = aOrder.map(a => grand > 1e-9 ? aSub[a] / grand * feeVal : 0);
  const tipCentsArr = reconcileCents(tipExact, grand > 1e-9 ? tipVal : 0, 'email-tip');
  const feeCentsArr = reconcileCents(feeExact, grand > 1e-9 ? feeVal : 0, 'email-fee');

  return { tipVal, feeVal, aOrder, aSub, cEff, cTax, grand, shareOf, cats, tipCentsArr, feeCentsArr };
}

function emailSummaryHTML() {
  const { tipVal, feeVal, aOrder, aSub, cEff, cTax, grand, shareOf, cats, tipCentsArr, feeCentsArr } = buildEmailData();

  const S = {
    wrap:     'font-family:Arial,sans-serif;font-size:14px;color:#1e293b;',
    h1:       'font-size:18px;font-weight:bold;margin:0 0 4px;',
    sub:      'font-size:13px;color:#64748b;margin:0 0 20px;',
    h2:       'font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin:20px 0 6px;',
    tbl:      'border-collapse:collapse;font-size:14px;',
    thL:      'padding:6px 14px 6px 0;text-align:left;border-bottom:2px solid #334155;white-space:nowrap;font-weight:600;',
    thR:      'padding:6px 0 6px 14px;text-align:right;border-bottom:2px solid #334155;white-space:nowrap;font-weight:600;',
    tdL:      'padding:5px 14px 5px 0;border-bottom:1px solid #e2e8f0;white-space:nowrap;',
    tdR:      'padding:5px 0 5px 14px;text-align:right;border-bottom:1px solid #e2e8f0;white-space:nowrap;font-family:monospace;font-size:13px;',
    totL:     'padding:6px 14px 6px 0;border-top:2px solid #334155;border-bottom:none;white-space:nowrap;font-weight:bold;',
    totR:     'padding:6px 0 6px 14px;text-align:right;border-top:2px solid #334155;border-bottom:none;white-space:nowrap;font-weight:bold;font-family:monospace;font-size:13px;',
  };

  function htmlTable(headers, dataRows) {
    const ths = headers.map((h, i) => `<th style="${i === 0 ? S.thL : S.thR}">${esc(h)}</th>`).join('');
    const trs = dataRows.map((row, ri) => {
      const isTotal = ri === dataRows.length - 1;
      const cells = row.map((cell, ci) => {
        const s = ci === 0 ? (isTotal ? S.totL : S.tdL) : (isTotal ? S.totR : S.tdR);
        return `<td style="${s}">${esc(String(cell))}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table style="${S.tbl}"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  let html = `<div style="${S.wrap}">`;
  html += `<p style="${S.h1}">Transaction Summary</p>`;
  html += `<p style="${S.sub}">Items ${fmt(grand)} &nbsp;+&nbsp; Tip ${fmt(tipVal)} &nbsp;+&nbsp; Fee ${fmt(feeVal)} &nbsp;= <strong>${fmt(grand + tipVal + feeVal)}</strong></p>`;

  if (cats.length) {
    const totalEff = cats.reduce((s, c) => s + cEff[c], 0);
    const totalTax = cats.reduce((s, c) => s + cTax[c], 0);
    const totalAmt = totalEff + totalTax;
    const catRows = [
      ...cats.map(c => {
        const amt = cEff[c] + cTax[c];
        const tip = shareOf(amt) * tipVal;
        const fee = shareOf(amt) * feeVal;
        return [c, fmt(cEff[c]), fmt(cTax[c]), fmt(amt), fmt(tip), fmt(fee), fmt(amt + tip + fee)];
      }),
      ['Total', fmt(totalEff), fmt(totalTax), fmt(totalAmt), fmt(tipVal), fmt(feeVal), fmt(totalAmt + tipVal + feeVal)],
    ];
    html += `<p style="${S.h2}">By Category</p>`;
    html += htmlTable(['Category', 'Subtotal', 'Tax', 'Items', 'Tip', 'Fee', 'Total'], catRows);
  }

  const personRows = [
    ...aOrder.map((a, idx) => {
      const tip = tipCentsArr[idx] / 100;
      const fee = feeCentsArr[idx] / 100;
      return [a, fmt(aSub[a]), fmt(tip), fmt(fee), fmt(aSub[a] + tip + fee)];
    }),
    ['Total', fmt(grand), fmt(tipVal), fmt(feeVal), fmt(grand + tipVal + feeVal)],
  ];
  html += `<p style="${S.h2}">By Person</p>`;
  html += htmlTable(['Person', 'Subtotal', 'Tip', 'Fee', 'Total'], personRows);
  html += '</div>';
  return html;
}

function emailSummaryText() {
  const { tipVal, feeVal, aOrder, aSub, cEff, cTax, grand, shareOf, cats, tipCentsArr, feeCentsArr } = buildEmailData();

  function col(s, w) { return String(s).padStart(w); }
  function row(cells, widths) { return cells.map((c, i) => col(c, widths[i])).join('  '); }
  function divider(widths) { return widths.map(w => '-'.repeat(w)).join('  '); }

  const lines = [];
  lines.push('TRANSACTION SUMMARY');
  lines.push(`Total: ${fmt(grand + tipVal + feeVal)}  (items ${fmt(grand)}  tip ${fmt(tipVal)}  fee ${fmt(feeVal)})`);

  if (cats.length) {
    const totalEff = cats.reduce((s, c) => s + cEff[c], 0);
    const totalTax = cats.reduce((s, c) => s + cTax[c], 0);
    const totalAmt = totalEff + totalTax;
    const catW = Math.max(8, ...cats.map(c => c.length));
    const numW = 9;
    lines.push('', 'BY CATEGORY');
    lines.push(row(['Category'.padEnd(catW), 'Subtotal', 'Tax     ', 'Items   ', 'Tip     ', 'Fee     ', 'Total   '], [catW, numW, numW, numW, numW, numW, numW]));
    lines.push(divider([catW, numW, numW, numW, numW, numW, numW]));
    cats.forEach(c => {
      const amt = cEff[c] + cTax[c];
      const tip = shareOf(amt) * tipVal;
      const fee = shareOf(amt) * feeVal;
      lines.push([c.padEnd(catW), fmt(cEff[c]).padStart(numW), fmt(cTax[c]).padStart(numW), fmt(amt).padStart(numW), fmt(tip).padStart(numW), fmt(fee).padStart(numW), fmt(amt+tip+fee).padStart(numW)].join('  '));
    });
    lines.push(divider([catW, numW, numW, numW, numW, numW, numW]));
    lines.push(['Total'.padEnd(catW), fmt(totalEff).padStart(numW), fmt(totalTax).padStart(numW), fmt(totalAmt).padStart(numW), fmt(tipVal).padStart(numW), fmt(feeVal).padStart(numW), fmt(totalAmt+tipVal+feeVal).padStart(numW)].join('  '));
  }

  const nameW = Math.max(6, ...aOrder.map(a => a.length));
  const numW  = 9;
  lines.push('', 'BY PERSON');
  lines.push(row(['Person'.padEnd(nameW), 'Subtotal', 'Tip     ', 'Fee     ', 'Total   '], [nameW, numW, numW, numW, numW]));
  lines.push(divider([nameW, numW, numW, numW, numW]));
  aOrder.forEach((a, idx) => {
    const tip = tipCentsArr[idx] / 100;
    const fee = feeCentsArr[idx] / 100;
    lines.push([a.padEnd(nameW), fmt(aSub[a]).padStart(numW), fmt(tip).padStart(numW), fmt(fee).padStart(numW), fmt(aSub[a]+tip+fee).padStart(numW)].join('  '));
  });
  lines.push(divider([nameW, numW, numW, numW, numW]));
  lines.push(['Total'.padEnd(nameW), fmt(grand).padStart(numW), fmt(tipVal).padStart(numW), fmt(feeVal).padStart(numW), fmt(grand+tipVal+feeVal).padStart(numW)].join('  '));

  return lines.join('\n');
}

function buildPersonSummaryParts(person) {
  const comp   = rows.map(computeRow);
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  // Collect all assignees to reconcile tip/fee consistently with buildSummaryTable.
  const allOrder = [], allSet = new Set(), allSub = {};
  rows.forEach((r, i) => {
    rowSplits(r).forEach((s, j) => {
      const sc   = comp[i].splits[j];
      const asgn = norm(s.assignee, '(unassigned)');
      if (!allSet.has(asgn)) { allSet.add(asgn); allOrder.push(asgn); allSub[asgn] = 0; }
      allSub[asgn] += sc.total;
    });
  });
  const grandTotal = allOrder.reduce((s, a) => s + allSub[a], 0);

  const tipExact = allOrder.map(a => grandTotal > 1e-9 ? allSub[a] / grandTotal * tipVal : 0);
  const feeExact = allOrder.map(a => grandTotal > 1e-9 ? allSub[a] / grandTotal * feeVal : 0);
  const tipCents = reconcileCents(tipExact, grandTotal > 1e-9 ? tipVal : 0, 'sum-tip');
  const feeCents = reconcileCents(feeExact, grandTotal > 1e-9 ? feeVal : 0, 'sum-fee');
  const pIdx = allOrder.indexOf(person);

  let pEff = 0, pTax = 0;
  rows.forEach((r, i) => {
    rowSplits(r).forEach((s, j) => {
      if (norm(s.assignee, '(unassigned)') !== person) return;
      const sc = comp[i].splits[j];
      pEff += sc.eff; pTax += sc.tax;
    });
  });
  const pSub = pEff + pTax;
  const pTip  = pIdx >= 0 ? tipCents[pIdx] / 100 : 0;
  const pFee  = pIdx >= 0 ? feeCents[pIdx] / 100 : 0;
  const pTot  = pSub + pTip + pFee;

  const catOrder = [], catSet = new Set(), catEff = {}, catTax = {};
  rows.forEach((r, i) => {
    const cat = norm(r.category, '(uncategorized)');
    rowSplits(r).forEach((s, j) => {
      if (norm(s.assignee, '(unassigned)') !== person) return;
      const sc = comp[i].splits[j];
      if (!catSet.has(cat)) { catSet.add(cat); catOrder.push(cat); catEff[cat] = 0; catTax[cat] = 0; }
      catEff[cat] += sc.eff; catTax[cat] += sc.tax;
    });
  });

  return { person, pEff, pTax, pTip, pFee, pTot, catOrder, catEff, catTax, grandTotal, tipVal, feeVal };
}

function fmtComponents(eff, tax, tip, fee) {
  const parts = [fmt(eff)];
  if (Math.round(tax * 100) > 0) parts.push(fmt(tax));
  if (Math.round(tip * 100) > 0) parts.push(fmt(tip));
  if (Math.round(fee * 100) > 0) parts.push(fmt(fee));
  return parts.join(' + ');
}

function buildSinglePersonSummaryText(person) {
  const { pEff, pTax, pTip, pFee, pTot, catOrder, catEff, catTax, grandTotal, tipVal, feeVal } = buildPersonSummaryParts(person);
  const showCats = catOrder.length > 1 || (catOrder.length === 1 && catOrder[0] !== '(uncategorized)');
  const lines = [`# ${person}`, '', `- ${fmtComponents(pEff, pTax, pTip, pFee)} = ${fmt(pTot)}`];
  if (showCats) {
    catOrder.forEach(cat => {
      const cEff = catEff[cat], cTax = catTax[cat], cSub = cEff + cTax;
      const cTip = grandTotal > 1e-9 ? cSub / grandTotal * tipVal : 0;
      const cFee = grandTotal > 1e-9 ? cSub / grandTotal * feeVal : 0;
      lines.push(`- ${fmtComponents(cEff, cTax, cTip, cFee)} = ${fmt(cSub + cTip + cFee)}  ${cat}`);
    });
  }
  return lines.join('\n');
}

function buildSinglePersonSummaryHTML(person) {
  const { pEff, pTax, pTip, pFee, pTot, catOrder, catEff, catTax, grandTotal, tipVal, feeVal } = buildPersonSummaryParts(person);
  const showCats = catOrder.length > 1 || (catOrder.length === 1 && catOrder[0] !== '(uncategorized)');
  const mono = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#1e293b;line-height:1.7;';
  let html = `<div style="${mono}">`;
  html += `<div style="font-weight:bold;"># ${esc(person)}</div>`;
  html += `<div>- ${fmtComponents(pEff, pTax, pTip, pFee)} = ${fmt(pTot)}</div>`;
  if (showCats) {
    catOrder.forEach(cat => {
      const cEff = catEff[cat], cTax = catTax[cat], cSub = cEff + cTax;
      const cTip = grandTotal > 1e-9 ? cSub / grandTotal * tipVal : 0;
      const cFee = grandTotal > 1e-9 ? cSub / grandTotal * feeVal : 0;
      html += `<div style="padding-left:1em;">- ${fmtComponents(cEff, cTax, cTip, cFee)} = ${fmt(cSub + cTip + cFee)}  ${esc(cat)}</div>`;
    });
  }
  html += '</div>';
  return html;
}

function clipboardWrite(text, html, btn) {
  function flash(label) {
    const orig = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  }
  if (navigator.clipboard && window.ClipboardItem) {
    navigator.clipboard.write([new ClipboardItem({
      'text/html':  new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]).then(() => flash('Copied!')).catch(() =>
      navigator.clipboard.writeText(text).then(() => flash('Copied!')).catch(() => flash('Error'))
    );
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => flash('Copied!')).catch(() => flash('Error'));
  } else {
    flash('Error');
  }
}

document.getElementById('sum-tbody').addEventListener('click', e => {
  const btn = e.target.closest('[data-copy-person]');
  if (!btn) return;
  const person = btn.dataset.copyPerson;
  clipboardWrite(buildSinglePersonSummaryText(person), buildSinglePersonSummaryHTML(person), btn);
});

document.getElementById('sum-tbody').addEventListener('click', e => {
  const btn = e.target.closest('#copy-all-btn');
  if (!btn) return;

  const asgnOrder = [], asgnSet = new Set();
  rows.forEach(r => {
    rowSplits(r).forEach(s => {
      const asgn = norm(s.assignee, '(unassigned)');
      if (!asgnSet.has(asgn)) { asgnSet.add(asgn); asgnOrder.push(asgn); }
    });
  });

  const text = asgnOrder.map(p => buildSinglePersonSummaryText(p)).join('\n\n');
  const html = `<div>${asgnOrder.map(p => buildSinglePersonSummaryHTML(p)).join('<br>')}</div>`;
  clipboardWrite(text, html, btn);
});

/* ── Roster management ── */

function setRoster(target, src) {
  target.length = 0;
  src.forEach(n => target.push(String(n)));
}

function renderRoster(roster, chipsId, emptyMsg) {
  const box = document.getElementById(chipsId);
  box.innerHTML = roster.length
    ? roster.map((n, i) => `<span class="chip">${esc(n)}<button class="chip-x" data-idx="${i}" title="Remove">✕</button></span>`).join('')
    : `<span class="muted">${emptyMsg}</span>`;
}
function renderPeople()     { renderRoster(people,     'people-chips',   'No names yet — add one below.'); }
function renderCategories() { renderRoster(categories, 'category-chips', 'No categories yet — add one below.'); }
function renderPayees()     { renderRoster(payees,     'payee-chips',    'No payees yet — add one below.'); }

function wireRoster(roster, inputId, addBtnId, chipsId, rerender) {
  const inp = document.getElementById(inputId);
  function add() {
    const name = inp.value.trim();
    if (name && !roster.includes(name)) roster.push(name);
    inp.value = '';
    rerender();
    buildMainTable();
    persist();
  }
  document.getElementById(addBtnId).addEventListener('click', add);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  document.getElementById(chipsId).addEventListener('click', e => {
    const b = e.target.closest('[data-idx]');
    if (!b) return;
    const i = parseInt(b.dataset.idx, 10);
    if (isNaN(i)) return;
    roster.splice(i, 1);
    rerender();
    buildMainTable();
    persist();
  });
}

wireRoster(people,     'people-input',   'people-add-btn',   'people-chips',   renderPeople);
wireRoster(categories, 'category-input', 'category-add-btn', 'category-chips', renderCategories);
wireRoster(payees,     'payee-input',    'payee-add-btn',    'payee-chips',    renderPayees);

/* ── Roster "Load Defaults" and "Clear" buttons ── */
wireTwoClickBtn('people-defaults-btn',   'Load Defaults', 'Click again to confirm', () => { setRoster(people,     DEFAULT_PEOPLE);     renderPeople();     buildMainTable(); persist(); });
wireTwoClickBtn('category-defaults-btn', 'Load Defaults', 'Click again to confirm', () => { setRoster(categories, DEFAULT_CATEGORIES); renderCategories(); buildMainTable(); persist(); });
wireTwoClickBtn('payee-defaults-btn',    'Load Defaults', 'Click again to confirm', () => { setRoster(payees,     DEFAULT_PAYEES);     renderPayees();     buildMainTable(); persist(); });

wireTwoClickBtn('people-clear-btn',   'Clear', 'Confirm clear', () => { people.length     = 0; renderPeople();     buildMainTable(); persist(); });
wireTwoClickBtn('category-clear-btn', 'Clear', 'Confirm clear', () => { categories.length = 0; renderCategories(); buildMainTable(); persist(); });
wireTwoClickBtn('payee-clear-btn',    'Clear', 'Confirm clear', () => { payees.length      = 0; renderPayees();     buildMainTable(); persist(); });

/* ── Shared YNAB plan lookup ── */
async function ynabLookupPlan() {
  const apiKey     = document.getElementById('ynab-api-key').value.trim();
  const budgetName = document.getElementById('ynab-budget-name').value.trim();
  if (!apiKey)     throw new Error('Enter your YNAB API Key on the Setup tab first.');
  if (!budgetName) throw new Error('Enter your Budget Name on the YNAB tab first.');
  const headers  = { 'Authorization': 'Bearer ' + apiKey };
  const res      = await fetch('https://api.ynab.com/v1/budgets', { headers });
  if (!res.ok) throw new Error('API error ' + res.status);
  const plans    = (await res.json()).data.budgets || [];
  const plan     = plans.find(p => p.name === budgetName);
  if (!plan) throw new Error(`Budget "${budgetName}" not found`);
  return { plan, headers };
}

function wireYnabFetchBtn(btnId, fetchLabel, handler) {
  const btn = document.getElementById(btnId);
  btn.addEventListener('click', async () => {
    const orig = btn.textContent;
    btn.textContent = 'Fetching…';
    btn.disabled = true;
    try {
      const { plan, headers } = await ynabLookupPlan();
      const label = await handler(plan, headers);
      btn.textContent = label;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
    } catch (err) {
      btn.textContent = orig;
      btn.disabled = false;
      alert(err.message);
    }
  });
}

wireYnabFetchBtn('category-fetch-btn', 'Fetch from YNAB', async (plan, headers) => {
  const res    = await fetch(`https://api.ynab.com/v1/budgets/${plan.id}/categories`, { headers });
  if (!res.ok) throw new Error('API error ' + res.status);
  const groups = (await res.json()).data.category_groups || [];
  const fetched = [];
  groups.forEach(g => {
    if (g.hidden || g.deleted) return;
    (g.categories || []).forEach(c => {
      if (c.hidden || c.deleted) return;
      fetched.push(g.name + ' : ' + c.name);
    });
  });
  fetched.forEach(name => { if (!categories.includes(name)) categories.push(name); });
  renderCategories(); buildMainTable(); persist();
  return `Added ${fetched.length} categories`;
});

wireYnabFetchBtn('payee-fetch-btn', 'Fetch from YNAB', async (plan, headers) => {
  const res     = await fetch(`https://api.ynab.com/v1/budgets/${plan.id}/payees`, { headers });
  if (!res.ok) throw new Error('API error ' + res.status);
  const ynabPayees = (await res.json()).data.payees || [];
  const fetched = ynabPayees
    .filter(p => !p.deleted && !p.transfer_account_id)
    .map(p => p.name)
    .filter(name => name && !payees.includes(name));
  fetched.forEach(name => payees.push(name));
  payees.sort((a, b) => a.localeCompare(b));
  renderPayees(); buildMainTable(); persist();
  return `Added ${fetched.length} payees`;
});

/* ── "Clear Settings" button — clears rosters only, preserves API keys ── */
wireTwoClickBtn('clear-settings-btn', 'Clear Settings', 'Click again to confirm', () => {
  people.length     = 0;
  categories.length = 0;
  payees.length     = 0;
  renderPeople(); renderCategories(); renderPayees();
  buildMainTable(); persist();
});

/* ── "Clear Local Storage" button (two-click confirm) ── */
wireTwoClickBtn('clear-storage-btn', 'Clear Local Storage', 'Click again to confirm', () => {
  try { localStorage.removeItem(LS_KEY); } catch (_) {}
  try { localStorage.removeItem('txn-splitter-ynab-v1'); } catch (_) {}
  try { localStorage.removeItem('txn-splitter-sw-v1');   } catch (_) {}
  rows = [];
  document.getElementById('default-tax-input').value = '7';
  document.getElementById('tip-input').value = '';
  document.getElementById('fee-input').value = '';
  setRoster(people,     DEFAULT_PEOPLE);
  setRoster(categories, DEFAULT_CATEGORIES);
  setRoster(payees,     DEFAULT_PAYEES);
  renderPeople(); renderCategories(); renderPayees();
  document.getElementById('ynab-api-key').value         = '';
  document.getElementById('ynab-date').value            = new Date().toLocaleDateString('en-CA');
  document.getElementById('ynab-budget-name').value     = DEFAULT_YNAB.budgetName;
  document.getElementById('ynab-purchase-acct').value   = DEFAULT_YNAB.purchaseAcct;
  document.getElementById('ynab-payable-acct').value    = DEFAULT_YNAB.payableAcct;
  document.getElementById('ynab-receivable-acct').value = DEFAULT_YNAB.receivableAcct;
  document.getElementById('sw-api-key').value           = '';
  document.getElementById('sw-proxy-url').value         = '';
  document.getElementById('sw-description').value       = '';
  document.getElementById('sw-date').value              = new Date().toLocaleDateString('en-CA');
  document.getElementById('sw-currency').value          = 'USD';
  document.getElementById('sw-group-id').value          = '';
  fullRender();
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('cat-view-matrix').style.display  = tab === 'matrix'  ? '' : 'none';
    document.getElementById('cat-view-grouped').style.display = tab === 'grouped' ? '' : 'none';
  });
});

/* ── Main tab switching ── */
document.querySelectorAll('.main-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.mainTab;
    document.querySelectorAll('.main-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('main-tab-split').style.display      = tab === 'split'      ? '' : 'none';
    document.getElementById('main-tab-config').style.display     = tab === 'config'     ? '' : 'none';
    document.getElementById('main-tab-ynab').style.display       = tab === 'ynab'       ? '' : 'none';
    document.getElementById('main-tab-splitwise').style.display  = tab === 'splitwise'  ? '' : 'none';
    document.getElementById('main-tab-readme').style.display     = tab === 'readme'     ? '' : 'none';
  });
});

/* ── Bootstrap ──────────────────────────────────────────────────────── */

function bootstrap() {
  // Always apply config.json defaults so roster changes take effect on reload.
  // Only row data and numeric settings are preserved from localStorage.
  setRoster(people, DEFAULT_PEOPLE);
  setRoster(categories, DEFAULT_CATEGORIES);
  setRoster(payees, DEFAULT_PAYEES);
  // Apply YNAB config defaults for any field not already restored from localStorage.
  const ynabMap = [
    ['ynab-budget-name',    DEFAULT_YNAB.budgetName],
    ['ynab-purchase-acct',  DEFAULT_YNAB.purchaseAcct],
    ['ynab-payable-acct',   DEFAULT_YNAB.payableAcct],
    ['ynab-receivable-acct',DEFAULT_YNAB.receivableAcct],
  ];
  ynabMap.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && !el.value && val) el.value = val;
  });
  const restored = restore();
  if (!restored) rows = [];
  renderPeople();
  renderCategories();
  renderPayees();
  fullRender();
}

// Load config.json for default lists; fall back to hardcoded values if unavailable.
fetch('config.json')
  .then(r => r.ok ? r.json() : Promise.reject())
  .then(cfg => {
    if (Array.isArray(cfg.defaultPeople))     DEFAULT_PEOPLE     = cfg.defaultPeople;
    if (Array.isArray(cfg.defaultCategories)) DEFAULT_CATEGORIES = cfg.defaultCategories;
    if (Array.isArray(cfg.defaultPayees))     DEFAULT_PAYEES     = cfg.defaultPayees;
    if (cfg.ynabBudgetName)     DEFAULT_YNAB.budgetName    = cfg.ynabBudgetName;
    if (cfg.ynabPurchaseAcct)   DEFAULT_YNAB.purchaseAcct  = cfg.ynabPurchaseAcct;
    if (cfg.ynabPayableAcct)    DEFAULT_YNAB.payableAcct   = cfg.ynabPayableAcct;
    if (cfg.ynabReceivableAcct) DEFAULT_YNAB.receivableAcct = cfg.ynabReceivableAcct;
    if (cfg.splitwiseProxyUrl)  window._txnSplit.splitwiseProxyUrl = cfg.splitwiseProxyUrl;
  })
  .catch(() => { /* use hardcoded fallbacks */ })
  .finally(() => { bootstrap(); });

// Shared utilities for the YNAB and Splitwise script modules.
function addToPayees(names) {
  names.forEach(n => { if (!payees.includes(n)) payees.push(n); });
  payees.sort((a, b) => a.localeCompare(b));
  renderPayees();
  buildMainTable();
  persist();
}
window._txnSplit = { computeRow, esc, LS_KEY, addToPayees, reconcileCents, refreshHooks: [] };

})();
