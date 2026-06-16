const HOLDINGS_KEY = 'stockresearch.holdings.v1';
const demoBasePrices = { AAPL: 196, MSFT: 448, NVDA: 126, AMZN: 186, GOOGL: 178, META: 503, TSLA: 182, JPM: 206, SPY: 546, QQQ: 473 };
const starterHoldings = [{ id: crypto.randomUUID(), ticker: 'AAPL' }, { id: crypto.randomUUID(), ticker: 'MSFT' }, { id: crypto.randomUUID(), ticker: 'NVDA' }];

let holdings = loadHoldings();
let snapshots = {};
let isLoading = false;

const app = document.querySelector('#app');

function loadHoldings() {
  const raw = localStorage.getItem(HOLDINGS_KEY);
  if (!raw) return starterHoldings;
  try {
    return JSON.parse(raw).map((holding) => ({ ...holding, ticker: String(holding.ticker).toUpperCase().trim() }));
  } catch {
    return starterHoldings;
  }
}

function saveHoldings() {
  localStorage.setItem(HOLDINGS_KEY, JSON.stringify(holdings));
}

function getTickers() {
  return Array.from(new Set(holdings.map((holding) => holding.ticker)));
}

function seededNoise(seed, index) {
  let value = 0;
  for (const char of seed) value += char.charCodeAt(0);
  return Math.sin(value * 17.13 + index * 0.73) * 0.018 + Math.cos(value + index * 0.29) * 0.012;
}

function buildDemoHistory(ticker) {
  const base = demoBasePrices[ticker] ?? 80 + ticker.charCodeAt(0);
  const today = new Date();
  const points = [];
  let price = base * (0.92 + Math.abs(seededNoise(ticker, 1)));
  for (let i = 29; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    price = Math.max(1, price * (1 + seededNoise(ticker, 30 - i)));
    points.push({ date: date.toISOString().slice(0, 10), close: Number(price.toFixed(2)) });
  }
  return points;
}

