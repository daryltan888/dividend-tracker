'use strict';

const path      = require('path');
const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const dbPromise = require('./database'); // Promise<Db>

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Date helpers ──────────────────────────────────────────────────────────────
// Ex-dates and lot dates are both ISO "YYYY-MM-DD", so lexicographic string
// comparison is also chronological — no timezone hazards.
function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function periodKey(iso) {
  const year  = iso.slice(0, 4);
  const month = parseInt(iso.slice(5, 7), 10);
  return `${year} ${month <= 6 ? 'H1' : 'H2'}`;
}

// ── Scraping (server-side, direct fetch — no CORS proxy needed) ───────────────
async function scrapeDividends(ticker) {
  const url = `https://www.dividends.sg/view/${encodeURIComponent(ticker)}`;
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  return parseDividendsHtml(String(resp.data), ticker);
}

function parseDividendsHtml(html, ticker) {
  const $ = cheerio.load(html);

  // Company name — heading looks like "CSE GLOBAL LTD (544) SGD 1.30 ..."
  let name = '';
  const heading = $('h4, h3, h2').first();
  if (heading.length) {
    name = heading.text().trim().replace(/\(\d+\).*$/, '').trim();
  }
  if (!name) name = ticker;

  // TTM yield
  let ttmYield = null;
  const ttmMatch = $('body').text().match(/TTM Dividend Yield:\s*([\d.]+%)/);
  if (ttmMatch) ttmYield = ttmMatch[1];

  // Find the dividend table — the one whose header contains "Ex Date".
  let table = null;
  $('table').each((_, el) => {
    if (table) return;
    const headerText = $(el).find('thead').text() || $(el).find('tr').first().text() || '';
    if (/Ex Date/i.test(headerText)) table = el;
  });
  if (!table) throw new Error('Dividend table not found');
  const $table = $(table);

  let headerCells = $table.find('thead th').map((_, e) => $(e).text().trim().toLowerCase()).get();
  if (!headerCells.length) {
    headerCells = $table.find('tr').first().find('th').map((_, e) => $(e).text().trim().toLowerCase()).get();
  }

  const col = {
    year:    headerCells.findIndex(c => c === 'year'),
    amount:  headerCells.findIndex(c => c === 'amount'),
    exDate:  headerCells.findIndex(c => c.includes('ex date')),
    payDate: headerCells.findIndex(c => c.includes('pay date'))
  };

  let rows = $table.find('tbody tr');
  if (!rows.length) rows = $table.find('tr').slice(1);

  const dividends = [];
  let currentYear = null;

  rows.each((_, row) => {
    const cells = $(row).find('td').map((__, c) => $(c).text().trim()).get();
    if (!cells.length) return;

    if (col.year >= 0 && cells[col.year]) {
      const y = parseInt(cells[col.year], 10);
      if (!isNaN(y)) currentYear = y;
    }

    const amountRaw  = col.amount  >= 0 ? cells[col.amount]  : '';
    const exDateRaw  = col.exDate  >= 0 ? cells[col.exDate]  : '';
    const payDateRaw = col.payDate >= 0 ? cells[col.payDate] : '';

    if (!exDateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(exDateRaw)) return;

    const amtMatch = amountRaw.match(/^([A-Z]{3})\s*([\d.]+)$/);
    let currency = 'SGD', amount = null;
    if (amtMatch) {
      currency = amtMatch[1];
      amount   = parseFloat(amtMatch[2]);
    } else {
      const numMatch = amountRaw.match(/([\d.]+)/);
      if (numMatch) amount = parseFloat(numMatch[1]);
    }
    if (amount === null || isNaN(amount)) return;

    dividends.push({
      year: currentYear, exDate: exDateRaw,
      payDate: /^\d{4}-\d{2}-\d{2}$/.test(payDateRaw) ? payDateRaw : null,
      amount, currency
    });
  });

  dividends.sort((a, b) => (a.exDate < b.exDate ? 1 : -1)); // newest first
  return { name, ticker, ttmYield, dividends };
}

