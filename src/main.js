const HOLDINGS_KEY = 'stockresearch.holdings.v1';
const RISK_FREE_RATE = 0.025;
const APP_VERSION = '2026-06-17 direct EUR + VaR update';
const demoBasePrices = { AAPL: 181, MSFT: 412, NVDA: 116, AMZN: 171, GOOGL: 164, META: 463, TSLA: 167, JPM: 190, SPY: 502, QQQ: 435 };
const starterHoldings = [{ id: crypto.randomUUID(), ticker: 'AAPL' }, { id: crypto.randomUUID(), ticker: 'MSFT' }, { id: crypto.randomUUID(), ticker: 'NVDA' }];

let holdings = loadHoldings();
let snapshots = {};
let isLoading = false;
let selectedTicker = holdings[0]?.ticker ?? 'AAPL';
let route = location.hash === '#analysis' ? 'analysis' : 'dashboard';
let newsTab = 'portfolio';

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

function seededNoise(seed, index) {
  let value = 0;
  for (const char of seed) value += char.charCodeAt(0);
  return Math.sin(value * 17.13 + index * 0.73) * 0.018 + Math.cos(value + index * 0.29) * 0.012;
}

function euroSymbolCandidates(ticker) {
  const normalized = normalizeTicker(ticker);
  if (normalized.includes('.')) return [normalized];
  return [`${normalized}.DE`, `${normalized}.F`, normalized];
}

function buildDemoHistory(ticker) {
  const base = demoBasePrices[ticker] ?? 80 + ticker.charCodeAt(0);
  const today = new Date();
  const points = [];
  let price = base * (0.92 + Math.abs(seededNoise(ticker, 1)));
  for (let i = 89; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    price = Math.max(1, price * (1 + seededNoise(ticker, 90 - i)));
    points.push({ date: date.toISOString().slice(0, 10), close: Number(price.toFixed(2)) });
  }
  return points;
}

async function fetchYahooChart(ticker) {
  for (const symbol of euroSymbolCandidates(ticker)) {
    const snapshot = await fetchYahooChartSymbol(ticker, symbol);
    if (snapshot) return snapshot;
  }
  return null;
}

async function fetchYahooChartSymbol(ticker, symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  const meta = result?.meta;
  if (!timestamps?.length || !closes?.length || !meta?.regularMarketPrice) return null;
  const history = timestamps
    .map((timestamp, index) => ({ date: new Date(timestamp * 1000).toISOString().slice(0, 10), close: closes[index] }))
    .filter((point) => typeof point.close === 'number')
    .map((point) => ({ ...point, close: Number(point.close.toFixed(2)) }));
  const previousClose = Number((meta.chartPreviousClose ?? history.at(-2)?.close ?? meta.regularMarketPrice).toFixed(2));
  const price = Number(meta.regularMarketPrice.toFixed(2));
  const currencyCode = meta.currency ?? 'EUR';
  if (currencyCode !== 'EUR') return null;
  return { ticker, quoteSymbol: symbol, currency: currencyCode, price, previousClose, changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)), history, source: `Yahoo Finance direct EUR quote (${symbol})`, updatedAt: new Date().toISOString() };
}

