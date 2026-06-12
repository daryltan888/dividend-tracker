'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const STORAGE_KEY_HOLDINGS = 'sgx_dividend_holdings';
const STORAGE_KEY_CACHE    = 'sgx_dividend_cache';
const CACHE_TTL_MS         = 24 * 60 * 60 * 1000; // 24 hours

let holdings = loadHoldings();
let cache    = loadCache();
const TODAY  = new Date();

// ── Persistence ────────────────────────────────────────────────────────────
function loadHoldings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_HOLDINGS)) || []; }
  catch { return []; }
}
function saveHoldings() {
  localStorage.setItem(STORAGE_KEY_HOLDINGS, JSON.stringify(
    holdings.map(h => ({ ticker: h.ticker, qty: h.qty }))
  ));
}
function loadCache() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_CACHE)) || {}; }
  catch { return {}; }
}
function saveCache() {
  localStorage.setItem(STORAGE_KEY_CACHE, JSON.stringify(cache));
}

// ── Add holding ────────────────────────────────────────────────────────────
function addHolding() {
  const ticker = document.getElementById('ticker-input').value.trim().toUpperCase();
  const qty    = parseInt(document.getElementById('qty-input').value, 10);
  const errEl  = document.getElementById('add-error');

  errEl.style.display = 'none';
  if (!ticker) return showAddError('Please enter a ticker.');
  if (!qty || qty < 1) return showAddError('Please enter a valid share quantity.');
  if (holdings.find(h => h.ticker === ticker)) return showAddError(ticker + ' is already in your portfolio.');

  holdings.push({ ticker, qty, data: null, loading: true, error: null });
  saveHoldings();
  document.getElementById('ticker-input').value = '';
  document.getElementById('qty-input').value   = '';
  render();
  fetchDividends(ticker);
}

function showAddError(msg) {
  const el = document.getElementById('add-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Fetch & parse dividends.sg via CORS proxy ─────────────────────────────
// dividends.sg blocks direct cross-origin requests from a browser, so we
// route the request through a public CORS proxy and parse the returned HTML
// table ourselves. No API key, no third-party AI calls, no cost.

const PROXIES = [
  url => 'https://corsproxy.io/?url=' + encodeURIComponent(url),
  url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url)
];

async function fetchDividends(ticker) {
  const h = holdings.find(x => x.ticker === ticker);
  if (!h) return;

  // Serve from cache if fresh
  if (cache[ticker] && (Date.now() - cache[ticker]._fetched) < CACHE_TTL_MS) {
    h.data    = cache[ticker];
    h.loading = false;
    render();
    return;
  }

  const targetUrl = `https://www.dividends.sg/view/${encodeURIComponent(ticker)}`;
  let html = null;

  for (const proxy of PROXIES) {
    try {
      const resp = await fetch(proxy(targetUrl));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (text && text.length > 500) { html = text; break; }
    } catch (e) {
      // try next proxy
    }
  }

  if (!html) {
    h.error   = 'Could not reach dividends.sg (proxy blocked). Try again later.';
    h.loading = false;
    render();
    return;
  }

  try {
    const parsed = parseDividendsHtml(html, ticker);
    parsed._fetched = Date.now();
    cache[ticker]   = parsed;
    saveCache();
    h.data  = parsed;
    h.error = null;
  } catch (e) {
    console.error('Parse error for', ticker, e);
    h.error = 'Could not parse data for ' + ticker + '. Check the ticker code is correct.';
  }

  h.loading = false;
  render();
}

// ── HTML parsing ───────────────────────────────────────────────────────────
function parseDividendsHtml(html, ticker) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Company name — page heading looks like "CSE GLOBAL LTD (544) SGD 1.30 ..."
  let name = '';
  const heading = doc.querySelector('h4, h3, h2');
  if (heading) {
    name = heading.textContent.trim()
      .replace(/\(\d+\).*$/, '')   // strip "(544) SGD ..."
      .trim();
  }
  if (!name) name = ticker;

  // TTM yield — text near "TTM Dividend Yield:"
  let ttmYield = null;
  const bodyText = doc.body.textContent;
  const ttmMatch = bodyText.match(/TTM Dividend Yield:\s*([\d.]+%)/);
  if (ttmMatch) ttmYield = ttmMatch[1];

  // Find the dividend table — it's the table containing a header cell "Ex Date"
  let table = null;
  for (const t of doc.querySelectorAll('table')) {
    const headerText = t.querySelector('thead')?.textContent || t.rows[0]?.textContent || '';
    if (/Ex Date/i.test(headerText)) { table = t; break; }
  }
  if (!table) throw new Error('Dividend table not found');

  // Map header columns to indices
  const headerCells = Array.from(table.querySelectorAll('thead th, tr:first-child th'))
    .map(c => c.textContent.trim().toLowerCase());

  const col = {
    year:    headerCells.findIndex(c => c === 'year'),
    amount:  headerCells.findIndex(c => c === 'amount'),
    exDate:  headerCells.findIndex(c => c.includes('ex date')),
    payDate: headerCells.findIndex(c => c.includes('pay date'))
  };

  const dividends = [];
  let currentYear = null;
  const bodyRows = table.querySelectorAll('tbody tr');
  const rows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1);

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
    if (cells.length === 0) continue;

    // Year column may be merged across multi-row entries — carry forward
    if (col.year >= 0 && cells[col.year]) {
      const y = parseInt(cells[col.year], 10);
      if (!isNaN(y)) currentYear = y;
    }

    const amountRaw  = col.amount  >= 0 ? cells[col.amount]  : '';
    const exDateRaw  = col.exDate  >= 0 ? cells[col.exDate]  : '';
    const payDateRaw = col.payDate >= 0 ? cells[col.payDate] : '';

    // Skip rows with no ex-date (e.g. bonus issue / split rows with '-')
    if (!exDateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(exDateRaw)) continue;

    // Amount format: "SGD0.0146" or "USD0.0250" -> currency + float
    const amtMatch = amountRaw.match(/^([A-Z]{3})\s*([\d.]+)$/);
    let currency = 'SGD', amount = null;
    if (amtMatch) {
      currency = amtMatch[1];
      amount   = parseFloat(amtMatch[2]);
    } else {
      const numMatch = amountRaw.match(/([\d.]+)/);
      if (numMatch) amount = parseFloat(numMatch[1]);
    }
    if (amount === null || isNaN(amount)) continue;

    dividends.push({
      year:    currentYear,
      exDate:  exDateRaw,
      payDate: /^\d{4}-\d{2}-\d{2}$/.test(payDateRaw) ? payDateRaw : null,
      amount,
      currency
    });
  }

  // Sort newest first
  dividends.sort((a, b) => (a.exDate < b.exDate ? 1 : -1));

  return { name, ticker, ttmYield, dividends };
}

