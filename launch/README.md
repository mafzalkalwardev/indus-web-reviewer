# Indus Web Reviewer — one-click launch

## Desktop (easiest)

From the project folder run once:

```bat
npm run shortcut
```

That installs two icons on your Desktop and Start Menu:

| Shortcut | What it does |
|----------|----------------|
| **Indus Web Reviewer** | Opens the dashboard (API + Electron) |
| **Indus Web Reviewer (Start Worker)** | Opens dashboard **and** starts the wait worker (live mode) |

Then just **double-click** the icon anytime.

## Or double-click these files

In `launch/`:

- `Start-Indus-Web-Reviewer.vbs` — silent start (no black window)
- `Start-Indus-With-Worker.vbs` — silent start + worker
- `Start-Indus-Web-Reviewer.bat` — same, with console logs (debug)

## Later: real `.exe` installer

When you want a packaged Windows app (installer, no Node required on the machine), we can add `electron-builder` and produce `IndusWebReviewer Setup.exe`. Say the word and we’ll build that next.
