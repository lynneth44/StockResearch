const HOLDINGS_KEY = 'stockresearch.holdings.v1';
const API_KEY_STORAGE_KEY = 'stockresearch.alphaVantageApiKey.v1';
const QUOTE_CACHE_KEY = 'stockresearch.quoteCache.v1';
const QUOTE_CACHE_TTL_MS = 15 * 60 * 1000;
const RISK_FREE_RATE = 0.025;
const APP_VERSION = '2026-06-17 Yahoo primary + throttled Alpha Vantage fallback';
const starterHoldings = [{ id: crypto.randomUUID(), ticker: 'AAPL' }, { id: crypto.randomUUID(), ticker: 'MSFT' }, { id: crypto.randomUUID(), ticker: 'NVDA' }];

let holdings = loadHoldings();
let snapshots = {};
let priceErrors = {};
let appMessages = [];
let isLoading = false;
let alphaVantageApiKey = localStorage.getItem(API_KEY_STORAGE_KEY) ?? '';
let selectedTicker = holdings[0]?.ticker ?? 'AAPL';
let route = location.hash === '#analysis' ? 'analysis' : 'dashboard';
let newsTab = 'portfolio';
let portfolioPeriod = '1m';
let analysisPeriod = '6m';
let lastAlphaVantageRequestAt = 0;
const PERIODS = ['1d', '1m', '6m', '1y'];
const chartRegistry = new Map();

const app = document.querySelector('#app');

window.addEventListener('hashchange', () => {
  route = location.hash === '#analysis' ? 'analysis' : 'dashboard';
  render();
});

function loadHoldings() {
  const raw = localStorage.getItem(HOLDINGS_KEY);
  if (!raw) return starterHoldings;
  try {
    return JSON.parse(raw).map((holding) => ({ ...holding, ticker: normalizeTicker(holding.ticker) })).filter((holding) => holding.ticker);
  } catch {
    return starterHoldings;
  }
}

function saveHoldings() {
  localStorage.setItem(HOLDINGS_KEY, JSON.stringify(holdings));
}

