#!/usr/bin/env bash
# Compiles the APK's MiniHttp client for the JVM and tests it against local servers.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
node "$ROOT/tools/dev-webdav.mjs" 8781 "$T/dav" >/dev/null & P1=$!
node "$ROOT/test/android/misc-server.mjs" 8782 & P2=$!
trap 'kill $P1 $P2 2>/dev/null; rm -rf "$T"' EXIT
sleep 1
javac -d "$T/cls" "$ROOT/android/src/net/dialdeck/app/MiniHttp.java" "$ROOT/test/android/MiniHttpTest.java"
# /continue lives on the raw-socket port (8783)
java -cp "$T/cls" MiniHttpTest "http://localhost:8781/remote.php/dav/files/test/" "http://localhost:8782" 2>&1 | sed 's#http://localhost:8782/continue#x#'
