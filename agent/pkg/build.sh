#!/bin/bash
# Builds BCC-Agent-<version>.pkg.
#
# The important property of this script is that it produces a working installer
# on a machine with no Apple certificates at all. Signing and notarization are
# both strictly optional upgrades that switch themselves on when the material
# for them exists, and switch themselves off silently when it does not. Nothing
# here ever blocks on Apple.
#
# Unsigned means the person installing has to approve it once in System Settings
# under Privacy & Security. That is a single click, and conclusion.html says so.
#
#   ./build.sh                  build, ad-hoc signed, unsigned installer
#   ./build.sh --rebuild-tap    recompile bcc-audiotap universal first
#   BCC_VERSION=1.1 ./build.sh  override the version
#   BCC_NOTARY_PROFILE=x ./build.sh   also notarize, needs a real Developer ID
#
# Requires nothing but the Command Line Tools.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT="$(cd "$HERE/.." && pwd)"
VERSION="${BCC_VERSION:-1.0.0}"
IDENT="com.bostonglobe.bcc"
BUILD="$HERE/build"
ROOT="$BUILD/root"
BCC="$ROOT/Library/Application Support/BCC/bin"
LA="$ROOT/Library/LaunchAgents"
REBUILD_TAP=0
[ "${1:-}" = "--rebuild-tap" ] && REBUILD_TAP=1

B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
G=$(printf '\033[32m'); Y=$(printf '\033[33m')
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$R"; }
ok()   { printf '    %sok%s   %s\n' "$G" "$R" "$*"; }
warn() { printf '    %swarn%s %s\n' "$Y" "$R" "$*"; }
die()  { printf '\n    error: %s\n\n' "$*" >&2; exit 1; }

step "Clean"
rm -rf "$BUILD"
mkdir -p "$BCC" "$LA"
ok "$BUILD"

# --------------------------------------------------------------- the audio tap

step "Audio tap"
TAP="$AGENT/audiotap/bcc-audiotap"
SRC="$AGENT/audiotap/bcc-audiotap.swift"
PLIST_TAP="$AGENT/audiotap/Info.plist"

if [ "$REBUILD_TAP" = "1" ] || [ ! -f "$TAP" ]; then
  [ -f "$SRC" ] || die "no bcc-audiotap and no source to build it from"
  command -v swiftc >/dev/null 2>&1 || die "swiftc not found, install the Command Line Tools"
  TMP="$BUILD/tap"; mkdir -p "$TMP"
  SLICES=()
  for arch in arm64 x86_64; do
    if swiftc -O -target "$arch-apple-macos14.4" \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST_TAP" \
        -o "$TMP/tap-$arch" "$SRC" 2>"$TMP/$arch.log"; then
      SLICES+=("$TMP/tap-$arch"); ok "compiled $arch"
    else
      warn "$arch slice failed, see $TMP/$arch.log"
    fi
  done
  [ "${#SLICES[@]}" -gt 0 ] || die "no architecture compiled, see $TMP/*.log"
  if [ "${#SLICES[@]}" -gt 1 ]; then
    lipo -create "${SLICES[@]}" -output "$TAP"; ok "lipo universal"
  else
    cp "${SLICES[0]}" "$TAP"
  fi
fi

ARCHS=$(lipo -archs "$TAP" 2>/dev/null || echo unknown)
ok "architectures: $ARCHS"
case "$ARCHS" in
  *x86_64*) : ;;
  *) warn "arm64 only. An Intel Mac in the fleet will not be able to tap browser audio."
     warn "Rebuild with ./build.sh --rebuild-tap to get a universal binary." ;;
esac

# The Info.plist has to be inside the binary, not beside it. A bare Mach-O with
# no bundle around it has nowhere else to keep NSAudioCaptureUsageDescription,
# and without that string TCC denies the tap with no prompt and no error.
otool -s __TEXT __info_plist "$TAP" >/dev/null 2>&1 \
  && [ -n "$(otool -s __TEXT __info_plist "$TAP" 2>/dev/null | sed -n '3p')" ] \
  || die "bcc-audiotap has no embedded Info.plist, rebuild with --rebuild-tap"
