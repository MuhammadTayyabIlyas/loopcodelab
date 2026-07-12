---
name: pwa-baseline
description: Make the generated web app an installable PWA by default — a complete web app manifest, a service worker with offline fallback, and an icon set — all derived from the project's own name/brand, never hardcoded.
---

# PWA baseline (every web app is installable)

Ship the web app as an installable Progressive Web App. This is required for every web build, and it is
the prerequisite for packaging the app for the Microsoft Store later. Derive ALL values from THIS project's
idea/brand — never hardcode an app name, color, or domain.

## 1. Web app manifest
Add `manifest.webmanifest` (served from the site root) with ALL of:
- `name`, `short_name` (≤12 chars), `description` — from the project's real name/summary.
- `start_url` (`/` or the app's entry) and `scope` (`/`).
- `display`: `standalone` (so it opens as an app, not a browser tab).
- `theme_color` and `background_color` — from the project's brand palette (match the UI).
- `icons`: at least `192x192` and `512x512` PNGs, plus a `512x512` entry with `"purpose": "maskable"`.
Link it from every page: `<link rel="manifest" href="/manifest.webmanifest">` and set
`<meta name="theme-color" content="...">`.

## 2. Service worker + offline fallback
Add a service worker (e.g. `sw.js` at the site root) and register it:
`if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')`.
- Cache the app shell (HTML/CSS/JS + icons) on install so the app loads offline.
- Serve an `offline.html` fallback for navigations that fail while offline, where the app allows it.
- Use a versioned cache name and clean up old caches on `activate` (so updates take effect).

## 3. Icons
Generate the icon set from the project's brand/source icon (or a tasteful generated mark if none):
`192x192`, `512x512`, a maskable `512x512`, a `favicon`, and an `apple-touch-icon` (180x180). Reference
them by relative path so the built site serves them.

## Rules
- Keep it consistent with the deploy contract (web-deliverable): emit into the same static output dir
  (`build/web`/`dist`/`build`/`out`/`public`/root), use RELATIVE asset paths, no hardcoded host/port.
- All manifest text/colors/icons come from the project's own brand/content — nothing hardcoded.
- Verify: the site has `manifest.webmanifest`, a registered service worker, and 192+512 icons, and it
  loads once offline after a first visit.
