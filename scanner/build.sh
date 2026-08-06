#!/bin/bash
# Builds Scanner Relay.app. swiftc alone, no Xcode project. The speech engine,
# its libraries and the model all get copied inside the bundle, so the finished
# app runs on a Mac that has never seen Homebrew.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="Scanner Relay"
EXEC="ScannerRelay"
IDENT="com.bostonglobe.scanner-relay"
VERSION="1.0.0"
MINOS="14.0"
BUILD="$HERE/build"
APP="$BUILD/$NAME.app"
WDIR="$APP/Contents/Resources/bin"
MDIR="$APP/Contents/Resources/models"
SDK="$(xcrun --show-sdk-path)"

MODEL="${MODEL:-$HERE/vendor/ggml-small.en.bin}"
WHISPER="${WHISPER:-$(command -v whisper-cli || true)}"

# Order matters only in that every file is handed to one compile.
SOURCES=(
  "$HERE/src/Model.swift"
  "$HERE/src/Models.swift"
  "$HERE/src/Ollama.swift"
  "$HERE/src/MP3Framer.swift"
  "$HERE/src/HLS.swift"
  "$HERE/src/SystemAudio.swift"
  "$HERE/src/Capture.swift"
  "$HERE/src/Relay.swift"
  "$HERE/src/Controller.swift"
  "$HERE/src/ContentView.swift"
  "$HERE/src/App.swift"
)

echo "==> clean"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$WDIR" "$MDIR"

echo "==> compile"
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
      echo "The build for this Mac's own architecture failed:"
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

echo "==> speech engine"
if [ -z "$WHISPER" ] || [ ! -x "$WHISPER" ]; then
  echo "    whisper-cli not found. Install it once with: brew install whisper-cpp"
  exit 1
fi
cp "$WHISPER" "$WDIR/whisper-cli"
chmod 755 "$WDIR/whisper-cli"

# Where a library might actually be, in the order worth trying.
LIBDIRS="/opt/homebrew/opt/whisper-cpp/lib /opt/homebrew/opt/ggml/lib
/opt/homebrew/lib /usr/local/opt/whisper-cpp/lib /usr/local/opt/ggml/lib /usr/local/lib"

find_lib() {
  for d in $LIBDIRS; do
    [ -f "$d/$1" ] && { echo "$d/$1"; return 0; }
  done
  # Homebrew scatters things like libomp into their own kegs, so sweep those
  # too before giving up on a name.
  local hit
  for root in /opt/homebrew/opt /usr/local/opt; do
    [ -d "$root" ] || continue
    hit="$(/bin/ls -1 "$root"/*/lib/"$1" 2>/dev/null | head -1)"
    [ -n "$hit" ] && { echo "$hit"; return 0; }
  done
  return 1
}