// Serve from cache if <24h old, otherwise scrape fresh and update cache.
async function getDividendData(db, ticker, force = false) {
  if (!force) {
    const row = db.prepare('SELECT data, fetched_at FROM dividend_cache WHERE ticker = ?').get(ticker);
    if (row && row.data) {
      const age = Date.now() - new Date(row.fetched_at).getTime();
      if (age < CACHE_TTL_MS) {
        const parsed = JSON.parse(row.data);
        parsed._cached = true;
        parsed._fetchedAt = row.fetched_at;
        return parsed;
      }
    }
  }

  const fresh = await scrapeDividends(ticker);
  const fetchedAt = new Date().toISOString();
  db.prepare(`INSERT INTO dividend_cache (ticker, data, fetched_at) VALUES (?, ?, ?)
              ON CONFLICT(ticker) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`)
    .run(ticker, JSON.stringify(fresh), fetchedAt);
  fresh._cached = false;
  fresh._fetchedAt = fetchedAt;
  return fresh;
}

// ── Calculations ──────────────────────────────────────────────────────────────
// Total invested sums only lots that carry a price; avg cost = invested / shares.
function costBasis(lots) {
  const totalShares   = lots.reduce((s, l) => s + l.shares, 0);
  const totalInvested = lots.reduce((s, l) =>
    (l.price_per_share != null && l.price_per_share > 0) ? s + l.shares * l.price_per_share : s, 0);
  const avgCost = (totalInvested > 0 && totalShares > 0) ? totalInvested / totalShares : null;
  return { totalShares, totalInvested, avgCost };
}

