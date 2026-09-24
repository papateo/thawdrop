#!/usr/bin/env bash
# Builds Thawdrop for macOS, signed with a Developer ID Application
# certificate and notarized, so it opens on any Mac without a Gatekeeper
# warning. Run this yourself in your own terminal — it reads your Apple
# credentials from environment variables, never pass them through chat.
#
# Required env vars (export these before running, or put them in a local
# .env-style file you `source` yourself — do NOT commit them anywhere):
#   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID                the Apple ID email used for the Developer account
#   APPLE_PASSWORD          an app-specific password from appleid.apple.com
#                           (Sign-In and Security > App-Specific Passwords) —
#                           NOT your normal Apple ID password
#   APPLE_TEAM_ID           your Developer Team ID
#
# Usage:
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   export APPLE_ID="you@example.com"
#   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#   export APPLE_TEAM_ID="TEAMID"
#   ./scripts/build-signed-mac.sh

set -euo pipefail

missing=()
for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required environment variable(s): ${missing[*]}" >&2
  echo "See the comment at the top of this script for what each one is." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Signs the update artifact (.app.tar.gz) with the local updater keypair so
# `@tauri-apps/plugin-updater` can verify it on users' machines. This key
# never leaves this machine and isn't an Apple credential, so — unlike the
# Apple env vars above — the script can read it on its own.
key_dir="src-tauri/.updater-keys"
if [ ! -f "$key_dir/thawdrop-updater.key" ]; then
  echo "Missing $key_dir/thawdrop-updater.key — the updater signing key hasn't been generated." >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_dir/thawdrop-updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$key_dir/password.txt")"

echo "Building and signing Thawdrop for macOS…"
npm run build

echo
echo "Done. Tauri notarizes and staples automatically when the Apple env"
echo "vars above are set. Verify with:"
echo
echo '  spctl -a -vv "src-tauri/target/release/bundle/macos/Thawdrop.app"'
echo
echo "It should say \"accepted\" and \"source=Notarized Developer ID\"."
echo "The signed .app and .dmg are under:"
echo "  apps/desktop/src-tauri/target/release/bundle/macos/"
echo "  apps/desktop/src-tauri/target/release/bundle/dmg/"
echo
echo "To publish this build as the required update, run:"
echo "  ./scripts/publish-release.sh"
