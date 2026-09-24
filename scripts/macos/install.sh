#!/usr/bin/env bash
# Installs a "Share with Thawdrop" Finder Quick Action (right-click menu on any
# file) that runs Thawdrop.app in --share mode on the selected item.
#
# NOTE: Automator's .workflow bundle format is not officially documented; this
# script writes a best-effort copy known to work on recent macOS. If the
# action doesn't show up under System Settings > Extensions > Finder, or in
# Finder's right-click menu, open Automator, create a new "Quick Action"
# ("receives files or folders in Finder"), add a "Run Shell Script" action
# with:
#   for f in "$@"; do /Applications/Thawdrop.app/Contents/MacOS/Thawdrop --share "$f"; done
# and save it as "Thawdrop Share".
#
# Usage: ./install.sh [/Applications/Thawdrop.app]
set -euo pipefail

APP_PATH="${1:-/Applications/Thawdrop.app}"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Thawdrop.app not found at $APP_PATH — build it first with:" >&2
  echo "  npm run desktop:build" >&2
  echo "then move apps/desktop/src-tauri/target/release/bundle/macos/Thawdrop.app to /Applications," >&2
  echo "or pass its path as \$1." >&2
  exit 1
fi
EXECUTABLE="$APP_PATH/Contents/MacOS/Thawdrop"

SERVICES_DIR="$HOME/Library/Services"
WORKFLOW_DIR="$SERVICES_DIR/Thawdrop Share.workflow"
mkdir -p "$WORKFLOW_DIR/Contents"

cat > "$WORKFLOW_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>Share with Thawdrop</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.item</string>
			</array>
		</dict>
	</array>
	<key>CFBundleIdentifier</key>
	<string>co.id.thawdrop.share-quickaction</string>
	<key>CFBundleName</key>
	<string>Thawdrop Share</string>
</dict>
</plist>
PLIST

cat > "$WORKFLOW_DIR/Contents/document.wflow" <<WFLOW
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>512</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>for f in "\$@"
do
  "$EXECUTABLE" --share "\$f"
done</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>7C956220-11E9-4C3E-9C09-000000000001</string>
				<key>OutputUUID</key>
				<string>7C956220-11E9-4C3E-9C09-000000000002</string>
				<key>UUID</key>
				<string>7C956220-11E9-4C3E-9C09-000000000003</string>
				<key>isViewVisible</key>
				<true/>
				<key>location</key>
				<string>309.000000:253.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/en.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<true/>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>11</integer>
		<key>processesInput</key>
		<integer>0</integer>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
WFLOW

# Let Launch Services / pbs pick up the new Service without a logout.
/System/Library/CoreServices/pbs -update "$WORKFLOW_DIR" >/dev/null 2>&1 || true
killall pbs >/dev/null 2>&1 || true
killall Finder >/dev/null 2>&1 || true

echo "Installed '$WORKFLOW_DIR'."
echo "If 'Share with Thawdrop' doesn't appear when you right-click a file, enable it in:"
echo "  System Settings > Privacy & Security > Extensions > Finder Extensions"
echo "or recreate it manually in Automator (see the note at the top of this script)."
echo "To remove: rm -rf \"$WORKFLOW_DIR\""
