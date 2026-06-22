/* ── YNAB Tab ────────────────────────────────────────────────────────── */
(function () {
'use strict';

const YNAB_API = 'https://api.ynab.com/v1';
const LS_YNAB  = 'txn-splitter-ynab-v1';

// Per-person direction: 'payable' (you owe them) or 'receivable' (they owe you).
// Defaults to 'receivable' — the common case is others owing Adam.
const ynabPersonDirections = {};
// Collapse state keyed by pane ID ('main' or 'person:<name>').
const ynabCollapseState    = {};

/* ── Persist / restore YNAB settings ── */

function ynabSave() {
  try {
    localStorage.setItem(LS_YNAB, JSON.stringify({
      apiKey:         document.getElementById('ynab-api-key').value,
      budgetName:     document.getElementById('ynab-budget-name').value,
      purchaseAcct:   document.getElementById('ynab-purchase-acct').value,
      payableAcct:    document.getElementById('ynab-payable-acct').value,
      receivableAcct: document.getElementById('ynab-receivable-acct').value
    }));
  } catch (_) {}
}

function ynabRestore() {
  try {
    const raw = localStorage.getItem(LS_YNAB);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.apiKey)         document.getElementById('ynab-api-key').value          = s.apiKey;
    if (s.budgetName)     document.getElementById('ynab-budget-name').value       = s.budgetName;
    if (s.purchaseAcct)   document.getElementById('ynab-purchase-acct').value     = s.purchaseAcct;
    if (s.payableAcct)    document.getElementById('ynab-payable-acct').value      = s.payableAcct;
    if (s.receivableAcct) document.getElementById('ynab-receivable-acct').value   = s.receivableAcct;
  } catch (_) {}
}

/* ── Helpers ── */

// Shared utilities from the main module via the _txnSplit namespace.
const { computeRow: _computeRow, esc: escHtml, LS_KEY: _LS_KEY } = window._txnSplit;

// YNAB amounts are milliunits (1 USD = 1000 milliunits).
// Positive = inflow, negative = outflow.
function toMilliunits(dollars) {
  return Math.round(parseFloat(dollars) * 1000) || 0;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getTxnDate() {
  const el = document.getElementById('ynab-date');
  return (el && el.value) ? el.value : todayISO();
}

function _getRows() {
  return JSON.parse(localStorage.getItem(_LS_KEY) || '{"rows":[]}').rows || [];
}

/* ── Build main (overall) YNAB transaction ── */
// Outflow from the Purchase Account (e.g. Apple : Mastercard), subtransactions per category.
// Each category subtransaction uses the payee of the first row in that category.

function buildMainYnabTransaction() {
  const rows   = _getRows();
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  const catOrder = [], catSet = new Set(), catData = {};
  let grandTotal = 0;
  let topPayee   = 'Payee';

  rows.forEach((r, idx) => {
    const comp  = _computeRow(r);
    if (comp.total < 1e-9) return;
    const cat   = (r.category || '').trim() || '(uncategorized)';
    const payee = (r.payee    || '').trim() || 'Payee';
    const memo  = (r.memo     || '').trim();
    if (idx === 0 || topPayee === 'Payee') topPayee = payee;
    if (!catSet.has(cat)) {
      catSet.add(cat);
      catOrder.push(cat);
      catData[cat] = { eff: 0, tax: 0, payee, memo: '' };
    }
    if (memo) catData[cat].memo = catData[cat].memo ? catData[cat].memo + '; ' + memo : memo;
    catData[cat].eff += comp.eff;
    catData[cat].tax += comp.tax;
    grandTotal += comp.total;
  });

  const total = grandTotal + tipVal + feeVal;
  if (total < 1e-9) return null;

  const allMemos = [...new Set(rows.map(r => (r.memo || '').trim()).filter(Boolean))].join('; ');

  const subtransactions = [];
  catOrder.forEach(cat => {
    const d = catData[cat];
    if (d.eff > 1e-9) subtransactions.push({ amount: toMilliunits(-d.eff), payee_name: d.payee, category_name: cat, ...(d.memo ? { memo: d.memo } : {}) });
    if (d.tax > 1e-9) subtransactions.push({ amount: toMilliunits(-d.tax), payee_name: 'Sales Tax', category_name: cat });
  });
  const primaryCat = catOrder[0] || undefined;
  if (tipVal > 1e-9) subtransactions.push({ amount: toMilliunits(-tipVal), payee_name: 'Tip', category_name: primaryCat });
  if (feeVal > 1e-9) subtransactions.push({ amount: toMilliunits(-feeVal), payee_name: 'Fee', category_name: primaryCat });

  // Derive the transaction amount from the subtransactions so YNAB's
  // required constraint (sum(subtransactions) == transaction.amount) is
  // guaranteed even when individual toMilliunits() calls round differently.
  const txnAmount = subtransactions.length > 0
    ? subtransactions.reduce((s, sub) => s + sub.amount, 0)
    : toMilliunits(-total);

  return {
    type: 'main',
    total,
    payload: {
      transaction: {
        account_id:      null, // resolved at submit time
        date:            getTxnDate(),
        amount:          txnAmount,
        payee_name:      topPayee,
        ...(allMemos ? { memo: allMemos } : {}),
        flag_color:      'blue',
        approved:        false,
        subtransactions
      }
    }
  };
}

/* ── Build per-person YNAB transaction payloads ── */

function buildPersonYnabTransactions() {
  const rows   = _getRows();
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  const personOrder = [], personSet = new Set(), personData = {};

  rows.forEach(r => {
    const comp  = _computeRow(r);
    const cat   = (r.category || '').trim() || '(uncategorized)';
    const payee = (r.payee    || '').trim() || 'Payee';
    const memo  = (r.memo     || '').trim();
    const splits = Array.isArray(r.splits) && r.splits.length > 0
      ? r.splits : [{ assignee: r.assignee || '', fraction: r.fraction || '1' }];
    splits.forEach((s, j) => {
      const sc     = comp.splits ? comp.splits[j] : comp;
      if (!sc || sc.total < 1e-9) return;
      const person = (s.assignee || '').trim() || '(unassigned)';
      if (!personSet.has(person)) { personSet.add(person); personOrder.push(person); personData[person] = {}; }
      if (!personData[person][cat]) personData[person][cat] = { eff: 0, tax: 0, payee, memo: '' };
      if (memo) personData[person][cat].memo = personData[person][cat].memo ? personData[person][cat].memo + '; ' + memo : memo;
      personData[person][cat].eff += sc.eff;
      personData[person][cat].tax += sc.tax;
    });
  });

  if (personOrder.length === 0) return [];

  let grandTotal = 0;
  personOrder.forEach(p => { Object.values(personData[p]).forEach(d => { grandTotal += d.eff + d.tax; }); });

  const date = getTxnDate();
  const results = [];

  personOrder.forEach(person => {
    const cats = Object.keys(personData[person]);
    let personTotal = 0;
    cats.forEach(c => { personTotal += personData[person][c].eff + personData[person][c].tax; });
    if (personTotal < 1e-9) return;

    const share       = grandTotal > 1e-9 ? personTotal / grandTotal : 0;
    const personTip   = share * tipVal;
    const personFee   = share * feeVal;
    const personFinal = personTotal + personTip + personFee;

    const direction = ynabPersonDirections[person] || 'receivable';
    const sign      = direction === 'payable' ? -1 : 1;

    const subtransactions = [];
    cats.forEach(cat => {
      const d = personData[person][cat];
      if (d.eff > 1e-9) subtransactions.push({ amount: toMilliunits(sign * d.eff), payee_name: d.payee, category_name: cat, ...(d.memo ? { memo: d.memo } : {}) });
      if (d.tax > 1e-9) subtransactions.push({ amount: toMilliunits(sign * d.tax), payee_name: 'Sales Tax', category_name: cat });
    });
    const primaryCat = cats[0] || undefined;
    if (personTip > 1e-9) subtransactions.push({ amount: toMilliunits(sign * personTip), payee_name: 'Tip', category_name: primaryCat });
    if (personFee > 1e-9) subtransactions.push({ amount: toMilliunits(sign * personFee), payee_name: 'Fee', category_name: primaryCat });

    const txnAmount = subtransactions.length > 0
      ? subtransactions.reduce((s, sub) => s + sub.amount, 0)
      : toMilliunits(sign * personFinal);

    results.push({
      type:      'person',
      person,
      direction,
      total:     personFinal,
      payload: {
        transaction: {
          account_id:      null, // resolved at submit time
          date,
          amount:          txnAmount,
          payee_name:      person,
          flag_color:      direction === 'payable' ? 'blue' : 'red',
          approved:        false,
          subtransactions
        }
      }
    });
  });

  return results;
}

// Combined: main transaction first, then per-person.
function buildAllYnabTransactions() {
  const all  = [];
  const main = buildMainYnabTransaction();
  if (main) all.push(main);
  all.push(...buildPersonYnabTransactions());
  return all;
}

/* ── Render YNAB panes ── */

function renderYnabPanes() {
  const panesEl = document.getElementById('ynab-panes');
  const emptyEl = document.getElementById('ynab-empty');
  const txns    = buildAllYnabTransactions();

  const apiKey         = document.getElementById('ynab-api-key').value.trim();
  const payableAcct    = document.getElementById('ynab-payable-acct').value.trim()    || '<payable-account>';
  const receivableAcct = document.getElementById('ynab-receivable-acct').value.trim()  || '<receivable-account>';
  const purchaseAcct   = document.getElementById('ynab-purchase-acct').value.trim()    || '<purchase-account>';

  if (txns.length === 0) {
    emptyEl.style.display = '';
    panesEl.innerHTML = '';
    return;
  }
  emptyEl.style.display = 'none';

  panesEl.innerHTML = txns.map((t, idx) => {
    let acctName, dirBadge, dirBtns;

    if (t.type === 'main') {
      acctName  = purchaseAcct;
      dirBadge  = `<span class="ynab-direction main-expense">Expense → ${escHtml(acctName)}</span>`;
      dirBtns   = '';
    } else {
      const dir = t.direction;
      acctName  = dir === 'payable' ? payableAcct : receivableAcct;
      dirBadge  = `<span class="ynab-direction ${dir}">${dir === 'payable' ? 'You owe' : 'Owed to you'} → ${escHtml(acctName)}</span>`;
      dirBtns   = `<div class="ynab-dir-btns">
        <button class="ynab-dir-btn${dir === 'payable'    ? ' dir-payable-active'    : ''}" data-ynab-dir-val="payable">You owe → Payable</button>
        <button class="ynab-dir-btn${dir === 'receivable' ? ' dir-receivable-active' : ''}" data-ynab-dir-val="receivable">Owed to you → Receivable</button>
      </div>`;
    }

    const headLabel = t.type === 'main'
      ? `All Items — $${t.total.toFixed(2)}`
      : `${escHtml(t.person)} — $${t.total.toFixed(2)}`;

    const paneId    = t.type === 'main' ? 'main' : 'person:' + t.person;
    const collapsed = ynabCollapseState[paneId] ? ' collapsed' : '';

    const displayPayload = JSON.parse(JSON.stringify(t.payload));
    displayPayload.transaction.account_id = `<id of "${acctName}" account>`;
    const jsonStr = JSON.stringify(displayPayload, null, 2);

    const curlCmd = [
      `curl -s -X POST \\`,
      `  "${YNAB_API}/budgets/<budget-id>/transactions" \\`,
      `  -H "Authorization: Bearer ${apiKey ? '****' : '<API_KEY>'}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${JSON.stringify(t.payload)}'`
    ].join('\n');

    const personAttr = t.type === 'person' ? ` data-ynab-person="${escHtml(t.person)}"` : '';

    return `<div class="ynab-pane${collapsed}" data-pane-id="${escHtml(paneId)}" data-ynab-idx="${idx}"${personAttr}>
      <div class="ynab-pane-head">
        <span>${headLabel}</span>
        <div style="display:flex;gap:8px;align-items:center">
          ${dirBadge}
          <span class="collapse-chevron">▾</span>
        </div>
      </div>
      <div class="ynab-pane-body">
        ${dirBtns}
        <div class="ynab-preview-label">JSON Payload</div>
        <pre class="ynab-code">${escHtml(jsonStr)}</pre>
        <div class="ynab-preview-label">curl Command</div>
        <pre class="ynab-code">${escHtml(curlCmd)}</pre>
        <div style="margin-top:10px">
          <button class="btn-primary" style="font-size:12px;padding:7px 14px" data-ynab-submit="${idx}">Submit to YNAB</button>
        </div>
        <div class="ynab-status" id="ynab-status-${idx}"></div>
      </div>
    </div>`;
  }).join('');
}

/* ── Submit to YNAB ── */

async function submitToYnab(idx) {
  const apiKey         = document.getElementById('ynab-api-key').value.trim();
  const budgetName     = document.getElementById('ynab-budget-name').value.trim();
  const payableAcct    = document.getElementById('ynab-payable-acct').value.trim();
  const receivableAcct = document.getElementById('ynab-receivable-acct').value.trim();
  const purchaseAcct   = document.getElementById('ynab-purchase-acct').value.trim();
  const statusEl       = document.getElementById('ynab-status-' + idx);

  function setStatus(cls, msg) {
    statusEl.className = 'ynab-status ' + cls;
    statusEl.textContent = msg;
  }

  if (!apiKey)     { setStatus('err', 'Please enter your YNAB API Key on the Setup tab.'); return; }
  if (!budgetName) { setStatus('err', 'Please enter the Budget Name.'); return; }

  const txns = buildAllYnabTransactions();
  if (idx >= txns.length) return;
  const t = txns[idx];

  let acctName;
  if (t.type === 'main') {
    acctName = purchaseAcct;
    if (!acctName) { setStatus('err', 'Please enter the Purchase Account name.'); return; }
  } else {
    acctName = t.direction === 'payable' ? payableAcct : receivableAcct;
    if (!acctName) { setStatus('err', `Please enter the ${t.direction === 'payable' ? 'Payable' : 'Receivable'} account name.`); return; }
  }

  const headers = { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };

  statusEl.style.display = 'block';
  statusEl.className = 'ynab-status';
  statusEl.textContent = 'Looking up budget…';

  try {
    const plansRes = await fetch(YNAB_API + '/plans', { headers });
    if (!plansRes.ok) throw new Error('Failed to fetch budgets: ' + plansRes.status + ' ' + await plansRes.text());
    const plansData = await plansRes.json();
    const plans = plansData.data.plans || [];
    const plan = plans.find(p => p.name === budgetName);
    if (!plan) throw new Error(`Budget "${budgetName}" not found. Available: ${plans.map(p => p.name).join(', ')}`);

    statusEl.textContent = 'Looking up account…';
    const acctRes = await fetch(`${YNAB_API}/plans/${plan.id}/accounts`, { headers });
    if (!acctRes.ok) throw new Error('Failed to fetch accounts: ' + acctRes.status + ' ' + await acctRes.text());
    const acctData = await acctRes.json();
    const accounts = acctData.data.accounts || [];
    const account  = accounts.find(a => a.name === acctName);
    if (!account) throw new Error(`Account "${acctName}" not found. Available: ${accounts.map(a => a.name).join(', ')}`);

    statusEl.textContent = 'Looking up categories…';
    const catsRes = await fetch(`${YNAB_API}/plans/${plan.id}/categories`, { headers });
    if (!catsRes.ok) throw new Error('Failed to fetch categories: ' + catsRes.status + ' ' + await catsRes.text());
    const catsData = await catsRes.json();
    const categoryMap = {};
    (catsData.data.category_groups || []).forEach(g => {
      (g.categories || []).forEach(c => {
        categoryMap[c.name] = c.id;                   // "Groceries"
        categoryMap[g.name + ' : ' + c.name] = c.id; // "Food : Groceries"
      });
    });

    const payload = JSON.parse(JSON.stringify(t.payload));
    payload.transaction.account_id = account.id;
    const unresolved = [];
    (payload.transaction.subtransactions || []).forEach(sub => {
      if (sub.category_name) {
        const id = categoryMap[sub.category_name];
        if (id) { sub.category_id = id; }
        else { unresolved.push(sub.category_name); }
        delete sub.category_name;
      }
    });
    if (unresolved.length) {
      const available = Object.keys(categoryMap).filter(k => k.includes(' : ')).join(', ') || Object.keys(categoryMap).join(', ');
      throw new Error(`Category not found: "${unresolved[0]}". Available: ${available}`);
    }

    statusEl.textContent = 'Submitting transaction…';
    const txnRes  = await fetch(`${YNAB_API}/plans/${plan.id}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const txnData = await txnRes.json();
    if (!txnRes.ok) {
      const detail = txnData.error ? txnData.error.detail || txnData.error.name : JSON.stringify(txnData);
      throw new Error('YNAB error: ' + detail);
    }
    const txnId = txnData.data && txnData.data.transaction ? txnData.data.transaction.id : '?';
    setStatus('ok', `Transaction created! ID: ${txnId}`);
  } catch (err) {
    setStatus('err', err.message);
  }
}

/* ── Wire up YNAB settings inputs ── */

['ynab-api-key','ynab-date','ynab-budget-name','ynab-purchase-acct','ynab-payable-acct','ynab-receivable-acct'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => { ynabSave(); renderYnabPanes(); });
});

// Delegate pane button clicks: collapse toggles, direction toggles, submit.
document.getElementById('ynab-panes').addEventListener('click', e => {
  // Collapse/expand on header click
  const head = e.target.closest('.ynab-pane-head');
  if (head) {
    const pane = head.closest('.ynab-pane');
    if (pane) {
      const collapsed = pane.classList.toggle('collapsed');
      ynabCollapseState[pane.dataset.paneId] = collapsed;
    }
    return;
  }

  // Direction toggle
  const dirBtn = e.target.closest('[data-ynab-dir-val]');
  if (dirBtn) {
    const pane = dirBtn.closest('.ynab-pane');
    if (pane && pane.dataset.ynabPerson) {
      ynabPersonDirections[pane.dataset.ynabPerson] = dirBtn.dataset.ynabDirVal;
      renderYnabPanes();
    }
    return;
  }

  // Submit button
  const submitBtn = e.target.closest('[data-ynab-submit]');
  if (!submitBtn) return;
  const idx = parseInt(submitBtn.dataset.ynabSubmit, 10);
  submitBtn.disabled = true;
  submitToYnab(idx).finally(() => { submitBtn.disabled = false; });
});

/* ── Keep panes fresh when split data changes ── */
const _ynabObserver = new MutationObserver(() => renderYnabPanes());
_ynabObserver.observe(document.getElementById('sum-tbody'), { childList: true, subtree: true, characterData: true });

/* ── Bootstrap ── */
ynabRestore();
document.getElementById('ynab-date').value = todayISO();
renderYnabPanes();
window._txnSplit.refreshHooks.push(renderYnabPanes);

})();