async function getQuoteSnapshot(ticker) {
  try {
    const live = await fetchYahooChart(ticker);
    if (live) return live;
  } catch {
    // Browser/network/CORS failures should not break the static dashboard.
  }
  const history = buildDemoHistory(ticker);
  const price = history.at(-1)?.close ?? 0;
  const previousClose = history.at(-2)?.close ?? price;
  return { ticker, quoteSymbol: `${ticker}.DE demo`, currency: 'EUR', price, previousClose, changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)), history, source: 'EUR demo fallback data - configure direct EUR quotes for production decisions', updatedAt: new Date().toISOString() };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function standardDeviation(values) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
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
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
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
  const portfolioNews = tickers.slice(0, 8).map((ticker, index) => {
    const eventDate = new Date(now.getTime() + (index + 1) * 24 * 60 * 60 * 1000);
    const publishDate = new Date(now.getTime() - index * 2 * 60 * 60 * 1000);
    return {
      id: `${ticker}-finance-news`,
      title: `${ticker} latest market headlines and analyst watch`,
      source: 'Yahoo Finance search',
      url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/news`,
      publishedAt: publishDate.toISOString(),
      eventDate: eventDate.toISOString(),
      summary: `Recent ${ticker} headlines should be reviewed for earnings guidance, product updates, analyst rating changes, margin commentary, and sector read-throughs. This MVP does not copy full articles; it gives you a longer checklist-style abstract so you know what to validate before opening the linked source. Pay special attention to whether the story changes expected revenue growth, free cash flow, competitive positioning, or valuation multiples.`,
      analystForecast: 'Market analysts will usually focus on revenue growth, EPS revisions, margin direction, and management guidance. A positive revision cycle would support the signal; downgrades, missed guidance, or valuation concerns would weaken it.',
      portfolioImpact: `${ticker} impacts the portfolio through both direct price movement and sentiment spillover to related holdings. If this is a large position, treat negative guidance or high volatility as a portfolio-risk event, not only a single-stock event.`,
      potentialImpact: 'Company-specific headlines can affect short-term sentiment; confirm whether the news changes revenue, margin, valuation, or guidance assumptions.',
      relatedTickers: [ticker],
      category: 'portfolio',
    };
  });
  const macroNews = [
    { id: 'fed-calendar', title: 'Federal Reserve meeting calendar and policy decisions', source: 'Federal Reserve', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Track upcoming FOMC meetings, policy statements, projections, and press conferences because interest-rate expectations directly influence discount rates, equity valuations, and risk appetite. The key items to watch are changes in the policy-rate path, inflation language, labor-market assessment, and whether officials signal cuts, pauses, or tighter-for-longer policy.', analystForecast: 'Analysts typically compare the decision and press conference tone against futures-market expectations. A more dovish Fed can support equities; a hawkish surprise can lift yields and pressure expensive growth stocks.', portfolioImpact: 'Fed surprises can affect nearly every holding. Growth and technology positions are usually more sensitive to discount-rate changes, while banks and defensive sectors may react differently depending on yield-curve expectations.', potentialImpact: 'Higher-for-longer rate expectations can pressure long-duration growth stocks; rate-cut expectations can support risk assets if recession fears remain contained.', category: 'macro' },
    { id: 'bea-gdp', title: 'GDP and broad U.S. economic growth releases', source: 'U.S. Bureau of Economic Analysis', url: 'https://www.bea.gov/news/schedule', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Use the BEA release schedule to watch GDP, income, spending, and inflation-related economic data. These releases help determine whether earnings expectations are supported by real demand or threatened by slowing growth and weaker consumer activity.', analystForecast: 'Consensus forecasts usually focus on annualized GDP growth, consumer spending, inflation components, and revisions. Stronger-than-expected growth can support cyclical earnings, while weak data may increase recession-risk pricing.', portfolioImpact: 'Broad growth data affects portfolio-level risk appetite. If your holdings are concentrated in cyclical or high-beta names, weaker GDP trends can increase drawdown risk.', potentialImpact: 'Stronger growth can support earnings expectations, while hot inflation data may lift rates and weigh on valuations.', category: 'macro' },
    { id: 'bls-cpi-jobs', title: 'Inflation and labor-market release calendar', source: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/schedule/news_release/', publishedAt: now.toISOString(), eventDate: now.toISOString(), summary: 'Follow CPI, PPI, employment, wage, and productivity releases because inflation and labor-market surprises can quickly reprice interest rates and sector leadership. The most important details are core inflation momentum, wage pressure, payroll growth, unemployment, and revisions.', analystForecast: 'Analysts compare actual data with consensus and market-implied expectations. Cooler inflation can support valuation multiples, while hotter wage or CPI data can push yields higher and weigh on equities.', portfolioImpact: 'Inflation surprises can move the entire portfolio on the same day. High-valuation and high-duration stocks may be more sensitive than value or defensive holdings.', potentialImpact: 'Hot inflation or wage data can pressure stocks through higher yields; cooling data can help if growth does not deteriorate too quickly.', category: 'macro' },
  ];
  return [...portfolioNews, ...macroNews];
}

async function loadQuotes() {
  isLoading = true;
  render();
  const tickers = Array.from(new Set([...getTickers(), 'SPY']));
  const entries = await Promise.all(tickers.map(async (symbol) => [symbol, await getQuoteSnapshot(symbol)]));
  snapshots = Object.fromEntries(entries);
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
  event.currentTarget.reset();
  loadQuotes();
}

function removeHolding(id) {
  holdings = holdings.filter((holding) => holding.id !== id);
  if (!holdings.some((holding) => holding.ticker === selectedTicker)) selectedTicker = holdings[0]?.ticker ?? 'AAPL';
  saveHoldings();
  loadQuotes();
}

function exportHoldings() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), currency: 'EUR', quoteMode: 'direct-eur-preferred', holdings }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `stockresearch-holdings-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function render() {
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
        <p class="eyebrow">EUR dashboard · static MVP · no paid API required</p><p class="release-note">Updated: ${APP_VERSION}</p>
        <h1>StockResearch portfolio and market briefing</h1>
        <p class="hero-copy">Track ticker-only watchlists or optional holdings, review direct-EUR performance, monitor risk KPIs, and use transparent signals as decision support.</p>
      </div>
      <div class="privacy-card"><strong>🛡️ Local portfolio data</strong><span>Values are quoted directly in EUR when a EUR listing is available. Your entries stay in this browser.</span></div>
    </section>
    <section class="grid summary-grid" aria-label="Portfolio summary">
      ${summaryCard('Tracked symbols', String(tickers.length), 'Ticker-only mode is supported.')}
      ${summaryCard('Portfolio value', portfolioValue ? currency(portfolioValue) : 'Optional', 'Direct EUR quote mode; enter shares for wealth tracking.')}
      ${summaryCard('Performance', `${unrealizedReturn.toFixed(2)}%`, costBasis ? 'Based on your average cost.' : 'Based on available price history.')}
      ${summaryCard('Daily VaR 95%', kpis.dailyVar95 ? currency(kpis.dailyVar95) : '—', 'Estimated one-day downside at 95% confidence.')}
      ${summaryCard('Sharpe ratio', kpis.sharpe.toFixed(2), 'Risk-adjusted return estimate.')}
      ${summaryCard('Beta vs SPY', kpis.beta.toFixed(2), 'Sensitivity versus broad U.S. equity proxy.')}
      ${summaryCard('Max drawdown', `${kpis.maxDrawdown.toFixed(1)}%`, 'Worst historical peak-to-trough move.')}
      ${summaryCard('Data status', isLoading ? 'Loading' : 'Ready', 'Live fetch attempts fall back to demo data.')}
    </section>
    <section class="panel two-column">
      <div>
        <h2>Add ticker or holding</h2><p class="muted">Only ticker is required. Shares and average cost are optional. Average cost should be entered in EUR for accurate performance tracking.</p>
        <form class="holding-form" id="holding-form">
          <label>Ticker<input name="ticker" placeholder="e.g. AAPL" /></label>
          <label>Shares optional<input name="shares" type="number" min="0" step="any" placeholder="e.g. 10" /></label>
          <label>Avg. cost optional<input name="averageCost" type="number" min="0" step="any" placeholder="e.g. 185" /></label>
          <button type="submit">＋ Add</button>
        </form>
      </div>
      <div class="actions-card"><h3>Security notes</h3><ul><li>No Alpha Vantage or Finnhub key is required for the MVP.</li><li>Do not paste API keys into the app or source code.</li><li>Export creates a local backup file on your device.</li></ul><button class="secondary" id="export-button" type="button">⬇ Export local data</button></div>
    </section>
    <section class="panel"><div class="section-heading"><div><h2>Portfolio technical performance</h2><p class="muted">Historical portfolio line chart using optional shares; ticker-only entries are weighted as one unit each.</p></div></div>${renderLineChart(series, { title: 'Portfolio value in EUR', valuePrefix: '€' })}</section>
    <section class="panel"><div class="section-heading"><div><h2>Portfolio tracker and signals</h2><p class="muted">Signals are rule-based educational indicators, not financial advice.</p></div></div><div class="stock-grid">${holdings.map(renderStockCard).join('')}</div></section>
    <section class="panel"><div class="section-heading"><div><h2>📰 Market and portfolio news briefing</h2><p class="muted">Longer summaries with publish date, event date, analyst forecast, and portfolio impact.</p></div></div><div class="news-tabs"><button class="tab-button ${newsTab === 'portfolio' ? 'active' : ''}" data-news-tab="portfolio" type="button">Stock news (${news.filter((item) => item.category === 'portfolio').length})</button><button class="tab-button ${newsTab === 'macro' ? 'active' : ''}" data-news-tab="macro" type="button">Economic news (${news.filter((item) => item.category === 'macro').length})</button></div><div class="news-list scrollable-news">${filteredNews.map(renderNewsItem).join('')}</div></section>
    <footer>This app provides informational signals only. Confirm data against your broker or a trusted financial-data provider before making investment decisions.<br><strong>${APP_VERSION}</strong></footer>`;
}

function renderAnalysisPage(tickers) {
  const options = tickers.map((ticker) => `<option value="${escapeHtml(ticker)}" ${ticker === selectedTicker ? 'selected' : ''}>${escapeHtml(ticker)}</option>`).join('');
  const snapshot = snapshots[selectedTicker] ?? snapshots[tickers[0]];
  return `
    <section class="hero compact-hero"><div><p class="eyebrow">Technical analysis</p><h1>Stock analysis chart</h1><p class="hero-copy">Analyze one portfolio stock with close price, 20-day moving average, and Bollinger Bands on a dedicated second page.</p></div></section>
    <section class="panel analysis-controls"><label>Select portfolio stock<select id="ticker-select">${options}</select></label><p class="muted">Prices use direct EUR quote symbols when available; fallback demo prices are already EUR-denominated.</p></section>
    <section class="panel">${snapshot ? renderTechnicalChart(snapshot) : '<p class="muted">Add a ticker on the dashboard to see technical analysis.</p>'}</section>`;
}

function bindEvents() {
  document.querySelector('#holding-form')?.addEventListener('submit', addHolding);
  document.querySelector('#export-button')?.addEventListener('click', exportHoldings);
  document.querySelector('#ticker-select')?.addEventListener('change', (event) => { selectedTicker = event.target.value; render(); });
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => removeHolding(button.dataset.remove)));
  document.querySelectorAll('[data-select]').forEach((link) => link.addEventListener('click', () => { selectedTicker = link.dataset.select; }));
  document.querySelectorAll('[data-news-tab]').forEach((button) => button.addEventListener('click', () => { newsTab = button.dataset.newsTab; render(); }));
}

function summaryCard(label, value, detail) {
  return `<article class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail)}</p></article>`;
}

function renderStockCard(holding) {
  const snapshot = snapshots[holding.ticker];
  const signal = snapshot ? buildSignal(snapshot) : null;
  const value = snapshot && holding.shares ? snapshot.price * holding.shares : null;
  return `<article class="stock-card">
    <div class="stock-card-header"><div><h3>${escapeHtml(holding.ticker)}</h3><span>${escapeHtml(snapshot?.source ?? 'Loading market data...')}</span></div><button class="icon-button" type="button" aria-label="Remove ${escapeHtml(holding.ticker)}" data-remove="${escapeHtml(holding.id)}">🗑</button></div>
    <div class="price-row"><strong>${snapshot ? currency(snapshot.price) : '—'}</strong>${snapshot ? `<span class="${snapshot.changePercent >= 0 ? 'positive' : 'negative'}">${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent}%</span>` : ''}</div>
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
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title ?? 'Line chart')}"><path class="grid-line" d="M ${padding} ${padding} H ${width - padding} M ${padding} ${height / 2} H ${width - padding} M ${padding} ${height - padding} H ${width - padding}"/><path class="chart-line" d="${path}"/><text x="${padding}" y="22" class="chart-label">${escapeHtml(options.title ?? 'Performance')}</text><text x="${padding}" y="${height - 8}" class="chart-axis">${escapeHtml(series[0].date)}</text><text x="${width - padding - 90}" y="${height - 8}" class="chart-axis">${escapeHtml(series.at(-1).date)}</text><text x="${width - padding - 120}" y="22" class="chart-axis">${escapeHtml(options.valuePrefix ?? '')}${max.toFixed(2)}</text><text x="${width - padding - 120}" y="${height - padding + 4}" class="chart-axis">${escapeHtml(options.valuePrefix ?? '')}${min.toFixed(2)}</text></svg></div>`;
}

