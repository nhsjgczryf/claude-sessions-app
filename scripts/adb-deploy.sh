#!/usr/bin/env bash
#
# Fast install/test loop for a USB-connected Android device. Run this
# on the machine the phone is plugged into (where `adb` can see it) —
# NOT in CI. It skips the manual "download from Releases → tap the
# file → confirm install" dance:
#
#   scripts/adb-deploy.sh                 # download rolling 'latest' + install
#   scripts/adb-deploy.sh path/to.apk     # install a local APK (e.g. your own build)
#
# Because the app is signed with the committed fixed keystore, this
# reinstalls IN PLACE (-r) and your saved sessions/settings survive.
#
# After installing it launches the app, grabs a screenshot, and prints
# the logcat command. Note: the Chinese-IME composition bug cannot be
# reproduced via `adb shell input text` (that bypasses the IME), so the
# actual type-test still needs a human typing with a real keyboard —
# but everything around it (build/install/launch/screenshot/logs) is
# automated here.
set -euo pipefail

PKG="app.claudesessions.android"
APK="${1:-}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found. Install Android platform-tools and connect the phone (USB debugging on)." >&2
  exit 1
fi

if ! adb get-state >/dev/null 2>&1; then
  echo "No device. Plug in the phone, enable USB debugging, accept the RSA prompt, then re-run." >&2
  adb devices
  exit 1
fi

if [[ -z "$APK" ]]; then
  URL="${APK_URL:-https://github.com/nhsjgczryf/claude-sessions-app/releases/download/latest/claude-sessions-latest.apk}"
  APK="/tmp/claude-sessions-latest.apk"
  echo "==> Downloading $URL"
  curl -fL --retry 3 -o "$APK" "$URL"
fi

echo "==> Installing $APK (in place, keeping data)"
# -r reinstall keeping data, -d allow version downgrade (CI versionCode
# is time-based and can go backwards between branches).
if ! adb install -r -d "$APK"; then
  echo "!! In-place reinstall failed (usually a signing-key mismatch from an OLD build)."
  echo "!! Uninstalling once, then fresh install (this loses saved sessions ONE time):"
  read -r -p "   Proceed with uninstall? [y/N] " ans
  [[ "$ans" == y || "$ans" == Y ]] || { echo "aborted."; exit 1; }
  adb uninstall "$PKG" || true
  adb install -d "$APK"
fi

echo "==> Launching"
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
sleep 2

SHOT="/tmp/claude-sessions-screen.png"
if adb exec-out screencap -p > "$SHOT" 2>/dev/null && [[ -s "$SHOT" ]]; then
  echo "==> Screenshot: $SHOT"
fi

echo
echo "Tail logs with:  adb logcat -s ClaudeIME ClaudeFGS"
echo "Now type Chinese into the compose box on the phone to test the IME path."