// Per-payout eligibility, half-year period breakdown, and yield on cost.
function computeAnalysis(lots, dividends) {
  const cb = costBasis(lots);
  const today = todayISO();
  const payouts = [];
  const periodMap = new Map();
  let allTimeReceived = 0;

  const sorted = [...dividends].sort((a, b) => (a.exDate < b.exDate ? 1 : -1));
  for (const d of sorted) {
    if (d.amount == null) continue;
    const eligibleShares = lots.reduce((s, l) => (l.date_bought < d.exDate ? s + l.shares : s), 0);
    if (eligibleShares <= 0) continue; // payout predates all ownership — skip

    const received = eligibleShares * d.amount;
    const upcoming = d.exDate > today;
    payouts.push({
      exDate: d.exDate, payDate: d.payDate, currency: d.currency || 'SGD',
      perShare: d.amount, eligibleShares, received, upcoming
    });

    if (!upcoming) {
      allTimeReceived += received;
      const key = periodKey(d.exDate);
      periodMap.set(key, (periodMap.get(key) || 0) + received);
    }
  }

  const periods = [...periodMap.entries()]
    .map(([key, total]) => ({
      key, total,
      yieldOnCost: cb.totalInvested > 0 ? (total / cb.totalInvested) * 100 : null
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  const allTimeYieldOnCost = cb.totalInvested > 0 ? (allTimeReceived / cb.totalInvested) * 100 : null;
  return { ...cb, payouts, periods, allTimeReceived, allTimeYieldOnCost };
}

// ── DB query helpers ──────────────────────────────────────────────────────────
const LOT_COLS = 'id, holding_id, shares, price_per_share, date_bought, created_at';

function getHoldingById(db, id) {
  const h = db.prepare('SELECT id, ticker, created_at FROM holdings WHERE id = ?').get(id);
  if (!h) return null;
  const lots = db.prepare(`SELECT ${LOT_COLS} FROM lots WHERE holding_id = ? ORDER BY date_bought ASC, id ASC`).all(id);
  return { ...h, lots, cost: costBasis(lots) };
}

function lotsForTicker(db, ticker) {
  const h = db.prepare('SELECT id FROM holdings WHERE ticker = ?').get(ticker);
  if (!h) return [];
  return db.prepare('SELECT shares, price_per_share, date_bought FROM lots WHERE holding_id = ?').all(h.id);
}

// ── Routes + server startup ───────────────────────────────────────────────────
// Await db initialisation before registering routes so all handlers
// can use the db instance synchronously.
(async () => {
  const db = await dbPromise;

  // GET all holdings with their lots + cost basis.
  app.get('/api/holdings', (req, res) => {
    const holdings = db.prepare('SELECT id, ticker, created_at FROM holdings ORDER BY created_at ASC, id ASC').all();
    const lotStmt  = db.prepare(`SELECT ${LOT_COLS} FROM lots WHERE holding_id = ? ORDER BY date_bought ASC, id ASC`);
    const out = holdings.map(h => {
      const lots = lotStmt.all(h.id);
      return { ...h, lots, cost: costBasis(lots) };
    });
    res.json(out);
  });

  // POST — add a new holding, or a new lot to an existing ticker.
  app.post('/api/holdings', (req, res) => {
    let { ticker, date_bought, shares, price_per_share } = req.body || {};
    ticker = String(ticker || '').trim().toUpperCase();
    shares = parseInt(shares, 10);

    if (!ticker) return res.status(400).json({ error: 'Ticker is required.' });
    if (!date_bought || !/^\d{4}-\d{2}-\d{2}$/.test(date_bought))
      return res.status(400).json({ error: 'A valid purchase date (YYYY-MM-DD) is required.' });
    if (date_bought > todayISO())
      return res.status(400).json({ error: 'Purchase date cannot be in the future.' });
    if (!shares || shares < 1)
      return res.status(400).json({ error: 'Shares must be a positive integer.' });

    let price = null;
    if (price_per_share !== undefined && price_per_share !== null && String(price_per_share).trim() !== '') {
      price = parseFloat(price_per_share);
      if (isNaN(price) || price < 0)
        return res.status(400).json({ error: 'Price per share must be a positive number, or omitted.' });
    }

    const tx = db.transaction(() => {
      let holding = db.prepare('SELECT id FROM holdings WHERE ticker = ?').get(ticker);
      if (!holding) {
        const info = db.prepare('INSERT INTO holdings (ticker) VALUES (?)').run(ticker);
        holding = { id: info.lastInsertRowid };
      }
      db.prepare('INSERT INTO lots (holding_id, shares, price_per_share, date_bought) VALUES (?, ?, ?, ?)')
        .run(holding.id, shares, price, date_bought);
      return holding.id;
    });

    try {
      const id = tx();
      res.status(201).json(getHoldingById(db, id));
    } catch (e) {
      console.error('POST /api/holdings error:', e.message);
      res.status(500).json({ error: 'Failed to save holding.' });
    }
  });

  // DELETE a lot; drop the holding too if no lots remain.
  app.delete('/api/lots/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lot = db.prepare('SELECT holding_id FROM lots WHERE id = ?').get(id);
    if (!lot) return res.status(404).json({ error: 'Lot not found.' });

    let holdingRemoved = false;
    db.transaction(() => {
      db.prepare('DELETE FROM lots WHERE id = ?').run(id);
      const remaining = db.prepare('SELECT COUNT(*) AS c FROM lots WHERE holding_id = ?').get(lot.holding_id).c;
      if (remaining === 0) {
        db.prepare('DELETE FROM holdings WHERE id = ?').run(lot.holding_id);
        holdingRemoved = true;
      }
    })();

    res.json({ ok: true, holdingRemoved });
  });

  // GET dividend data (cached <24h, else scraped) plus computed analysis.
  app.get('/api/dividends/:ticker', async (req, res) => {
    const ticker = String(req.params.ticker).trim().toUpperCase();
    const force  = req.query.force === '1' || req.query.force === 'true';
    try {
      const data     = await getDividendData(db, ticker, force);
      const analysis = computeAnalysis(lotsForTicker(db, ticker), data.dividends);
      res.json({ ...data, analysis });
    } catch (e) {
      console.error('Dividend fetch failed for', ticker, '-', e.message);
      res.status(502).json({ error: `Could not fetch dividend data for ${ticker}.`, detail: e.message });
    }
  });

  // DELETE cache entry for a ticker (forces re-scrape on next fetch).
  app.delete('/api/cache/:ticker', (req, res) => {
    const ticker = String(req.params.ticker).trim().toUpperCase();
    db.prepare('DELETE FROM dividend_cache WHERE ticker = ?').run(ticker);
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    console.log(`SGX Dividend Tracker running at http://localhost:${PORT}`);
  });
})();
