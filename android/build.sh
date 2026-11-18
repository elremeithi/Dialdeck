#!/usr/bin/env bash
# Builds the DialDeck Android app (APK) without Gradle or Android Studio.
#
#   android/build.sh                 -> dist/dialdeck-android-<version>.apk
#
# Needs: Java 17+ (javac, keytool), node, curl, unzip, zip.
# The Android SDK pieces (platform android.jar + build-tools) are downloaded once into
# android/.sdk and verified by SHA-1 (override with ANDROID_JAR=... BUILD_TOOLS=...).
#
# Signing: uses KEYSTORE / KEYSTORE_PASS_FILE / KEY_ALIAS if set; otherwise creates
# android/dialdeck-release.keystore (+ .pass) on first build. KEEP THAT FILE: Android only
# installs an update if it is signed with the same key. Both are git-ignored.
set -euo pipefail
# run a tool, hide the JVM's proxy banner, fail the build if the tool fails
run() { local o; if ! o=$("$@" 2>&1); then echo "$o" | grep -v '^Picked up' >&2; echo "FAILED: $1" >&2; exit 1; fi; echo "$o" | grep -v '^Picked up\|^Note:' || true; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
A="$ROOT/android"
OUT="$A/build"
SDK="$A/.sdk"

# ---------- SDK ----------
fetch() { # url sha1 dest
  local f="$SDK/$(basename "$1")"
  [ -f "$f" ] || curl -fsSL "$1" -o "$f"
  echo "$2  $f" | sha1sum -c --quiet - || { rm -f "$f"; echo "checksum mismatch: $1" >&2; exit 1; }
  unzip -qo "$f" -d "$SDK"
}
if [ -z "${ANDROID_JAR:-}" ] || [ -z "${BUILD_TOOLS:-}" ]; then
  mkdir -p "$SDK"
  [ -f "$SDK/android-35/android.jar" ] || fetch https://dl.google.com/android/repository/platform-35_r02.zip 0bb560a90a7a2cbd0dd8348224d518b638fe7949
  [ -x "$SDK/android-15/aapt2" ] || fetch https://dl.google.com/android/repository/build-tools_r35_linux.zip 2cfaa0bbb2336e9ec18ed3ecea84fa2e2af607bc
  ANDROID_JAR=${ANDROID_JAR:-$SDK/android-35/android.jar}
  BUILD_TOOLS=${BUILD_TOOLS:-$SDK/android-15}
fi

VERSION=$(node -p "require('$ROOT/extension/manifest.base.json').version")
IFS=. read -r MA MI PA <<<"$VERSION"
VCODE=$((MA * 10000 + MI * 100 + PA))
APK="$ROOT/dist/dialdeck-android-$VERSION.apk"
echo "DialDeck Android $VERSION (versionCode $VCODE)"

rm -rf "$OUT"
mkdir -p "$OUT/assets/www" "$OUT/classes" "$OUT/dex" "$ROOT/dist"

# ---------- web assets: the extension UI + Android shim ----------
cp -r "$ROOT/extension/lib" "$ROOT/extension/ui" "$ROOT/extension/icons" "$ROOT/extension/background.js" "$ROOT/extension/newtab.html" "$OUT/assets/www/"
cp "$A/www/"* "$OUT/assets/www/"
node -e '
  const fs = require("fs"); const p = process.argv[1];
  let h = fs.readFileSync(p, "utf8");
  const tag = "<script type=\"module\" src=\"ui/newtab.js\"></script>";
  if (!h.includes(tag)) throw new Error("newtab.html layout changed");
  h = h.replace("<link rel=\"stylesheet\" href=\"ui/newtab.css\">", "<link rel=\"stylesheet\" href=\"ui/newtab.css\">\n<link rel=\"stylesheet\" href=\"android.css\">\n<meta name=\"theme-color\" content=\"#000000\">");
  h = h.replace(tag, "<script src=\"android-shim.js\"></script>\n<script type=\"module\" src=\"background.js\"></script>\n" + tag);
  h = h.replace("<title>New Tab</title>", "<title>DialDeck</title>");
  fs.writeFileSync(p, h);
' "$OUT/assets/www/newtab.html"

# ---------- resources + manifest ----------
"$BUILD_TOOLS/aapt2" compile --dir "$A/res" -o "$OUT/res.zip"
"$BUILD_TOOLS/aapt2" link -I "$ANDROID_JAR" --manifest "$A/AndroidManifest.xml" -A "$OUT/assets" \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$VCODE" --version-name "$VERSION" \
  -o "$OUT/base.apk" "$OUT/res.zip"

# ---------- code ----------
run javac -nowarn --release 11 -cp "$ANDROID_JAR" -d "$OUT/classes" $(find "$A/src" -name '*.java')
run "$BUILD_TOOLS/d8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q "$OUT/unsigned.apk" classes.dex)
"$BUILD_TOOLS/zipalign" -P 16 -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# ---------- signing ----------
KEYSTORE=${KEYSTORE:-$A/dialdeck-release.keystore}
KEYSTORE_PASS_FILE=${KEYSTORE_PASS_FILE:-$KEYSTORE.pass}
KEY_ALIAS=${KEY_ALIAS:-dialdeck}
if [ ! -f "$KEYSTORE" ]; then
  echo "Creating signing key $KEYSTORE (keep it, and its .pass file, to install future updates)"
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$KEYSTORE_PASS_FILE"
  chmod 600 "$KEYSTORE_PASS_FILE"
  run keytool -genkeypair -keystore "$KEYSTORE" -storepass:file "$KEYSTORE_PASS_FILE" -keypass:file "$KEYSTORE_PASS_FILE" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=DialDeck"
  chmod 600 "$KEYSTORE"
fi
run "$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE_PASS_FILE" \
  --ks-key-alias "$KEY_ALIAS" --out "$APK" "$OUT/aligned.apk"
run "$BUILD_TOOLS/apksigner" verify "$APK"
rm -f "$APK.idsig"
echo "Built $APK ($(du -h "$APK" | cut -f1))"
