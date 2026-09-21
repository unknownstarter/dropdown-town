#!/bin/zsh
# 클로드 타운 맥 앱을 만든다. 결과물: ./클로드 타운.app
# server.mjs 나 index.html 을 고친 뒤에는 이 스크립트를 다시 돌려야 앱에 반영된다.
set -euo pipefail
cd "$(dirname "$0")"

APP="클로드 타운.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O app/main.swift -o "$APP/Contents/MacOS/ClaudeTown" -framework Cocoa -framework WebKit

# 아이콘
swiftc app/icon.swift -o "$WORK/icon" -framework Cocoa
"$WORK/icon" "$WORK/icon.png"
mkdir "$WORK/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cp server.mjs index.html "$APP/Contents/Resources/"
cp -R assets "$APP/Contents/Resources/"
# Finder 로 연 앱은 셸 PATH 를 못 받으므로, 지금 쓰는 node 의 절대 경로를 적어 둔다.
command -v node > "$APP/Contents/Resources/node-path.txt"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>클로드 타운</string>
  <key>CFBundleDisplayName</key><string>클로드 타운</string>
  <key>CFBundleIdentifier</key><string>local.claude-town</string>
  <key>CFBundleExecutable</key><string>ClaudeTown</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

codesign --force --deep -s - "$APP" >/dev/null 2>&1
echo "완성: $PWD/$APP"
