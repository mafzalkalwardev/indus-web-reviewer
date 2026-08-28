# Indus Web Reviewer

Local **Electron app** + wait-mode worker for Humanatic call reviews (Playwright/CDP Chrome, Grok + Whisper).

## Run as desktop app (recommended)

```bash
npm install
npm run web:install
npm run app
```

This builds the UI, starts the Control API, and opens **Indus Web Reviewer** in an Electron window.

### Dev mode (hot reload UI)

```bash
npm run app:dev
```

Or browser-only: `npm run dashboard` → http://127.0.0.1:5173

## Wait-mode flow

1. Set Chrome profile in `.env` (`CHROME_USER_DATA_DIR`, `CHROME_PROFILE_DIRECTORY=Default`, `SKIP_ANTI_DETECTION=1`)
2. `npm run app` (or `npm run dashboard`)
3. Soft-assist userscripts auto-load on worker start (no manual Tampermonkey install).
   Run once to pre-download the manager: `npm run tm:ensure`
   Scripts live in `tampermonkey/*.user.js` and are Playwright-injected + loaded via Violentmonkey/Tampermonkey.
4. Pick a category → **Start worker** — opens/attaches Chrome and clicks Category List → REVIEW (no x19 deep-links)
5. Auto-rotate follows US Eastern traffic windows when queues are empty

## Environment

See `.env.example`. Important:

- `PRACTICE_MODE=1` select only; `0` live submit (dashboard can override)
- `CHROME_USER_DATA_DIR` + `CHROME_PROFILE_DIRECTORY` for your real Chrome profile
- `GROK_API_KEY` (+ Groq `gsk_` keys auto-route for chat + Whisper)

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run app` | Electron desktop app (builds UI + API) |
| `npm run app:dev` | Electron + Vite HMR + API |
| `npm run api` | Control API on `:3847` |
| `npm run web` | Vite dashboard on `:5173` |
| `npm run dashboard` | API + web in browser |
| `npm run worker:wait` | Wait-mode worker (launches Chrome CDP) |

## Troubleshooting

### Electron window blank / API errors
- Run `npm run build:web` once so `web/dist` exists
- Ensure nothing else is blocking port `3847`

### Logout loop
- Disable old Tampermonkey scripts that deep-link `category_selector`
- Worker uses Category List → REVIEW clicks only
