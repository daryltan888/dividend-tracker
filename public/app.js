'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const THEME_KEY = 'sgx_theme';
let holdings = [];
const divState = new Map(); // ticker → { loading, error, data }
const lotsOpen = new Set(); // tickers whose lots panel is expanded

let chartInstance = null;

const CHART_COLORS = [
  '#007AFF','#34C759','#FF9500','#AF52DE','#FF2D55',
  '#32ADE6','#FF6B2C','#5856D6','#30B0C7','#A2845E'
];
// Suffix appended to H2 dataset labels so they can be filtered from the legend.
const H2_SUFFIX = ' H2';

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

// ── Formatting ────────────────────────────────────────────────────────────────
function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
}

function money(n, cur = 'SGD') {
  return `${cur} ${Number(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })}`;
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function cleanName(raw, fallback = '') {
  return (raw || fallback).split('\t')[0].trim() || fallback;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const moon = document.querySelector('.icon-moon');
  const sun  = document.querySelector('.icon-sun');
  if (moon) moon.style.display = t === 'dark' ? 'none'  : 'block';
  if (sun)  sun.style.display  = t === 'dark' ? 'block' : 'none';
  if (chartInstance) updateChartTheme();
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
  const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved || preferred);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  applyTheme(next);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span><span>${esc(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadHoldings() {
  try {
    holdings = await api('GET', '/api/holdings');
  } catch (e) {
    holdings = [];
    console.error('loadHoldings:', e.message);
  }
  render();
  for (const h of holdings) loadDividends(h.ticker);
}

async function loadDividends(ticker, force = false) {
  divState.set(ticker, { loading: true, error: null, data: null });
  renderCard(ticker);
  renderSummary();
  try {
    const url = `/api/dividends/${encodeURIComponent(ticker)}${force ? '?force=1' : ''}`;
    const data = await api('GET', url);
    divState.set(ticker, { loading: false, error: null, data });
    if (force) showToast(`${ticker} data updated`);
  } catch (e) {
    divState.set(ticker, { loading: false, error: e.message, data: null });
    if (force) showToast(`Could not reach dividends.sg for ${ticker}`, 'error');
    console.error(`loadDividends(${ticker}):`, e.message);
  }
  renderCard(ticker);
  renderSummary();
  renderUpcoming();
  renderChart();
}

// ── Top-level render ──────────────────────────────────────────────────────────
function render() {
  const hasHoldings = holdings.length > 0;
  const emptyEl   = document.getElementById('empty-state');
  const contentEl = document.getElementById('content');
  emptyEl.style.display   = hasHoldings ? 'none'  : 'block';
  contentEl.style.display = hasHoldings ? 'block' : 'none';

  if (!hasHoldings) return;

  renderSummary();
  renderHoldingsGrid();
  renderUpcoming();
  renderChart();
}

// ── Summary metrics ───────────────────────────────────────────────────────────
function renderSummary() {
  let totalShares = 0, totalInvested = 0, allTime = 0;
  let invForYoc = 0, divForYoc = 0;

  for (const h of holdings) {
    totalShares   += h.cost.totalShares;
    totalInvested += h.cost.totalInvested;
    const st = divState.get(h.ticker);
    const rx = st?.data?.analysis?.allTimeReceived || 0;
    allTime += rx;
    if (h.cost.totalInvested > 0) { invForYoc += h.cost.totalInvested; divForYoc += rx; }
  }

  const yoc = invForYoc > 0 ? (divForYoc / invForYoc * 100) : null;
  document.getElementById('v-holdings').textContent = holdings.length;
  document.getElementById('v-shares').textContent   = totalShares.toLocaleString();
  document.getElementById('v-invested').textContent = money(totalInvested);
  document.getElementById('v-alltime').textContent  = money(allTime);
  document.getElementById('v-yoc').textContent      = yoc != null ? yoc.toFixed(2) + '%' : '—';
}

// ── Chart ─────────────────────────────────────────────────────────────────────
function getChartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    grid:  style.getPropertyValue('--border').trim() || '#D2D2D7',
    text:  style.getPropertyValue('--text-2').trim() || '#6E6E73',
    text1: style.getPropertyValue('--text').trim()   || '#1D1D1F',
  };
}

function updateChartTheme() {
  if (!chartInstance) return;
  const c = getChartColors();
  chartInstance.options.scales.x.ticks.color = c.text;
  chartInstance.options.scales.x.grid.color  = c.grid;
  chartInstance.options.scales.y.ticks.color = c.text;
  chartInstance.options.scales.y.grid.color  = c.grid;
  chartInstance.options.plugins.legend.labels.color = c.text1;
  chartInstance.update();
}

async function renderChart() {
  if (!holdings.length) return;

  let rawData;
  try {
    rawData = await api('GET', '/api/chart-data');
  } catch (e) {
    console.error('renderChart:', e.message);
    return;
  }

  const tickerList = holdings.map(h => h.ticker).filter(t => rawData[t]);
  if (!tickerList.length) return;

  const allPeriods = new Set();
  const tickerPeriods = {};

  for (const ticker of tickerList) {
    tickerPeriods[ticker] = {};
    for (const [k, v] of Object.entries(rawData[ticker].periods || {})) {
      const key = k.replace('_', ' '); // "2024_H1" → "2024 H1"
      allPeriods.add(key);
      tickerPeriods[ticker][key] = v;
    }
  }

  if (!allPeriods.size) return;

  // X-axis = unique years; two side-by-side stacked bar groups per year (H1 | H2)
  const allYears = [...new Set([...allPeriods].map(k => k.split(' ')[0]))].sort();
  const c = getChartColors();

  // H1 datasets — lighter shade, appear in legend
  const h1 = tickerList.map((ticker, i) => ({
    label: ticker,
    data: allYears.map(yr => tickerPeriods[ticker][`${yr} H1`] || 0),
    backgroundColor: hexToRgba(CHART_COLORS[i % CHART_COLORS.length], 0.5),
    borderRadius: 4,
    borderSkipped: false,
    stack: 'H1',
  }));
  // H2 datasets — full opacity (darker), hidden from legend via filter
  const h2 = tickerList.map((ticker, i) => ({
    label: ticker + H2_SUFFIX,
    data: allYears.map(yr => tickerPeriods[ticker][`${yr} H2`] || 0),
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
    borderRadius: 4,
    borderSkipped: false,
    stack: 'H2',
  }));

  const datasets = [...h1, ...h2];
  const canvas = document.getElementById('dividend-chart');
  if (!canvas) return;

  if (chartInstance) {
    chartInstance.data.labels   = allYears;
    chartInstance.data.datasets = datasets;
    updateChartTheme(); // also calls chartInstance.update()
    return;
  }

  chartInstance = new Chart(canvas, {
    type: 'bar',
    data: { labels: allYears, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: c.text1,
            font: { size: 11, family: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif' },
            boxWidth: 10, boxHeight: 10, padding: 16,
            filter: item => !item.text.endsWith(H2_SUFFIX),
          }
        },
        tooltip: {
          callbacks: {
            title: ctx => `${ctx[0].label} ${ctx[0].dataset.stack}`,
            label: ctx => ` ${ctx.dataset.label.replace(H2_SUFFIX, '')}: SGD ${ctx.parsed.y.toFixed(2)}`,
          }
        }
      },
      scales: {
        x: {
          ticks: { color: c.text, font: { size: 11 } },
          grid:  { color: c.grid, lineWidth: 0.5 }
        },
        y: {
          ticks: { color: c.text, font: { size: 11 }, callback: v => 'S$' + v.toFixed(0) },
          grid:  { color: c.grid, lineWidth: 0.5 }
        }
      }
    }
  });
}

