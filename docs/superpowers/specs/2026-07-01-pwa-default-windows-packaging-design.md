# PWA-by-Default + Progressive Windows Packaging — Design Spec

**Date:** 2026-07-01
**Status:** Design approved — ready for implementation plan
**Scope:** Make every generated web app **PWA-compliant by default** (installable via the browser), then let
the user, on demand from any finished web-app build, package it for Windows as a **Tauri installer** and/or a
**Microsoft Store package** (PWABuilder-from-URL by default, Electron MSIX for native apps), delivering each
artifact to **Google Drive** with a link + QR — exactly like the existing flutter-app APK flow.

## Goal

Two layers of progressive enhancement, no up-front target choice:
1. **Every web app is born PWA-compliant** — manifest, service worker, icons, offline fallback — as a default
   of the standard `web-app` build. This alone makes it installable through the browser's "Install app."
2. **On any finished web-app build**, the user can trigger — as later, user-directed steps — a native
   **Windows installer**, then a **Microsoft Store package**. The heavy Windows builds run **off-box on a
   GitHub Actions `windows-latest` runner** in the generated repo; the webtmux box downloads the artifact and
   shares it to **Google Drive** with a link + QR + `DELIVERABLE.md` + Web Push — the same delivery UX as the
   APK.

There is **no `windows-app` output format** and **no up-front `target` field**: a Windows app is just the web
app in a native shell, so packaging is a post-build action, not a stack choice. The design is modular so
`macos`, `android`, and `linux-desktop` packagers can be added later without touching existing ones.

## Precedent (reuse, don't reinvent)

Modeled directly on the shipped **flutter-app** on-demand delivery:
- The **APK is a user-triggered step** (`POST /api/ralph/apk`, phase `delivering`, `ralph/ralph-deliver.sh`)
  that builds off the main loop and uploads via `sudo /usr/local/sbin/webtmux-apk-share` →
  `share-apk-to-drive.mjs` (Drive OAuth tokens are www-data-owned; the uploader runs as root and chowns
  `tokens.json` back). The tick reaps `.ralph/deliver.json` → writes `DELIVERABLE.md` (link + QR) → push.
