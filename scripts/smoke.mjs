const storage = new Map();
const app = { innerHTML: '' };

globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
globalThis.location = { hash: '' };
globalThis.window = { addEventListener() {} };
globalThis.document = {
  querySelector: (selector) => selector === '#app' ? app : null,
  querySelectorAll: () => [],
};
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    chart: {
      result: [{
        timestamp: [1749859200, 1749945600, 1750032000],
        indicators: { quote: [{ close: [100, 102, 101] }] },
        meta: { regularMarketPrice: 101, chartPreviousClose: 102, currency: 'USD' },
      }],
    },
  }),
});

await import('../src/main.js');
await new Promise((resolve) => setTimeout(resolve, 50));

if (!app.innerHTML.includes('StockResearch portfolio and market briefing')) {
  throw new Error(`Dashboard did not render. Output: ${app.innerHTML.slice(0, 300)}`);
}
if (app.innerHTML.includes('StockResearch could not start')) {
  throw new Error(`Dashboard entered startup error state: ${app.innerHTML.slice(0, 300)}`);
}

console.log('Dashboard runtime smoke test passed.');
