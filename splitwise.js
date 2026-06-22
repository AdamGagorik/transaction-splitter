/* ── Splitwise Tab ────────────────────────────────────────────────────── */
(function () {
'use strict';

const SW_API = 'https://secure.splitwise.com/api/v3.0';
const LS_SW  = 'txn-splitter-sw-v1';

const { computeRow: _computeRow, esc: escHtml, LS_KEY: _LS_KEY } = window._txnSplit;

function getSwApiKey() {
  // Strip control characters that would make the Authorization header invalid.
  return document.getElementById('sw-api-key').value.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function getSwBase() {
  const manual  = document.getElementById('sw-proxy-url').value.trim().replace(/\/+$/, '');
  const fromCfg = (window._txnSplit.splitwiseProxyUrl || '').replace(/\/+$/, '');
  return manual || fromCfg || SW_API;
}

// Splitwise user ID per assignee name, persisted across sessions.
let swUserMap = {}; // { [assignee]: { userId: '' } }
let swPayer   = ''; // name of the paying assignee
let swFriends = []; // cached GET /get_friends response, in-memory only
let swGroups  = []; // cached GET /get_groups response, in-memory only

/* ── Persist / restore ── */

function swSave() {
  try {
    localStorage.setItem(LS_SW, JSON.stringify({
      apiKey:      document.getElementById('sw-api-key').value,
      description: document.getElementById('sw-description').value,
      currency:    document.getElementById('sw-currency').value,
      groupId:     document.getElementById('sw-group-id').value,
      proxyUrl:    document.getElementById('sw-proxy-url').value.trim(),
      swUserMap,
      swPayer
    }));
  } catch (_) {}
}

function swRestore() {
  try {
    const raw = localStorage.getItem(LS_SW);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.apiKey)      document.getElementById('sw-api-key').value      = s.apiKey;
    if (s.description) document.getElementById('sw-description').value  = s.description;
    if (s.currency)    document.getElementById('sw-currency').value      = s.currency;
    if (s.groupId)     document.getElementById('sw-group-id').value      = s.groupId;
    if (s.proxyUrl)    document.getElementById('sw-proxy-url').value     = s.proxyUrl;
    if (s.swUserMap && typeof s.swUserMap === 'object') Object.assign(swUserMap, s.swUserMap);
    if (s.swPayer)     swPayer = s.swPayer;
  } catch (_) {}
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function getSwDate() {
  const el = document.getElementById('sw-date');
  return (el && el.value) ? el.value : todayISO();
}

function _getRows() {
  return JSON.parse(localStorage.getItem(_LS_KEY) || '{"rows":[]}').rows || [];
}

/* ── Build expense data ── */

function buildSwExpense() {
  const rows   = _getRows();
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;

  const personOrder = [], personSet = new Set();
  const personEff = {}, personTax = {};

  rows.forEach(r => {
    const comp   = _computeRow(r);
    const splits = Array.isArray(r.splits) && r.splits.length > 0
      ? r.splits : [{ assignee: r.assignee || '', fraction: r.fraction || '1' }];
    splits.forEach((s, j) => {
      const sc     = comp.splits ? comp.splits[j] : comp;
      if (!sc || sc.total < 1e-9) return;
      const person = (s.assignee || '').trim() || '(unassigned)';
      if (!personSet.has(person)) {
        personSet.add(person); personOrder.push(person);
        personEff[person] = 0; personTax[person] = 0;
      }
      personEff[person] += sc.eff;
      personTax[person] += sc.tax;
    });
  });

  if (personOrder.length === 0) return null;

  const grandTotal = personOrder.reduce((s, p) => s + personEff[p] + personTax[p], 0);

  const cost = grandTotal + tipVal + feeVal;

  const persons = personOrder.map(person => {
    const items = personEff[person] + personTax[person];
    const share = grandTotal > 1e-9 ? items / grandTotal : 0;
    const tip   = share * tipVal;
    const fee   = share * feeVal;
    return {
      name:   person,
      userId: (swUserMap[person] && swUserMap[person].userId) ? swUserMap[person].userId.trim() : '',
      items:  personEff[person],
      tax:    personTax[person],
      tip,
      fee,
      total:  items + tip + fee
    };
  });

  // Reconcile per-person totals to cents so sum(owed_share) == cost exactly,
  // as required by the Splitwise API.
  const totalCentsArr = window._txnSplit.reconcileCents(persons.map(p => p.total), cost, 'sw-person-totals');
  const personsOut = persons.map((p, i) => ({ ...p, totalCents: totalCentsArr[i] }));

  const payer = (swPayer && personOrder.includes(swPayer)) ? swPayer : personOrder[0];
  return { persons: personsOut, cost, payer };
}

/* ── Build Splitwise API payload ── */

function buildSwPayload(expData) {
  const { persons, cost, payer } = expData;
  const desc     = document.getElementById('sw-description').value.trim() || 'Transaction';
  const currency = document.getElementById('sw-currency').value.trim()    || 'USD';
  const groupId  = document.getElementById('sw-group-id').value.trim();

  // Splitwise requires flattened double-underscore keys, not a nested users array.
  const payload = {
    cost:          cost.toFixed(2),
    description:   desc,
    date:          getSwDate(),
    currency_code: currency,
    split_equally: false,
  };
  persons.forEach((p, i) => {
    payload[`users__${i}__user_id`]    = parseInt(p.userId, 10) || p.userId;
    payload[`users__${i}__paid_share`] = (p.name === payer ? cost : 0).toFixed(2);
    payload[`users__${i}__owed_share`] = (p.totalCents / 100).toFixed(2);
  });
  payload.group_id = groupId ? (parseInt(groupId, 10) || groupId) : 0;
  return payload;
}

/* ── Render user-mapping table ── */

function renderSwUserMap() {
  const rows  = _getRows();
  const names = [];
  const seen  = new Set();
  rows.forEach(r => {
    (Array.isArray(r.splits) && r.splits.length > 0 ? r.splits : [{ assignee: r.assignee || '' }]).forEach(s => {
      const p = (s.assignee || '').trim() || '(unassigned)';
      if (!seen.has(p)) { seen.add(p); names.push(p); }
    });
  });

  const container = document.getElementById('sw-user-map');
  if (!container) return;

  if (names.length === 0) {
    container.innerHTML = '<p class="ynab-empty">Add rows with assignees to set up user mapping.</p>';
    return;
  }

  const hasFriends = swFriends.length > 0;

  let html = `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:4px">
    <thead><tr>
      <th style="text-align:left;padding:5px 8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Assignee</th>
      <th style="text-align:left;padding:5px 8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b">Splitwise User</th>
    </tr></thead><tbody>`;

  names.forEach(name => {
    const uid = (swUserMap[name] && swUserMap[name].userId) ? swUserMap[name].userId : '';
    let inputHtml;
    if (hasFriends) {
      const opts = swFriends.map(f => {
        const label = escHtml(f.first_name + (f.last_name ? ' ' + f.last_name : '') + (f.email ? ' (' + f.email + ')' : ''));
        return `<option value="${f.id}"${String(f.id) === String(uid) ? ' selected' : ''}>${label}</option>`;
      }).join('');
      inputHtml = `<select class="sw-uid-select" data-person="${escHtml(name)}"
        style="max-width:280px;border:1px solid #e2e8f0;border-radius:5px;padding:4px 7px;font-size:13px">
        <option value="">— select friend —</option>
        ${opts}
      </select>`;
    } else {
      inputHtml = `<input type="text" class="sw-uid-input" data-person="${escHtml(name)}"
        value="${escHtml(uid)}" placeholder="e.g. 12345678" inputmode="numeric"
        style="width:160px;border:1px solid #e2e8f0;border-radius:5px;padding:4px 7px;font-size:13px">`;
    }
    html += `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-weight:500">${escHtml(name)}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9">${inputHtml}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">${html}</div>`;

  container.querySelectorAll('.sw-uid-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const p = inp.dataset.person;
      if (!swUserMap[p]) swUserMap[p] = {};
      swUserMap[p].userId = inp.value;
      swSave();
      renderSwPane();
    });
  });

  container.querySelectorAll('.sw-uid-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const p = sel.dataset.person;
      if (!swUserMap[p]) swUserMap[p] = {};
      swUserMap[p].userId = sel.value;
      swSave();
      renderSwPane();
    });
  });
}

