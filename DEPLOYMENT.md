# Free deployment options

This project is a static HTML/CSS/JavaScript app. The build command creates a `dist/` folder that can be hosted by GitHub Pages, Cloudflare Pages, Netlify, Vercel, or another static host.

## Option A: GitHub Pages with a public repository

Use this option if you are comfortable making the `StockResearch` repository public. GitHub Pages is available for public repositories on GitHub Free.

### Steps

1. On GitHub, open the `StockResearch` repository.
2. Go to **Settings → General**.
3. Scroll to **Danger Zone**.
4. Change repository visibility from **Private** to **Public**.
5. Go to **Settings → Pages**.
6. Under **Build and deployment**, set **Source** to **GitHub Actions**.
7. Push to `main`, `master`, or `work`, or manually run the workflow named **Deploy static dashboard to GitHub Pages**.
8. Open the GitHub Pages URL shown by the workflow or in **Settings → Pages**.

### What becomes public

- The repository code becomes public.
- The deployed dashboard website becomes public.
- Your locally entered tickers, optional shares, and optional cost basis still stay in your browser local storage and are not committed automatically.

### What not to commit

- Real API keys.
- Portfolio export JSON files.
- Personal notes you do not want public.
- Broker statements or screenshots.

## Option B: Cloudflare Pages with a private repository

Use this option if you later decide to keep the repository private but still want free static hosting.

### Cloudflare Pages settings

- Framework preset: `None` or `Other`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root
- Environment variables: none required for the MVP

### Steps

1. Create or sign in to a free Cloudflare account.
2. Go to **Workers & Pages**.
3. Choose **Create application**.
4. Choose **Pages** and connect GitHub.
5. Select the private `StockResearch` repository.
6. Use the settings above.
7. Deploy.

## Security notes for both options

- The MVP stores tickers, optional shares, and optional cost basis only in your browser local storage.
- Do not commit API keys or portfolio exports.
- Optional future API keys should be stored in the hosting provider's secret/environment-variable settings or in GitHub Actions secrets for server-side jobs.
- The deployed website is public unless you add an access-control layer later.
- If you make the repository public, anyone can read the source code, so keep the app free of secrets.
