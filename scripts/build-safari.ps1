$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$distRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "dist"))
$stage = [IO.Path]::GetFullPath((Join-Path $distRoot "safari-extension"))
$manifestSource = Join-Path $repoRoot "safari\manifest.json"

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "content.js"))) {
  throw "未找到扩展源码：$repoRoot"
}
if (-not $stage.StartsWith($distRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝清理 dist 目录以外的路径：$stage"
}

$manifest = ConvertFrom-Json ([IO.File]::ReadAllText($manifestSource, [Text.Encoding]::UTF8))
$zipPath = Join-Path $distRoot "ielts-soundalike-helper-safari-v$($manifest.version).zip"

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null

$directories = @("audio", "data", "lib")
foreach ($directory in $directories) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination $stage -Recurse
}

$files = @(
  "background.js",
  "comparison.css", "comparison.html", "comparison.js",
  "content.js", "page-capture.js", "safari-page-loader.js",
  "plural.css",
  "popup.css", "popup-extra.css", "popup.html", "popup.js",
  "sound-favorites.css", "sound-favorites.html", "sound-favorites.js",
  "speaking.css", "speaking-extra.css", "speaking.html", "speaking.js",
  "THIRD_PARTY_NOTICES.md"
)
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $stage
}
Copy-Item -LiteralPath $manifestSource -Destination (Join-Path $stage "manifest.json")

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Safari Web Extension resources: $stage"
Write-Output "Safari package: $zipPath"