/* ── Update payer dropdown ── */

function renderSwPayerDropdown(names) {
  const sel = document.getElementById('sw-payer');
  if (!sel) return;
  const current = (swPayer && names.includes(swPayer)) ? swPayer : names[0] || '';
  sel.innerHTML = names.length
    ? names.map(n => `<option value="${escHtml(n)}"${n === current ? ' selected' : ''}>${escHtml(n)}</option>`).join('')
    : '<option value="">(add rows first)</option>';
  if (!swPayer && names.length) { swPayer = names[0]; swSave(); }
}

/* ── Render expense preview pane ── */

function renderSwPane() {
  const panesEl = document.getElementById('sw-panes');
  const emptyEl = document.getElementById('sw-empty');
  if (!panesEl || !emptyEl) return;

  const expData = buildSwExpense();

  if (!expData) {
    emptyEl.style.display = '';
    panesEl.innerHTML     = '';
    renderSwPayerDropdown([]);
    return;
  }

  emptyEl.style.display = 'none';
  const { persons, cost, payer } = expData;
  const apiKey = getSwApiKey();

  renderSwPayerDropdown(persons.map(p => p.name));

  // Breakdown table
  const tdStyle  = 'padding:4px 8px;border-bottom:1px solid #f1f5f9';
  const numStyle = tdStyle + ';text-align:right;font-variant-numeric:tabular-nums';
  const thStyle  = 'text-align:right;padding:5px 8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b';
  const thLStyle = 'text-align:left;padding:5px 8px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b';

  let breakdownHtml = `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:14px">
    <thead><tr>
      <th style="${thLStyle}">Person</th>
      <th style="${thStyle}">Items</th>
      <th style="${thStyle}">Tax</th>
      <th style="${thStyle}">Tip</th>
      <th style="${thStyle}">Fee</th>
      <th style="${thStyle}">Owed</th>
      <th style="${thStyle}">Paid</th>
    </tr></thead><tbody>`;

  persons.forEach(p => {
    const isPayer = p.name === payer;
    breakdownHtml += `<tr>
      <td style="${tdStyle};font-weight:500">${escHtml(p.name)}</td>
      <td style="${numStyle}">$${p.items.toFixed(2)}</td>
      <td style="${numStyle}">$${p.tax.toFixed(2)}</td>
      <td style="${numStyle}">$${p.tip.toFixed(2)}</td>
      <td style="${numStyle}">$${p.fee.toFixed(2)}</td>
      <td style="${numStyle};font-weight:600">$${(p.totalCents / 100).toFixed(2)}</td>
      <td style="${tdStyle};text-align:center">${isPayer
        ? '<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">Payer</span>'
        : '<span style="color:#cbd5e1;font-size:12px">—</span>'}</td>
    </tr>`;
  });

  const totItems = persons.reduce((s, p) => s + p.items, 0);
  const totTax   = persons.reduce((s, p) => s + p.tax,   0);
  const totTip   = persons.reduce((s, p) => s + p.tip,   0);
  const totFee   = persons.reduce((s, p) => s + p.fee,   0);
  const totStyle = 'padding:5px 8px;font-weight:700;background:#f0f4ff;border-top:2px solid #c7d2fe';
  const totNumStyle = totStyle + ';text-align:right;font-variant-numeric:tabular-nums';

  breakdownHtml += `<tr>
    <td style="${totStyle}">Total</td>
    <td style="${totNumStyle}">$${totItems.toFixed(2)}</td>
    <td style="${totNumStyle}">$${totTax.toFixed(2)}</td>
    <td style="${totNumStyle}">$${totTip.toFixed(2)}</td>
    <td style="${totNumStyle}">$${totFee.toFixed(2)}</td>
    <td style="${totNumStyle}">$${cost.toFixed(2)}</td>
    <td style="${totStyle}"></td>
  </tr></tbody></table>`;

  const payload    = buildSwPayload(expData);
  const jsonStr    = JSON.stringify(payload, null, 2);
  const curlCmd    = [
    `curl -s -X POST \\`,
    `  "${getSwBase()}/create_expense" \\`,
    `  -H "Authorization: Bearer ${apiKey ? '****' : '<API_KEY>'}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(payload)}'`
  ].join('\n');

  panesEl.innerHTML = `<div class="ynab-pane" data-pane-id="sw-main">
    <div class="ynab-pane-head">
      <span>Splitwise Expense — $${cost.toFixed(2)}</span>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="ynab-direction main-expense">$${cost.toFixed(2)} total</span>
        <span class="collapse-chevron">▾</span>
      </div>
    </div>
    <div class="ynab-pane-body">
      <div class="ynab-preview-label">Breakdown</div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">${breakdownHtml}</div>
      <div class="ynab-preview-label">JSON Payload</div>
      <pre class="ynab-code">${escHtml(jsonStr)}</pre>
      <div class="ynab-preview-label">curl Command</div>
      <pre class="ynab-code">${escHtml(curlCmd)}</pre>
      <div style="margin-top:10px">
        <button class="btn-primary" style="font-size:12px;padding:7px 14px" id="sw-submit-btn">Submit to Splitwise</button>
      </div>
      <div class="ynab-status" id="sw-status"></div>
    </div>
  </div>`;

  // Collapse toggle
  panesEl.querySelector('.ynab-pane-head').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    panesEl.querySelector('.ynab-pane').classList.toggle('collapsed');
  });

  // Submit
  document.getElementById('sw-submit-btn').addEventListener('click', submitToSplitwise);
}

