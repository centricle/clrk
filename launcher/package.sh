#!/usr/bin/env bash
# Package the signed stub as a notarized installer that installs into
# ~/Applications with no admin password.
#
#   launcher/package.sh [--no-notarize]
#
# Needs both Developer ID identities in the login keychain (Application for the
# app, Installer for the package) and a notarytool keychain profile, named by
# NOTARY_PROFILE (default: notary), stored once with
# `xcrun notarytool store-credentials`. There is no unsigned path: Gatekeeper
# blocks an unsigned package, and while the stub is ad-hoc, build.sh places the
# app directly instead.
#
# The package is for the machine that builds it: the stub carries this
# checkout's absolute path to bin/cli.mjs, and the package targets Apple
# silicon only.
#
# Not yet run end to end.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
profile="${NOTARY_PROFILE:-notary}"
notarize=1
[ "${1:-}" = "--no-notarize" ] && notarize=0

read -r name version < <(node -e '
  const p = require(process.argv[1] + "/package.json");
  console.log(p.name.replace(/^@[^/]+\//, ""), p.version);' "$repo")
title="$(tr '[:lower:]' '[:upper:]' <<< "${name:0:1}")${name:1}"
bundle_id="com.centricle.$name"

identity() {
  security find-identity -v -p "$1" 2>/dev/null \
    | sed -n "s/.*\"\\($2: [^\"]*\\)\".*/\\1/p" | head -1
}
app_id="$(identity codesigning 'Developer ID Application')"
pkg_id="$(identity basic 'Developer ID Installer')"
if [ -z "$app_id" ] || [ -z "$pkg_id" ]; then
  echo "Need both Developer ID Application and Developer ID Installer identities." >&2
  echo "Found: application='${app_id:-none}' installer='${pkg_id:-none}'" >&2
  exit 1
fi

build="$repo/build/pkg"
rm -rf "$build"
mkdir -p "$build/root"

# Build and sign the app into the package root, not ~/Applications.
"$repo/launcher/build.sh" --replace --dest "$build/root"
codesign -dv --verbose=4 "$build/root/$title.app" 2>&1 | grep -q 'Authority=Developer ID Application' \
  || { echo "stub is not Developer ID signed" >&2; exit 1; }

# Never relocatable: the installer must not go looking for, and update, a stray
# copy of the app somewhere else on disk.
pkgbuild --analyze --root "$build/root" "$build/component.plist"
plutil -replace 0.BundleIsRelocatable -bool NO "$build/component.plist"

pkgbuild --root "$build/root" --component-plist "$build/component.plist" \
  --identifier "$bundle_id" --version "$version" \
  --install-location /Applications "$build/component.pkg"

# enable_currentUserHome: installs into ~/Applications, no admin password.
cat > "$build/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>$title</title>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <choices-outline>
    <line choice="$bundle_id"/>
  </choices-outline>
  <choice id="$bundle_id" visible="false">
    <pkg-ref id="$bundle_id"/>
  </choice>
  <pkg-ref id="$bundle_id" version="$version" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
XML

out="$repo/build/$title-$version.pkg"
productbuild --distribution "$build/distribution.xml" --package-path "$build" \
  --sign "$pkg_id" "$out"

if [ "$notarize" -eq 1 ]; then
  xcrun notarytool submit "$out" --keychain-profile "$profile" --wait
  xcrun stapler staple "$out"
  xcrun stapler validate "$out"
fi
pkgutil --check-signature "$out"
spctl -a -vv -t install "$out" || true
echo "package: $out"
echo "install: installer -pkg '$out' -target CurrentUserHomeDirectory"
