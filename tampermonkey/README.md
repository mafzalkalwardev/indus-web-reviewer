# Userscripts (auto-injected)

Drop any `*.user.js` file here. On worker/Chrome start, Indus Web Reviewer:

1. Loads Violentmonkey into the CDP Chrome profile
2. Injects every `*.user.js` in this folder via Playwright (and tries one-click install)

## Facial / face-verify script

Put **your** face script here (you added it yourself). Example name:

`humanatic-face-verify.user.js`

The worker waits on `face_verify.cfm` for your script (or webcam) to clear that page — it does **not** invent a face-bypass.

## Soft assist

`humanatic-category-refresh.user.js` **v1.6** — stays on intro / soft-reloads REVIEW CALLS hunt.
Does **not** bounce Category List → intro (that caused List↔Practice thrash). Worker owns the list.
