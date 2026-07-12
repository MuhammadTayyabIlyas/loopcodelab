---
name: firebase
description: Wire a Flutter app to Firebase (auth, Cloud Firestore, push) when the app needs user accounts, cloud sync, or notifications. Only use when the clarify step said a backend is needed. Prefers the signed-in Firebase CLI + `flutterfire configure` (auto-generates the config); falls back to a provided google-services.json, else local-only storage.
---

# Firebase backend for a Flutter app

Use this only when the build needs **user accounts, cloud data, or push notifications**
(the clarify step asks). For purely local apps, do NOT add Firebase — use
`shared_preferences`/`sqflite` instead.

> `firebase` and `dart` are on PATH. Run config steps in ONE command after sourcing the env:
> `source /etc/profile.d/flutter.sh && firebase login:list`.

## Connect, in priority order

### 1. Signed-in Firebase CLI → `flutterfire configure` (preferred, automatic)
Check first: `firebase login:list`. If it shows an account, the user signed in (Settings →
Firebase → "Sign in (CLI)"). Generate the config automatically — **no file to paste**:

```bash
source /etc/profile.d/flutter.sh
command -v flutterfire >/dev/null || dart pub global activate flutterfire_cli
# pick the project: a Firebase project id from the clarify answers if given, else an existing one
PROJ="$(firebase projects:list 2>/dev/null | awk -F'│|\\|' '/[a-z0-9-]{6,}/{print $3}' | tr -d ' ' | grep -m1 .)"
# (if none exists: firebase projects:create flutter-<slug> --display-name "<App>")
flutterfire configure --project="$PROJ" --platforms=android,web --yes
```

This writes **`lib/firebase_options.dart`** (commit it — Firebase config keys are public by
design, not secrets) and **`android/app/google-services.json`** (gitignored). Do this in the
FIRST story that needs Firebase so later builds + finalize already have `firebase_options.dart`.

### 2. Provided `google-services.json` (fallback)
If the CLI isn't signed in but `.ralph/google-services.json` exists (the user pasted one), copy
it in after `flutter create`: `mkdir -p android/app && cp .ralph/google-services.json android/app/`.
Then add `firebase_core` + init from those values (you may still run `flutterfire configure` to
generate `firebase_options.dart` for web).

### 3. Neither → local-only
Don't hardcode another project's keys and don't block. Implement against a **local stub**
(`shared_preferences`/`sqflite`) and note in `DELIVERABLE.md` that Firebase isn't connected
(the user can sign in under Settings → Firebase and rebuild).

## Provision the app's requirements
Drive provisioning from the clarify answers (accounts? cloud data? push?). With the CLI signed in
(and a **Firebase MCP server wired** — use its tools or the CLI):
- **Project:** reuse an existing one (`firebase projects:list`) when possible; only
  `firebase projects:create flutter-<slug>` if the user has none (project-creation quota is limited).
  `flutterfire configure --project=<id>` registers the app.
- **Cloud data (Firestore):** create the DB once if missing —
  `firebase firestore:databases:create '(default)' --location=nam5` (or a region near the user) — then
  write a **locked** `firestore.rules` and `firebase deploy --only firestore:rules`.
- **Accounts (Auth):** enabling sign-in providers (Email/Password, Google) is NOT a plain CLI command.
  Use the **Firebase MCP** tools if they expose auth config; otherwise leave a one-time step in
  `DELIVERABLE.md` (Console → Authentication → Sign-in method → enable Email/Password + Google). Wire
  `firebase_auth` in code either way, and offer a guest/demo path so the app works pre-enablement.
- **Push (FCM):** registration is handled by `flutterfire configure`; sending needs a service account
  (out of scope unless asked).

## Wiring + best practices
- `pubspec.yaml`: add only what's used — `firebase_core`, then `firebase_auth` /
  `cloud_firestore` / `firebase_messaging`.
- `main.dart`: `await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform)`
  before `runApp` (this needs `firebase_options.dart`, hence step 1/2).
- Android Gradle: ensure the Google Services plugin is applied (Flutter 3.44 uses
  `build.gradle.kts` — add `id("com.google.gms.google-services")`); `flutterfire configure`
  patches most of this.
- Keep Firestore access behind a `services/` layer; ship **locked** `firestore.rules` (auth-gated,
  never open `allow read, write: if true`).
- Gate web vs Android with `kIsWeb` where setup differs. Offer a **guest/demo** path so the app
  (and store screenshots) work without login.

## Rules
- **Never commit** `google-services.json`, `GoogleService-Info.plist`, or service-account JSON —
  they're gitignored and provided/generated per build. `firebase_options.dart` IS committed.
- Don't enable billable features (heavy Cloud Functions) unless the user asked.
