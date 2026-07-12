#!/bin/bash
# Build the flutter-app deliverables (web preview + installable APK) and share the APK
# to Google Drive via the privileged wrapper. Run by the orchestrator AS THE APP USER
# (tmuxweb) after finalize PASS — tmuxweb has the 'flutterbuild' group (for the shared
# SDK cache) and the sudo grant for webtmux-apk-share (the upload needs the admin Drive
# OAuth, owned by www-data). ALWAYS writes JSON to --out so the orchestrator tick never
# hangs: {"shareLink":...,"qr":...} on success, {"error":...} on any failure.
set -u

DIR=""; NAME="app.apk"; OUT=""; URL=""; STUB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2;;
    --name) NAME="${2:-app.apk}"; shift 2;;
    --out) OUT="${2:-}"; shift 2;;
    --url) URL="${2:-}"; shift 2;;
    --stub) STUB=1; shift;;
    *) shift;;
  esac
done

[ -n "$OUT" ] || { echo "ralph-deliver: no --out" >&2; exit 0; }
emit() { printf '%s\n' "$1" > "$OUT"; exit 0; }
fail() { local m="${1//\"/\\\"}"; emit "{\"error\":\"$m\"}"; }

[ -n "$DIR" ] || fail "no dir"

# No-spend path for the stub harness: skip the real build + upload entirely.
if [ "$STUB" = 1 ]; then
  emit "{\"shareLink\":\"https://drive.example/stub/$(basename "$NAME")\",\"qr\":\"https://drive.example/qr/$(basename "$NAME")\"}"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"  # resolve BEFORE cd "$DIR" so capture-shots.mjs is found even if $0 is relative
cd "$DIR" 2>/dev/null || fail "cd failed: $DIR"
[ -f pubspec.yaml ] || fail "not a flutter project (no pubspec.yaml)"

# shellcheck disable=SC1091
source /etc/profile.d/flutter.sh 2>/dev/null
export PUB_CACHE="$HOME/.pub-cache" GRADLE_USER_HOME="$HOME/.gradle"

# CAP GRADLE/KOTLIN MEMORY — this host has ~8G RAM and Flutter's default Gradle heap (-Xmx8G)
# is larger than the whole machine, so an uncapped build OOM-kills it. GRADLE_USER_HOME/
# gradle.properties overrides the project's value; daemon=false so nothing lingers after.
mkdir -p "$GRADLE_USER_HOME"
cat > "$GRADLE_USER_HOME/gradle.properties" <<'GP'
org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m
org.gradle.daemon=false
org.gradle.workers.max=2
org.gradle.parallel=false
kotlin.daemon.jvmargs=-Xmx1024m
GP

# Firebase fallback (paste path): the orchestrator staged google-services.json under .ralph/;
# put it where the Android build expects it. The CLI/flutterfire path generates its own.
[ -f .ralph/google-services.json ] && mkdir -p android/app && cp -f .ralph/google-services.json android/app/google-services.json || true

# Web build first (no Gradle — cheap; it's the live preview). `sg` reads /etc/group directly so
# the shared-SDK group applies even if our cached login groups are stale.
sg flutterbuild -c 'flutter pub get && flutter build web --release' || fail "flutter build web failed"
# APK build under a GLOBAL lock so only ONE heavy Gradle build runs at a time on this host
# (concurrent deliveries queue rather than pile up and exhaust RAM). Debug-signed by default →
# installable for testing; release signing is wired at Play submission.
flock -w 2400 /tmp/webtmux-flutter-build.lock \
  sg flutterbuild -c 'flutter build apk --release' || fail "flutter build apk failed (see the rd- tmux session)"

# Best-effort store screenshots from the web build (headless Chromium at device viewports).
# Non-fatal: a failure here must not block the APK delivery. Output lands in store-assets/
# and is committed alongside DELIVERABLE.md by the orchestrator.
node "$SCRIPT_DIR/capture-shots.mjs" --dir "$DIR" >/dev/null 2>&1 || true

APK="build/app/outputs/flutter-apk/app-release.apk"
[ -f "$APK" ] || fail "no apk produced at $APK"

OUTJSON="$(sudo -n /usr/local/sbin/webtmux-apk-share "$(readlink -f "$APK")" "$NAME" 2>/dev/null)" \
  || fail "drive upload failed"
emit "$OUTJSON"
