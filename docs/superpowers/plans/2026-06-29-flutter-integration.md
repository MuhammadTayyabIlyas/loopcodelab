# Flutter App Development in Ralph — Implementation Plan

**Design:** `docs/superpowers/specs/2026-06-29-flutter-integration-design.md`
**Date:** 2026-06-29
**Execution:** Each task is independently verifiable (syntax-check + unit/stub tests) so it can be driven by `/ralph-loop` or the in-repo orchestrator. Tasks are ordered by dependency; T1 (toolchain) is the only infra/host change and gates real builds — everything else is code/doc.

**Global rules (from CLAUDE.md):**
- `node --check server.js` / `node --check public/js/dashboard.js` / `bash -n ralph/*.sh` / `node --test ralph/*.test.mjs` before any restart.
- After `public/` edits, bump `VERSION` in `public/sw.js`. After `web/src` edits, `cd web && npm run build`.
- Never commit secrets, keystores, `google-services.json`, service-account JSON, or `web/dist`.
- Restarting `webtmux.service` deploys live — only when explicitly approved.
- Validate the no-spend stub harness end-to-end before declaring done (`RALPH_FORCE_TOOL=stub`, `RALPH_FAKE_REMOTE`, isolated port/data dirs).

---

## Task 0 — Verify host prerequisites (read-only)
**Goal:** Confirm the toolchain + Drive helper are present on *this* server before building anything on them.
**Do:**
- `source /etc/profile.d/flutter.sh && flutter --version && flutter doctor -v` (expect 3.44.x + Android toolchain).
- Confirm `/opt/flutter`, `/opt/android-sdk/build-tools/36.0.0/apksigner`.
- Confirm `~/.claude/skills/create-and-share-apk/share-apk-to-drive.mjs` and `/var/www/tayyabcheema.com/subdomains/drive/config/tokens.json` exist and the OAuth still refreshes (dry import test).
**Verify:** All present; note any gap as a blocker before T6.

---

## Task 1 — Tenant toolchain access + build env helper
**Goal:** Sandboxed `wt_*` users can run Flutter/Gradle builds with isolated caches and a concurrency guard.
**Files:** new `ralph/flutter-env.mjs` (pure helper building env map) + `ralph/flutter-env.test.mjs`; wiring in `server.js` near `ralphEnvPrefix` (`server.js:~1549`) and the worker/finalize spawn paths; a host setup script `docs/ops/flutter-tenant-access.sh` (chmod/ACL steps, run once by admin — NOT auto-run).
**Do:**
- Host (documented script, admin-run): ensure `/opt/flutter` + `/opt/android-sdk` are `o+rx`; `/etc/profile.d/flutter.sh` exports `FLUTTER_ROOT`/`ANDROID_HOME`/PATH; `git config --system --add safe.directory '*'`.
- `flutterEnv(run)`: returns `PUB_CACHE=<home>/.pub-cache`, `GRADLE_USER_HOME=<home>/.gradle`, `FLUTTER_ROOT`, `ANDROID_HOME`, `PATH` additions; tenant home in multitenant, repo-local in single-tenant.
- Add a build-concurrency semaphore (cap, e.g. 2 concurrent `flutter build`) + a `df` precheck helper; refuse/queue when low on disk.
**Verify:** `node --test ralph/flutter-env.test.mjs`; manual: a `wt_*` user runs `flutter build web` on a scaffold and it succeeds with caches under its home.

---

## Task 2 — Register the `flutter-app` output format
**Goal:** `flutter-app` is a first-class format in both UIs and the planner.
**Files:** `server.js:166` (OUTPUT_FORMATS), `server.js:169` (OUTPUT_SKILL `'flutter-app':'flutter-deliverable'`), `server.js:1709` (add to `VISUAL_OUTPUT`); `web/src/pages/NewBuild.jsx:21` (FORMATS) + label/help; `public/index.html` + `public/js/dashboard.js` format picker.
**Do:** Add the string everywhere the format list is mirrored; add a human label ("Flutter mobile app (Android + web)").
**Verify:** `node --check server.js && node --check public/js/dashboard.js`; `cd web && npm run build`; `/api/ralph/plan` response includes `flutter-app`; bump `public/sw.js` VERSION.

---

## Task 3 — Vendored Ralph skills (flutter-app, flutter-deliverable, firebase)
**Goal:** Every agent can build Flutter; finalize knows how to produce the artifacts.
**Files:** `ralph/skills/flutter-app/SKILL.md`, `ralph/skills/flutter-deliverable/SKILL.md`, `ralph/skills/firebase/SKILL.md`.
**Do:**
- `flutter-app`: scaffold conventions (`flutter create`, lib/ layout, state mgmt, packages, `flutter test`), use `assets/brand/` first (defers to `imagery`), `source /etc/profile.d/flutter.sh` reminder, "re-run first build once" gotcha.
- `flutter-deliverable`: `flutter build web --release` → `build/web`; `flutter build apk --release` (signing via `android/key.properties` provided by orchestrator); verify with `apksigner`; record artifact paths; never commit keystores.
- `firebase`: wire `firebase_*` packages assuming `android/app/google-services.json` present; FlutterFire patterns; fallback to local-only if absent.
**Verify:** `loadSkillsCatalog` lists all three (add a tiny assertion test or log); `writeRalphBrief` for `flutter-app` includes `imagery` + assigned skills.