- Store submission is a separate user-triggered scaffold (`POST /api/ralph/submit`, `ralph/store-submit.mjs`)
  that emits a CI workflow + a checklist and **auto-wires GitHub Actions secrets** (`ralph/github-secrets.mjs`,
  `gh secret/variable set` on the tenant's token). Final submit stays manual.

Windows packaging reuses all of it: GitHub-Actions-in-the-generated-repo, github-secrets wiring, the Drive/QR
delivery pipeline, and the "scaffold CI, manual final submit" posture.

## Research findings that shaped this design

The naive "wrap with Tauri → produce MSIX" chain does not exist off the shelf. The design reflects current
(2026) tool reality:
- **Tauri emits only EXE/MSI, never MSIX.** Its own Store path is MSI/EXE-installer submission, which needs a
  **paid CA-trusted cert** and gives **no Store-managed updates**, and a fresh Tauri v2 app currently fails
  WACK on S-Mode blocked executables. → Tauri is used for the **standalone installer only**, never the Store.
  ([Tauri MS Store](https://v2.tauri.app/distribute/microsoft-store/), [tauri #8548](https://github.com/tauri-apps/tauri/issues/8548), [WACK #14935](https://github.com/tauri-apps/tauri/issues/14935))
- **Electron (electron-builder) emits MSIX/AppX natively** on a Windows runner with the Windows SDK. → the
  **native-shell Store path**. ([electron.build appx](https://www.electron.build/appx.html))
- **PWABuilder packages a live HTTPS PWA URL into a Store MSIX**, Store-re-signed for free, with hosted-content
  updates — Microsoft's recommended path for web apps. → the **default Store path**, fed by Ralph's existing
  preview subdomain. ([choose-distribution-path](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path), [publish a PWA](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store))
- **MSIX/PWA Store packages are re-signed by the Store for free**; only the standalone installer needs the
  user's own cert (for SmartScreen). **Store dev registration is now free** (individual 2025, company 2026).
  **Package identity must match a Partner Center app reservation** (reserve first → obtain Identity/Publisher/
  PFN → feed as config). **Publisher name must not equal product name.**

---

## Part 1 — PWA-by-default (universal foundation)

**Every web-app build is PWA-compliant, with no opt-in.** This is a default enhancement to the standard
`web-app` generation, not a new format.

- **Requirements enforced on every web-app build:** a valid `manifest.webmanifest` (name, short_name,
  description, start_url, scope, `display: standalone`, theme_color, background_color, icons), a registered
  **service worker** with a caching strategy and an **offline fallback** page where the app allows it, and an
  **icon set** generated from the brand/source icon. All values from config/brand — nothing hardcoded.
- **How it's applied:** a vendored `pwa-baseline` skill is injected into every `web-app` build (like the
  imagery skill is injected for visual outputs), the finalize pass verifies compliance, and a pure validator
  (`ralph/pwa-validate.mjs`) checks the built output before a run is marked done.
- **Payoff on its own:** the app is immediately **browser-installable** (Edge/Chrome "Install app") and is the
  **prerequisite for the Store PWA path** in Part 2.
- **Non-regression:** the web app's existing structure/output is unchanged except for the added PWA assets;
  when brand assets exist they seed the manifest/icons.

Part 1 ships independently and benefits every build, Windows or not.

---

## Part 2 — Progressive Windows packaging (on-demand, post-build)

### Trigger model
On **every finished web-app build**, the UI shows actions (web/ BuildDetail + PWA status view), placed like
"Create APK" / "Submit to Play":
- **Build Windows installer** → Tauri `.exe/.msi`.
- **Build Store package** → PWA (PWABuilder) or Electron MSIX.
- **Submit to Store** → Partner Center submission scaffold + checklist.

**Config is collected at trigger time** (not at project start):
- Installer: `appId` (reverse-DNS), `version` (defaults from the repo), optional signing cert.
- Store: `appId` + Partner Center **Identity / Publisher / PFN** + `storePackaging` + `version`.
- `storePackaging` ∈ `auto` | `pwa` | `msix`:
  - `auto` resolves **deterministically to PWA** (safest/cheapest, always available since the build is already
    a compliant PWA). **MSIX is explicit opt-in** — the user pins `msix` when the app needs native OS APIs the
    web can't reach. The pipeline never auto-detects native-API needs; the trigger dialog surfaces the choice
    and the default.

### Artifact → toolchain → output → signing

| Artifact | Toolchain (Windows runner) | Output dir | Signing |
|---|---|---|---|
| Installer | Tauri (`tauri build` → NSIS/MSI) | `/dist/windows-installer` | user cert (optional; SmartScreen) |
| Store — PWA | PWABuilder CLI, input = **preview URL** → MSIX | `/dist/windows-store` | free (Store re-signs) |
| Store — MSIX | electron-builder `msix` target | `/dist/windows-store` | free (Store re-signs) |

### Architecture: Linux prepare → Windows Actions → Drive delivery
1. **Linux prepare (at trigger):** validate inputs; scaffold the needed wrapper project(s) around the built
   web app (Tauri: `frontendDist` → built assets; Electron: main loads local assets, electron-builder `msix`
   config; all identity/version/icons from config); generate Windows/Store icon assets from one source icon
   (Square44/150/310, Wide310x150, StoreLogo, SplashScreen + PWA 192/512 maskable); write a resolved
   `.ralph/windows-build.json` (the sole input to the Windows scripts); emit/push
   `.github/workflows/windows-package.yml` and dispatch it (`gh workflow run`).
2. **Windows package (GitHub Actions `windows-latest`):** run the selected packager script(s) from the build
   manifest; upload the artifact(s) as a GitHub Release asset. Store packages are unsigned (Store re-signs);
   the installer is signed only if a cert secret was wired.
3. **Delivery (box):** a new phase `windows-delivering` **polls the run**; on success the box **downloads the
   artifact** (`gh run download` / release asset) into the project dir, then uploads it to **Google Drive**
   via the existing share pipeline — generalize `webtmux-apk-share` → `webtmux-artifact-share` (accepts any
   file; still runs as root, chowns `tokens.json` back) — producing a **link + QR**. Writes `DELIVERABLE.md`
   (link + QR + provenance: tool, version, package identity) → **Web Push**.
   - Installer → direct-install download link. Store MSIX/PWA MSIX → Drive link for manual Partner Center upload.
   - **Stub-aware:** `RALPH_FORCE_TOOL` → simulated Actions build + Drive link, no spend (matches APK `--stub`).

### Packager registry (modularity)
`tauri-installer`, `electron-msix`, `pwabuilder-pwa` are plugins behind a common interface —
`validate(cfg) → prepare(cfg) → emitJob(cfg) → outputDir`. The trigger selects packagers from the action +
`storePackaging`. A future `macos`/`android`/`linux-desktop` target is a new plugin with **zero edits** to
existing packagers.

## Ralph integration

- **No new output format.** The PWA baseline folds into `web-app` generation (Part 1). Windows packaging is a
  set of post-build actions on any finished web-app build (Part 2).
- **Endpoints (user-triggered, mirror `/api/ralph/apk` + `/submit`):**
  - `POST /api/ralph/windows/installer {project, appId, version, ...}` → phase `windows-delivering`, Tauri
    installer → Drive.
  - `POST /api/ralph/windows/store {project, identity, storePackaging, ...}` → PWA or Electron MSIX → Drive.
  - `POST /api/ralph/windows/submit {project, ...}` → Partner Center submission scaffold + checklist +
    secret-wiring.
- **UI:** "Build Windows installer / Build Store package / Submit to Store" buttons on **every finished
  web-app build** (web/ BuildDetail + PWA status view). The trigger opens a small dialog to collect
  identity/version/storePackaging.
- **Credentials (per-tenant vault, empty by default):** `VAULT_PROVIDERS += windows-signing` (optional
  installer/sideload cert) and `windows-store` (Partner Center identity JSON: appId, Identity, Publisher, PFN).
  Reuse the tenant `github` token for Actions and the **existing Drive tokens** for delivery. `gitInitProject`
  ignores signing material (`*.pfx`, `*.snk`, identity JSON).
- **github-secrets:** reuse `ralph/github-secrets.mjs` to set the installer signing secret (when provided);
  Store packages need none.

## Scripts & `/dist` layout

- `build-web.sh` — reuse Ralph's existing web build → `/dist/web` (+ PWA assets from Part 1).
- `prepare-windows` (Linux `ralph/*.mjs`, invoked by the trigger) — validate, scaffold, generate icons, write
  `.ralph/windows-build.json`, emit `windows-package.yml`.
- `build-tauri-installer.ps1` (Windows) → `/dist/windows-installer`.
- `build-electron-msix.ps1` (Windows) → `/dist/windows-store`.
- `build-pwa-store.ps1` (Windows) — PWABuilder CLI, input = preview URL → `/dist/windows-store`.
- `windows-package.yml` — the emitted GitHub Actions workflow orchestrating the above.

Each script reads the build manifest only, writes its own `/dist` folder, is idempotent, and exits non-zero
with an actionable message on failure.

## Validation gate (Linux, at trigger, before dispatching the job — fail closed, name the key)

- app name present · **app ID** present + well-formed reverse-DNS
- **publisher ≠ product name**
- **icons** present for all required sizes (generated from the source icon)
- **manifest** present with all required PWA fields (guaranteed by Part 1)
- **version** present + valid semver (derive 4-part MSIX version deterministically)
- Store targets: **Partner Center reservation values present** (Identity, Publisher, PFN)
- PWA path: **preview URL reachable over HTTPS**
- legal action / `desktopWrapper` / `storePackaging` combination

## Testing (no-spend, matches Ralph's conventions)

Pure, unit-tested helper modules (each with a `*.test.mjs`, `node --test`):
- `ralph/pwa-validate.mjs` — PWA-baseline compliance check (manifest fields, SW presence, icon set).
- `ralph/windows-target.mjs` — action + `storePackaging` → packagers, and coupling validation.
- `ralph/windows-scaffold.mjs` — Tauri/Electron scaffold config, icon-size map, semver→4-part version.
- `ralph/windows-deliver.mjs` — parse `.ralph/windows-build.json` / artifact results; build DELIVERABLE
  provenance.
Server routes stay thin over these. **Stub-aware end-to-end:** `RALPH_FORCE_TOOL=stub` simulates the Actions
build + Drive link (no GitHub/Windows/Drive spend), driven by the existing stub harness.

## Documentation deliverables

- **Publishing to Microsoft Store / Partner Center:** the **reserve-app-first** workflow (get
  Identity/Publisher/PFN → put in config), free registration (2025/26), PWA-vs-MSIX choice, "Store re-signs
  MSIX/PWA free" vs "your cert for the installer," how the preview URL feeds PWABuilder, running/monitoring the
  Windows Actions job, and where the Drive artifact lands.
- **Windows runner setup:** the toolchain the `windows-latest` job provisions (Rust/Tauri, Node/Electron +
  Windows SDK for MSIX, PWABuilder CLI, signtool).
- **Extending with a new target:** the exact packager-registry plugin a future `macos`/`android` must implement.

## Security & secrets

- Drive OAuth tokens stay on the box (never in the user's repo); the generalized `webtmux-artifact-share` runs
  as root and chowns `tokens.json` back to www-data — unchanged from the APK path.
- Installer signing cert (if provided) is wired as a GitHub Actions secret via github-secrets; never committed.
  Store packages are unsigned locally (Store re-signs), so no secret leaves the box for those.
- Generated repos gitignore all signing material (`*.pfx`, `*.snk`, identity JSON).

## Non-goals (YAGNI)

- **No paid Tauri→MSI/EXE Store submission route** (rejected: cert cost + no Store updates + WACK friction).
- **No macOS / Android / Linux-desktop targets yet** — the packager registry leaves room; not built now.
- **No in-loop Windows builds** — every Windows build is off-box on GitHub Actions.
- **No automated Store submission** beyond a scaffold + checklist + secret-wiring; final submit stays manual.
- **No new output format** and **no up-front target choice** — Windows is a post-build action.

## Phasing (for the implementation plan)

- **P1 — PWA-by-default (universal):** the `pwa-baseline` skill + finalize compliance check +
  `ralph/pwa-validate.mjs` (TDD) applied to every `web-app` build. Ships: every web app is installable via the
  browser. No Windows build.
- **P2 — Windows installer action:** Tauri scaffold + `windows-package.yml` (installer job) + `POST
  /windows/installer` + off-box build → download → **Drive/QR** delivery (generalize `webtmux-artifact-share`)
  + the trigger dialog/button on every finished web-app build.
- **P3 — Store action:** PWA (PWABuilder-from-URL, default) + Electron MSIX (native) packagers + `POST
  /windows/store` + `POST /windows/submit` scaffold (github-secrets, Partner Center checklist) + docs.

Each phase is independently shippable and testable; P1 is pure-logic TDD, P2/P3 add the off-box packagers
behind the stub harness.

## Sources

[Tauri MS Store](https://v2.tauri.app/distribute/microsoft-store/) ·
[Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/) ·
[tauri #8548 (MSIX)](https://github.com/tauri-apps/tauri/issues/8548) ·
[tauri #14935 (WACK)](https://github.com/tauri-apps/tauri/issues/14935) ·
[electron-builder AppX/MSIX](https://www.electron.build/appx.html) ·
[Electron Forge MSIX](https://www.electronforge.io/config/makers/msix) ·
[MS: choose distribution path](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path) ·
[MS: publish a PWA](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store) ·
[PWABuilder Windows docs](https://docs.pwabuilder.com/#/builder/windows) ·
[MSIX on Linux](https://learn.microsoft.com/en-us/windows/msix/msix-sdk/msix-linux) ·
[free company registration (2026)](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/)