function renderTechnicalChart(snapshot) {
  const eurPoints = snapshot.history.map((point) => ({ date: point.date, close: point.close }));
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
  return `<div class="technical-header"><div><h2>${escapeHtml(snapshot.ticker)} technical chart</h2><p class="muted">Close price, 20-day moving average, and Bollinger Bands in EUR.</p></div><strong>${currency(snapshot.price)}</strong></div><div class="legend"><span class="price-dot">Close</span><span class="ma-dot">20D moving average</span><span class="band-dot">Bollinger upper/lower</span></div><div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(snapshot.ticker)} technical chart"><path class="grid-line" d="M ${padding} ${padding} H ${width - padding} M ${padding} ${height / 2} H ${width - padding} M ${padding} ${height - padding} H ${width - padding}"/><path class="band-line" d="${pathFor('upper')}"/><path class="band-line" d="${pathFor('lower')}"/><path class="ma-line" d="${pathFor('ma')}"/><path class="chart-line" d="${pathFor('close')}"/><text x="${padding}" y="${height - 10}" class="chart-axis">${escapeHtml(series[0].date)}</text><text x="${width - padding - 92}" y="${height - 10}" class="chart-axis">${escapeHtml(series.at(-1).date)}</text></svg></div>`;
}

render();
loadQuotes();
