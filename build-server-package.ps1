param(
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Invoke-FileOperationWithRetry {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Description,
        [int]$Attempts = 12
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return & $Action
        } catch {
            if (-not ($_.Exception -is [IO.IOException]) -and -not ($_.Exception -is [UnauthorizedAccessException])) { throw }
            $lastError = $_.Exception
            if ($attempt -ge $Attempts) { break }
            Start-Sleep -Milliseconds ([Math]::Min(1000, 150 * $attempt))
        }
    }

    throw [IO.IOException]::new("$Description failed after $Attempts attempts: $($lastError.Message)", $lastError)
}

$package = Get-Content -Raw -Encoding UTF8 -LiteralPath 'package.json' | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'package.json does not contain a version.' }

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot '.build\server-deployment'
}
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$workspaceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$workspacePrefix = $workspaceRoot + [IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Server package output directory must stay inside the workspace.'
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$clientArtifact = Join-Path $PSScriptRoot 'dist\SyncWatch-Experience-Client-Portable-v2.2.0-x64.exe'
if (-not (Test-Path -LiteralPath $clientArtifact -PathType Leaf)) {
    throw 'Missing separate Windows client artifact in root dist/. Build the Experience client first.'
}
$androidArtifact = Join-Path $PSScriptRoot 'dist\SyncWatch-Android-v2.2.0-universal.apk'

$deploymentGuidePath = 'docs\server-deployment-guide.md'
$architectureGuidePath = 'docs\architecture.md'
$macosGuidePath = 'docs\macos-build.md'
$standaloneReadmePath = 'docs\standalone-server.md'

$requiredFiles = @(
    'package.json', 'package-lock.json', 'server-standalone.js', 'server\standalone-tunnel.js', 'server\cloudflared-installer.js', 'vendor\cloudflared.exe',
    'start-server.ps1', 'start-server.cmd', 'start-server.sh',
    'Dockerfile', 'docker-compose.yml', '.dockerignore', 'mac-distribution.example.json',
    'scripts\collect-macos-distribution.ps1',
    $standaloneReadmePath, $deploymentGuidePath, $architectureGuidePath, $macosGuidePath,
    'server\index.js', 'server\ai-relay.js', 'server\macos-distribution.js', 'public\index.html', 'public\js\app.js', 'public\css\style.css',
    'dist\SyncWatch-Android-v2.2.0-universal.apk',
    'tests\standalone-package-smoke.js',
    'node_modules\compression\package.json', 'node_modules\express\package.json', 'node_modules\multer\package.json',
    'node_modules\nodemailer\package.json', 'node_modules\socket.io\package.json',
    'node_modules\qrcode\package.json', 'node_modules\ffmpeg-static\package.json',
    'node_modules\ffprobe-static\package.json'
)
foreach ($relative in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relative))) { throw "Missing deployment file: $relative" }
}

# Windows PowerShell 5.1 decodes BOM-less scripts with the active ANSI code
# page. Parse the shipped launcher through the same engine before publishing.
$launcherTokens = $null
$launcherErrors = $null
[Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'start-server.ps1'),
    [ref]$launcherTokens,
    [ref]$launcherErrors
) | Out-Null
if ($launcherErrors.Count -gt 0) {
    throw ('start-server.ps1 is not valid in Windows PowerShell 5.1: ' + (($launcherErrors | ForEach-Object { $_.Message }) -join '; '))
}

$command = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
if (-not $command) { throw 'Node.js is required to build the deployment package.' }
$node = $command.Source
$nodeDirectory = Split-Path -Parent $node
$npm = Join-Path $nodeDirectory 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npmCommand) { throw 'npm is required to stage the standalone production dependencies.' }
    $npm = $npmCommand.Source
}
$pnpm = $null
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) {
    $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $pnpmCommand) { $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue }
    if ($pnpmCommand) { $pnpm = $pnpmCommand.Source }
}
& $node --check 'server\index.js'
if ($LASTEXITCODE -ne 0) { throw 'server/index.js syntax validation failed.' }
& $node --check 'server-standalone.js'
if ($LASTEXITCODE -ne 0) { throw 'server-standalone.js syntax validation failed.' }

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = [IO.Path]::GetFullPath((Join-Path $tempBase ('syncwatch-server-package-' + [Guid]::NewGuid().ToString('N'))))
$prefix = $tempBase.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $work.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary directory validation failed.' }

