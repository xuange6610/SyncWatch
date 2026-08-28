$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'package.json') | ConvertFrom-Json
if ([string]$manifest.version -ne '2.2.7') { throw 'package.json version must be 2.2.7.' }
$expectedProductName = [string]$manifest.build.productName
if ([string]::IsNullOrWhiteSpace($expectedProductName)) { throw 'package.json build.productName is required.' }

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand) { throw 'Node.js 22 or newer is required.' }
$node = $nodeCommand.Source
$nodeMajor = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }

$distRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.build'))
$offlineRoot = Join-Path $buildRoot 'offline-bundle'
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

function Remove-BuildPath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $workspacePrefix = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the workspace: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

function Assert-Artifact([string]$Name, [long]$MinimumBytes = 1MB) {
    $filename = Join-Path $distRoot $Name
    if (-not (Test-Path -LiteralPath $filename -PathType Leaf)) { throw "Missing build artifact: $Name" }
    $item = Get-Item -LiteralPath $filename
    if ($item.Length -lt $MinimumBytes) { throw "Build artifact is unexpectedly small: $Name" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $filename).Hash
    Write-Host "$Name | $($item.Length) bytes | SHA256 $hash" -ForegroundColor Green
    return $filename
}

function Invoke-Builder([string]$Config = '') {
    $cli = Join-Path $PSScriptRoot 'node_modules\electron-builder\out\cli\cli.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'electron-builder is not installed.' }
    $arguments = @($cli)
    if ($Config) { $arguments += @('--config', $Config) }
    $arguments += @('--win', '--x64', '--publish', 'never')
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed for $Config" }
    Remove-BuildPath (Join-Path $distRoot 'win-unpacked')
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\electron-builder\package.json'))) {
    & npm.cmd ci --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}

$cloudflared = Join-Path $PSScriptRoot 'vendor\cloudflared.exe'
if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf) -or (Get-Item -LiteralPath $cloudflared).Length -lt 1MB) {
    throw 'vendor/cloudflared.exe is missing or invalid.'
}

Write-Host 'Running the complete regression suite...' -ForegroundColor Cyan
& npm.cmd run test:all
if ($LASTEXITCODE -ne 0) { throw 'Regression suite failed.' }

Write-Host 'Building the signed Android APK into dist/...' -ForegroundColor Cyan
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'mobile\build-apk.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Android build failed.' }
$android = Assert-Artifact 'SyncWatch-Android-v2.2.7-universal.apk' 50MB

Write-Host 'Building Windows Standard and Experience packages into dist/...' -ForegroundColor Cyan
Invoke-Builder
$standard = Assert-Artifact 'SyncWatch-Standard-Server-Portable-v2.2.7-x64.exe' 50MB
& $node 'tests\split-desktop-artifact-smoke.js' $standard
if ($LASTEXITCODE -ne 0) { throw 'Standard server artifact smoke test failed.' }
Invoke-Builder 'electron-builder-client.json'
$client = Assert-Artifact 'SyncWatch-Experience-Client-Portable-v2.2.7-x64.exe' 50MB

try {
    Remove-BuildPath $offlineRoot
    foreach ($folder in @('windows', 'android')) {
        New-Item -ItemType Directory -Path (Join-Path $offlineRoot $folder) -Force | Out-Null
    }
    Copy-Item -LiteralPath $client -Destination (Join-Path $offlineRoot 'windows\SyncWatch-Experience-Client-Portable-v2.2.7-x64.exe')
    Copy-Item -LiteralPath $android -Destination (Join-Path $offlineRoot 'android\SyncWatch-Android-v2.2.7-universal.apk')
    & $node 'scripts\verify-full-offline-bundle.js'
    if ($LASTEXITCODE -ne 0) { throw 'Full Offline payload verification failed.' }

    Write-Host 'Building Windows Full Offline packages into dist/...' -ForegroundColor Cyan
    Invoke-Builder 'electron-builder-windows-installer.json'
    Assert-Artifact 'SyncWatch-v2.2.7-Full-Offline-Installer-x64.exe' 300MB | Out-Null
    Invoke-Builder 'electron-builder-windows-full-portable.json'
    Assert-Artifact 'SyncWatch-v2.2.7-Full-Offline-Portable-x64.exe' 300MB | Out-Null
} finally {
    Remove-BuildPath $offlineRoot
}

Get-ChildItem -LiteralPath $distRoot -File | Sort-Object Name | ForEach-Object {
    Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
}
Write-Host 'Windows and Android v2.2.7 build assets are ready in root dist/.' -ForegroundColor Green
