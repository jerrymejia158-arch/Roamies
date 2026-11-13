#!/bin/bash
# Copies the phone page and the shared creature files into dist/ for the Android app.
# ./build.sh          the files only (then: cd src-tauri && cargo tauri android dev | build)
# ./build.sh apk      also builds a debug APK you can install on a phone
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist/onboarding/fonts
cp ../phone.html dist/index.html
cp -R ../roamies dist/
cp ../onboarding/fonts/martian-mono.woff2 ../onboarding/fonts/doto.woff2 dist/onboarding/fonts/
if [ "${1:-}" = "apk" ]; then cd src-tauri && cargo tauri android build --debug --apk; fi