ok "embedded Info.plist present"

# ------------------------------------------------------------------- signing id

step "Signing identity"
APP_ID=$(security find-identity -v -p codesigning 2>/dev/null \
         | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)".*/\1/' || true)
INST_ID=$(security find-identity -v 2>/dev/null \
         | grep "Developer ID Installer" | head -1 | sed -E 's/.*"(.*)".*/\1/' || true)

if [ -n "$APP_ID" ]; then
  ok "Developer ID Application: $APP_ID"
else
  warn "no Developer ID Application certificate, signing bcc-audiotap ad-hoc"
  warn "ad-hoc means the code hash changes on every build, so macOS re-asks for"
  warn "audio permission after each update. Cosmetic, not a blocker."
fi

# --------------------------------------------------------------------- payload

step "Stage payload"
install -m 755 "$HERE/payload/bin/bcc-doctor"    "$BCC/bcc-doctor"
install -m 755 "$HERE/payload/bin/bcc-run"       "$BCC/bcc-run"
install -m 755 "$HERE/payload/bin/bcc-setup"     "$BCC/bcc-setup"
install -m 755 "$HERE/payload/bin/bcc-uninstall" "$BCC/bcc-uninstall"
install -m 644 "$AGENT/supervisor/bcc-agent.js"  "$BCC/bcc-agent.js"
install -m 644 "$AGENT/supervisor/stt.py"        "$BCC/stt.py"
install -m 644 "$AGENT/supervisor/config.example.json" "$BCC/config.example.json"
install -m 755 "$TAP"                            "$BCC/bcc-audiotap"
install -m 644 "$HERE/com.bostonglobe.bcc-agent.plist" "$LA/com.bostonglobe.bcc-agent.plist"
ok "$(find "$ROOT" -type f | wc -l | tr -d ' ') files staged"

# Quarantine is the one extended attribute that must not ride along. Anything
# downloaded or unzipped on this Mac carries com.apple.quarantine, pkgbuild
# encodes it into the payload, and the installed binary arrives on the target
# machine already quarantined. On an unsigned build that turns one Gatekeeper
# approval into one per file.
#
# com.apple.provenance cannot be removed, it is applied by the kernel and
# reapplied on write, so every payload ends up with AppleDouble ._sidecars
# carrying it. That is normal: installer decodes them back into attributes at
# install time and leaves no ._files on disk. Not worth fighting.
xattr -cr "$ROOT" 2>/dev/null || true
QUAR=$(find "$ROOT" -type f -exec sh -c 'xattr "$1" 2>/dev/null | grep -q quarantine && echo "$1"' _ {} \;)
[ -z "$QUAR" ] || die "quarantine attribute survived on: $QUAR"
ok "no quarantine attributes"

# Sign the tap after staging, so the signature covers the copy that ships.
if [ -n "$APP_ID" ]; then
  codesign --force --options runtime --timestamp --sign "$APP_ID" "$BCC/bcc-audiotap"
  ok "signed with Developer ID"
else
  codesign --force --sign - "$BCC/bcc-audiotap"
  ok "ad-hoc signed"
fi
codesign --verify --verbose=1 "$BCC/bcc-audiotap" 2>&1 | sed 's/^/    /'

# --------------------------------------------------------------------- pkgbuild

step "pkgbuild"
pkgbuild \
  --root "$ROOT" \
  --scripts "$HERE/scripts" \
  --identifier "$IDENT" \
  --version "$VERSION" \
  --install-location / \
  "$BUILD/bcc-payload.pkg" >/dev/null
ok "bcc-payload.pkg"

step "productbuild"
OUT="$BUILD/BCC-Agent-$VERSION.pkg"
productbuild \
  --distribution "$HERE/Distribution.xml" \
  --resources "$HERE/resources" \
  --package-path "$BUILD" \
  "$OUT" >/dev/null
ok "$(basename "$OUT")"

# ------------------------------------------------------------- optional signing

