---
name: flutter-app
description: Build a cross-platform app in Flutter/Dart that runs on Android and the web. Use for any "mobile app", "Android app", or "Flutter app" story. The Flutter SDK is installed on this box; release builds, signing and APK delivery are handled at finalize — a worker's job is a clean, compiling, tested app that also runs on web.
---

# Build a Flutter app

The Flutter SDK (3.44.x), Android SDK (API 36) and JDK 17 are already installed on this
server. You do **not** need sudo or to install an SDK.

> **The shell resets between commands.** Always `source /etc/profile.d/flutter.sh` in the
> SAME command as `flutter`, e.g.
> `source /etc/profile.d/flutter.sh && cd <proj> && flutter pub get`
> or you'll hit `flutter: command not found`.

## Project layout
- Scaffold once at the repo root with `flutter create .` (or build on the existing
  scaffold). Keep the package name stable; don't rename it mid-build.
- App code lives in `lib/` — split into `lib/screens/`, `lib/widgets/`, `lib/models/`,
  `lib/services/` as the app grows. Keep `main.dart` thin.
- Dependencies go in `pubspec.yaml`; run `flutter pub get` after editing it.
- State management: prefer `provider` or `riverpod` for anything beyond trivial; plain
  `setState` is fine for a single screen. Pick ONE and stay consistent.
- Persistence (local): `shared_preferences` for key/value, `sqflite` for relational.
  Only add a cloud backend (Firebase) if the build's clarify answers asked for accounts /
  cloud sync / push — see the `firebase` skill, which is injected when that's the case.

## Must run on web (the live preview is the web build)
The project is previewed at `https://<project>.tayyabcheema.com` from `build/web`. So:
- Don't use plugins that have **no web support** unless the feature is Android-only and
  guarded (`if (kIsWeb) ...`). Prefer packages marked web-compatible on pub.dev.
- Verify web compiles: `source /etc/profile.d/flutter.sh && flutter build web --release`
  must succeed before you call the story done.
- **Do NOT run `flutter build apk` / `appbundle`.** This host is RAM-limited and an Android
  Gradle build OOM-kills it. Verifying with `flutter build web` + `flutter analyze` is enough;
  the orchestrator builds the signed APK once, capped, in the delivery pass.

## Make key screens URL-addressable (deep links + store screenshots)
Use a declarative router (**`go_router`**) with named routes, and call `usePathUrlStrategy()`
(from `flutter_web_plugins`) in `main()` so web URLs are clean paths (`/leaderboard`) rather than
hash routes. Expose a **guest/demo** entry that reaches the main screens WITHOUT login (e.g. a
"continue as guest" action, or honor a `?demo=1` query that seeds sample data). This makes the app
deep-linkable AND lets the store-screenshot step (see the `flutter-deliverable` skill) navigate to
real screens by URL — without it, every store screenshot is just the landing screen.

## Imagery & branding
Follow the `imagery` skill: use `assets/brand/` (logo, colors from `MANIFEST.md`) first,
else free stock. Declare asset paths under `flutter:\n  assets:` in `pubspec.yaml`.

## Quality bar for a story
Before writing the `.ralph/<id>.exit` sentinel, ensure:
- `flutter analyze` is clean (no errors; fix warnings you introduced).
- `flutter test` passes — add at least a widget test for new screens.
- `flutter build web --release` succeeds (NOT `flutter build apk` — see above).
- No secrets, `*.jks`, `key.properties`, or `google-services.json` are committed
  (these are provided at finalize, gitignored).

## Build gotchas
- The **first** `flutter build` (or first build after adding a plugin) is slow (3–7 min,
  Gradle/NDK downloads) and sometimes fails while resolving new deps — **re-run it once**
  before investigating. If it still fails: `flutter clean && flutter pub get` then build
  once more; only then read the actual Gradle error.
- `flutter`/Gradle "running as root" warnings are harmless on this box — ignore them.
