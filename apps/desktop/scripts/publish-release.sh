#!/usr/bin/env bash
# Publishes the most recent signed build (from build-signed-mac.sh) as the
# required update: writes apps/web/public/updates/latest.json and copies the
# update artifact next to it, then deploys apps/web to thawdrop.com.
#
# Run this AFTER build-signed-mac.sh has completed successfully for the
# version you want everyone to be forced onto.

set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
bundle_dir="src-tauri/target/release/bundle/macos"
app_tar="$bundle_dir/Thawdrop.app.tar.gz"
sig_file="$app_tar.sig"

if [ ! -f "$app_tar" ] || [ ! -f "$sig_file" ]; then
  echo "Missing $app_tar or $sig_file — run ./scripts/build-signed-mac.sh first." >&2
  exit 1
fi

updates_dir="../web/public/updates"
mkdir -p "$updates_dir"

artifact_name="Thawdrop_${version}_aarch64.app.tar.gz"
cp "$app_tar" "$updates_dir/$artifact_name"

# First-time install, not the updater: a stable, unversioned path so the
# "Download for Mac" button on the landing page never needs its link edited.
dmg="$bundle_dir/../dmg/Thawdrop_${version}_aarch64.dmg"
download_dir="../web/public/download"
mkdir -p "$download_dir"
if [ -f "$dmg" ]; then
  cp "$dmg" "$download_dir/Thawdrop.dmg"
else
  echo "Warning: $dmg not found — leaving the existing download/Thawdrop.dmg as-is." >&2
fi

signature=$(cat "$sig_file")
pub_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$updates_dir/latest.json" <<EOF
{
  "version": "$version",
  "notes": "",
  "pub_date": "$pub_date",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$signature",
      "url": "https://thawdrop.com/updates/$artifact_name"
    }
  }
}
EOF

echo "Wrote $updates_dir/latest.json for version $version."
echo "Deploying apps/web to thawdrop.com…"

(cd ../web && npx vite build && npx wrangler deploy)

echo
echo "Published. Any running Thawdrop older than $version will now be"
echo "blocked until it updates."
