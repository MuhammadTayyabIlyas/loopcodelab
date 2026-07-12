#!/bin/bash
# webtmux APK -> Google Drive upload helper — TEMPLATE (do NOT run from the repo).
#
# The Drive OAuth tokens (admin account tayyabcheema777@gmail.com) are owned by
# www-data and the bundled uploader lives under /root — neither readable by tmuxweb.
# So, like webtmux-sudo / webtmux-provision, this privileged helper lives OUTSIDE the
# repo and is the ONLY way the app (tmuxweb) triggers a Drive upload. It runs the
# uploader as root (can read the APK + tokens), then restores tokens.json ownership to
# www-data so the Drive service keeps working after a token refresh.
#
# Install at cutover:
#   sudo install -m 0755 docs/ops/webtmux-apk-share.sh /usr/local/sbin/webtmux-apk-share
#   echo 'tmuxweb ALL=(root) NOPASSWD: /usr/local/sbin/webtmux-apk-share' \
#     | sudo tee /etc/sudoers.d/tmuxweb-apk-share && sudo chmod 0440 /etc/sudoers.d/tmuxweb-apk-share
#
# Usage: webtmux-apk-share <apk-path> <drive-filename.apk>
# Prints the uploader's JSON ({shareLink,qr,...}) on stdout.
set -uo pipefail

apk="${1:-}"; name="${2:-}"
HELPER="/root/.claude/skills/create-and-share-apk/share-apk-to-drive.mjs"
TOKENS="/var/www/tayyabcheema.com/subdomains/drive/config/tokens.json"
NODE="$(command -v node || echo /usr/bin/node)"

[[ "$name" =~ ^[A-Za-z0-9._-]+\.(apk|aab)$ ]] || { echo '{"error":"bad output name"}'; exit 1; }
[ -f "$apk" ] || { echo '{"error":"apk not found"}'; exit 1; }
[ -f "$HELPER" ] || { echo '{"error":"uploader missing"}'; exit 1; }

out="$("$NODE" "$HELPER" --apk "$apk" --name "$name" 2>/dev/null)"; rc=$?
# Keep the Drive service working: the uploader rewrites tokens.json on refresh; as root
# that would flip ownership to root. Restore it to www-data unconditionally.
chown www-data:www-data "$TOKENS" 2>/dev/null || true
[ $rc -eq 0 ] || { echo '{"error":"upload failed"}'; exit 1; }
printf '%s\n' "$out"