// ── Holdings grid ─────────────────────────────────────────────────────────────
function renderHoldingsGrid() {
  const grid = document.getElementById('holdings-grid');
  // Preserve which tickers already have card elements
  const existing = new Set([...grid.querySelectorAll('[data-card]')].map(el => el.dataset.card));

  // Remove cards for tickers no longer in holdings
  for (const el of grid.querySelectorAll('[data-card]')) {
    if (!holdings.some(h => h.ticker === el.dataset.card)) el.remove();
  }

  // Add cards for new holdings (in correct order)
  for (const h of holdings) {
    if (!existing.has(h.ticker)) {
      const wrapper = document.createElement('div');
      wrapper.dataset.card = h.ticker;
      grid.appendChild(wrapper);
    }
  }

  // Re-order DOM to match holdings order
  for (const h of holdings) {
    const el = grid.querySelector(`[data-card="${CSS.escape(h.ticker)}"]`);
    if (el && el !== grid.children[holdings.indexOf(h)]) grid.appendChild(el);
  }

  // Populate/update each card
  for (const h of holdings) renderCard(h.ticker);
}

function renderCard(ticker) {
  const grid = document.getElementById('holdings-grid');
  const wrapper = grid ? grid.querySelector(`[data-card="${CSS.escape(ticker)}"]`) : null;
  if (!wrapper) return;

  const h   = holdings.find(h => h.ticker === ticker);
  const st  = divState.get(ticker) || { loading: true, error: null, data: null };
  if (!h) return;

  const cost = h.cost;
  const data = st.data;
  const analysis = data?.analysis;
  const name = cleanName(data?.name, ticker);
  const price        = data?.price        ?? null;
  const priceCur     = data?.priceCurrency || 'SGD';
  const priceChgPct  = data?.priceChangePct  || null;
  const priceChgAmt  = data?.priceChangeAmt  || null;

  // Lots HTML
  const lotsHtml = h.lots.map((l, i) => {
    const priceStr = (l.price_per_share != null && l.price_per_share > 0)
      ? ` · SGD ${Number(l.price_per_share).toFixed(l.price_per_share < 1 ? 3 : 2)}/share` : '';
    return `<div class="lot-row">
      <span class="lot-text"><strong>Lot ${i+1}:</strong> ${l.shares.toLocaleString()} shares @ ${fmtDate(l.date_bought)}${priceStr}</span>
      <button class="lot-remove" data-lot="${l.id}" data-ticker="${esc(ticker)}" title="Remove lot" aria-label="Remove lot ${i+1}">✕</button>
    </div>`;
  }).join('');

  // Cost summary
  const avgStr      = cost.avgCost != null ? `SGD ${cost.avgCost.toFixed(cost.avgCost < 1 ? 3 : 2)}/share` : '—';
  const investedStr = cost.totalInvested > 0 ? money(cost.totalInvested) : '—';
  const ttmStr      = data?.ttmYield ? data.ttmYield : '—';

  // Body content
  let bodyHtml;
  if (st.loading) {
    bodyHtml = `
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:8px">
          <div class="skeleton sk-line sk-w90"></div>
          <div class="skeleton sk-line sk-w70"></div>
          <div class="skeleton sk-line sk-full"></div>
          <div class="skeleton sk-line sk-w55"></div>
          <div class="skeleton sk-line sk-full"></div>
        </div>
      </div>`;
  } else if (st.error) {
    bodyHtml = `<div class="error-row">
      <span>⚠ ${esc(st.error)}</span>
      <button class="btn btn-ghost btn-sm" data-refresh data-ticker="${esc(ticker)}">Retry</button>
    </div>`;
  } else if (!analysis || !analysis.payouts.length) {
    bodyHtml = `<div class="no-data">No dividends recorded after your earliest purchase date.</div>`;
  } else {
    // Dividend table
    const divRows = analysis.payouts.map(p => `
      <tr class="${p.upcoming ? 'up-row' : ''}">
        <td>${fmtDate(p.exDate)}${p.upcoming ? ' <span class="up-badge">upcoming</span>' : ''}</td>
        <td>${fmtDate(p.payDate)}</td>
        <td>${p.eligibleShares.toLocaleString()}</td>
        <td>${esc(p.currency)} ${p.perShare.toFixed(4)}</td>
        <td class="amount-cell">${esc(p.currency)} ${p.received.toFixed(2)}</td>
      </tr>`).join('');

    // Period breakdown by year (H1 / H2 columns)
    const byYear = {};
    for (const p of analysis.periods) {
      const [yr, half] = p.key.split(' ');
      if (!byYear[yr]) byYear[yr] = { H1: null, H2: null };
      byYear[yr][half] = { total: p.total };
    }

    const periodRows = Object.entries(byYear).sort().map(([yr, halves]) => {
      const h1 = halves.H1;
      const h2 = halves.H2;
      return `
        <tr class="period-row">
          <td class="period-yr">${yr}</td>
          <td>${h1 ? 'SGD ' + h1.total.toFixed(2) : '—'}</td>
          <td>${h2 ? 'SGD ' + h2.total.toFixed(2) : '—'}</td>
        </tr>`;
    }).join('');

    bodyHtml = `
      <div class="div-section">
        <table class="div-table" aria-label="Dividends for ${esc(ticker)}">
          <thead><tr><th>Ex Date</th><th>Pay Date</th><th>Shares</th><th>Per Share</th><th>Received</th></tr></thead>
          <tbody>${divRows}</tbody>
        </table>
      </div>
      <div class="period-section">
        <div class="period-title">Period Breakdown</div>
        <table class="period-table" aria-label="Period breakdown for ${esc(ticker)}">
          <thead><tr><th style="font-size:10.5px;color:var(--text-2);font-weight:600;">Year</th><th style="text-align:right;font-size:10.5px;color:var(--text-2);font-weight:600;">H1</th><th style="text-align:right;font-size:10.5px;color:var(--text-2);font-weight:600;">H2</th></tr></thead>
          <tbody>
            ${periodRows}
            <tr class="period-row period-total">
              <td>All-time</td>
              <td colspan="2">SGD ${analysis.allTimeReceived.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>`;
  }

  const isOpen = lotsOpen.has(ticker);

  wrapper.innerHTML = `<div class="holding-card">
    <div class="card-top">
      <div class="card-top-left">
        <span class="ticker-badge">${esc(ticker)}</span>
        <div class="company-name">${esc(name)}</div>
        ${price != null ? (() => {
          const isPos = priceChgPct && priceChgPct.startsWith('+');
          const isNeg = priceChgPct && priceChgPct.startsWith('-');
          const chgColor = isPos ? 'var(--green)' : isNeg ? 'var(--red)' : 'var(--text-2)';
          const chgHtml = priceChgPct
            ? `<span style="font-size:11.5px;font-weight:500;color:${chgColor};margin-left:5px">${esc(priceChgPct)}${priceChgAmt ? ' (' + esc(priceChgAmt) + ')' : ''}</span>`
            : '';
          return `<div style="margin-top:4px;display:flex;align-items:baseline;flex-wrap:wrap;gap:0">
            <span style="font-size:12px;color:var(--text-2)">Price:&nbsp;</span>
            <span style="font-size:13px;font-weight:700;color:var(--text)">${esc(priceCur)} ${price.toFixed(2)}</span>
            ${chgHtml}
          </div>`;
        })() : ''}
        <div class="card-sub">${cost.totalShares.toLocaleString()} shares · ${h.lots.length} lot${h.lots.length === 1 ? '' : 's'}</div>
        <div class="card-cost-row">
          <span class="cost-item">Avg: <strong>${avgStr}</strong></span>
          <span class="cost-item">·</span>
          <span class="cost-item">Invested: <strong>${investedStr}</strong></span>
          <span class="cost-item">·</span>
          <span class="cost-item">TTM: <strong>${esc(ttmStr)}</strong></span>
        </div>
      </div>
      <div class="card-top-right">
        <button class="refresh-btn" data-refresh data-ticker="${esc(ticker)}" title="Refresh data" aria-label="Refresh ${esc(ticker)}">
          ${st.loading ? '<span class="spin" aria-hidden="true">↻</span>' : '↻'}
        </button>
      </div>
    </div>
    <div class="lots-section">
      <button class="lots-toggle${isOpen ? ' open' : ''}" data-lots-toggle data-ticker="${esc(ticker)}" aria-expanded="${isOpen}">
        <span class="chevron">▾</span>
        ${isOpen ? 'Hide' : 'Show'} lots (${h.lots.length})
      </button>
      <div class="lots-body${isOpen ? ' open' : ''}" aria-hidden="${!isOpen}">
        ${lotsHtml}
      </div>
    </div>
    ${bodyHtml}
    ${(!st.loading && !st.error && analysis) ? `<div class="card-foot"><button class="btn btn-ghost btn-sm" data-export data-ticker="${esc(ticker)}">Export this stock</button></div>` : ''}
  </div>`;
}

