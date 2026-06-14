'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const STORAGE_KEY_THEME = 'sgx_dividend_theme';
let holdings = [];                 // from GET /api/holdings (each has .lots and .cost)
const divState = new Map();        // ticker -> { loading, error, data }

// ── API helpers ─────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  let data = null;
  try { data = await resp.json(); } catch { /* no body */ }
  if (!resp.ok) throw new Error((data && data.error) || `Request failed (${resp.status})`);
  return data;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function money(n, currency = 'SGD') {
  return `${currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Load data ───────────────────────────────────────────────────────────────
async function loadHoldings() {
  try {
    holdings = await api('GET', '/api/holdings');
  } catch (e) {
    holdings = [];
    console.error('Failed to load holdings:', e.message);
  }
  render();
  for (const h of holdings) loadDividends(h.ticker);
}

async function loadDividends(ticker, force = false) {
  divState.set(ticker, { loading: true, error: null, data: null });
  render();
  try {
    const url = `/api/dividends/${encodeURIComponent(ticker)}${force ? '?force=1' : ''}`;
    const data = await api('GET', url);
    divState.set(ticker, { loading: false, error: null, data });
  } catch (e) {
    divState.set(ticker, { loading: false, error: e.message, data: null });
  }
  render();
}

// ── Add lot ─────────────────────────────────────────────────────────────────
async function addLot() {
  const tickerEl = document.getElementById('ticker-input');
  const dateEl   = document.getElementById('date-input');
  const qtyEl    = document.getElementById('qty-input');
  const priceEl  = document.getElementById('price-input');
  const btn      = document.getElementById('add-btn');

  const ticker = tickerEl.value.trim().toUpperCase();
  const body = {
    ticker,
    date_bought: dateEl.value,
    shares: qtyEl.value,
    price_per_share: priceEl.value.trim() === '' ? null : priceEl.value
  };

  hideAddError();
  btn.disabled = true;
  try {
    await api('POST', '/api/holdings', body);
    tickerEl.value = '';
    qtyEl.value = '';
    priceEl.value = '';
    tickerEl.focus();
    await loadHoldings();
    // Refresh dividend analysis for this ticker (eligibility may have changed).
    loadDividends(ticker);
  } catch (e) {
    showAddError(e.message);
  } finally {
    btn.disabled = false;
  }
}

function showAddError(msg) {
  const el = document.getElementById('add-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideAddError() { document.getElementById('add-error').style.display = 'none'; }

// ── Remove lot / refresh ──────────────────────────────────────────────────────
async function removeLot(lotId, ticker) {
  try {
    await api('DELETE', `/api/lots/${lotId}`);
    await loadHoldings();
    // If the holding still exists, its eligibility changed — refresh analysis.
    if (holdings.some(h => h.ticker === ticker)) loadDividends(ticker);
  } catch (e) {
    console.error('Remove lot failed:', e.message);
  }
}

async function refresh(ticker) {
  try { await api('DELETE', `/api/cache/${encodeURIComponent(ticker)}`); } catch { /* ignore */ }
  loadDividends(ticker, true);
}

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  const grid    = document.getElementById('holdings-grid');
  const empty   = document.getElementById('empty-state');
  const summary = document.getElementById('summary-section');

  const has = holdings.length > 0;
  empty.style.display   = has ? 'none' : 'block';
  summary.style.display = has ? 'block' : 'none';

  renderSummary();
  grid.innerHTML = holdings.map(renderCard).join('');
}

function renderSummary() {
  let totalShares = 0, totalInvested = 0, allTime = 0;
  let investedForYield = 0, divForYield = 0;

  for (const h of holdings) {
    totalShares   += h.cost.totalShares;
    totalInvested += h.cost.totalInvested;

    const st = divState.get(h.ticker);
    const received = st && st.data ? st.data.analysis.allTimeReceived : 0;
    allTime += received;

    if (h.cost.totalInvested > 0) {
      investedForYield += h.cost.totalInvested;
      divForYield += received;
    }
  }

  const yoc = investedForYield > 0 ? (divForYield / investedForYield) * 100 : null;

  document.getElementById('m-holdings').textContent = holdings.length;
  document.getElementById('m-shares').textContent   = totalShares.toLocaleString();
  document.getElementById('m-invested').textContent = money(totalInvested);
  document.getElementById('m-alltime').textContent  = money(allTime);
  document.getElementById('m-yoc').textContent      = yoc != null ? yoc.toFixed(2) + '%' : '—';
}

function renderCard(h) {
  const cost = h.cost;
  const st   = divState.get(h.ticker) || { loading: true, error: null, data: null };
  const data = st.data;

  // Lots (already sorted oldest-first by the API)
  const lotsHtml = h.lots.map((l, i) => {
    const priceSuffix = (l.price_per_share != null && l.price_per_share > 0)
      ? ` · SGD ${Number(l.price_per_share).toFixed(l.price_per_share < 1 ? 3 : 2)}/share` : '';
    return `
    <div class="lot-row">
      <span class="lot-text"><strong>Lot ${i + 1}:</strong> ${l.shares.toLocaleString()} shares @ ${fmtDate(l.date_bought)}${priceSuffix}</span>
      <button class="lot-remove" data-lot-id="${l.id}" data-ticker="${escHtml(h.ticker)}" title="Remove lot" aria-label="Remove lot ${i + 1}">✕</button>
    </div>`;
  }).join('');

  const costHtml = cost.avgCost != null
    ? `<div class="cost-line">Avg cost: <strong>SGD ${cost.avgCost.toFixed(3)}/share</strong></div>
       <div class="cost-line">Total invested: <strong>${money(cost.totalInvested)}</strong></div>`
    : `<div class="cost-line">Avg cost: <strong>—</strong> · Total invested: <strong>—</strong></div>`;

  const ttmLine = data && data.ttmYield
    ? `<div class="holding-sub">TTM yield: ${escHtml(data.ttmYield)}</div>` : '';

  // Body: dividend table + period breakdown
  let body;
  if (st.loading) {
    body = `<div class="loading-text"><span class="spin">↻</span> Fetching dividends…</div>`;
  } else if (st.error) {
    body = `<div class="error-text">⚠ ${escHtml(st.error)}
      <br><button class="secondary" data-refresh data-ticker="${escHtml(h.ticker)}" style="margin-top:8px;height:30px;font-size:12px">Retry</button></div>`;
  } else {
    const a = data.analysis;
    if (!a.payouts.length) {
      body = `<div class="loading-text" style="color:var(--muted)">No dividends recorded after your earliest purchase date.</div>`;
    } else {
      const divRows = a.payouts.map(p => `
        <tr>
          <td>${fmtDate(p.exDate)}${p.upcoming ? ' <span class="upcoming-badge">upcoming</span>' : ''}</td>
          <td>${fmtDate(p.payDate)}</td>
          <td>${p.eligibleShares.toLocaleString()}</td>
          <td>${escHtml(p.currency)} ${p.perShare.toFixed(4)}</td>
          <td class="amount-cell">${escHtml(p.currency)} ${p.received.toFixed(2)}</td>
        </tr>`).join('');

      const yocText = v => v != null ? `${v.toFixed(2)}% yield on cost` : '—';
      const periodRows = a.periods.map(pr => `
        <tr>
          <td>${escHtml(pr.key)}</td>
          <td class="amount-cell">SGD ${pr.total.toFixed(2)}</td>
          <td class="yoc-cell">${yocText(pr.yieldOnCost)}</td>
        </tr>`).join('');

      const overall = a.allTimeYieldOnCost != null
        ? `overall yield on cost: ${a.allTimeYieldOnCost.toFixed(2)}%` : '—';

      const periodTable = a.periods.length ? `
        <div class="period-block">
          <div class="period-title">Period breakdown</div>
          <table class="period-table"><tbody>
            ${periodRows}
            <tr class="period-total">
              <td>All-time received</td>
              <td class="amount-cell">SGD ${a.allTimeReceived.toFixed(2)}</td>
              <td class="yoc-cell">${overall}</td>
            </tr>
          </tbody></table>
        </div>` : '';

      body = `
        <table class="div-table" aria-label="Dividends for ${escHtml(h.ticker)}">
          <thead><tr><th>Ex date</th><th>Pay date</th><th>Shares</th><th>Per share</th><th>Received</th></tr></thead>
          <tbody>${divRows}</tbody>
        </table>
        ${periodTable}`;
    }
  }

  return `<div class="holding-card">
    <div class="holding-header">
      <div class="holding-id">
        <span class="ticker-badge">${escHtml(h.ticker)}</span>
        <div class="holding-name">${escHtml(data?.name || '')}</div>
        ${costHtml}
        ${ttmLine}
      </div>
      <div class="holding-actions">
        <span class="holding-qty">${cost.totalShares.toLocaleString()} shares · ${h.lots.length} lot${h.lots.length === 1 ? '' : 's'}</span>
        <button class="icon-btn" data-refresh data-ticker="${escHtml(h.ticker)}" title="Refresh data" aria-label="Refresh ${escHtml(h.ticker)}">↻</button>
      </div>
    </div>
    <div class="lots-block">${lotsHtml}</div>
    ${body}
  </div>`;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('.theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
}
function initTheme() {
  let theme = localStorage.getItem(STORAGE_KEY_THEME);
  if (!theme) theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(theme);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEY_THEME, next);
  applyTheme(next);
}

// ── Wiring & init ────────────────────────────────────────────────────────────
document.getElementById('add-btn').addEventListener('click', addLot);
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

document.getElementById('ticker-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('date-input').focus();
});
document.getElementById('date-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('qty-input').focus();
});
document.getElementById('qty-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('price-input').focus();
});
document.getElementById('price-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addLot();
});

// Event delegation for per-card buttons (remove lot, refresh).
document.getElementById('holdings-grid').addEventListener('click', e => {
  const removeBtn = e.target.closest('.lot-remove');
  if (removeBtn) { removeLot(removeBtn.dataset.lotId, removeBtn.dataset.ticker); return; }
  const refreshBtn = e.target.closest('[data-refresh]');
  if (refreshBtn) { refresh(refreshBtn.dataset.ticker); return; }
});

(function init() {
  initTheme();
  const dateInput = document.getElementById('date-input');
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  dateInput.max = iso;
  dateInput.value = iso;

  loadHoldings();
})();
