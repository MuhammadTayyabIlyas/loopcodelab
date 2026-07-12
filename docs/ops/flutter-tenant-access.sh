#!/bin/bash
# Make the shared Flutter + Android SDKs usable by sandboxed tenant (wt_*) users and
# by the control-plane user (tmuxweb) for flutter-app builds. Run ONCE as root after
# installing the SDKs; idempotent (safe to re-run). NOT auto-run by the app.
#
#   sudo bash docs/ops/flutter-tenant-access.sh
#
# What it does and WHY:
#  1. SDKs world-readable/traversable (they hold no secrets; tenants only read them).
#  2. git "safe.directory" exception for /opt/flutter — flutter runs `git` against its
#     own root to detect the version; without this, a non-owner hits "dubious ownership".
#  3. A shared 'flutterbuild' group owns /opt/flutter/bin/cache group-writable + setgid,
#     so any build user can write Flutter's engine stamps/lockfiles without each tenant
#     owning the SDK. Per-build pub/gradle caches live under each runner's $HOME (see
#     ralph/flutter-env.mjs), so only the shared SDK itself is group-writable.
#     Trade-off: a shared writable SDK tree is a (low) cross-tenant surface on a
#     single-operator box; acceptable for v1. Revisit with per-tenant SDK clones at scale.
#  New tenants are auto-enrolled in flutterbuild by saas/provision-tenant.sh.
set -euo pipefail
FLUTTER_ROOT="${FLUTTER_ROOT:-/opt/flutter}"
ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
APP_USER="${WEBTMUX_APP_USER:-tmuxweb}"

[ -d "$FLUTTER_ROOT" ] || { echo "no $FLUTTER_ROOT — install Flutter first" >&2; exit 1; }
[ -d "$ANDROID_HOME" ] || { echo "no $ANDROID_HOME — install the Android SDK first" >&2; exit 1; }

# 1. Readable/traversable by all (idempotent).
chmod o+rx "$FLUTTER_ROOT" "$ANDROID_HOME"

# 2. git ownership exception (guarded so re-runs don't duplicate the entry).
git config --system --get-all safe.directory 2>/dev/null | grep -qx "$FLUTTER_ROOT" \
  || git config --system --add safe.directory "$FLUTTER_ROOT"

# 3. Make the SDK tree group-writable via 'flutterbuild'. flutter writes in several places
#    besides bin/cache — notably packages/flutter_tools/.dart_tool/package_config.json on
#    `flutter create`/`pub get` — so the whole tree (not just bin/cache) must be writable by
#    the group, with setgid dirs so new files keep the group.
groupadd -f flutterbuild
id -u "$APP_USER" >/dev/null 2>&1 && usermod -aG flutterbuild "$APP_USER"
for u in $(getent passwd | awk -F: '/^wt_/{print $1}'); do usermod -aG flutterbuild "$u"; done
chgrp -R flutterbuild "$FLUTTER_ROOT"
chmod -R g+rwX "$FLUTTER_ROOT"
find "$FLUTTER_ROOT" -type d -exec chmod g+s {} \;

echo "flutterbuild: $(getent group flutterbuild)"
echo "done. Note: group changes apply to NEW processes — restart webtmux.service so the"
echo "single-tenant orchestrator (runs as $APP_USER) picks up the group; tenant builds run"
echo "as fresh wt_* sessions and get it immediately."
