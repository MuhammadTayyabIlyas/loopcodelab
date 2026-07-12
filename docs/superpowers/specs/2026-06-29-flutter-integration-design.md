# Flutter App Development in Ralph — Design Spec

**Date:** 2026-06-29
**Status:** Draft for approval (design); implementation plan in `docs/superpowers/plans/2026-06-29-flutter-integration.md`
**Repo:** `/var/www/tmux.tayyabcheema.com` (webtmux + Ralph orchestrator)
**Related:** brand-visual-inputs (clarify + assets + imagery), the `apkipa.tayyabcheema.com` Flutter proof-of-concept, the `create-and-share-apk` skill.

## 1. Goal

Let a webtmux/Ralph user describe a mobile-app idea, answer **clarification questions**, pick **agent + model**, and have agents build a working **Flutter app** end-to-end. The finished app is:

1. **Previewable in the browser** at `https://<project>.tayyabcheema.com` (Flutter `build/web`, served by the existing project-preview host-routing).
2. **Delivered as a signed, installable Android APK** via a **Google Drive share link + QR** (reusing the established `share-apk-to-drive.mjs` helper on the admin Drive account `tayyabcheema777@gmail.com`).
3. Optionally backed by **Firebase** (auth / cloud data / push) — only when the clarify step says the app needs it.

**Store submission** (Google Play first, iOS App Store later) is an **explicitly separate, user-triggered task** — a "Submit" button that spawns a *new* task. It is NOT part of the build/delivery flow.

## 2. Scope