// ── Remove / refresh holding ───────────────────────────────────────────────
function removeHolding(ticker) {
  holdings = holdings.filter(h => h.ticker !== ticker);
  saveHoldings();
  render();
}

function refreshHolding(ticker) {
  delete cache[ticker];
  saveCache();
  const h = holdings.find(x => x.ticker === ticker);
  if (!h) return;
  h.loading = true;
  h.error   = null;
  render();
  fetchDividends(ticker);
}

// ── Metrics ────────────────────────────────────────────────────────────────
function isUpcoming(exDateStr) {
  if (!exDateStr) return false;
  return new Date(exDateStr) > TODAY;
}

function calcMetrics() {
  let ttm = 0, upcoming = 0, total = 0;
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  for (const h of holdings) {
    if (!h.data?.dividends) continue;
    for (const d of h.data.dividends) {
      if (d.amount == null) continue;
      const exD = d.exDate ? new Date(d.exDate) : null;
      total += d.amount * h.qty;
      if (exD && exD >= oneYearAgo && exD <= TODAY) ttm += d.amount * h.qty;
      if (isUpcoming(d.exDate)) upcoming += d.amount * h.qty;
    }
  }
  return { ttm, upcoming, total };
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const grid    = document.getElementById('holdings-grid');
  const empty   = document.getElementById('empty-state');
  const summary = document.getElementById('summary-section');

  const hasHoldings = holdings.length > 0;
  empty.style.display   = hasHoldings ? 'none' : 'block';
  summary.style.display = hasHoldings ? 'block' : 'none';

  const m = calcMetrics();
  document.getElementById('m-holdings').textContent = holdings.length;
  document.getElementById('m-ttm').textContent      = 'SGD ' + m.ttm.toFixed(2);
  document.getElementById('m-upcoming').textContent = 'SGD ' + m.upcoming.toFixed(2);
  document.getElementById('m-total').textContent    = 'SGD ' + m.total.toFixed(2);

  grid.innerHTML = holdings.map(h => renderCard(h)).join('');
}

function renderCard(h) {
  let body = '';

  if (h.loading) {
    body = `<div class="loading-text"><span class="spin">↻</span> Fetching dividends from dividends.sg...</div>`;
  } else if (h.error) {
    body = `<div class="error-text">⚠ ${escHtml(h.error)}
      <br><button class="secondary" style="margin-top:8px;height:30px;font-size:12px" onclick="refreshHolding('${h.ticker}')">Retry</button>
    </div>`;
  } else if (!h.data?.dividends?.length) {
    body = `<div class="loading-text" style="color:var(--muted)">No dividend records found.</div>`;
  } else {
    const rows = h.data.dividends.map(d => {
      const totalAmt = d.amount != null ? (d.amount * h.qty).toFixed(2) : '-';
      const upcoming = isUpcoming(d.exDate);
      const currency = d.currency || 'SGD';
      return `<tr>
        <td>${escHtml(d.exDate || '-')}${upcoming ? ' <span class="upcoming-badge">upcoming</span>' : ''}</td>
        <td>${escHtml(d.payDate || '-')}</td>
        <td>${currency} ${d.amount != null ? d.amount.toFixed(4) : '-'}</td>
        <td class="amount-cell">${d.amount != null ? currency + ' ' + totalAmt : '-'}</td>
      </tr>`;
    }).join('');

    const yieldLine = h.data.ttmYield
      ? `<div class="holding-name">TTM yield: ${escHtml(h.data.ttmYield)}</div>`
      : '';

    body = `${yieldLine}
    <table class="div-table" aria-label="Dividends for ${h.ticker}">
      <thead><tr><th>Ex date</th><th>Pay date</th><th>Per share</th><th>You receive</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  return `<div class="holding-card">
    <div class="holding-header">
      <div>
        <span class="ticker-badge">${escHtml(h.ticker)}</span>
        <div class="holding-name">${escHtml(h.data?.name || '')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="holding-qty">${h.qty.toLocaleString()} shares</span>
        <button class="remove-btn" onclick="refreshHolding('${h.ticker}')" title="Refresh data" style="font-size:14px">↻</button>
        <button class="remove-btn" onclick="removeHolding('${h.ticker}')" title="Remove" aria-label="Remove ${h.ticker}">✕</button>
      </div>
    </div>
    ${body}
  </div>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.getElementById('ticker-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('qty-input').focus();
});
document.getElementById('qty-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addHolding();
});

// ── Init ───────────────────────────────────────────────────────────────────
(function init() {
  holdings = holdings.map(h => ({ ...h, data: null, loading: true, error: null }));
  render();
  for (const h of holdings) fetchDividends(h.ticker);
})();
