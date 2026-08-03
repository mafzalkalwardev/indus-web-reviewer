# Indus Web Reviewer

Local control dashboard + wait-mode worker for Humanatic call reviews (Playwright/CDP Chrome, Grok + Whisper, Tampermonkey queue refresh).

## Dashboard + wait mode (recommended)

1. Set Chrome profile in `.env` (`CHROME_USER_DATA_DIR`, `CHROME_PROFILE_DIRECTORY=Default`, `SKIP_ANTI_DETECTION=1`)
2. `npm run dashboard` → open http://127.0.0.1:5173
3. Install Tampermonkey script once: `tampermonkey/humanatic-category-refresh.user.js` (or via API after it is up)
4. In the UI: pick a category → **Start worker** — this **launches your Chrome profile** with remote debugging and attaches the AI worker
5. Tampermonkey refreshes that category until a call appears; the wait worker only answers when the review screen is visible

Or: `npm run api` + `npm run web` separately. Worker can also be started with `npm run worker:wait`.

### Flow

- **You** choose the category in the dashboard
- **Start worker** opens/attaches Chrome (`CHROME_USER_DATA_DIR`) on CDP `:9222`
- **Tampermonkey** keeps refreshing `category_selector?category=N` / `noCalls`
- **Wait worker** watches Chrome, handles Break Room, Whisper → Grok → submit (or practice select)

## Environment

See `.env.example`. Important:

- `PRACTICE_MODE=1` select only; `0` live submit (dashboard can override via target.practiceMode)
- `CHROME_USER_DATA_DIR` + `CHROME_PROFILE_DIRECTORY` for your real Chrome profile
- `GROK_API_KEY` (+ Groq `gsk_` keys auto-route for chat + Whisper)

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run api` | Control API on `:3847` |
| `npm run web` | Dashboard on `:5173` |
| `npm run dashboard` | API + web via concurrently |
| `npm run worker:wait` | Wait-mode worker (launches Chrome CDP) |
| `npm run long-haul` | Legacy multi-category hopper |
| `npm run practice` | Inbound practice quiz helper |
| `npm run scrape-categories` | Scrape category rules |
| `npm run dev` | Legacy continuous engine |

## Outputs

- `data/worker-state.json` — active category + worker status
- `data/reviews.json` — per-call log
- `data/categories.json` — cached rules/options
- `analysis-output/categories/` — scraped instructions

## Troubleshooting

### Worker fails with `Cannot find module './Dispatch'`
Fixed: Start worker uses `node` + `ts-node` without shell so paths with spaces work.

### API unreachable in UI
- Run `npm run api` first; dashboard proxies `/api` to `:3847`

### Tampermonkey not refreshing
- Confirm script is enabled on Humanatic pages
- Confirm API: `http://127.0.0.1:3847/api/tm/target` returns `enabled: true` and a `categoryId`
- Disable conflicting noCalls userscripts that fight the dashboard target

### Chrome does not open
- Close all Chrome windows, then Start worker again (profile lock)
- Confirm `CHROME_USER_DATA_DIR` points at your User Data folder
- Or start Chrome manually with `--remote-debugging-port=9222`