/* ── Build expense comment text ── */

function buildSwComment(expData) {
  const rows   = _getRows();
  const tipVal = parseFloat(document.getElementById('tip-input').value) || 0;
  const feeVal = parseFloat(document.getElementById('fee-input').value) || 0;
  const { persons, cost } = expData;

  // By category
  const catTotals = {}, catSeen = new Set();
  const catOrder  = [];
  rows.forEach(r => {
    const comp = _computeRow(r);
    if (comp.total < 1e-9) return;
    const cat = (r.category || '').trim() || '(uncategorized)';
    if (!catSeen.has(cat)) { catSeen.add(cat); catOrder.push(cat); catTotals[cat] = 0; }
    catTotals[cat] += comp.eff + comp.tax;
  });

  const lines = [];

  lines.push('By person:');
  persons.forEach(p => {
    const parts = [];
    if (p.items) parts.push(`items $${p.items.toFixed(2)}`);
    if (p.tax)   parts.push(`tax $${p.tax.toFixed(2)}`);
    if (p.tip)   parts.push(`tip $${p.tip.toFixed(2)}`);
    if (p.fee)   parts.push(`fee $${p.fee.toFixed(2)}`);
    lines.push(`  ${p.name}: $${(p.totalCents / 100).toFixed(2)}` + (parts.length ? ` (${parts.join(', ')})` : ''));
  });

  if (catOrder.length) {
    lines.push('');
    lines.push('By category:');
    catOrder.forEach(cat => lines.push(`  ${cat}: $${catTotals[cat].toFixed(2)}`));
  }

  const extras = [];
  if (tipVal) extras.push(`tip $${tipVal.toFixed(2)}`);
  if (feeVal) extras.push(`fee $${feeVal.toFixed(2)}`);
  lines.push('');
  lines.push(`Total: $${cost.toFixed(2)}` + (extras.length ? ` (incl. ${extras.join(', ')})` : ''));

  return lines.join('\n');
}

