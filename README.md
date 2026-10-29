<div align="center">

# Indus Web Reviewer

<img src="https://readme-typing-svg.demolab.com?font=Inter&weight=700&size=28&duration=2800&pause=700&color=2563EB&center=true&vCenter=true&width=900&lines=Humanatic+Call+Review+Automation;Local+Control+Dashboard;QA+Workflow+Acceleration;Built+for+review+ops" alt="Typing SVG" />

<p>
  <img src="https://komarev.com/ghpvc/?username=mafzalkalwardev&label=Project%20Views&color=2563eb&style=for-the-badge" alt="Project views" />
  <img src="https://img.shields.io/github/stars/mafzalkalwardev/indus-web-reviewer?style=for-the-badge&color=22c55e" alt="GitHub stars" />
  <img src="https://img.shields.io/github/forks/mafzalkalwardev/indus-web-reviewer?style=for-the-badge&color=f59e0b" alt="GitHub forks" />
  <img src="https://img.shields.io/github/license/mafzalkalwardev/indus-web-reviewer?style=for-the-badge&color=64748b" alt="License" />
</p>

<p>
  <img src="https://skillicons.dev/icons?i=ts,react,nodejs" alt="Skill icons" />
</p>

<p>
  <strong>Indus Web Reviewer — Humanatic call review automation with a local control dashboard for QA workflows.</strong>
</p>

</div>

---

## Contribution Snake

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mafzalkalwardev/google-voice-dispatch-agent/output/github-contribution-grid-snake-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/mafzalkalwardev/google-voice-dispatch-agent/output/github-contribution-grid-snake.svg">
    <img alt="Contribution snake" src="https://raw.githubusercontent.com/mafzalkalwardev/google-voice-dispatch-agent/output/github-contribution-grid-snake.svg">
  </picture>
</div>

---

## SEO Keywords

`call review` `Humanatic` `QA automation` `Indus`

---

## Requirements

- Windows, macOS, or Linux with Node.js 20+
- Google Chrome and an authenticated Humanatic profile
- A Grok-compatible API key for AI-assisted decisions (optional for dashboard-only use)

## Quick start

```bash
npm install
npm run web:install
Copy-Item .env.example .env
# Edit .env with your Chrome profile path and API key(s)
npm run app
```

This builds the dashboard, starts the local Control API, and opens **Indus Web Reviewer** in an Electron window.

## Configuration

Start with `.env.example`. The most important settings are:

| Setting | Purpose |
| --- | --- |
| `PRACTICE_MODE=1` | Safe select-only mode; set `0` only when live submission is intended. |
| `CHROME_USER_DATA_DIR` | Path to the local Chrome user-data directory. |
| `CHROME_PROFILE_DIRECTORY` | Chrome profile name, normally `Default`. |
| `SKIP_ANTI_DETECTION=1` | Enables the expected local Chrome connection path. |
| `GROK_API_KEY` | AI assistance key; Groq `gsk_` keys are also supported for chat and Whisper routing. |

## Wait-mode flow

1. Configure your Chrome profile and API key(s) in `.env`.
2. Start the desktop app with `npm run app` (or use `npm run dashboard` for the browser dashboard).
3. On first worker use, the helper userscripts are automatically loaded. To pre-download the userscript manager, run `npm run tm:ensure` once.
4. Select a category and choose **Start worker**. The worker opens or attaches to Chrome, then navigates through Category List to **REVIEW**.
5. When queues are empty, automatic rotation follows the configured US Eastern traffic windows.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run app` | Build and open the Electron desktop app. |
| `npm run app:dev` | Electron app with Vite hot reload. |
| `npm run dashboard` | Control API and browser dashboard. |
| `npm run api` | Control API on port `3847`. |
| `npm run web` | Vite dashboard on port `5173`. |
| `npm run worker:wait` | Run only the wait-mode worker. |
| `npm run tm:ensure` | Pre-download the userscript manager. |
| `npm run check` | Type-check and run the offline verification suite. |

## Troubleshooting

### Electron window is blank or the API is unavailable

Run `npm run build:web` once, then make sure nothing else is using port `3847`.

### Chrome login loops

Disable older Tampermonkey scripts that deep-link to `category_selector`. This worker follows the supported Category List to REVIEW flow instead.

### Dashboard does not show expected profile data

Confirm `CHROME_USER_DATA_DIR` and `CHROME_PROFILE_DIRECTORY` point to the Chrome profile you actually use, then restart the worker.

## Safety

Use `PRACTICE_MODE=1` while configuring or validating the tool. Switching to live submission is an explicit local configuration decision and should be made only after you have verified the category, Chrome profile, and review flow.

---

## Discoverability

**Author:** Muhammad Afzal Kalwar ([@mafzalkalwardev](https://github.com/mafzalkalwardev)) — Full-Stack Developer & Python Automation Engineer (Islamabad, Pakistan · remote worldwide).

**Hire / contact:** [Email](mailto:kalwarmuhammadafzal3@gmail.com) · [WhatsApp](https://wa.me/923079670503) · [Portfolio](https://mafzalkalwardev.github.io) · [LinkedIn](https://www.linkedin.com/in/muhammad-afzal-2670b527b/)

### Who is this for?
Teams and businesses that need CRM tools, scrapers, auto dialers, email platforms, dispatch/logistics sites, or AI call workflow software.

### FAQ
- **Who built this?** Muhammad Afzal Kalwar (`mafzalkalwardev`).
- **Can I hire the author?** Yes — remote freelance and contract. See contact links above.
- **Related work?** Browse [all repositories](https://github.com/mafzalkalwardev?tab=repositories) and the [live portfolio](https://mafzalkalwardev.github.io).

<details>
<summary><strong>SEO / GEO / AEO keywords</strong></summary>

Muhammad Afzal Kalwar, mafzalkalwardev, indus-web-reviewer, full-stack developer, Python automation engineer, Islamabad Pakistan, freelance remote developer, CRM scraping dialer email AI tools, voice-ai, indus, qa, call-analytics, automation, call-review, logistics, typescript

</details>

