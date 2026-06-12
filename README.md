# SGX Dividend Tracker

A free, lightweight personal finance tool to track dividends from your Singapore equities (SGX) portfolio. No API key, no subscription, no cost.

## Features

- Add any SGX stock by ticker code (e.g. `544`, `D05`, `A17U`)
- Auto-fetches dividend history directly from [dividends.sg](https://www.dividends.sg) — no AI or API key required
- Calculates **your total dividend received** based on shares held × amount per share
- Shows ex date, pay date, per-share amount, and your total payout
- Handles stocks that pay 2x/year, 4x/year, or any frequency — pulled straight from the source
- Tracks TTM (trailing twelve months) dividends, upcoming payouts, and all-time total
- Data cached in browser for 24 hours, holdings persist across sessions

## How it works

The app fetches the dividend table from `dividends.sg/view/{TICKER}` through a free public CORS proxy (since browsers block direct cross-site requests), then parses the HTML table to extract Year, Amount, Ex Date, and Pay Date — exactly as shown on the source site.

## Setup

### Run locally
Just open `index.html` in your browser — no build step, no server, no account needed.

### Deploy via GitHub Pages
1. Push these files to a GitHub repo
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/ (root)` folder
4. Your app goes live at `https://YOUR_USERNAME.github.io/dividend-tracker`

## Usage

1. Enter an SGX ticker code (e.g. `544` for CSE Global) and your share quantity
2. Click **Add**
3. The app fetches and displays the dividend history with your calculated payouts
4. Use **↻** on any card to force a fresh fetch (bypasses the 24h cache)

## Notes

- Dividend data accuracy depends on dividends.sg and the CORS proxy being reachable. If a fetch fails, click ↻ to retry or it will fall back to a second proxy automatically.
- This tool is for personal tracking only — not financial advice.
- All your holdings and cached data stay in your browser's localStorage only.

## Folder structure

```
dividend-tracker/
├── index.html   # App shell and layout
├── style.css    # Styles (light + dark mode)
├── app.js       # Scraping, parsing, calculation, rendering
└── README.md
```