/* ── Submit to Splitwise API ── */

async function submitToSplitwise() {
  const apiKey   = getSwApiKey();
  const statusEl = document.getElementById('sw-status');
  const submitBtn = document.getElementById('sw-submit-btn');

  function setStatus(cls, msg) {
    statusEl.className   = 'ynab-status ' + cls;
    statusEl.textContent = msg;
  }

  if (!apiKey) { setStatus('err', 'Please enter your Splitwise API Key on the Setup tab.'); return; }

  const desc = document.getElementById('sw-description').value.trim();
  if (!desc) { setStatus('err', 'Description is required.'); return; }

  const expData = buildSwExpense();
  if (!expData) { setStatus('err', 'No expense data to submit.'); return; }

  const missing = expData.persons.filter(p => !p.userId);
  if (missing.length) {
    setStatus('err', 'Missing Splitwise User IDs for: ' + missing.map(p => p.name).join(', '));
    return;
  }

  submitBtn.disabled    = true;
  statusEl.style.display = 'block';
  statusEl.className    = 'ynab-status';
  statusEl.textContent  = 'Submitting expense…';

  try {
    const payload = buildSwPayload(expData);
    const res  = await fetch(getSwBase() + '/create_expense', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || (data.errors && Object.keys(data.errors).length > 0)) {
      const detail = data.errors ? JSON.stringify(data.errors) : (res.status + ' ' + res.statusText);
      throw new Error('Splitwise error: ' + detail);
    }
    const expId = data.expenses && data.expenses[0] ? data.expenses[0].id : null;
    if (expId) {
      const comment = buildSwComment(expData);
      await fetch(getSwBase() + '/create_comment', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ expense_id: expId, content: comment })
      });
    }
    setStatus('ok', 'Expense created! ID: ' + (expId || '?'));
  } catch (err) {
    const extra = (err.name === 'TypeError') ? ' — CORS may block direct calls; use the curl command instead.' : '';
    setStatus('err', err.message + extra);
  } finally {
    submitBtn.disabled = false;
  }
}