function normalizeTicker(ticker) {
  return String(ticker ?? '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function getTickers() {
  return Array.from(new Set(holdings.map((holding) => holding.ticker)));
}

function alphaVantageUrl(params) {
  const url = new URL('https://www.alphavantage.co/query');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('apikey', alphaVantageApiKey);
  return url;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadQuoteCache() {
  try {
    return JSON.parse(localStorage.getItem(QUOTE_CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function getCachedQuote(ticker) {
  const cached = loadQuoteCache()[ticker];
  if (!cached || Date.now() - cached.cachedAt > QUOTE_CACHE_TTL_MS) return null;
  return cached.snapshot;
}

function saveCachedQuote(ticker, snapshot) {
  const cache = loadQuoteCache();
  cache[ticker] = { cachedAt: Date.now(), snapshot };
  localStorage.setItem(QUOTE_CACHE_KEY, JSON.stringify(cache));
}

async function throttleAlphaVantage() {
  const elapsed = Date.now() - lastAlphaVantageRequestAt;
  if (elapsed < 1100) await sleep(1100 - elapsed);
  lastAlphaVantageRequestAt = Date.now();
}

async function fetchYahooHistory(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
    const response = await fetch(url);
    if (!response.ok) {
      setPriceError(ticker, `Yahoo Finance HTTP error ${response.status}; trying Alpha Vantage fallback.`);
      return null;
    }
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    const meta = result?.meta;
    if (!timestamps?.length || !closes?.length || !meta?.regularMarketPrice) {
      setPriceError(ticker, 'Yahoo Finance returned no valid chart data; trying Alpha Vantage fallback.');
      return null;
    }
    const history = timestamps
      .map((timestamp, index) => ({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close: closes[index] }))
      .filter((point) => Number.isFinite(point.close))
      .map((point) => ({ ...point, close: Number(point.close.toFixed(2)) }));
    const price = Number(meta.regularMarketPrice.toFixed(2));
    const previousClose = Number((meta.chartPreviousClose ?? history.at(-2)?.close ?? price).toFixed(2));
    const snapshot = {
      ticker,
      quoteSymbol: ticker,
      currency: meta.currency ?? 'USD',
      price,
      previousClose,
      changePercent: previousClose ? Number((((price - previousClose) / previousClose) * 100).toFixed(2)) : 0,
      history,
      source: `Yahoo Finance exact ticker (${ticker}, ${meta.currency ?? 'USD'})`,
      updatedAt: new Date().toISOString(),
    };
    delete priceErrors[ticker];
    saveCachedQuote(ticker, snapshot);
    return snapshot;
  } catch (error) {
    setPriceError(ticker, `Yahoo Finance network/CORS error: ${error.message}. Trying Alpha Vantage fallback.`);
    return null;
  }
}

function addFeedback(type, text) {
  appMessages = [{ type, text, at: new Date().toISOString() }, ...appMessages].slice(0, 6);
}

function setPriceError(ticker, error) {
  priceErrors[ticker] = error;
}

async function fetchAlphaVantageGlobalQuote(ticker) {
  if (!alphaVantageApiKey) {
    setPriceError(ticker, `${priceErrors[ticker] ?? 'Yahoo unavailable'} Alpha Vantage fallback cannot run because no API key is saved.`);
    return null;
  }
  try {
    await throttleAlphaVantage();
    const url = alphaVantageUrl({ function: 'GLOBAL_QUOTE', symbol: ticker });
    const response = await fetch(url);
    if (!response.ok) {
      setPriceError(ticker, `Global Quote HTTP error ${response.status}.`);
      return null;
    }
    const payload = await response.json();
    const apiMessage = payload.Note || payload.Information || payload['Error Message'];
    if (apiMessage) {
      setPriceError(ticker, apiMessage);
      return null;
    }
    const quote = payload['Global Quote'];
    const price = Number(quote?.['05. price']);
    const previousClose = Number(quote?.['08. previous close']) || price;
    const tradingDay = quote?.['07. latest trading day'] ?? new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(price)) {
      setPriceError(ticker, 'Alpha Vantage Global Quote returned no valid price. Confirm ticker symbol and API limit.');
      return null;
    }
    const previousDate = new Date(tradingDay);
    previousDate.setDate(previousDate.getDate() - 1);
    const snapshot = {
      ticker,
      quoteSymbol: ticker,
      currency: 'USD',
      price: Number(price.toFixed(2)),
      previousClose: Number(previousClose.toFixed(2)),
      changePercent: previousClose ? Number((((price - previousClose) / previousClose) * 100).toFixed(2)) : 0,
      history: [
        { date: previousDate.toISOString().slice(0, 10), close: Number(previousClose.toFixed(2)) },
        { date: tradingDay, close: Number(price.toFixed(2)) },
      ],
      source: `Alpha Vantage GLOBAL_QUOTE fallback (${ticker})`,
      updatedAt: new Date().toISOString(),
    };
    delete priceErrors[ticker];
    saveCachedQuote(ticker, snapshot);
    return snapshot;
  } catch (error) {
    setPriceError(ticker, `Network/CORS error while loading Global Quote: ${error.message}`);
    return null;
  }
}

async function getQuoteSnapshot(ticker, allowAlphaFallback = true) {
  const cached = getCachedQuote(ticker);
  if (cached) {
    delete priceErrors[ticker];
    return { ...cached, source: `${cached.source} · cached` };
  }
  const yahoo = await fetchYahooHistory(ticker);
  if (yahoo) return yahoo;
  if (!allowAlphaFallback) {
    setPriceError(ticker, `${priceErrors[ticker] ?? 'Yahoo unavailable'} Alpha Vantage fallback skipped for benchmark to preserve quota.`);
    return null;
  }
  return await fetchAlphaVantageGlobalQuote(ticker);
}

function calculateReturns(values) {
  return values.slice(1).map((value, index) => (value - values[index]) / values[index]).filter(Number.isFinite);
}

function calculateVolatility(values) {
  return standardDeviation(calculateReturns(values)) * 100;
}

function calculateBeta(portfolioReturns, benchmarkReturns) {
  const length = Math.min(portfolioReturns.length, benchmarkReturns.length);
  if (length < 2) return 1;
  const p = portfolioReturns.slice(-length);
  const b = benchmarkReturns.slice(-length);
  const meanP = average(p);
  const meanB = average(b);
  const covariance = average(p.map((value, index) => (value - meanP) * (b[index] - meanB)));
  const variance = average(b.map((value) => (value - meanB) ** 2));
  return variance ? covariance / variance : 1;
}

function calculateSharpe(returns) {
  if (returns.length < 2) return 0;
  const dailyRiskFree = RISK_FREE_RATE / 252;
  const excess = returns.map((value) => value - dailyRiskFree);
  const dailyStd = standardDeviation(excess);
  return dailyStd ? (average(excess) / dailyStd) * Math.sqrt(252) : 0;
}

function percentile(values, percentileRank) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentileRank)));
  return sorted[index];
}

function calculateMaxDrawdown(values) {
  let peak = values[0] ?? 0;
  let maxDrawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak) maxDrawdown = Math.min(maxDrawdown, (value - peak) / peak);
  }
  return maxDrawdown * 100;
}

function currency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value));
}

