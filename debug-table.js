'use strict';
// Simulates exactly what server.js parseDividendsHtml does, step by step.
const axios   = require('axios');
const cheerio = require('cheerio');

axios.get('https://www.dividends.sg/view/OV8', {
  timeout: 15000,
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' }
}).then(r => {
  const $ = cheerio.load(r.data);

  // ── 1. Find the table (same logic as server.js) ───────────────────────────
  let table = null;
  $('table').each((_, el) => {
    if (table) return;
    const headerText = $(el).find('thead').text() || $(el).find('tr').first().text() || '';
    if (/Ex Date/i.test(headerText)) table = el;
  });
  console.log('Table found:', !!table);
  const $table = $(table);

  // ── 2. Find headers (same fallback as server.js) ──────────────────────────
  let headerCells = $table.find('thead th').map((_, e) => $(e).text().trim().toLowerCase()).get();
  console.log('Step1 headers (thead th):', headerCells);
  if (!headerCells.length) {
    headerCells = $table.find('tr').first().find('th').map((_, e) => $(e).text().trim().toLowerCase()).get();
    console.log('Step2 headers (tr.first th):', headerCells);
  }

  const col = {
    year:    headerCells.findIndex(c => c === 'year'),
    amount:  headerCells.findIndex(c => c === 'amount'),
    exDate:  headerCells.findIndex(c => c.includes('ex date')),
    payDate: headerCells.findIndex(c => c.includes('pay date')),
  };
  console.log('col indices:', col);
  console.log('colCount:', headerCells.length);

  // ── 3. Grid builder ───────────────────────────────────────────────────────
  const colCount = headerCells.length;
  const spanRemaining = new Array(colCount).fill(0);
  const spanValue     = new Array(colCount).fill('');
  const grid = [];

  let rows = $table.find('tbody tr');
  if (!rows.length) rows = $table.find('tr').slice(1);
  console.log('\nTotal tbody rows:', rows.length);

  rows.each((rowIdx, row) => {
    const gridRow = new Array(colCount).fill(null);
    for (let c = 0; c < colCount; c++) {
      if (spanRemaining[c] > 0) { gridRow[c] = spanValue[c]; spanRemaining[c]--; }
    }
    const tds = $(row).find('td').toArray();
    let tdIdx = 0;
    for (let c = 0; c < colCount && tdIdx < tds.length; c++) {
      if (gridRow[c] !== null) continue;
      const td = $(tds[tdIdx++]);
      const text = td.text().trim();
      const rs   = parseInt(td.attr('rowspan') || '1', 10);
      gridRow[c] = text;
      if (rs > 1) { spanRemaining[c] = rs - 1; spanValue[c] = text; }
    }
    for (let c = 0; c < colCount; c++) if (gridRow[c] === null) gridRow[c] = '';
    grid.push(gridRow);

    const yr = col.year >= 0 ? gridRow[col.year] : '?';
    const am = col.amount >= 0 ? gridRow[col.amount] : '?';
    const ex = col.exDate >= 0 ? gridRow[col.exDate] : '?';
    const td2 = $(row).find('td').length;
    console.log(`  row[${rowIdx}] tds=${td2}  year="${yr}"  amount="${am}"  exDate="${ex}"`);
  });

  // ── 4. Extract dividends ──────────────────────────────────────────────────
  console.log('\nExtracting dividends:');
  const dividends = [];
  for (const gridRow of grid) {
    const exDateRaw = col.exDate >= 0 ? gridRow[col.exDate] : '';
    if (!exDateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(exDateRaw)) continue;
    const amountRaw = col.amount >= 0 ? gridRow[col.amount] : '';
    const amtMatch  = amountRaw.match(/^([A-Z]{3})\s*([\d.]+)$/);
    let currency = 'SGD', amount = null;
    if (amtMatch) { currency = amtMatch[1]; amount = parseFloat(amtMatch[2]); }
    else { const n = amountRaw.match(/([\d.]+)/); if (n) amount = parseFloat(n[1]); }
    if (amount == null || isNaN(amount)) { console.log('  SKIP (amount fail):', amountRaw); continue; }
    const year = col.year >= 0 ? (parseInt(gridRow[col.year], 10) || null) : null;
    dividends.push({ year, exDate: exDateRaw, amount, currency });
    console.log(`  + ${exDateRaw}  ${currency} ${amount}  (${year})`);
  }
  console.log('\nTotal dividends extracted:', dividends.length);
}).catch(e => console.error('ERR:', e.message));
