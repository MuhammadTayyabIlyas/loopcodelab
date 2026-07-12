#!/bin/bash
# webtmux ARTIFACT -> Google Drive upload helper — TEMPLATE (do NOT run from the repo).
# Generalizes webtmux-apk-share to any installer artifact (.exe/.msi/.apk/.aab/.appx/.msix). Runs the
# bundled uploader as root (reads the file + the www-data-owned Drive tokens), then restores
# tokens.json ownership to www-data so the Drive service keeps working after a token refresh.
#
# Install at cutover:
#   sudo install -m 0755 docs/ops/webtmux-artifact-share.sh /usr/local/sbin/webtmux-artifact-share
#   echo 'tmuxweb ALL=(root) NOPASSWD: /usr/local/sbin/webtmux-artifact-share' \
#     | sudo tee /etc/sudoers.d/tmuxweb-artifact-share && sudo chmod 0440 /etc/sudoers.d/tmuxweb-artifact-share
#
# Usage: webtmux-artifact-share <file-path> <drive-filename.(exe|msi|apk|aab|appx|msix)>
# Prints the uploader's JSON ({shareLink,qr,...}) on stdout.
set -uo pipefail

file="${1:-}"; name="${2:-}"
HELPER="/root/.claude/skills/create-and-share-apk/share-apk-to-drive.mjs"
TOKENS="/var/www/tayyabcheema.com/subdomains/drive/config/tokens.json"
NODE="$(command -v node || echo /usr/bin/node)"

[[ "$name" =~ ^[A-Za-z0-9._-]+\.(exe|msi|apk|aab|appx|msix|mp4|mp3|wav|png|jpg|jpeg|webp|zip)$ ]] || { echo '{"error":"bad output name"}'; exit 1; }
[ -f "$file" ] || { echo '{"error":"file not found"}'; exit 1; }
[ -f "$HELPER" ] || { echo '{"error":"uploader missing"}'; exit 1; }

# The bundled uploader takes --apk/--name but uploads any file at that path unchanged.
out="$("$NODE" "$HELPER" --apk "$file" --name "$name" 2>/dev/null)"; rc=$?
chown www-data:www-data "$TOKENS" 2>/dev/null || true
[ $rc -eq 0 ] || { echo '{"error":"upload failed"}'; exit 1; }
printf '%s\n' "$out"