if [ -n "$INST_ID" ]; then
  step "productsign"
  productsign --sign "$INST_ID" "$OUT" "$OUT.signed" >/dev/null
  mv -f "$OUT.signed" "$OUT"
  ok "signed with $INST_ID"

  if [ -n "${BCC_NOTARY_PROFILE:-}" ]; then
    step "notarize"
    xcrun notarytool submit "$OUT" --keychain-profile "$BCC_NOTARY_PROFILE" --wait
    xcrun stapler staple "$OUT"
    ok "notarized and stapled"
  else
    warn "set BCC_NOTARY_PROFILE to also notarize"
  fi
else
  step "productsign"
  warn "no Developer ID Installer certificate, shipping unsigned"
  warn "the installer works. macOS asks the user to approve it once under"
  warn "System Settings, Privacy & Security. conclusion.html explains it."
fi

# ----------------------------------------------------------------- verification

step "Verify"
EXP="$BUILD/expanded"
rm -rf "$EXP"
pkgutil --expand-full "$OUT" "$EXP" >/dev/null
[ -d "$EXP/bcc-payload.pkg/Payload/Library/Application Support/BCC/bin" ] \
  || die "payload did not land at the expected path"
ok "payload path correct"

for f in bcc-run bcc-doctor bcc-setup bcc-uninstall bcc-agent.js stt.py bcc-audiotap; do
  P="$EXP/bcc-payload.pkg/Payload/Library/Application Support/BCC/bin/$f"
  [ -f "$P" ] || die "missing from payload: $f"
done
ok "all 7 payload files present"
[ -f "$EXP/bcc-payload.pkg/Payload/Library/LaunchAgents/com.bostonglobe.bcc-agent.plist" ] \
  || die "LaunchAgent plist missing from payload"
ok "LaunchAgent plist present"

for s in preinstall postinstall; do
  [ -x "$EXP/bcc-payload.pkg/Scripts/$s" ] || die "$s missing or not executable"
done
ok "preinstall and postinstall are executable"

# Modes read out of the receipt rather than trusted from the install commands
# above. bcc-run has to be executable or launchd cannot start it, and a stray
# AppleDouble sidecar means the xattr strip did not happen.
BOM=$(lsbom -p Mf "$EXP/bcc-payload.pkg/Bom" 2>/dev/null)
check_mode() {
  local want="$1" file="$2"
  local got
  # lsbom separates mode from path with a tab, and the path contains a space
  # ("Application Support"), so splitting on whitespace puts half the path in $3
  # and finds nothing. Split on the tab.
  got=$(printf '%s\n' "$BOM" \
        | awk -F'\t' -v f="./Library/Application Support/BCC/bin/$file" \
              '$NF==f {gsub(/[ \t]+$/,"",$1); print $1}')
  [ "$got" = "$want" ] || die "$file has mode $got in the receipt, expected $want"
  ok "$file $got"
}
check_mode -rwxr-xr-x bcc-run
check_mode -rwxr-xr-x bcc-audiotap
check_mode -rw-r--r-- bcc-agent.js

# Every real file should have exactly one BOM entry and nothing extra should
# have appeared. The ._sidecars are expected (see the note in Stage payload), so
# count the real entries instead of asserting they are absent.
NREAL=$(printf '%s\n' "$BOM" | grep -c '/BCC/bin/[^._]')
[ "$NREAL" = "8" ] || die "expected 8 real files in BCC/bin, receipt has $NREAL"
ok "8 real files in the receipt, no strays"

echo ""
# Exits non-zero on an unsigned package, which is the expected state here, so it
# reports rather than decides.
pkgutil --check-signature "$OUT" 2>&1 | head -3 | sed 's/^/    /' || true

SIZE=$(du -h "$OUT" | awk '{print $1}')
printf '\n%sBuilt%s  %s  (%s)\n' "$B" "$R" "$OUT" "$SIZE"
printf '%sInstall with:%s  sudo installer -pkg "%s" -target /\n' "$D" "$R" "$OUT"
printf '%sOr double click it.%s\n\n' "$D" "$R"
