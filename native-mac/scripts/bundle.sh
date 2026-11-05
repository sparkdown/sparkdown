#!/usr/bin/env bash
# swift build -> SparkDown Native.app -> .dmg (ad-hoc signed, not notarized).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/SparkDownNative"
OUT="$HERE/dist"
APP="$OUT/SparkDown Native.app"
rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SparkDownNative"
strip -x "$APP/Contents/MacOS/SparkDownNative" || true
# libghostty finds its resources by the terminfo sentinel in Contents/Resources.
cp -R vendor/share/terminfo "$APP/Contents/Resources/" 2>/dev/null || true
# Only shell-integration is needed at runtime (themes/docs are skipped).
mkdir -p "$APP/Contents/Resources/ghostty"
cp -R vendor/share/ghostty/shell-integration "$APP/Contents/Resources/ghostty/" 2>/dev/null || true
du -sh vendor/share/ghostty/* 2>/dev/null || true
ICON="$HERE/../src-tauri/icons/icon.icns"
[ -f "$ICON" ] && cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>SparkDown Native</string>
  <key>CFBundleDisplayName</key><string>SparkDown Native</string>
  <key>CFBundleIdentifier</key><string>com.sparkdown.native-spike</string>
  <key>CFBundleExecutable</key><string>SparkDownNative</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1-spike</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
hdiutil create -volname "SparkDown Native" -srcfolder "$APP" -ov -format UDZO "$OUT/SparkDownNative_spike_aarch64.dmg"
du -sk "$APP" "$OUT"/*.dmg; du -sk "$APP"/Contents/MacOS/* "$APP"/Contents/Resources/*
