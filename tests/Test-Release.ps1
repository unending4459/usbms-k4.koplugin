#Requires -Version 7
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$build = Join-Path $repo 'tools/Build-Release.ps1'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('usbms-release-test-' + [guid]::NewGuid().ToString('N'))
$releaseDir = Join-Path $tmp 'release'
function Expect-Failure([scriptblock]$Action, [string]$Label) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    if (-not $failed) { throw "Expected rejection: $Label" }
    Write-Output "PASS rejected $Label"
}
try {
    New-Item -ItemType Directory -Path $tmp | Out-Null
    & $build -OutputDir $releaseDir
    $zip = @(Get-ChildItem -LiteralPath $releaseDir -Filter *.zip)
    if ($zip.Count -ne 1) { throw 'Expected exactly one release ZIP' }
    $checksum = [IO.File]::ReadAllText($zip[0].FullName + '.sha256').Split(' ')[0]
    if ($checksum -cne (Get-FileHash -LiteralPath $zip[0].FullName).Hash.ToLowerInvariant()) { throw 'Invalid ZIP checksum' }
    $manifest = Get-Content -LiteralPath ($zip[0].FullName + '.manifest.json') -Raw | ConvertFrom-Json
    # Fixed files: main.lua, _meta.lua, usbms_l10n.lua, two helpers, busybox and LICENSE.
    $localeCount = @(Get-ChildItem -LiteralPath (Join-Path $repo 'usbms.koplugin/l10n') -Filter *.lua -File).Count
    if ($manifest.files.Count -ne 7 + $localeCount -or $manifest.locales -ne $localeCount) { throw 'Unexpected release manifest' }
    Expect-Failure { & $build -OutputDir $releaseDir } 'existing release ZIP'
    Write-Output 'PASS release package and checksum'
} finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}