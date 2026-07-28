#!/bin/bash
# Builds BCC Control.app with swiftc alone. No Xcode project, no scheme, no
# workspace. Command Line Tools is enough.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="BCC Control"
EXEC="BCCControl"
IDENT="com.bostonglobe.bcc-control"
VERSION="1.0.0"
MINOS="14.0"
BUILD="$HERE/build"
APP="$BUILD/$NAME.app"
SDK="$(xcrun --show-sdk-path)"

SOURCES=(
  "$HERE/Model.swift"
  "$HERE/AgentControl.swift"
  "$HERE/FeedsView.swift"
  "$HERE/LogView.swift"
  "$HERE/SettingsView.swift"
  "$HERE/BCCApp.swift"
)

echo "==> clean"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> icon"
swiftc -O -sdk "$SDK" -target "$(uname -m)-apple-macosx$MINOS" \
  -o "$BUILD/iconmaker" "$HERE/iconmaker.swift"
"$BUILD/iconmaker" "$BUILD/AppIcon.iconset" >/dev/null
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

echo "==> compile"
# Try both architectures so one build runs on Apple Silicon and Intel. If the
# cross compile is unavailable the native slice alone still ships.
SLICES=()
for ARCH in arm64 x86_64; do
  if swiftc -O -parse-as-library -swift-version 5 \
      -sdk "$SDK" -target "$ARCH-apple-macosx$MINOS" \
      -o "$BUILD/$EXEC-$ARCH" "${SOURCES[@]}" 2>"$BUILD/compile-$ARCH.log"; then
    SLICES+=("$BUILD/$EXEC-$ARCH")
    echo "    $ARCH ok"
  else
    echo "    $ARCH skipped"
    if [ "$ARCH" = "$(uname -m)" ]; then
      echo
      echo "The build for this Mac's own architecture failed. Errors:"
      cat "$BUILD/compile-$ARCH.log"
      exit 1
    fi
  fi
done

if [ "${#SLICES[@]}" -gt 1 ]; then
  lipo -create "${SLICES[@]}" -output "$APP/Contents/MacOS/$EXEC"
else
  cp "${SLICES[0]}" "$APP/Contents/MacOS/$EXEC"
fi
chmod 755 "$APP/Contents/MacOS/$EXEC"

echo "==> bundle"
cat > "$APP/Contents/Info.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>$NAME</string>
  <key>CFBundleDisplayName</key>       <string>$NAME</string>
  <key>CFBundleExecutable</key>        <string>$EXEC</string>
  <key>CFBundleIdentifier</key>        <string>$IDENT</string>
  <key>CFBundleIconFile</key>          <string>AppIcon</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key>           <string>$VERSION</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key>    <string>$MINOS</string>
  <key>LSApplicationCategoryType</key> <string>public.app-category.news</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <key>NSHumanReadableCopyright</key>  <string>Boston Globe Media</string>
</dict>
</plist>
PLISTEOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> sign"
# Ad hoc is enough here. The point of signing is a stable code identity, which
# is what lets a microphone or screen recording grant stick to the app instead
# of being asked for again after every rebuild.
xattr -cr "$APP" 2>/dev/null || true
codesign --force --sign - --identifier "$IDENT" --timestamp=none "$APP"
codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

echo
echo "Built $APP"
echo "Install it with:  cp -R \"$APP\" /Applications/"