async function fetchYahooChart(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d`;
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
  return { ticker, price, previousClose, changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)), history, source: 'Yahoo Finance chart endpoint with local demo fallback', updatedAt: new Date().toISOString() };
}

async function getQuoteSnapshot(ticker) {
  try {
    const live = await fetchYahooChart(ticker);
    if (live) return live;
  } catch {
    // Static MVP: browser/network/CORS failures should not break the dashboard.
  }
  const history = buildDemoHistory(ticker);
  const price = history.at(-1)?.close ?? 0;
  const previousClose = history.at(-2)?.close ?? price;
  return { ticker, price, previousClose, changePercent: Number((((price - previousClose) / previousClose) * 100).toFixed(2)), history, source: 'Demo fallback data - configure a provider for production decisions', updatedAt: new Date().toISOString() };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function calculateVolatility(values) {
  const returns = values.slice(1).map((value, index) => ((value - values[index]) / values[index]) * 100);
  const mean = average(returns);
  const variance = average(returns.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
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

function buildNews(tickers) {
  const now = new Date();
  const portfolioNews = tickers.slice(0, 8).map((ticker, index) => ({
    id: `${ticker}-finance-news`,
    title: `${ticker} latest market headlines`,
    source: 'Yahoo Finance search',
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/news`,
    publishedAt: new Date(now.getTime() - index * 60 * 60 * 1000).toISOString(),
    summary: `Open the linked news page for recent ${ticker} headlines. The MVP avoids copying full articles and keeps provider/API keys out of the browser.`,
    potentialImpact: 'Company-specific headlines can affect short-term sentiment; confirm whether the news changes revenue, margin, valuation, or guidance assumptions.',
    relatedTickers: [ticker],
    category: 'portfolio',
  }));
  const macroNews = [
    { id: 'fed-calendar', title: 'Federal Reserve meeting calendar and policy decisions', source: 'Federal Reserve', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', publishedAt: now.toISOString(), summary: 'Track upcoming FOMC meetings, policy statements, projections, and press conferences that can influence interest-rate expectations.', potentialImpact: 'Higher-for-longer rate expectations can pressure long-duration growth stocks; rate-cut expectations can support risk assets if recession fears remain contained.', category: 'macro' },
    { id: 'bea-gdp', title: 'GDP and broad U.S. economic growth releases', source: 'U.S. Bureau of Economic Analysis', url: 'https://www.bea.gov/news/schedule', publishedAt: now.toISOString(), summary: 'Use the BEA release schedule to watch GDP, income, spending, and inflation-related economic data.', potentialImpact: 'Stronger growth can support earnings expectations, while hot inflation data may lift rates and weigh on valuations.', category: 'macro' },
    { id: 'bls-cpi-jobs', title: 'Inflation and labor-market release calendar', source: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/schedule/news_release/', publishedAt: now.toISOString(), summary: 'Follow CPI, PPI, employment, wage, and productivity releases that shape macro and Fed expectations.', potentialImpact: 'Hot inflation or wage data can pressure stocks through higher yields; cooling data can help if growth does not deteriorate too quickly.', category: 'macro' },
  ];
  return [...portfolioNews, ...macroNews];
}

async function loadQuotes() {
  isLoading = true;
  render();
  const entries = await Promise.all(getTickers().map(async (symbol) => [symbol, await getQuoteSnapshot(symbol)]));
  snapshots = Object.fromEntries(entries);
  isLoading = false;
  render();
}

function addHolding(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const ticker = String(formData.get('ticker') ?? '').toUpperCase().trim();
  if (!ticker) return;
  const shares = Number(formData.get('shares'));
  const averageCost = Number(formData.get('averageCost'));
  holdings = [...holdings, { id: crypto.randomUUID(), ticker, shares: shares > 0 ? shares : undefined, averageCost: averageCost > 0 ? averageCost : undefined }];
  saveHoldings();
  event.currentTarget.reset();
  loadQuotes();
}

function removeHolding(id) {
  holdings = holdings.filter((holding) => holding.id !== id);
  saveHoldings();
  loadQuotes();
}

function exportHoldings() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), holdings }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `stockresearch-holdings-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function currency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function render() {
  const tickers = getTickers();
  const portfolioValue = holdings.reduce((sum, holding) => sum + (snapshots[holding.ticker]?.price ?? 0) * (holding.shares ?? 0), 0);
  const costBasis = holdings.reduce((sum, holding) => sum + (holding.averageCost ?? 0) * (holding.shares ?? 0), 0);
  const unrealizedReturn = costBasis ? ((portfolioValue - costBasis) / costBasis) * 100 : 0;
  const news = buildNews(tickers);

  app.innerHTML = `
    <section class="hero">
      <div>
        <p class="eyebrow">Private-first MVP · static dashboard · no paid API required</p>
        <h1>StockResearch portfolio and market briefing</h1>
        <p class="hero-copy">Track ticker-only watchlists or optional holdings, review daily movement, read concise market/news briefs, and use transparent buy/sell/hold-style signals as decision support.</p>
      </div>
      <div class="privacy-card"><strong>🛡️ Your portfolio stays local</strong><span>Tickers, shares, and cost basis are saved in this browser only and are not committed to GitHub.</span></div>
    </section>
    <section class="grid summary-grid" aria-label="Portfolio summary">
      ${summaryCard('Tracked symbols', String(tickers.length), 'Ticker-only mode is supported.')}
      ${summaryCard('Portfolio value', portfolioValue ? currency(portfolioValue) : 'Optional', 'Enter shares/cost basis to calculate wealth.')}
      ${summaryCard('Unrealized return', costBasis ? `${unrealizedReturn.toFixed(2)}%` : 'Not set', 'Hidden unless you enter position sizes.')}
      ${summaryCard('Data status', isLoading ? 'Loading' : 'Ready', 'Live fetch attempts fall back to demo data.')}
    </section>
    <section class="panel two-column">
      <div>
        <h2>Add ticker or holding</h2><p class="muted">Only ticker is required. Shares and average cost are optional for wealth tracking.</p>
        <form class="holding-form" id="holding-form">
          <label>Ticker<input name="ticker" placeholder="e.g. AAPL" /></label>
          <label>Shares optional<input name="shares" type="number" min="0" step="any" placeholder="e.g. 10" /></label>
          <label>Avg. cost optional<input name="averageCost" type="number" min="0" step="any" placeholder="e.g. 185" /></label>
          <button type="submit">＋ Add</button>
        </form>
      </div>
      <div class="actions-card"><h3>Security notes</h3><ul><li>No Alpha Vantage or Finnhub key is required for the MVP.</li><li>Do not paste API keys into the app or source code.</li><li>Export creates a local backup file on your device.</li></ul><button class="secondary" id="export-button" type="button">⬇ Export local data</button></div>
    </section>
    <section class="panel"><div class="section-heading"><div><h2>Portfolio tracker and signals</h2><p class="muted">Signals are rule-based educational indicators, not financial advice.</p></div></div><div class="stock-grid">${holdings.map(renderStockCard).join('')}</div></section>
    <section class="panel"><div class="section-heading"><div><h2>📰 Market and portfolio news briefing</h2><p class="muted">Short abstracts, potential stock impact, and source links for deeper reading.</p></div></div><div class="news-list">${news.map(renderNewsItem).join('')}</div></section>
    <footer>This app provides informational signals only. Confirm data against your broker or a trusted financial-data provider before making investment decisions.</footer>`;

  document.querySelector('#holding-form').addEventListener('submit', addHolding);
  document.querySelector('#export-button').addEventListener('click', exportHoldings);
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => removeHolding(button.dataset.remove)));
}

function summaryCard(label, value, detail) {
  return `<article class="summary-card"><span>${label}</span><strong>${value}</strong><p>${detail}</p></article>`;
}

function renderStockCard(holding) {
  const snapshot = snapshots[holding.ticker];
  const signal = snapshot ? buildSignal(snapshot) : null;
  const value = snapshot && holding.shares ? snapshot.price * holding.shares : null;
  return `<article class="stock-card">
    <div class="stock-card-header"><div><h3>${holding.ticker}</h3><span>${snapshot?.source ?? 'Loading market data...'}</span></div><button class="icon-button" type="button" aria-label="Remove ${holding.ticker}" data-remove="${holding.id}">🗑</button></div>
    <div class="price-row"><strong>${snapshot ? currency(snapshot.price) : '—'}</strong>${snapshot ? `<span class="${snapshot.changePercent >= 0 ? 'positive' : 'negative'}">${snapshot.changePercent >= 0 ? '+' : ''}${snapshot.changePercent}%</span>` : ''}</div>
    ${value ? `<p class="muted">Position value: ${currency(value)}</p>` : ''}
    ${signal ? `<div class="signal ${signal.tone}"><strong>${signal.label}</strong><span>Confidence: ${signal.confidence}</span><ul>${signal.reasons.map((reason) => `<li>${reason}</li>`).join('')}</ul></div>` : ''}
  </article>`;
}

function renderNewsItem(item) {
  return `<article class="news-item"><div><span class="tag">${item.category === 'macro' ? 'Macro event' : item.relatedTickers.join(', ')}</span><h3>${item.title}</h3><p>${item.summary}</p><p class="impact"><strong>Potential impact:</strong> ${item.potentialImpact}</p></div><a href="${item.url}" target="_blank" rel="noreferrer">Read source</a></article>`;
}

render();
loadQuotes();