$folderName = "SyncWatch同步观影-Server-v$version"
$stage = Join-Path $work $folderName
$zipTemp = Join-Path $work "$folderName.zip"
$destination = Join-Path $outputRoot "$folderName.zip"
$publishToken = [Guid]::NewGuid().ToString('N')
$publishTemp = Join-Path $PSScriptRoot ".$folderName.$publishToken.publishing"
$backup = Join-Path $PSScriptRoot ".$folderName.$publishToken.previous"
$originalProcessPath = $env:Path

try {
    # npm package lifecycle scripts invoke `node` by name even when npm.cmd was
    # launched through an absolute path. Keep the selected runtime discoverable
    # for this build only, then restore the caller's environment in finally.
    $env:Path = $nodeDirectory + [IO.Path]::PathSeparator + $originalProcessPath
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($name in @('package.json','package-lock.json','server-standalone.js','start-server.ps1','start-server.cmd','start-server.sh','Dockerfile','docker-compose.yml','.dockerignore','mac-distribution.example.json')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stage $name)
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $standaloneReadmePath) -Destination (Join-Path $stage 'README.md')
    $stagedDocs = Join-Path $stage 'docs'
    New-Item -ItemType Directory -Path $stagedDocs -Force | Out-Null
    foreach ($guidePath in @($deploymentGuidePath, $architectureGuidePath, $macosGuidePath)) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $guidePath) -Destination (Join-Path $stagedDocs (Split-Path -Leaf $guidePath))
    }
    # Keep the constrained macOS artifact collector in the deployment archive.
    # Operators may use it on a build host to stage DMG/ZIP releases without
    # copying unrelated binaries or signing material into the server package.
    $stagedScripts = Join-Path $stage 'scripts'
    New-Item -ItemType Directory -Path $stagedScripts -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'scripts\collect-macos-distribution.ps1') -Destination (Join-Path $stagedScripts 'collect-macos-distribution.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'server') -Destination (Join-Path $stage 'server') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stage 'vendor') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vendor\cloudflared.exe') -Destination (Join-Path $stage 'vendor\cloudflared.exe') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'public') -Destination (Join-Path $stage 'public') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stage 'mobile') -Force | Out-Null
    Copy-Item -LiteralPath $androidArtifact -Destination (Join-Path $stage 'mobile\SyncWatch同步观影-v2.2.0.apk')
    Copy-Item -LiteralPath $clientArtifact -Destination (Join-Path $stage 'SyncWatch同步观影-Client-v2.2.0.exe')
    $macDirectory = Join-Path $stage 'mac'
    & (Join-Path $PSScriptRoot 'scripts\collect-macos-distribution.ps1') -SourceRoot $PSScriptRoot -Destination $macDirectory -Version $version

    # Ship the locked production tree so a cloud server can start without a
    # network install. Dev dependencies, build tools, tests, and source caches
    # never enter the deployment archive.
    Write-Host 'Staging locked production dependencies...' -ForegroundColor Cyan
    if ($pnpm) {
        $deploy = Join-Path $work 'production-deploy'
        & $pnpm --filter ([string]$package.name) deploy --prod --legacy $deploy
        if ($LASTEXITCODE -ne 0) { throw 'pnpm production dependency deployment failed.' }
        if (-not (Test-Path -LiteralPath (Join-Path $deploy 'node_modules') -PathType Container)) {
            throw 'pnpm deploy completed without node_modules.'
        }
        Copy-Item -LiteralPath (Join-Path $deploy 'node_modules') -Destination (Join-Path $stage 'node_modules') -Recurse
    } else {
        # Production package tarballs are already cached by the locked source
        # install. Disable lifecycle scripts so ffmpeg-static/ffprobe-static do
        # not attempt a second GitHub download while building an offline ZIP.
        & $npm ci --omit=dev --ignore-scripts --offline --no-audit --no-fund --prefix $stage
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency staging failed.' }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node_modules\ffmpeg-static\ffmpeg.exe') -Destination (Join-Path $stage 'node_modules\ffmpeg-static\ffmpeg.exe') -Force
        $stagedFfprobeBin = Join-Path $stage 'node_modules\ffprobe-static\bin'
        if (Test-Path -LiteralPath $stagedFfprobeBin) { Remove-Item -LiteralPath $stagedFfprobeBin -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node_modules\ffprobe-static\bin') -Destination (Join-Path $stage 'node_modules\ffprobe-static') -Recurse -Force
    }
    foreach ($dependency in @('compression', 'express', 'multer', 'nodemailer', 'socket.io', 'qrcode', 'ffmpeg-static', 'ffprobe-static')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stage "node_modules\$dependency\package.json"))) {
            throw "Staged production dependency is missing: $dependency"
        }
    }
    foreach ($binary in @(
        (Join-Path $stage 'node_modules\ffmpeg-static\ffmpeg.exe'),
        (Join-Path $stage 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe')
    )) {
        if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Staged media binary is missing: $binary" }
    }
    $dependencyTestResidue = Join-Path $stage 'node_modules\ffprobe-static\tests'
    if (Test-Path -LiteralPath $dependencyTestResidue) {
        Remove-Item -LiteralPath $dependencyTestResidue -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'SyncWatch同步观影-Data') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $stage 'SyncWatch同步观影-Data\README.txt') -Encoding UTF8 -Value @(
        'This directory stores all SyncWatch同步观影 server data. Stop the server and move or back up the whole directory.',
        'Do not copy config.json alone. QQ SMTP credentials also require .secrets/mail.key.'
    )

    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipTemp, [IO.Compression.CompressionLevel]::Optimal, $true)
    $archive = [IO.Compression.ZipFile]::OpenRead($zipTemp)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
        foreach ($required in @(
            "$folderName/server/index.js", "$folderName/server/ai-relay.js", "$folderName/server/macos-distribution.js", "$folderName/server/standalone-tunnel.js", "$folderName/public/index.html",
            "$folderName/vendor/cloudflared.exe",
            "$folderName/scripts/collect-macos-distribution.ps1",
            "$folderName/mobile/SyncWatch同步观影-v2.2.0.apk", "$folderName/SyncWatch同步观影-Client-v2.2.0.exe", "$folderName/server-standalone.js",
            "$folderName/README.md", "$folderName/docs/server-deployment-guide.md", "$folderName/docs/architecture.md", "$folderName/docs/macos-build.md", "$folderName/mac-distribution.example.json",
            "$folderName/node_modules/compression/package.json", "$folderName/node_modules/express/package.json", "$folderName/node_modules/nodemailer/package.json",
            "$folderName/node_modules/ffmpeg-static/package.json", "$folderName/node_modules/ffprobe-static/package.json",
            "$folderName/SyncWatch同步观影-Data/README.txt"
        )) {
            if ($entries -notcontains $required) { throw "Package validation failed; missing: $required" }
        }
        foreach ($entry in $entries) {
            $relativeEntry = $entry.Substring($folderName.Length + 1)
            $segments = $relativeEntry.ToLowerInvariant().Split('/')
            if ($segments[0] -in @('tests', 'dist', 'mobile/.keys', 'mobile/app/build', 'mobile/.gradle')) {
                throw "Package contains unrelated or sensitive file: $entry"
            }
            if ($relativeEntry -match '(^|/)mobile/\.keys(/|$)|(^|/)mobile/app/build(/|$)|(^|/)mobile/\.gradle(/|$)|(^|/)\.cxx(/|$)|\.jks$') {
                throw "Package contains unrelated or sensitive file: $entry"
            }
            if ($relativeEntry -match '(^|/)node_modules/ffprobe-static/tests(/|$)') {
                throw "Package contains dependency test residue: $entry"
            }
            if ($entry.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and
                $entry -ne "$folderName/SyncWatch同步观影-Client-v2.2.0.exe" -and
                $entry -ne "$folderName/vendor/cloudflared.exe" -and
                $entry -notmatch '/node_modules/(?:ffmpeg-static/ffmpeg\.exe|ffprobe-static/bin/win32/(?:ia32|x64)/ffprobe\.exe)$') {
                throw "Package contains an unexpected executable: $entry"
            }
            if (($entry.EndsWith('.dmg', [StringComparison]::OrdinalIgnoreCase) -or $entry.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) -and
                $entry -notmatch ('/mac/SyncWatch同步观影-.+-v' + [Regex]::Escape($version) + '-(?:x64|arm64)\.(?:dmg|zip)$')) {
                throw "Package contains an unexpected macOS artifact: $entry"
            }
        }
        $devNames = @($package.devDependencies.PSObject.Properties | ForEach-Object { [string]$_.Name })
        foreach ($devName in $devNames) {
            $devEntry = "$folderName/node_modules/$devName/package.json"
            if ($entries -contains $devEntry -and $devName -eq 'electron') {
                throw "Package unexpectedly contains the Electron development runtime: $devName"
            }
        }
    } finally { $archive.Dispose() }

    # Exercise the exact candidate archive before it can replace the previous
    # release. The smoke test starts it, moves the complete folder, starts it
    # again, and verifies that portable data and host identity survive.
    $runtimeVerifyRoot = Join-Path $work 'runtime-verify'
    Expand-Archive -LiteralPath $zipTemp -DestinationPath $runtimeVerifyRoot
    $runtimeRoots = @(Get-ChildItem -LiteralPath $runtimeVerifyRoot -Directory)
    if ($runtimeRoots.Count -ne 1) {
        throw "Runtime package validation expected one archive root, found $($runtimeRoots.Count)."
    }
    & $node (Join-Path $PSScriptRoot 'tests\standalone-package-smoke.js') $runtimeRoots[0].FullName
    if ($LASTEXITCODE -ne 0) { throw 'Standalone server runtime smoke test failed.' }

    # File.Replace is only atomic when source, destination, and backup are on the
    # same volume. The build workspace lives under the system temp directory,
    # which can be on a different drive from the release folder, so first copy
    # the validated archive beside the destination. Never delete the old package
    # up front: a persistent lock must fail with the existing artifact intact.
    [IO.File]::Copy($zipTemp, $publishTemp, $false)
    if ((Get-Item -LiteralPath $publishTemp).Length -ne (Get-Item -LiteralPath $zipTemp).Length) {
        throw 'Publishing copy length validation failed.'
    }
    $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $publishTemp).Hash
    $published = $false
    $verified = $false
    try {
        Invoke-FileOperationWithRetry -Description 'Publishing the standalone server package' -Action {
            if ([IO.File]::Exists($destination)) {
                [IO.File]::Replace($publishTemp, $destination, $backup, $true)
            } else {
                [IO.File]::Move($publishTemp, $destination)
            }
        }
        $published = $true
        $hash = Invoke-FileOperationWithRetry -Description 'Reading the published package for verification' -Action {
            (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
        }
        if ($hash -ne $expectedHash) { throw 'Published package hash validation failed.' }
        $verified = $true
    } catch {
        if ($published -and [IO.File]::Exists($backup)) {
            Invoke-FileOperationWithRetry -Description 'Restoring the previous standalone server package' -Action {
                if ([IO.File]::Exists($destination)) {
                    [IO.File]::Replace($backup, $destination, $null, $true)
                } else {
                    [IO.File]::Move($backup, $destination)
                }
            }
            $published = $false
        }
        throw
    } finally {
        if ([IO.File]::Exists($publishTemp)) {
            try { Remove-Item -LiteralPath $publishTemp -Force -ErrorAction Stop }
            catch { Write-Warning "Could not remove temporary publish file: $publishTemp ($($_.Exception.Message))" }
        }
        if ($verified -and [IO.File]::Exists($backup)) {
            try {
                Invoke-FileOperationWithRetry -Description 'Removing the verified package backup' -Action {
                    Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
                }
            } catch {
                Write-Warning "The new package is verified, but the temporary previous-package backup could not be removed: $backup ($($_.Exception.Message))"
            }
        }
    }
    Write-Host "Standalone server package: $destination" -ForegroundColor Green
    Write-Host "SHA256: $hash" -ForegroundColor Green
} finally {
    $env:Path = $originalProcessPath
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}