// ── Upcoming list ─────────────────────────────────────────────────────────────
async function renderUpcoming() {
  const list = document.getElementById('upcoming-list');
  if (!list) return;

  let items;
  try {
    items = await api('GET', '/api/upcoming');
  } catch (e) {
    list.innerHTML = '<div class="up-empty">Failed to load upcoming dividends.</div>';
    return;
  }

  if (!items.length) {
    list.innerHTML = '<div class="up-empty">No upcoming dividends in the next 90 days.</div>';
    return;
  }

  list.innerHTML = items.map(it => `
    <div class="upcoming-item">
      <span class="up-type-badge up-ex">Ex</span>
      <span class="up-date">${fmtShort(it.exDate)}</span>
      <span class="up-type-badge up-pay">Pay</span>
      <span class="up-date">${fmtShort(it.payDate)}</span>
      <span class="ticker-badge" style="font-size:10.5px">${esc(it.ticker)}</span>
      <span class="up-company">${esc(it.company)}</span>
      <span class="up-per-share">${money(it.amount, it.currency)}/sh</span>
      <span class="up-amount">${it.totalReceived > 0 ? money(it.totalReceived, it.currency) : '—'}</span>
    </div>`).join('');
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal() {
  document.getElementById('modal-overlay').style.display = 'flex';
  document.body.classList.add('modal-open');
  const ticker = document.getElementById('m-ticker');
  setTimeout(() => ticker.focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.body.classList.remove('modal-open');
  hideModalError();
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideModalError() {
  document.getElementById('modal-error').style.display = 'none';
}

async function submitModal() {
  const ticker = document.getElementById('m-ticker').value.trim().toUpperCase();
  const date   = document.getElementById('m-date').value;
  const shares = document.getElementById('m-shares').value;
  const price  = document.getElementById('m-price').value.trim();

  hideModalError();

  if (!ticker)  return showModalError('Please enter a ticker.');
  if (!date)    return showModalError('Please select a purchase date.');
  if (!shares || parseInt(shares, 10) < 1) return showModalError('Shares must be a positive number.');

  const submitBtn  = document.getElementById('modal-submit');
  const submitLbl  = document.getElementById('modal-submit-label');
  const submitSpin = document.getElementById('modal-submit-spin');
  submitBtn.disabled    = true;
  submitLbl.textContent = 'Adding…';
  submitSpin.style.display = 'inline-block';

  try {
    await api('POST', '/api/holdings', {
      ticker, date_bought: date, shares,
      price_per_share: price === '' ? null : price
    });
    closeModal();
    document.getElementById('m-ticker').value = '';
    document.getElementById('m-shares').value = '';
    document.getElementById('m-price').value  = '';
    await loadHoldings();
    loadDividends(ticker);
    showToast(`${ticker} added`);
  } catch (e) {
    showModalError(e.message);
  } finally {
    submitBtn.disabled    = false;
    submitLbl.textContent = 'Add Holding';
    submitSpin.style.display = 'none';
  }
}

// ── Remove lot / refresh ──────────────────────────────────────────────────────
async function removeLot(lotId, ticker) {
  try {
    const result = await api('DELETE', `/api/lots/${lotId}`);
    if (result.holdingRemoved) {
      divState.delete(ticker);
      lotsOpen.delete(ticker);
    }
    await loadHoldings();
    if (!result.holdingRemoved && holdings.some(h => h.ticker === ticker)) {
      loadDividends(ticker);
    }
    showToast('Lot removed');
  } catch (e) {
    showToast('Failed to remove lot', 'error');
    console.error('removeLot:', e.message);
  }
}

async function refresh(ticker) {
  const wrapper = document.getElementById('holdings-grid')?.querySelector(`[data-card="${CSS.escape(ticker)}"]`);
  const btn = wrapper?.querySelector('[data-refresh]');
  if (btn) btn.innerHTML = '<span class="spin" aria-hidden="true">↻</span>';
  try {
    await api('DELETE', `/api/cache/${encodeURIComponent(ticker)}`);
  } catch { /* ignore */ }
  loadDividends(ticker, true);
}

// ── Export (SheetJS) ──────────────────────────────────────────────────────────
function exportStock(ticker) {
  const st   = divState.get(ticker);
  const h    = holdings.find(h => h.ticker === ticker);
  if (!st?.data || !h) return showToast('No data to export yet', 'error');

  const data = st.data;
  const a    = data.analysis;
  const cName = cleanName(data.name, ticker);
  const rows = [['Ex Date','Pay Date','Company','Shares','Per Share','Currency','Received','Period']];
  for (const p of a.payouts) {
    if (!p.upcoming) {
      const yr  = p.exDate.slice(0, 4);
      const mon = parseInt(p.exDate.slice(5, 7), 10);
      const period = `${yr} ${mon <= 6 ? 'H1' : 'H2'}`;
      rows.push([p.exDate, p.payDate || '', cName, p.eligibleShares, p.perShare, p.currency || 'SGD', p.received, period]);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), ticker);
  XLSX.writeFile(wb, `${ticker}_Dividends_${todayISO()}.xlsx`);
  showToast(`${ticker} exported`);
}

function exportAll() {
  if (!holdings.length) return showToast('No holdings to export', 'error');

  // Sheet 1: Portfolio Summary
  const s1 = [['Ticker','Company','Total Shares','Total Invested (SGD)','Avg Cost/Share','All-time Dividends (SGD)','Yield on Cost (%)']];
  for (const h of holdings) {
    const st = divState.get(h.ticker);
    const a  = st?.data?.analysis;
    const invested = h.cost.totalInvested;
    const allTime  = a?.allTimeReceived || 0;
    const yoc      = invested > 0 ? (allTime / invested * 100).toFixed(2) : '';
    s1.push([h.ticker, cleanName(st?.data?.name, h.ticker), h.cost.totalShares, invested.toFixed(2), h.cost.avgCost?.toFixed(3) || '', allTime.toFixed(2), yoc]);
  }

  // Sheet 2: Full Dividend History
  const s2 = [['Ticker','Company','Ex Date','Pay Date','Eligible Shares','Per Share','Currency','Total Received','Period']];
  for (const h of holdings) {
    const st = divState.get(h.ticker);
    if (!st?.data) continue;
    for (const p of (st.data.analysis?.payouts || [])) {
      if (!p.upcoming) {
        const yr  = p.exDate.slice(0, 4);
        const mon = parseInt(p.exDate.slice(5, 7), 10);
        s2.push([h.ticker, cleanName(st.data.name, h.ticker), p.exDate, p.payDate || '', p.eligibleShares, p.perShare, p.currency || 'SGD', p.received.toFixed(2), `${yr} ${mon <= 6 ? 'H1' : 'H2'}`]);
      }
    }
  }

  // Sheet 3: Period Breakdown
  const s3 = [['Ticker','Company','Year','H1 (SGD)','H2 (SGD)','Total (SGD)','Yield on Cost (%)']];
  for (const h of holdings) {
    const st = divState.get(h.ticker);
    if (!st?.data) continue;
    const invested = h.cost.totalInvested;
    const byYear = {};
    for (const p of (st.data.analysis?.periods || [])) {
      const [yr, half] = p.key.split(' ');
      if (!byYear[yr]) byYear[yr] = { H1: 0, H2: 0 };
      byYear[yr][half] = (byYear[yr][half] || 0) + p.total;
    }
    for (const [yr, halves] of Object.entries(byYear).sort()) {
      const total = (halves.H1 || 0) + (halves.H2 || 0);
      const yoc   = invested > 0 ? (total / invested * 100).toFixed(2) : '';
      s3.push([h.ticker, cleanName(st.data.name, h.ticker), yr, (halves.H1 || 0).toFixed(2), (halves.H2 || 0).toFixed(2), total.toFixed(2), yoc]);
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s1), 'Portfolio Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), 'Full Dividend History');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s3), 'Period Breakdown');
  XLSX.writeFile(wb, `SGX_Dividend_Tracker_${todayISO()}.xlsx`);
  showToast('Portfolio exported to Excel');
}

// ── Event wiring ──────────────────────────────────────────────────────────────
function wireEvents() {
  // Navbar
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('add-holding-btn').addEventListener('click', openModal);
  document.getElementById('export-all-btn').addEventListener('click', exportAll);
  document.getElementById('empty-add-btn').addEventListener('click', openModal);

  // Modal
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-submit').addEventListener('click', submitModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Modal form keyboard nav
  const mFields = ['m-ticker', 'm-date', 'm-shares', 'm-price'];
  mFields.forEach((id, i) => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (i < mFields.length - 1) document.getElementById(mFields[i+1]).focus();
        else submitModal();
      }
    });
  });

  // ESC closes modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('modal-overlay').style.display !== 'none') closeModal();
    }
  });

  // Holdings grid delegation (lots, refresh, remove, export)
  document.getElementById('holdings-grid').addEventListener('click', e => {
    const lotRemove = e.target.closest('.lot-remove');
    if (lotRemove) { removeLot(lotRemove.dataset.lot, lotRemove.dataset.ticker); return; }

    const refreshBtn = e.target.closest('[data-refresh]');
    if (refreshBtn) { refresh(refreshBtn.dataset.ticker); return; }

    const exportBtn = e.target.closest('[data-export]');
    if (exportBtn) { exportStock(exportBtn.dataset.ticker); return; }

    const lotsToggle = e.target.closest('[data-lots-toggle]');
    if (lotsToggle) {
      const ticker = lotsToggle.dataset.ticker;
      const wrapper = document.querySelector(`[data-card="${CSS.escape(ticker)}"]`);
      if (!wrapper) return;
      const body = wrapper.querySelector('.lots-body');
      const isOpen = body.classList.contains('open');
      if (isOpen) {
        lotsOpen.delete(ticker);
        body.classList.remove('open');
        lotsToggle.classList.remove('open');
        lotsToggle.setAttribute('aria-expanded', 'false');
        lotsToggle.innerHTML = `<span class="chevron">▾</span> Show lots (${body.querySelectorAll('.lot-row').length})`;
      } else {
        lotsOpen.add(ticker);
        body.classList.add('open');
        lotsToggle.classList.add('open');
        lotsToggle.setAttribute('aria-expanded', 'true');
        lotsToggle.innerHTML = `<span class="chevron">▾</span> Hide lots (${body.querySelectorAll('.lot-row').length})`;
      }
      return;
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  initTheme();

  // Set today as default date in modal, restrict future dates
  const dateInput = document.getElementById('m-date');
  dateInput.max   = todayISO();
  dateInput.value = todayISO();

  wireEvents();
  loadHoldings();
}

init();