/* ── Fetch friends via proxy ── */

async function fetchSwFriends() {
  const apiKey   = getSwApiKey();
  const base     = getSwBase();
  const statusEl = document.getElementById('sw-friends-status');
  const btn      = document.getElementById('sw-fetch-friends-btn');
  if (!apiKey) { if (statusEl) statusEl.textContent = 'Enter API key on the Setup tab first.'; return; }
  if (base === SW_API) { if (statusEl) statusEl.textContent = 'Set a Proxy URL first.'; return; }
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Fetching…';
  try {
    const headers = { 'Authorization': 'Bearer ' + apiKey };
    const [friendsRes, selfRes] = await Promise.all([
      fetch(base + '/get_friends',      { headers }),
      fetch(base + '/get_current_user', { headers }),
    ]);
    if (!friendsRes.ok) throw new Error((await friendsRes.json()).error || friendsRes.status);
    if (!selfRes.ok)    throw new Error((await selfRes.json()).error    || selfRes.status);
    const friends = (await friendsRes.json()).friends || [];
    const self    = (await selfRes.json()).user;
    const sorted  = friends.sort((a, b) =>
      (a.first_name + ' ' + (a.last_name || '')).localeCompare(b.first_name + ' ' + (b.last_name || '')));
    swFriends = self ? [self, ...sorted] : sorted;
    swAutoMatch();
    if (statusEl) statusEl.textContent = swFriends.length + ' loaded';
    renderSwUserMap();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error: ' + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── Auto-match assignees to friends by first name ── */

function swAutoMatch() {
  const rows  = JSON.parse(localStorage.getItem(_LS_KEY) || '{"rows":[]}').rows || [];
  const names = [...new Set(
    rows.flatMap(r => (Array.isArray(r.splits) && r.splits.length > 0 ? r.splits : [{ assignee: r.assignee || '' }])
      .map(s => (s.assignee || '').trim()))
    .filter(Boolean)
  )];

  names.forEach(name => {
    if (swUserMap[name] && swUserMap[name].userId) return; // already mapped
    const needle   = name.toLowerCase();
    const matches  = swFriends.filter(f => (f.first_name || '').toLowerCase() === needle);
    if (matches.length === 1) {
      if (!swUserMap[name]) swUserMap[name] = {};
      swUserMap[name].userId = String(matches[0].id);
    }
  });

  swSave();
}

/* ── Fetch Splitwise groups ── */

function renderSwGroupSelect() {
  const wrap   = document.getElementById('sw-group-select-wrap');
  const input  = document.getElementById('sw-group-id');
  if (!wrap) return;
  if (swGroups.length === 0) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }

  const current = input ? input.value.trim() : '';
  const opts = swGroups.map(g =>
    `<option value="${g.id}"${String(g.id) === current ? ' selected' : ''}>${escHtml(g.name)} (${g.id})</option>`
  ).join('');

  wrap.style.display = '';
  wrap.innerHTML = `<select id="sw-group-select" style="width:100%">
    <option value="">— no group —</option>
    ${opts}
  </select>`;

  wrap.querySelector('#sw-group-select').addEventListener('change', e => {
    if (input) { input.value = e.target.value; input.dispatchEvent(new Event('input')); }
  });
}

async function fetchSwGroups() {
  const apiKey   = getSwApiKey();
  const base     = getSwBase();
  const statusEl = document.getElementById('sw-groups-status');
  const btn      = document.getElementById('sw-fetch-groups-btn');
  if (!apiKey) { if (statusEl) statusEl.textContent = 'Enter API key on the Setup tab first.'; return; }
  if (base === SW_API) { if (statusEl) statusEl.textContent = 'Set a Proxy URL first.'; return; }
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Fetching…';
  try {
    const res  = await fetch(base + '/get_groups', { headers: { 'Authorization': 'Bearer ' + apiKey } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    swGroups = (data.groups || [])
      .filter(g => g.id !== 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (statusEl) statusEl.textContent = swGroups.length + ' loaded';
    renderSwGroupSelect();
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error: ' + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── Wire settings inputs ── */

function swRefresh() { renderSwUserMap(); renderSwPane(); swSave(); }

['sw-api-key', 'sw-description', 'sw-date', 'sw-currency', 'sw-group-id', 'sw-proxy-url'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', swRefresh);
});

document.getElementById('sw-payer').addEventListener('change', e => {
  swPayer = e.target.value;
  swSave();
  renderSwPane();
});

/* ── Keep panes fresh when split data changes ── */
const _swObserver = new MutationObserver(() => { renderSwUserMap(); renderSwPane(); });
_swObserver.observe(document.getElementById('sum-tbody'), { childList: true, subtree: true, characterData: true });

/* ── Bootstrap ── */
swRestore();
document.getElementById('sw-date').value = todayISO();
renderSwUserMap();
renderSwPane();
window._txnSplit.refreshHooks.push(() => { renderSwUserMap(); renderSwPane(); });
const _swFetchBtn        = document.getElementById('sw-fetch-friends-btn');
const _swClearFriendsBtn = document.getElementById('sw-clear-friends-btn');
const _swFetchGroupsBtn  = document.getElementById('sw-fetch-groups-btn');
if (_swFetchGroupsBtn) _swFetchGroupsBtn.addEventListener('click', fetchSwGroups);
if (_swFetchBtn)  _swFetchBtn.addEventListener('click', fetchSwFriends);
if (_swClearFriendsBtn) _swClearFriendsBtn.addEventListener('click', () => {
  swFriends = [];
  const statusEl = document.getElementById('sw-friends-status');
  if (statusEl) statusEl.textContent = '';
  renderSwUserMap();
});

/* ── Fetch payees from Splitwise (Setup tab) ── */
const _swFetchPayeesBtn = document.getElementById('payee-fetch-sw-btn');
if (_swFetchPayeesBtn) {
  _swFetchPayeesBtn.addEventListener('click', async function () {
    const apiKey = getSwApiKey();
    const base   = getSwBase();
    const orig   = _swFetchPayeesBtn.textContent;
    if (!apiKey) { alert('Enter your Splitwise API Key on the Setup tab first.'); return; }
    if (base === SW_API) { alert('Set a Proxy URL on the Setup tab first.'); return; }
    _swFetchPayeesBtn.disabled = true;
    _swFetchPayeesBtn.textContent = 'Fetching…';
    try {
      const headers = { 'Authorization': 'Bearer ' + apiKey };
      const [friendsRes, selfRes] = await Promise.all([
        fetch(base + '/get_friends',      { headers }),
        fetch(base + '/get_current_user', { headers }),
      ]);
      if (!friendsRes.ok) throw new Error((await friendsRes.json()).error || String(friendsRes.status));
      if (!selfRes.ok)    throw new Error((await selfRes.json()).error    || String(selfRes.status));
      const friends = (await friendsRes.json()).friends || [];
      const self    = (await selfRes.json()).user;
      const all     = self ? [self, ...friends] : friends;
      // Detect ambiguous first names
      const firstNameCount = {};
      all.forEach(f => {
        const fn = (f.first_name || '').trim();
        if (fn) firstNameCount[fn] = (firstNameCount[fn] || 0) + 1;
      });
      const names = all.map(f => {
        const fn = (f.first_name || '').trim();
        const ln = (f.last_name  || '').trim();
        if (!fn) return ln || null;
        return firstNameCount[fn] === 1 ? fn : [fn, ln].filter(Boolean).join(' ');
      }).filter(Boolean);
      window._txnSplit.addToPayees(names);
      _swFetchPayeesBtn.textContent = 'Added ' + names.length;
      setTimeout(() => { _swFetchPayeesBtn.textContent = orig; _swFetchPayeesBtn.disabled = false; }, 2500);
    } catch (err) {
      _swFetchPayeesBtn.textContent = orig;
      _swFetchPayeesBtn.disabled = false;
      alert('Splitwise error: ' + err.message);
    }
  });
}

})();