### In scope (v1)
- New Ralph output format **`flutter-app`** (Android + Web).
- Vendored Ralph skills: `flutter-app` (worker scaffolding), `flutter-deliverable` (finalize build), `firebase` (optional backend). Reuse `imagery` for visuals.
- **Flutter-aware clarify** axes (incl. the Firebase/backend question) + adding a **clarify step to the `web/` React new-build flow** (which today has none).
- **Post-finalize build + delivery** pipeline: `flutter build web` (preview) + `flutter build apk --release` (signed) → APK to Drive → `DELIVERABLE.md` + push notification with the link.
- **Multitenant from day one:** per-tenant credential fields (empty by default) for Firebase / Google Play / Codemagic / GitHub-Actions, plus single-tenant `secrets.json` fallback. Tenants supply their *own* Firebase (apkipa's Firebase stays admin-only).
- **Tenant toolchain access:** make `/opt/flutter` + `/opt/android-sdk` usable by sandboxed `wt_*` users with per-tenant caches and build-concurrency guards.
- **Play store-submission task** (scaffold CI + upload to a test track; production promotion stays manual).

### Out of scope (deferred to a later "extra layer")
- **iOS builds / App Store** — impossible on this Linux host; requires cloud-macOS (Codemagic). The `codemagic` credential field is added now (empty) so the later layer drops in cleanly.
- **Fully-automated production store submission** (first submission needs manual console steps + review).
- **AI image generation** (the brand-visual spec already deferred this; `imagery` uses uploaded assets → free stock).
- **In-app visual/WYSIWYG editing of the finished app** (separate follow-up; the existing `revise` follow-up-instruction flow covers prompt-based edits).

## 3. Key decisions (resolved with the user 2026-06-29)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Build targets v1 | **Web preview + Android only** | No macOS needed; everything builds on this host with the toolchain already installed for apkipa. |
| Store deploy depth | **Scaffold CI, manual submit** | Safe first release; automation targets test tracks, humans gate production. |
| Android delivery | **Signed APK → Drive link + QR** | Reuses `share-apk-to-drive.mjs` (admin OAuth); Drive connector can't take multi-MB binaries. |
| Store submission | **Separate user-triggered task** | A "Submit" button spawns a new task; keeps the build flow clean. |
| Firebase | **Optional, asked in clarify** | Simple apps stay lightweight; wired only when the app needs accounts/cloud/push. |
| Firebase ownership | **Tenant supplies own creds** | apkipa's Firebase project is admin-only; tenants must not share it. |
| Rollout | **Multitenant from day one** | Per-tenant credential fields + sandboxed builds from the start. |

### Decisions made while planning (flagged for confirmation)
- **Signing identity:** generate a **per-tenant-per-app upload keystore** on first build, persist it in the vault (`flutter-signing` provider). This gives the app a *stable* signing identity so the same app can later go to Play without re-keying. (Alternative: ephemeral per-run keystore — simpler but breaks Play updates. Recommend persisted.)
- **Drive destination:** all APKs upload to the **admin** Drive account but into a **per-tenant subfolder** (`webtmux-apks/<tenant-slug>/`) for isolation and quota hygiene.
- **Clarify in `web/`:** add the missing clarify step to the React new-build flow (idea → **clarify** → plan → review). Benefits every content-heavy format, not just Flutter, and is required since "start with user clarification" is a core ask and SaaS tenants use `web/`.

## 4. Architecture (grounded in current code)

### 4.1 Output format plumbing (additive)
- `OUTPUT_FORMATS` — `server.js:166` — add `'flutter-app'`.
- `OUTPUT_SKILL` — `server.js:169` — add `'flutter-app': 'flutter-deliverable'`.
- `FORMATS` mirror — `web/src/pages/NewBuild.jsx:21`; PWA picker in `public/index.html` + `public/js/dashboard.js`.
- `normalizePrd` (`server.js:881-920`) and `run.outputFormat` (`server.js:3495`) are already generic — no change.
- `VISUAL_OUTPUT` set (`server.js:1709`) — add `'flutter-app'` so the `imagery` skill auto-injects.

### 4.2 Skills (injected, not installed)
`loadSkillsCatalog` (`server.js:233-251`) auto-discovers `ralph/skills/*/SKILL.md`; `writeRalphBrief` (`server.js:1704-1733`) concatenates assigned skills into `.ralph/skills.md` (worker) / `.ralph/finalize.skills.md` (finalize). New vendored skills:
- **`flutter-app`** (worker): project layout, state mgmt, null-safety, packages, widget tests, asset usage (defers to `assets/brand/` via `imagery`).
- **`flutter-deliverable`** (finalize, via `OUTPUT_SKILL`): run `flutter build web --release` (→ `build/web` for preview) and `flutter build apk --release` (signed via the orchestrator-provided `android/key.properties`); where outputs land; never commit keystores/`google-services.json`.
- **`firebase`** (worker, planner-assigned when clarify says backend needed): wire `firebase_core`/`firebase_auth`/`cloud_firestore`/`firebase_messaging` assuming `android/app/google-services.json` is present (orchestrator writes it from the tenant's vault cred); fall back to local-only (`shared_preferences`/`sqflite`) if absent.

### 4.3 Clarify (format-aware, + Firebase axis)
- `clarifyAxesFor` (`ralph/clarify-axes.mjs`) — add a `flutter-app` entry to `CONTENT_AXES`: *app category, brand identity & colors, target audience, key screens/features, **backend needs (accounts / cloud sync / push → Firebase)**, offline behavior* (`contentHeavy: true`, `cap: 6`).
- `clarifyQuestions` (`server.js:837-877`) + `/api/ralph/clarify` (`server.js:3322-3327`) already thread `outputFormat` → no change.
- **`web/` React UI** gains a clarify step (reusing `api.clarify(idea, outputFormat)` already in `web/src/api.js:35`).

### 4.4 Build + delivery (sandbox builds, admin delivers)
- **Web preview:** `build/web` is the *first* candidate in `WEB_ROOT_CANDIDATES` (`server.js:2554`); host-routing `servePreview` (`server.js:2757-2774`) + SPA fallback (`server.js:2743`) serve a Flutter web build with zero new code.
- **APK build:** finalize agent (tenant sandbox) produces `build/app/outputs/flutter-apk/app-release.apk` per the `flutter-deliverable` skill, signed with `android/key.properties` the orchestrator writes from the persisted per-tenant keystore.
- **APK delivery (post-finalize orchestrator step):** after finalize `PASS` (handled at `server.js:2215-2230`), for `flutter-app` runs the orchestrator (admin context) executes `node ~/.claude/skills/create-and-share-apk/share-apk-to-drive.mjs --apk <path> --name <project>.apk` → parses `shareLink`/`qr` → writes `DELIVERABLE.md` + README + emits a `revent` + Web Push with the link. Stub-aware (`RALPH_FORCE_TOOL=stub` simulates).

### 4.5 Credentials (multitenant-first, single-tenant fallback)
- New vault providers in `VAULT_PROVIDERS` (`server.js:2889`): `firebase`, `google-play`, `codemagic`, `flutter-signing` (`github` already exists for CI). Generic `setProviderKey`/`getProviderKey` (`saas/store.mjs:59-75`, `saas/db.mjs:69-79`) need no schema change.
- New single-tenant accessors near `server.js:656-664`: `firebaseConfig()`, `googlePlayKey()`, `codemagicToken()` (env → `secrets.json`).
- A build-cred resolver (alongside `tenantAgentCreds` `server.js:1451`) materializes `google-services.json` / `key.properties` into the worktree at build time, gitignored.
- **UI:** a new "Mobile app & backend credentials" card group in `web/src/pages/Settings.jsx` (tenant self-serve; empty by default) using the existing `api.setKey`/`deleteKey` (`web/src/api.js:24-26`) → `PUT/DELETE /api/keys/:provider` (`server.js:2948-2970`). Single-tenant continues via `secrets.json`.

### 4.6 Tenant toolchain access (the infra prereq)
Sandboxed `wt_*` users must reach the shared toolchain:
- `/opt/flutter` + `/opt/android-sdk` world-readable + executable; PATH via `/etc/profile.d/flutter.sh`.
- Per-tenant `PUB_CACHE` + `GRADLE_USER_HOME` under the tenant home (avoids cross-tenant cache clashes / permission errors).
- `git config --global --add safe.directory '*'` for the build user; per-user Flutter config dir.
- **Build-concurrency guard** + disk check (Flutter first-build is 3–7 min, multi-GB) so concurrent heavy builds don't exhaust the box.

### 4.7 Store submission (separate task, Play-only v1)
`POST /api/ralph/submit {project, store:'play'}` spawns a new task that: builds a signed **AAB** (`flutter build appbundle --release`), scaffolds `.github/workflows/play-upload.yml` (mirrors the apkipa pipeline) + sets repo secrets via the tenant's `github` token, and uploads to a Play **internal/closed** track using the tenant's `google-play` service account. Production promotion stays manual. iOS/Codemagic is the later layer.

## 5. Security & isolation
- Keystores, `google-services.json`, service-account JSON: vault-encrypted (AES-256-GCM, `saas/vault.mjs`), materialized into worktrees only at build time, gitignored (extend `gitInitProject` ignores). Never committed.
- Tenant Firebase/Play creds are per-tenant; apkipa's admin Firebase is never shared.
- Drive uploads go to the admin account in a per-tenant subfolder; links are "anyone with link" (acceptable for sideload test builds).
- Sandbox builds run as the tenant `wt_*` user; only the Drive upload runs as admin.

## 6. Risks & mitigations
| Risk | Mitigation |
| --- | --- |
| Flutter builds are heavy (CPU/RAM/disk, 3–7 min) | Build-concurrency cap + disk precheck + per-tenant Gradle cache; surface as a normal long story (checkpoint/stall logic already exists). |
| iOS can't build here | Out of scope v1; `codemagic` field added empty for the later cloud-Mac layer. |
| Firebase config is fiddly | v1 = Android `google-services.json` only; clarify gates it; missing-cred → `needs-input` attention. |
| Sideload vs Play signing identity | Persist a per-tenant upload keystore so the same app updates cleanly on Play later. |
| Stub harness can't run real `flutter` | Post-finalize build step is stub-aware (simulates APK + link) so E2E orchestration is testable with no spend. |
| `web/` had no clarify step | Add it (also fixes the brand-visual gap). |

## 7. Acceptance criteria
1. `flutter-app` selectable in both UIs; `/api/ralph/plan` returns it; `normalizePrd` round-trips it.
2. Clarify for `flutter-app` asks brand + the Firebase/backend question; the `web/` flow shows a clarify step.
3. A `flutter-app` build serves a working web preview at `<project>.tayyabcheema.com` and produces a signed APK shared via a Drive link + QR recorded in `DELIVERABLE.md`.
4. Firebase wired only when clarify says so, using the tenant's own creds; absent creds → local-only or a clear `needs-input`.
5. Tenant (`wt_*`) builds succeed using the shared toolchain with per-tenant caches.
6. New credential fields appear empty per tenant, save/round-trip via the vault, and single-tenant reads `secrets.json`.
7. "Submit to Play Store" spawns a separate task that scaffolds CI + uploads to a test track.
8. No-spend stub E2E reaches `done` with a (simulated) deliverable link; pure helpers unit-tested.

## 8. Sources
- `create-and-share-apk` skill + `share-apk-to-drive.mjs` (`/root/.claude/skills/create-and-share-apk/`) and `/var/www/tayyabcheema.com/subdomains/drive/google-client.js`.
- apkipa proof-of-concept: `/srv/apkipa/my_counter_app` (signing, `.github/workflows`, `codemagic.yaml`), `docs/superpowers/specs/2026-06-25-flutter-live-preview-apk-design.md`.
- Current code anchors cited inline (server.js, ralph/clarify-axes.mjs, web/src/*).