function buildSignal(snapshot) {
  const prices = snapshot.history.map((point) => point.close);
  const shortAverage = average(prices.slice(-5));
  const longAverage = average(prices.slice(-20));
  const weekBase = prices.at(-6) ?? snapshot.price;
  const recentReturn = ((snapshot.price - weekBase) / weekBase) * 100;
  const volatility = calculateVolatility(prices);
  const reasons = [];
  if (shortAverage > longAverage * 1.015) reasons.push('Short-term trend is above the 20-day trend, suggesting positive momentum.');
  else if (shortAverage < longAverage * 0.985) reasons.push('Short-term trend is below the 20-day trend, suggesting weakening momentum.');
  else reasons.push('Short-term and 20-day trends are close, suggesting a neutral setup.');
  if (recentReturn > 7) reasons.push('The stock rose quickly over the last week, so chase-risk is elevated.');
  if (recentReturn < -7) reasons.push('The stock fell sharply over the last week, so downside pressure should be monitored.');
  if (volatility > 3) reasons.push('Recent volatility is high, so position sizing and stop levels matter more.');
  if (shortAverage > longAverage * 1.015 && recentReturn < 10) return { tone: 'buy', label: 'Constructive / consider adding carefully', confidence: 'medium', reasons };
  if (shortAverage < longAverage * 0.985 || recentReturn < -10) return { tone: 'sell', label: 'Defensive / consider reducing risk', confidence: 'medium', reasons };
  return { tone: 'hold', label: 'Hold / monitor', confidence: 'medium', reasons };
}

function daysForPeriod(period) {
  return { '1d': 2, '1m': 31, '6m': 183, '1y': 366 }[period] ?? 31;
}

function filterSeriesByPeriod(series, period) {
  if (series.length <= 1) return series;
  const end = new Date(series.at(-1).date);
  const start = new Date(end);
  start.setDate(end.getDate() - daysForPeriod(period));
  const filtered = series.filter((point) => new Date(point.date) >= start);
  return filtered.length > 1 ? filtered : series.slice(-2);
}

function renderPeriodControls(activePeriod, target) {
  return `<div class="period-controls">${PERIODS.map((period) => `<button class="period-button ${period === activePeriod ? 'active' : ''}" data-period-target="${target}" data-period="${period}" type="button">${period.toUpperCase()}</button>`).join('')}</div>`;
}

function buildPortfolioSeries() {
  const datedTotals = new Map();
  for (const holding of holdings) {
    const snapshot = snapshots[holding.ticker];
    if (!snapshot) continue;
    const units = holding.shares && holding.shares > 0 ? holding.shares : 1;
    for (const point of snapshot.history) {
      datedTotals.set(point.date, (datedTotals.get(point.date) ?? 0) + point.close * units);
    }
  }
  return Array.from(datedTotals.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value: Number(value.toFixed(2)) }));
}

function buildBenchmarkReturns(length) {
  const spy = snapshots.SPY?.history?.map((point) => point.close);
  if (spy?.length) return calculateReturns(spy).slice(-length);
  return Array.from({ length }, (_, index) => 0.00035 + seededNoise('SPY', index) / 10);
}

function buildPortfolioKpis(series) {
  const values = series.map((point) => point.value);
  const returns = calculateReturns(values);
  const totalReturn = values.length > 1 ? ((values.at(-1) - values[0]) / values[0]) * 100 : 0;
  const volatility = standardDeviation(returns) * Math.sqrt(252) * 100;
  const sharpe = calculateSharpe(returns);
  const beta = calculateBeta(returns, buildBenchmarkReturns(returns.length));
  const maxDrawdown = calculateMaxDrawdown(values);
  const latestValue = values.at(-1) ?? 0;
  const dailyVar95 = Math.abs(percentile(returns, 0.05) * latestValue);
  return { totalReturn, volatility, sharpe, beta, maxDrawdown, dailyVar95 };
}

function movingAverage(points, windowSize) {
  return points.map((point, index) => ({ ...point, ma: index + 1 >= windowSize ? average(points.slice(index + 1 - windowSize, index + 1).map((item) => item.close)) : null }));
}

function bollingerBands(points, windowSize = 20, multiplier = 2) {
  return points.map((point, index) => {
    if (index + 1 < windowSize) return { ...point, middle: null, upper: null, lower: null };
    const window = points.slice(index + 1 - windowSize, index + 1).map((item) => item.close);
    const middle = average(window);
    const sd = standardDeviation(window);
    return { ...point, middle, upper: middle + multiplier * sd, lower: middle - multiplier * sd };
  });
}

