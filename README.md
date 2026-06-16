# StockResearch Portfolio Dashboard

A private-first MVP for tracking a stock watchlist or optional portfolio holdings, reviewing daily movement, reading concise market/news briefs, and seeing transparent rule-based signals.

## MVP privacy model

- Tickers, optional share counts, and optional cost basis are stored in the browser with `localStorage`.
- Portfolio data is not committed to GitHub and is not required for the dashboard to work.
- The app can be used in ticker-only mode if you do not want to enter share counts.
- API keys are not required for the MVP and should never be committed to the repository.

## Features

- Mobile-responsive static dashboard.
- Ticker-only watchlist mode.
- Optional shares and average cost for wealth tracking.
- Daily movement cards with simple rule-based buy/hold/sell-style signals.
- Short news abstracts with links for portfolio tickers.
- Macro event links for Federal Reserve, BEA, and BLS calendars.
- Local JSON export for backup.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Build

```bash
npm run build
```

The static output is generated in `dist/`.

## Deploy online for free

You now have two supported free deployment paths:

1. **GitHub Pages** if you make this repository public.
2. **Cloudflare Pages** if you want to keep this repository private.

For GitHub Pages, make the repository public, then configure **Settings → Pages → Source → GitHub Actions**. The included workflow builds and deploys the `dist/` output.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for step-by-step instructions and privacy notes for both options.

## Data-source notes

The MVP attempts browser-based quote loading and falls back to deterministic demo data when a provider is unavailable. For production-grade decisions, configure an official market-data provider through a server-side job or GitHub Actions secret so API keys are not exposed in browser code.

Potential future optional providers:

- Alpha Vantage for daily prices, indicators, and fundamentals.
- Finnhub for company news, quotes, and financial data.

Do not paste real API keys into the app, README, frontend code, or committed `.env` files.

## Disclaimer

Signals are educational decision-support indicators, not personalized financial advice. Confirm market data with your broker or a trusted financial-data provider before making investment decisions.
