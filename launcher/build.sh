#!/usr/bin/env bash
# Build the stub app bundle and sign it.
#
#   launcher/build.sh [--replace] [--ui-element] [--dest DIR]
#
# Signs with a "Developer ID Application" identity when the keychain has one,
# ad-hoc when it does not, and says which it used.
#
# The app name comes from package.json (rename kit, part one), so nothing here
# spells it out. The CLI script path is baked into the binary.
#
# An ad-hoc stub's identity is its hash: replacing an installed ad-hoc stub
# drops its Documents grant, and a new grant needs a person at the Mac to click
# Allow. So an existing bundle is never overwritten without --replace.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/Applications"
replace=0
agent_key=LSBackgroundOnly

while [ $# -gt 0 ]; do
  case "$1" in
    --replace) replace=1 ;;
    --ui-element) agent_key=LSUIElement ;;
    --dest) dest="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

read -r name version < <(node -e '
  const p = require(process.argv[1] + "/package.json");
  console.log(p.name.replace(/^@[^/]+\//, ""), p.version);' "$repo")
title="$(tr '[:lower:]' '[:upper:]' <<< "${name:0:1}")${name:1}"
bundle_id="com.centricle.$name"
app="$dest/$title.app"
script="$repo/bin/cli.mjs"

if [ -e "$app" ] && [ "$replace" -ne 1 ]; then
  echo "$app exists. Rebuilding an ad-hoc stub drops its Documents grant." >&2
  echo "Pass --replace to overwrite it anyway." >&2
  exit 1
fi

build="$repo/build"
stage="$build/$title.app"
rm -rf "$stage"
mkdir -p "$stage/Contents/MacOS"

# Swift string literal; the path cannot contain a quote or backslash here.
case "$script" in *\"*|*\\*) echo "unsupported script path: $script" >&2; exit 1 ;; esac
printf 'let scriptPath = "%s"\n' "$script" > "$build/BuildConfig.swift"

# swiftc allows top-level code only in a file named main.swift.
cp "$repo/launcher/Stub.swift" "$build/main.swift"
swiftc -O -o "$stage/Contents/MacOS/$title" \
  "$build/main.swift" "$build/BuildConfig.swift"

cat > "$stage/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
  <key>CFBundleName</key>
  <string>$title</string>
  <key>CFBundleDisplayName</key>
  <string>$title</string>
  <key>CFBundleExecutable</key>
  <string>$title</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>$agent_key</key>
  <true/>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>$title files the documents you drop into Documents/Inbox.</string>
</dict>
</plist>
PLIST

identity="$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"

if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp --sign "$identity" "$stage"
  echo "signed: Developer ID ($identity)"
else
  codesign --force --options runtime --sign - "$stage"
  echo "signed: ad-hoc (no Developer ID Application identity in the keychain)"
fi
codesign --verify --strict "$stage"

mkdir -p "$dest"
rm -rf "$app"
# ditto keeps the signature intact; cp -R can add extended attributes.
ditto "$stage" "$app"
echo "installed: $app ($agent_key)"