function buildNews(tickers) {
  const now = new Date();
  const freeNewsSources = [
    { name: 'Yahoo Finance', url: (ticker) => `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/news` },
    { name: 'Google News', url: (ticker) => `https://news.google.com/search?q=${encodeURIComponent(`${ticker} stock news`)}` },
    { name: 'Nasdaq', url: (ticker) => `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(ticker.toLowerCase())}/news-headlines` },
  ];
  const portfolioNews = tickers.slice(0, 8).flatMap((ticker, tickerIndex) => freeNewsSources.map((source, sourceIndex) => {
    const eventDate = new Date(now.getTime() + (tickerIndex + 1) * 24 * 60 * 60 * 1000);
    const publishDate = new Date(now.getTime() - (tickerIndex * freeNewsSources.length + sourceIndex) * 2 * 60 * 60 * 1000);
    return {
      id: `${ticker}-${source.name}-finance-news`,
      title: `${ticker} latest market headlines via ${source.name}`,
      source: source.name,
      url: source.url(ticker),
      publishedAt: publishDate.toISOString(),
      eventDate: eventDate.toISOString(),
      summary: `Review ${source.name} for recent ${ticker} headlines, earnings guidance, product updates, analyst rating changes, margin commentary, and sector read-throughs. This MVP links to free sources and does not copy full articles; use the abstract as a checklist before opening the source.`,
      analystForecast: 'Analysts will usually focus on revenue growth, EPS revisions, margin direction, valuation, and management guidance. A positive revision cycle would support the signal; downgrades or weak guidance would weaken it.',
      portfolioImpact: `${ticker} impacts the portfolio through direct price movement and sentiment spillover. If this is a large position, treat negative guidance or high volatility as a portfolio-risk event.`,
      potentialImpact: 'Company-specific headlines can affect short-term sentiment; confirm whether the news changes revenue, margin, valuation, or guidance assumptions.',
      relatedTickers: [ticker],
      category: 'portfolio',
    };
  }));
  const macroNews = [
    { id: 'fed-calendar', title: 'Federal Reserve meeting calendar and policy decisions', source: 'Federal Reserve', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Track upcoming FOMC meetings, policy statements, projections, and press conferences because interest-rate expectations directly influence discount rates, equity valuations, and risk appetite. The key items to watch are changes in the policy-rate path, inflation language, labor-market assessment, and whether officials signal cuts, pauses, or tighter-for-longer policy.', analystForecast: 'Analysts typically compare the decision and press conference tone against futures-market expectations. A more dovish Fed can support equities; a hawkish surprise can lift yields and pressure expensive growth stocks.', portfolioImpact: 'Fed surprises can affect nearly every holding. Growth and technology positions are usually more sensitive to discount-rate changes, while banks and defensive sectors may react differently depending on yield-curve expectations.', potentialImpact: 'Higher-for-longer rate expectations can pressure long-duration growth stocks; rate-cut expectations can support risk assets if recession fears remain contained.', category: 'macro' },
    { id: 'bea-gdp', title: 'GDP and broad U.S. economic growth releases', source: 'U.S. Bureau of Economic Analysis', url: 'https://www.bea.gov/news/schedule', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Use the BEA release schedule to watch GDP, income, spending, and inflation-related economic data. These releases help determine whether earnings expectations are supported by real demand or threatened by slowing growth and weaker consumer activity.', analystForecast: 'Consensus forecasts usually focus on annualized GDP growth, consumer spending, inflation components, and revisions. Stronger-than-expected growth can support cyclical earnings, while weak data may increase recession-risk pricing.', portfolioImpact: 'Broad growth data affects portfolio-level risk appetite. If your holdings are concentrated in cyclical or high-beta names, weaker GDP trends can increase drawdown risk.', potentialImpact: 'Stronger growth can support earnings expectations, while hot inflation data may lift rates and weigh on valuations.', category: 'macro' },
    { id: 'bls-cpi-jobs', title: 'Inflation and labor-market release calendar', source: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/schedule/news_release/', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Follow CPI, PPI, employment, wage, and productivity releases because inflation and labor-market surprises can quickly reprice interest rates and sector leadership. The most important details are core inflation momentum, wage pressure, payroll growth, unemployment, and revisions.', analystForecast: 'Analysts compare actual data with consensus and market-implied expectations. Cooler inflation can support valuation multiples, while hotter wage or CPI data can push yields higher and weigh on equities.', portfolioImpact: 'Inflation surprises can move the entire portfolio on the same day. High-valuation and high-duration stocks may be more sensitive than value or defensive holdings.', potentialImpact: 'Hot inflation or wage data can pressure stocks through higher yields; cooling data can help if growth does not deteriorate too quickly.', category: 'macro' },

    { id: 'treasury-yields', title: 'U.S. Treasury yield curve and bond-market signals', source: 'U.S. Treasury', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Monitor Treasury yields and the curve shape because discount rates, bank margins, and equity valuation multiples can change quickly when yields move. The most useful watch items are the 2-year yield, 10-year yield, and whether the curve steepens or flattens.', analystForecast: 'Analysts compare yield moves with Fed expectations and inflation data. Falling yields can support growth valuations; sharply rising real yields often pressure equities.', portfolioImpact: 'Rate-sensitive growth stocks can react strongly to yield changes, while financials and value stocks may respond differently depending on the curve.', potentialImpact: 'Large yield moves can change valuation multiples and sector leadership across the whole portfolio.', category: 'macro' },
    { id: 'earnings-calendar', title: 'Earnings season and company guidance calendar', source: 'Nasdaq earnings calendar', url: 'https://www.nasdaq.com/market-activity/earnings', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Track upcoming earnings reports because guidance changes often drive the largest single-stock moves. Focus on revenue growth, operating margin, free cash flow, backlog, customer demand, and management commentary.', analystForecast: 'Analysts compare reported EPS and revenue with consensus and then revise price targets based on guidance quality and margin direction.', portfolioImpact: 'If multiple holdings report in the same week, earnings season can increase portfolio-level volatility and daily VaR.', potentialImpact: 'Positive guidance can support momentum; weak guidance can trigger sharp drawdowns even when headline EPS beats.', category: 'macro' },
    { id: 'oil-dollar', title: 'Oil prices and U.S. dollar market pulse', source: 'MarketWatch market data', url: 'https://www.marketwatch.com/markets', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Watch oil and the U.S. dollar because they influence inflation expectations, multinational earnings translation, energy-sector margins, and risk sentiment. A stronger dollar can weigh on non-U.S. revenue translation for global companies.', analystForecast: 'Analysts track whether commodity and FX moves are temporary or likely to affect margins, input costs, and reported earnings.', portfolioImpact: 'Dollar strength can pressure exporters and global tech earnings, while oil spikes can affect consumer spending and inflation expectations.', potentialImpact: 'Commodity and FX shocks can create broad market volatility even without company-specific news.', category: 'macro' },
  ];
  return [...portfolioNews, ...macroNews];
}

async function loadQuotes() {
  isLoading = true;
  priceErrors = {};
  render();
  const tickers = Array.from(new Set([...getTickers(), 'SPY']));
  const entries = [];
  for (const symbol of tickers) {
    entries.push([symbol, await getQuoteSnapshot(symbol, symbol !== 'SPY')]);
  }
  snapshots = Object.fromEntries(entries);
  const requested = getTickers().length;
  const loaded = getTickers().filter((ticker) => snapshots[ticker]).length;
  const yahooLoaded = getTickers().filter((ticker) => snapshots[ticker]?.source?.includes('Yahoo')).length;
  const alphaLoaded = getTickers().filter((ticker) => snapshots[ticker]?.source?.includes('Alpha Vantage')).length;
  addFeedback(loaded ? 'success' : 'warning', `Loaded ${loaded}/${requested} prices: ${yahooLoaded} Yahoo, ${alphaLoaded} Alpha Vantage fallback.`);
  isLoading = false;
  render();
}

function addHolding(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const ticker = normalizeTicker(formData.get('ticker'));
  if (!ticker) return;
  const shares = Number(formData.get('shares'));
  const averageCost = Number(formData.get('averageCost'));
  holdings = [...holdings, { id: crypto.randomUUID(), ticker, shares: shares > 0 ? shares : undefined, averageCost: averageCost > 0 ? averageCost : undefined }];
  selectedTicker = ticker;
  saveHoldings();
  addFeedback('success', `${ticker} added. Loading Yahoo price with throttled Alpha Vantage fallback.`);
  event.currentTarget.reset();
  loadQuotes();
}

function removeHolding(id) {
  holdings = holdings.filter((holding) => holding.id !== id);
  if (!holdings.some((holding) => holding.ticker === selectedTicker)) selectedTicker = holdings[0]?.ticker ?? 'AAPL';
  saveHoldings();
  loadQuotes();
}

function saveAlphaVantageApiKey(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  alphaVantageApiKey = String(formData.get('alphaVantageApiKey') ?? '').trim();
  if (alphaVantageApiKey) {
    localStorage.setItem(API_KEY_STORAGE_KEY, alphaVantageApiKey);
    addFeedback('success', 'Alpha Vantage fallback key saved locally. Reloading provider chain now.');
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    addFeedback('warning', 'Alpha Vantage fallback key removed. Yahoo Finance will remain the primary price source.');
  }
  loadQuotes();
}

function exportHoldings() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), currency: 'USD', quoteMode: 'usd-provider-chain', holdings }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `stockresearch-holdings-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function render() {
  chartRegistry.clear();
  const tickers = getTickers();
  const series = buildPortfolioSeries();
  const kpis = buildPortfolioKpis(series);
  const portfolioValue = series.at(-1)?.value ?? 0;
  const costBasis = holdings.reduce((sum, holding) => sum + (holding.averageCost ?? 0) * (holding.shares ?? 0), 0);
  const unrealizedReturn = costBasis ? ((portfolioValue - costBasis) / costBasis) * 100 : kpis.totalReturn;
  const news = buildNews(tickers);
  const filteredNews = news.filter((item) => newsTab === 'portfolio' ? item.category === 'portfolio' : item.category === 'macro');

  app.innerHTML = `
    <nav class="top-nav"><a class="${route === 'dashboard' ? 'active' : ''}" href="#dashboard">Dashboard</a><a class="${route === 'analysis' ? 'active' : ''}" href="#analysis">Stock analysis</a></nav>
    ${route === 'analysis' ? renderAnalysisPage(tickers) : renderDashboard(tickers, series, kpis, portfolioValue, costBasis, unrealizedReturn, news, filteredNews)}`;

  bindEvents();
}

function renderDashboard(tickers, series, kpis, portfolioValue, costBasis, unrealizedReturn, news, filteredNews) {
  return `
    <section class="hero">
      <div>
        <p class="eyebrow">USD dashboard · Yahoo primary · no simulated prices</p><p class="release-note">Updated: ${APP_VERSION}</p>
        <h1>StockResearch portfolio and market briefing</h1>
        <p class="hero-copy">Track ticker-only watchlists or optional holdings, review live-quote performance, monitor risk KPIs, and use transparent signals as decision support.</p>
      </div>
      <div class="privacy-card"><strong>🛡️ USD provider chain</strong><span>Exact-ticker Yahoo data is tried first. Alpha Vantage Global Quote is a throttled fallback. No simulated prices are used.</span></div>
    </section>
    ${renderFeedback()}
    <section class="grid summary-grid" aria-label="Portfolio summary">
      ${summaryCard('Tracked symbols', String(tickers.length), 'Ticker-only mode is supported.')}
      ${summaryCard('Portfolio value', portfolioValue ? currency(portfolioValue) : 'Optional', 'Live quote mode; enter shares for wealth tracking.')}
      ${summaryCard('Performance', `${unrealizedReturn.toFixed(2)}%`, costBasis ? 'Based on your average cost.' : 'Based on available price history.')}
      ${summaryCard('Daily VaR 95%', kpis.dailyVar95 ? currency(kpis.dailyVar95) : '—', 'Estimated one-day downside at 95% confidence.')}
      ${summaryCard('Sharpe ratio', kpis.sharpe.toFixed(2), 'Risk-adjusted return estimate.')}
      ${summaryCard('Beta vs SPY', kpis.beta.toFixed(2), 'Sensitivity versus broad U.S. equity proxy.')}
      ${summaryCard('Max drawdown', `${kpis.maxDrawdown.toFixed(1)}%`, 'Worst historical peak-to-trough move.')}
      ${summaryCard('Data status', isLoading ? 'Loading' : 'Ready', 'Yahoo primary, throttled Alpha Vantage fallback; no simulations.')}
    </section>
    <section class="panel two-column">
      <div>
        <h2>Add ticker or holding</h2><p class="muted">Only ticker is required. Shares and average cost are optional. Average cost should be entered in USD for accurate performance tracking.</p>
        <form class="holding-form" id="holding-form">
          <label>Ticker<input name="ticker" placeholder="e.g. AAPL" /></label>
          <label>Shares optional<input name="shares" type="number" min="0" step="any" placeholder="e.g. 10" /></label>
          <label>Avg. cost optional<input name="averageCost" type="number" min="0" step="any" placeholder="e.g. 185" /></label>
          <button type="submit">＋ Add</button>
        </form>
      </div>
      <div class="actions-card"><h3>Alpha Vantage fallback key</h3><p class="muted">Optional fallback only. Yahoo is tried first. The key stays in this browser and is not committed.</p><form id="api-key-form" class="api-key-form"><input name="alphaVantageApiKey" type="password" value="${escapeHtml(alphaVantageApiKey)}" placeholder="Alpha Vantage API key" /><button type="submit">Save key</button></form><ul><li>No simulated prices are shown when data is unavailable.</li><li>Do not paste API keys into source code.</li><li>Export creates a local backup file.</li></ul><button class="secondary" id="export-button" type="button">⬇ Export local data</button></div>
    </section>
    <section class="panel"><div class="section-heading"><div><h2>Portfolio technical performance</h2><p class="muted">Historical portfolio line chart using optional shares; ticker-only entries are weighted as one unit each. Hover the chart to inspect daily values.</p></div>${renderPeriodControls(portfolioPeriod, 'portfolio')}</div>${renderLineChart(filterSeriesByPeriod(series, portfolioPeriod), { title: `Portfolio value in USD · ${portfolioPeriod.toUpperCase()}`, valuePrefix: '$', chartId: 'portfolio-value' })}</section>
    <section class="panel"><div class="section-heading"><div><h2>Portfolio tracker and signals</h2><p class="muted">Signals are rule-based educational indicators, not financial advice.</p></div></div><div class="stock-grid">${holdings.map(renderStockCard).join('')}</div></section>
    <section class="panel"><div class="section-heading"><div><h2>📰 Market and portfolio news briefing</h2><p class="muted">Longer summaries with publish date, event date, analyst forecast, and portfolio impact.</p></div></div><div class="news-tabs"><button class="tab-button ${newsTab === 'portfolio' ? 'active' : ''}" data-news-tab="portfolio" type="button">Stock news (${news.filter((item) => item.category === 'portfolio').length})</button><button class="tab-button ${newsTab === 'macro' ? 'active' : ''}" data-news-tab="macro" type="button">Economic news (${news.filter((item) => item.category === 'macro').length})</button></div><div class="news-list scrollable-news">${filteredNews.map(renderNewsItem).join('')}</div></section>
    <footer>This app provides informational signals only. Confirm data against your broker or a trusted financial-data provider before making investment decisions.<br><strong>${APP_VERSION}</strong></footer>`;
}

function renderAnalysisPage(tickers) {
  const options = tickers.map((ticker) => `<option value="${escapeHtml(ticker)}" ${ticker === selectedTicker ? 'selected' : ''}>${escapeHtml(ticker)}</option>`).join('');
  const snapshot = snapshots[selectedTicker] ?? snapshots[tickers[0]];
  return `
    <section class="hero compact-hero"><div><p class="eyebrow">Technical analysis</p><h1>Stock analysis chart</h1><p class="hero-copy">Analyze one portfolio stock with close price, 20-day moving average, and Bollinger Bands on a dedicated second page.</p></div></section>
    <section class="panel analysis-controls"><label>Select portfolio stock<select id="ticker-select">${options}</select></label><div>${renderPeriodControls(analysisPeriod, 'analysis')}</div><p class="muted">Charts use exact-ticker Yahoo one-year history. Alpha Vantage Global Quote is used only if Yahoo fails. If both fail, no price is shown. Hover the chart to inspect daily values.</p></section>
    <section class="panel">${snapshot ? renderTechnicalChart(snapshot, analysisPeriod) : '<p class="muted">No price history available. Review the diagnostics above, confirm the exact ticker, and optionally save an Alpha Vantage fallback key.</p>'}</section>`;
}

function bindEvents() {
  document.querySelector('#holding-form')?.addEventListener('submit', addHolding);
  document.querySelector('#export-button')?.addEventListener('click', exportHoldings);
  document.querySelector('#api-key-form')?.addEventListener('submit', saveAlphaVantageApiKey);
  document.querySelector('#ticker-select')?.addEventListener('change', (event) => { selectedTicker = event.target.value; render(); });
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => removeHolding(button.dataset.remove)));
  document.querySelectorAll('[data-select]').forEach((link) => link.addEventListener('click', () => { selectedTicker = link.dataset.select; }));
  document.querySelectorAll('[data-news-tab]').forEach((button) => button.addEventListener('click', () => { newsTab = button.dataset.newsTab; render(); }));
  document.querySelectorAll('[data-period-target]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.periodTarget === 'portfolio') portfolioPeriod = button.dataset.period;
    if (button.dataset.periodTarget === 'analysis') analysisPeriod = button.dataset.period;
    render();
  }));
  document.querySelectorAll('.interactive-chart').forEach(bindChartTooltip);
}

function bindChartTooltip(container) {
  const chartId = container.dataset.chartId;
  const points = chartRegistry.get(chartId);
  const tooltip = container.querySelector('.chart-tooltip');
  if (!points?.length || !tooltip) return;
  container.addEventListener('pointermove', (event) => {
    const rect = container.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(rect.width - 160, Math.max(8, event.clientX - rect.left + 12))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 42)}px`;
    tooltip.innerHTML = `<strong>${escapeHtml(point.date)}</strong><span>${currency(point.value)}</span>`;
  });
  container.addEventListener('pointerleave', () => { tooltip.hidden = true; });
}