---

## Task 4 — Flutter-aware clarify + clarify step in `web/`
**Goal:** Building a Flutter app starts with brand + backend discovery, in the UI tenants actually use.
**Files:** `ralph/clarify-axes.mjs` (+ `ralph/clarify-axes.test.mjs`); `web/src/pages/NewBuild.jsx` (new clarify step); reuse `web/src/api.js:35 clarify(...)`.
**Do:**
- Add `flutter-app` to `CONTENT_AXES` with mobile axes incl. the Firebase/backend question; keep `contentHeavy:true`, `cap:6`.
- `web/` NewBuild: insert idea → **clarify** (render questions + asset tray already present) → plan → review; thread answers into `api.plan` (same shape the PWA uses).
**Verify:** `node --test ralph/clarify-axes.test.mjs` (new assertions for `flutter-app`); `cd web && npm run build`; manual clarify call returns mobile/Firebase questions.

---

## Task 5 — Credentials: vault providers + single-tenant + UI fields
**Goal:** Per-tenant (empty) + admin/single-tenant credential entry for Firebase / Google Play / Codemagic / signing.
**Files:** `server.js:2889` (VAULT_PROVIDERS += `firebase`,`google-play`,`codemagic`,`flutter-signing`); validation in `PUT /api/keys/:provider` (`server.js:2948`); single-tenant accessors near `server.js:656`; `web/src/pages/Settings.jsx` (new "Mobile app & backend" card group); `gitInitProject` ignore list (add `google-services.json`, `*.jks`, `key.properties`, service-account JSON).
**Do:** JSON-shape validation for `firebase`/`google-play`; render empty inputs per tenant; single-tenant reads `secrets.json` (documented, root-shell editable). Add a build-cred resolver that writes `google-services.json`/`key.properties` into the worktree at build time (gitignored).
**Verify:** set/get/delete each provider via `/api/keys` (multitenant); single-tenant accessor reads `secrets.json`; `cd web && npm run build`; no secret ever returned by GET (only `last4`).

---

## Task 6 — Build + deliverable pipeline (post-finalize APK → Drive)
**Goal:** On finalize PASS for `flutter-app`, deliver a working web preview + a Drive APK link.
**Files:** post-finalize branch in the tick (`server.js:2215-2230`); new orchestrator helpers `buildFlutterDeliverable(run)` + `shareApkToDrive(run, apkPath)` (wraps `share-apk-to-drive.mjs`); `DELIVERABLE.md`/README writer; `gitignore` for keystore materials.
**Do:**
- Ensure signing: generate/persist per-tenant keystore (`flutter-signing` vault), write `android/key.properties` + wire `build.gradle.kts` if missing (or rely on the `flutter-deliverable` skill to wire it during finalize).
- If Firebase creds present, write `android/app/google-services.json` before build.
- Confirm/produce `build/web` + signed APK; run `share-apk-to-drive.mjs` (admin OAuth, per-tenant Drive subfolder) → `shareLink`+`qr` → `DELIVERABLE.md` + `revent` + Web Push.
- **Stub-aware:** `RALPH_FORCE_TOOL=stub` → skip real `flutter`/upload, simulate APK + link.
**Verify:** stub E2E (isolated port/data, `RALPH_FAKE_REMOTE`) reaches `done` with a `DELIVERABLE.md` link; live smoke: build the apkipa counter scaffold + upload, confirm the link opens.

---

## Task 7 — Store submission as a separate task (Play, manual-submit)
**Goal:** A "Submit to Play Store" action that spawns a *new* task scaffolding CI + uploading to a test track.
**Files:** `POST /api/ralph/submit` (`server.js`); a submit task runner (build AAB, scaffold `.github/workflows/play-upload.yml`, set repo secrets via `github` token, upload via `google-play` service account to internal/closed track); `web/src/pages/*` + `public/js/dashboard.js` "Submit to Play Store" button on finished `flutter-app` builds; `web/src/api.js` `submit(project, store)`.
**Do:** Mirror the apkipa workflow; gate on presence of `google-play` + `github` creds (else `needs-input`). iOS path stubbed/disabled (Codemagic later).
**Verify:** stub-mode spawns the task and writes the workflow file; with creds, dry-run the scaffold (no real production push).

---

## Task 8 — Tests, docs, version bumps
**Goal:** Lock it in.
**Do:** finalize unit tests (`clarify-axes`, `flutter-env`, any cred-shaping helper); a stub-harness E2E script under `docs/ops/` for the `flutter-app` format; add a "Flutter app builds" section to `CLAUDE.md`; bump `public/sw.js` VERSION; update `web/dist` via build (not committed).
**Verify:** `node --test ralph/*.test.mjs` all green; stub E2E green; `node --check` clean.

---

## Suggested execution order for `/ralph-loop`
T0 → T2 → T3 → T4 (UI + clarify) → T5 (creds) → T1 (host access; admin-run script) → T6 (delivery) → T7 (submit) → T8 (tests/docs).
*(T1's host steps need admin/root and a manual run; the rest is code the loop can iterate on with `node --check`/`node --test` as the success signal. Per-task completion promise suggestion: tests pass + `node --check` clean for that task's files.)*