# Walk the dependency graph by hand rather than leaning on a helper tool. Every
# reference becomes @loader_path, so the folder resolves wherever it is dropped.
absorb() {
  local bin="$1" dep base found
  for dep in $(otool -L "$bin" | awk 'NR>1 {print $1}'); do
    case "$dep" in
      /usr/lib/*|/System/*) continue ;;
      @loader_path/*) continue ;;
    esac
    base="$(basename "$dep")"
    install_name_tool -change "$dep" "@loader_path/$base" "$bin" 2>/dev/null || true
    [ -f "$WDIR/$base" ] && continue
    found="$(find_lib "$base")" || { echo "    missing dependency $base"; return 1; }
    cp "$found" "$WDIR/$base"
    chmod 755 "$WDIR/$base"
    install_name_tool -id "@loader_path/$base" "$WDIR/$base" 2>/dev/null || true
    absorb "$WDIR/$base" || return 1
  done
}

absorb "$WDIR/whisper-cli" || exit 1
echo "    libraries: $(ls -1 "$WDIR"/*.dylib 2>/dev/null | wc -l | tr -d ' ')"

# The compute backends are opened at runtime rather than linked, so nothing in
# the dependency graph points at them. Copy every Apple Silicon variant so one
# build runs on an M1 and an M4 alike.
BACKENDS="${GGML_LIBEXEC:-/opt/homebrew/opt/ggml/libexec}"
if [ -d "$BACKENDS" ]; then
  for so in "$BACKENDS"/*.so; do
    [ -e "$so" ] || continue
    base="$(basename "$so")"
    cp "$so" "$WDIR/$base"
    chmod 755 "$WDIR/$base"
    install_name_tool -id "@loader_path/$base" "$WDIR/$base" 2>/dev/null || true
    absorb "$WDIR/$base" || exit 1
  done
  echo "    backends: $(ls -1 "$WDIR"/*.so 2>/dev/null | wc -l | tr -d ' ')"
else
  echo "    no runtime backends found, the engine will fall back to plain CPU"
fi

echo "==> model"
if [ ! -f "$MODEL" ]; then
  echo "    model not found at $MODEL"
  echo "    fetch it once with:"
  echo "      curl -L -o \"$MODEL\" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
  exit 1
fi
cp "$MODEL" "$MDIR/ggml-small.en.bin"
echo "    $(du -h "$MDIR/ggml-small.en.bin" | awk '{print $1}')"

echo "==> bundle"
# The face on the Dock. Committed as a finished .icns rather than rebuilt from
# the master every run, because iconutil's output is deterministic and nobody
# should need the source PNG on disk to ship a build. Chief belongs to Disney,
# which is fine for a tool that never leaves the building and would not be for
# anything that does.
if [ -f "$HERE/icon/AppIcon.icns" ]; then
  cp "$HERE/icon/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

cat > "$APP/Contents/Info.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>$NAME</string>
  <key>CFBundleDisplayName</key>       <string>$NAME</string>
  <key>CFBundleExecutable</key>        <string>$EXEC</string>
  <key>CFBundleIdentifier</key>        <string>$IDENT</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key>           <string>$VERSION</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleIconFile</key>          <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>    <string>$MINOS</string>
  <key>LSApplicationCategoryType</key> <string>public.app-category.news</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <key>NSHumanReadableCopyright</key>  <string>Boston Globe Media</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Scanner Relay reads the sound one application is playing, so a police feed that only exists in a web player can be transcribed. No picture is captured and nothing is saved to disk.</string>
</dict>
</plist>
PLISTEOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> sign"
# Nested code gets signed first, then the bundle around it. Ad hoc is enough:
# the point is a stable identity so the keychain entry survives a rebuild.
xattr -cr "$APP" 2>/dev/null || true
for f in "$WDIR"/*.dylib "$WDIR"/*.so "$WDIR/whisper-cli"; do
  [ -e "$f" ] || continue
  codesign --force --sign - --timestamp=none "$f" >/dev/null 2>&1 || true
done
codesign --force --sign - --identifier "$IDENT" --timestamp=none "$APP"
codesign --verify --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

echo "==> self test"
"$WDIR/whisper-cli" --help >/dev/null 2>&1 \
  && echo "    engine runs from inside the bundle" \
  || echo "    WARNING: the bundled engine would not start"

echo "==> installer"
# A disk image rather than a package installer. The app is ad hoc signed, so
# there is nothing for a package receipt to verify and nothing to uninstall
# later. Drag it across, approve it once, done.
STAGE="$BUILD/dmg"
DMG="$BUILD/Scanner Relay $VERSION.dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

cat > "$STAGE/Read Me First.txt" <<'READMEEOF'
Scanner Relay

Drag the app onto the Applications folder beside it.

FIRST LAUNCH
This app is signed by us rather than by Apple, so macOS will refuse it the
first time and say it cannot be verified.

  1. Right click the app in Applications and pick Open.
  2. If a button called Open appears, press it and you are done.
  3. If it only offers Cancel, open System Settings, go to Privacy and
     Security, scroll to the bottom, and press Open Anyway next to
     Scanner Relay. Then open the app again.

You do this once per Mac.

SETUP
Open Settings inside the app and fill in three things:

  Dashboard URL   https://boston-control-center.vercel.app
  Ingest token    this Mac's own key, from whoever runs the dashboard
  Machine name    something you will recognize, for example Newsroom Mini 2

Press Test Connection. A green check means the dashboard is listening.

Broadcastify Premium credentials go in the same Settings panel. They are only
needed for broadcastify.com feeds and are stored in a file readable only by
your account, never in the cloud.

FEEDS
Press Add Feed. Give it a name, leave the type on Stream, and paste a
Broadcastify link or just the feed number. Fill in Covers with the town or
towns that feed actually reaches, since street names off the radio mean
nothing without it.

For a police feed that only exists in a web player, such as Boston Police,
set the type to App audio instead, play the stream in Chrome, and pick Chrome
from the list. macOS will ask once for screen recording permission. That
permission is what allows one application's sound to be read. No picture is
captured and no audio is written to disk.

HOW MANY FEEDS
Start capture and watch the System Load panel. It shows the share of the clock
spent turning radio into text and says plainly how many more feeds this Mac
could take. Past eighty percent the text starts arriving later than the radio,
which on a scanner is the same as not arriving at all.

The FEEDS box reads something like "5 of 8". The second number is how many
feeds could be talking at the same moment before this Mac falls behind. It
comes from SPEED, which is how many seconds of audio the model handles per
second of work. Quiet feeds cost nothing, so on an ordinary afternoon a Mac
will look far emptier than that. Trust the smaller number. The night that
matters is the one where every feed is busy at once.

If a Mac is full, either pick a smaller speech model in Settings or move a
feed to another Mac. Every Mac reports separately to the dashboard.
READMEEOF

if hdiutil create -volname "Scanner Relay" -srcfolder "$STAGE" \
     -ov -format UDZO "$DMG" >/dev/null 2>&1; then
  echo "    $(du -h "$DMG" | awk '{print $1}')  $DMG"
else
  echo "    disk image step failed, the app itself is still fine"
fi
rm -rf "$STAGE"

echo
echo "Built $APP"
du -sh "$APP" | awk '{print "Size " $1}'
echo "Install it here with:  cp -R \"$APP\" /Applications/"
[ -f "$DMG" ] && echo "Ship this to another Mac:  $DMG"
exit 0