function renderFeedback() {
  const errorItems = Object.entries(priceErrors).filter(([ticker]) => ticker !== 'SPY').map(([ticker, error]) => ({ type: 'error', text: `${ticker}: ${error}` }));
  const items = [...errorItems, ...appMessages];
  if (!items.length) return '';
  return `<section class="feedback-panel" aria-live="polite">${items.map((item) => `<div class="feedback-item ${escapeHtml(item.type)}"><strong>${escapeHtml(item.type.toUpperCase())}</strong><span>${escapeHtml(item.text)}</span></div>`).join('')}</section>`;
}

function summaryCard(label, value, detail) {
  return `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail)}</p></article>`;
}

function renderStockCard(holding) {
  const snapshot = snapshots[holding.ticker];
  const signal = snapshot ? buildSignal(snapshot) : null;
  const value = snapshot && holding.shares ? snapshot.price * holding.shares : null;
  return `<article class="stock-card">
    <div class="stock-card-header"><div><h3>${escapeHtml(holding.ticker)}</h3><span>${escapeHtml(snapshot?.source ?? priceErrors[holding.ticker] ?? (alphaVantageApiKey ? 'No price available from Yahoo or Alpha Vantage' : 'No Yahoo price; optional Alpha Vantage fallback key not set'))}</span></div><button class="icon-button" type="button" aria-label="Remove ${escapeHtml(holding.ticker)}" data-remove="${escapeHtml(holding.id)}">🗑</button></div>
    <div class="price-row"><strong>${snapshot ? currency(snapshot.price) : 'No price'}</strong>${snapshot ? `<span class="${snapshot.changePercent >= 0 ? 'positive' : 'negative'}">${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent}%</span>` : ''}</div>
    ${value ? `<p class="muted">Position value: ${currency(value)}</p>` : ''}
    ${signal ? `<div class="signal ${signal.tone}"><strong>${escapeHtml(signal.label)}</strong><span>Confidence: ${escapeHtml(signal.confidence)}</span><ul>${signal.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>` : ''}
    <a class="analysis-link" href="#analysis" data-select="${escapeHtml(holding.ticker)}">Open technical analysis →</a>
  </article>`;
}

function renderNewsItem(item) {
  return `<article class="news-item"><div><span class="tag">${item.category === 'macro' ? 'Macro event' : item.relatedTickers.map(escapeHtml).join(', ')}</span><h3>${escapeHtml(item.title)}</h3><div class="date-row"><span>Published: ${formatDate(item.publishedAt)}</span><span>Event date: ${formatDate(item.eventDate)}</span></div><p>${escapeHtml(item.summary)}</p><p class="impact"><strong>Analyst forecast:</strong> ${escapeHtml(item.analystForecast)}</p><p class="impact"><strong>Portfolio impact:</strong> ${escapeHtml(item.portfolioImpact)}</p><p class="impact"><strong>Potential impact:</strong> ${escapeHtml(item.potentialImpact)}</p></div><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Read source</a></article>`;
}

function renderLineChart(series, options = {}) {
  if (series.length < 2) return '<p class="muted">Add tickers and wait for price data to render the chart.</p>';
  const chartId = options.chartId ?? `chart-${chartRegistry.size + 1}`;
  chartRegistry.set(chartId, series.map((point) => ({ date: point.date, value: point.value })));
  const width = 920;
  const height = 300;
  const padding = 36;
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (index) => padding + (index / (series.length - 1)) * (width - padding * 2);
  const y = (value) => height - padding - ((value - min) / range) * (height - padding * 2);
  const path = series.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
  return `<div class="chart-wrap interactive-chart" data-chart-id="${escapeHtml(chartId)}"><div class="chart-tooltip" hidden></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title ?? 'Line chart')}"><path class="grid-line" d="M ${padding} ${padding} H ${width - padding} M ${padding} ${height / 2} H ${width - padding} M ${padding} ${height - padding} H ${width - padding}"/><path class="chart-line" d="${path}"/><text x="${padding}" y="22" class="chart-label">${escapeHtml(options.title ?? 'Performance')}</text><text x="${padding}" y="${height - 8}" class="chart-axis">${escapeHtml(series[0].date)}</text><text x="${width - padding - 90}" y="${height - 8}" class="chart-axis">${escapeHtml(series.at(-1).date)}</text><text x="${width - padding - 120}" y="22" class="chart-axis">${escapeHtml(options.valuePrefix ?? '')}${max.toFixed(2)}</text><text x="${width - padding - 120}" y="${height - padding + 4}" class="chart-axis">${escapeHtml(options.valuePrefix ?? '')}${min.toFixed(2)}</text></svg></div>`;
}

function renderTechnicalChart(snapshot, period) {
  const eurPoints = filterSeriesByPeriod(snapshot.history.map((point) => ({ date: point.date, close: point.close })), period);
  const maPoints = movingAverage(eurPoints, 20);
  const bandPoints = bollingerBands(eurPoints, 20, 2);
  const series = eurPoints.map((point, index) => ({ ...point, ma: maPoints[index].ma, upper: bandPoints[index].upper, lower: bandPoints[index].lower }));
  const width = 920;
  const height = 360;
  const padding = 42;
  const values = series.flatMap((point) => [point.close, point.ma, point.upper, point.lower]).filter((value) => typeof value === 'number');
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (index) => padding + (index / (series.length - 1)) * (width - padding * 2);
  const y = (value) => height - padding - ((value - min) / range) * (height - padding * 2);
  const pathFor = (key) => series.filter((point) => typeof point[key] === 'number').map((point, index, filtered) => `${index === 0 ? 'M' : 'L'} ${x(series.indexOf(point)).toFixed(1)} ${y(point[key]).toFixed(1)}`).join(' ');
  const chartId = `technical-${snapshot.ticker}`;
  chartRegistry.set(chartId, series.map((point) => ({ date: point.date, value: point.close })));
  return `<div class="technical-header"><div><h2>${escapeHtml(snapshot.ticker)} technical chart · ${period.toUpperCase()}</h2><p class="muted">Close price, 20-day moving average, and Bollinger Bands in USD.</p></div><strong>${currency(series.at(-1)?.close ?? snapshot.price)}</strong></div><div class="legend"><span class="price-dot">Close</span><span class="ma-dot">20D moving average</span><span class="band-dot">Bollinger upper/lower</span></div><div class="chart-wrap interactive-chart" data-chart-id="${escapeHtml(chartId)}"><div class="chart-tooltip" hidden></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(snapshot.ticker)} technical chart"><path class="grid-line" d="M ${padding} ${padding} H ${width - padding} M ${padding} ${height / 2} H ${width - padding} M ${padding} ${height - padding} H ${width - padding}"/><path class="band-line" d="${pathFor('upper')}"/><path class="band-line" d="${pathFor('lower')}"/><path class="ma-line" d="${pathFor('ma')}"/><path class="chart-line" d="${pathFor('close')}"/><text x="${padding}" y="${height - 10}" class="chart-axis">${escapeHtml(series[0].date)}</text><text x="${width - padding - 92}" y="${height - 10}" class="chart-axis">${escapeHtml(series.at(-1).date)}</text></svg></div>`;
}

render();
loadQuotes();
