#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
dist_root="$repo_root/dist"
stage="$dist_root/orion-extension"
manifest_source="$repo_root/orion/manifest.json"

if [ ! -f "$repo_root/content.js" ]; then
  echo "未找到扩展源码：$repo_root" >&2
  exit 1
fi

version="$(node -p "require('$manifest_source').version")"
zip_path="$dist_root/ielts-soundalike-helper-orion-v$version.zip"

mkdir -p "$dist_root"
rm -rf "$stage"
mkdir -p "$stage"

for directory in audio data lib; do
  cp -R "$repo_root/$directory" "$stage/"
done

files=(
  background.js
  comparison.css comparison.html comparison.js
  content.js study-session.js page-capture.js safari-page-loader.js
  plural.css
  popup.css popup-extra.css popup.html popup.js
  sound-favorites.css sound-favorites.html sound-favorites.js
  speaking.css speaking-extra.css speaking.html speaking.js
  THIRD_PARTY_NOTICES.md
)
for file in "${files[@]}"; do
  cp "$repo_root/$file" "$stage/"
done
cp "$manifest_source" "$stage/manifest.json"

rm -f "$zip_path"
(cd "$stage" && zip -qr -X "$zip_path" .)

echo "Orion extension resources: $stage"
echo "Orion package: $zip_path"
