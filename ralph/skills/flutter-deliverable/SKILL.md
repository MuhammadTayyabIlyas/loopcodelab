---
name: flutter-deliverable
description: Produce the final Flutter deliverables — a web build served at https://<project>.tayyabcheema.com AND a release Android build — so the orchestrator can sign the APK and share an install link. Use at finalize for the flutter-app output format. Works with any agent.
---

# Finalize a Flutter app deliverable

This project's chosen output is a **Flutter mobile app (Android + web)**. Your finalize job
is to make BOTH build targets succeed cleanly. The orchestrator then signs the APK and
uploads it to Google Drive, returning an install link + QR — you do **not** upload anything.

> Always `source /etc/profile.d/flutter.sh` in the SAME command as `flutter` (the shell
> resets between commands).

## 1. Web build (the live preview)
```
source /etc/profile.d/flutter.sh && flutter pub get && flutter build web --release
```
This must produce `build/web/index.html`. The host serves `build/web` first in its
candidate list, so a successful web build *is* the live preview at
`https://<project>.tayyabcheema.com`. Use **relative** asset paths (SPA fallback serves
`index.html` for unknown routes).

## 2. Do NOT build the APK here — the orchestrator does
**Do not run `flutter build apk` at finalize.** This host is RAM-limited and Flutter's default
Gradle heap (`-Xmx8G`) is larger than the whole machine — an uncapped Gradle build OOMs the box.
The orchestrator's **delivery pass** builds the release APK with capped memory (`gradle.properties`
`-Xmx1536m`, no daemon) + signing, serialized so concurrent builds can't exhaust the host. Your
finalize job is only the **web build** above (cheap, no Gradle — it's the live preview *and* a real
compile check). The signed, installable APK + Drive link are produced after finalize passes.

## 3. Record the deliverable
In `DELIVERABLE.md` and `README.md`, record:
- That the deliverable is a Flutter app; the web preview URL; and that an installable APK
  link + QR are produced by the orchestrator after this finalize passes (don't fabricate a
  link — the orchestrator appends it).
- The Android `applicationId` / package name and the app version (`pubspec.yaml`).

## Store screenshots — write `.ralph/shots.json`
The orchestrator captures device screenshots of the web build into `store-assets/` for the store
listings. To showcase the app's ACTUAL key screens (not just the landing screen), **write
`.ralph/shots.json`** before you finish — a JSON array of the 3–5 best screens:

```json
[
  { "name": "home", "path": "/" },
  { "name": "leaderboard", "path": "/leaderboard" },
  { "name": "gameplay", "path": "/play?demo=1" }
]
```

Rules for `path` (the capture navigates by URL):
- Use the app's REAL URL form. With `usePathUrlStrategy()` it's `"/leaderboard"`; with Flutter's
  default **hash** strategy it's `"/#/leaderboard"`. Check how the app routes.
- Every screen MUST be reachable **without logging in** — point at a guest/demo route or a query
  flag the app honors (e.g. `?demo=1` seeds sample data). A shot stuck on a login wall is useless.
- Only list screens that are actually URL-addressable. If a key screen isn't, prefer adding a
  route for it (see the `flutter-app` skill's routing guidance); otherwise omit it.
- Pick screens that show value — the main UI, a populated list, a key action. Up to 6; extras are
  ignored. If you write nothing, the default is just the home screen.

## Feature graphic — write `.ralph/feature-graphic.json`
Google Play requires a **1024×500 feature graphic** (the banner atop the listing). The orchestrator
composes one automatically; give it the app's brand by writing `.ralph/feature-graphic.json`:

```json
{ "name": "Snake Game", "tagline": "Classic snake, modern leaderboard", "bg": "#0b3d2e", "accent": "#16a34a", "icon": "assets/brand/logo.png" }
```

- `name` + `tagline`: short and punchy (tagline ≤ ~90 chars). Defaults: name from the project, no tagline.
- `bg`/`accent`: hex colors from the brand (`assets/brand/MANIFEST.md` if present) — they form a diagonal
  gradient. Default is a blue→purple gradient.
- `icon`: a repo-relative path; defaults to the brand logo, else the Flutter web icon. Output is
  `store-assets/feature-1024x500.png`.

## Rules
- Never commit `*.jks`, `key.properties`, `google-services.json`, or any service-account
  JSON — they are materialized at build time and are gitignored.
- Don't share an `.aab` as an install link (not installable); the APK is the install
  artifact. The `.aab` is only for Play Store submission, which is a separate task.
- End with `<promise>COMPLETE</promise>` only when `flutter build web --release` succeeds and
  tests pass. (The APK is built by the orchestrator's delivery pass — not here.)
