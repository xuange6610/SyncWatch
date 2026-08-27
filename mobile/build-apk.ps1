$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$NodeMobileVersion = '18.20.4'
$NodeMobileSourceRevision = 'ff4e063f1f1911047c067335ad0a3d81336236ca'
$NodeMobileArchiveUrl = 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip'
$NodeMobileArchiveSha256 = 'BD7321EAA1A7602FBE0BB87302DF2D79D87835CF4363FBDD17C350DBB485C2AF'
$NodeMobileHeaderSha256 = '6B7970057E8382E6E8CABEECB8637929054C28D168C3755CB1160B0062FAC4C9'
$NodeMobileLibSha256 = @{
    'arm64-v8a' = '5AFCD3BE4891F2FCF434F5218CE5FAAD08380789B6B080D30EA5D5867B1FC4F4'
    'armeabi-v7a' = 'D0C41551F6CFBB0EFD5A6C94ED7C3EFC0E74594FE60095147C4C20A6E81A1D58'
    'x86_64' = '57BAD09BA77FF33BB0A518EB57ED52CBA21A24BDC9F99042A3C407BFDC2F907D'
}
$NodeMobilePackagedLibSha256 = @{
    # Android Gradle Plugin packages JNI libraries after NDK 28.2 llvm-strip --strip-unneeded.
    'arm64-v8a' = '4ACF028FD4EE6FAF97CE4672CE8174CF01E7B55AF9D84CBAAE801F85D04804C5'
    'armeabi-v7a' = '9EB306E8467D4B5AC600022B0052718398AFBFD0CBFECA52B11BF7B03E9319F5'
    'x86_64' = '0F83FC6720E51FE115B928F0A04D2D8EDC0E227D1E517A398C00381F14ED4B6D'
}

function Get-Sha256([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file was not found: $path"
    }
    $stream = [System.IO.File]::OpenRead($path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToUpperInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Assert-NodeMobileRuntime([string]$root) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Node.js Mobile $NodeMobileVersion 16 KB runtime directory was not found: $root"
    }

    $header = Join-Path $root 'include\node\node.h'
    $headerHash = Get-Sha256 $header
    if ($headerHash -ne $NodeMobileHeaderSha256) {
        throw "Node.js Mobile header checksum mismatch in ${root}. Expected $NodeMobileHeaderSha256, got $headerHash."
    }

    foreach ($abi in $NodeMobileLibSha256.Keys) {
        $library = Join-Path $root "bin\$abi\libnode.so"
        $actualHash = Get-Sha256 $library
        $expectedHash = $NodeMobileLibSha256[$abi]
        if ($actualHash -ne $expectedHash) {
            throw "Node.js Mobile $abi checksum mismatch in ${root}. Expected $expectedHash, got $actualHash."
        }
    }

    return [System.IO.Path]::GetFullPath($root)
}

function Resolve-NodeMobileRuntime {
    if ($env:NODEJS_MOBILE_ANDROID_HOME -and $env:NODEJS_MOBILE_ANDROID_HOME.Trim()) {
        return Assert-NodeMobileRuntime ([System.IO.Path]::GetFullPath($env:NODEJS_MOBILE_ANDROID_HOME))
    }

    $vendored = Join-Path $PSScriptRoot 'app\libnode'
    if (Test-Path -LiteralPath $vendored -PathType Container) {
        return Assert-NodeMobileRuntime $vendored
    }

    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $localAppData) { throw 'Unable to resolve LocalApplicationData for the Node.js Mobile build cache.' }
    $cacheRoot = Join-Path $localAppData 'SyncWatch同步观影\android-build-cache'
    $runtimeRoot = Join-Path $cacheRoot "nodejs-mobile-v$NodeMobileVersion-android-$($NodeMobileArchiveSha256.Substring(0, 12))"
    if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
        return Assert-NodeMobileRuntime $runtimeRoot
    }

    # Reuse the already prepared official runtime on development hosts. Some
    # Windows setups redirect TEMP to another drive while LocalApplicationData
    # still owns the Android tool cache, so check both locations before trying
    # a network download.
    $preparedRoots = @(
        (Join-Path ([System.IO.Path]::GetTempPath()) "nodejs-mobile-v$NodeMobileVersion-android"),
        (Join-Path $localAppData "Temp\nodejs-mobile-v$NodeMobileVersion-android")
    ) | Select-Object -Unique
    foreach ($preparedRoot in $preparedRoots) {
        if (Test-Path -LiteralPath $preparedRoot -PathType Container) {
            return Assert-NodeMobileRuntime $preparedRoot
        }
    }

    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $archivePath = Join-Path $cacheRoot "nodejs-mobile-v$NodeMobileVersion-android.zip"
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $archiveHash = Get-Sha256 $archivePath
        if ($archiveHash -ne $NodeMobileArchiveSha256) {
            throw "Cached Node.js Mobile archive checksum mismatch: $archivePath. Remove only this corrupt cache file and retry."
        }
    } else {
        $downloadPath = Join-Path $cacheRoot ("nodejs-mobile-download-" + [Guid]::NewGuid().ToString('N') + '.zip')
        try {
            Write-Host "Downloading official Node.js Mobile $NodeMobileVersion runtime..." -ForegroundColor Cyan
            Invoke-WebRequest -UseBasicParsing -Uri $NodeMobileArchiveUrl -OutFile $downloadPath
            $downloadHash = Get-Sha256 $downloadPath
            if ($downloadHash -ne $NodeMobileArchiveSha256) {
                throw "Downloaded Node.js Mobile archive checksum mismatch. Expected $NodeMobileArchiveSha256, got $downloadHash."
            }
            Move-Item -LiteralPath $downloadPath -Destination $archivePath
        } finally {
            if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath -Force }
        }
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extractRoot = Join-Path $cacheRoot ("nodejs-mobile-extract-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $extractRoot | Out-Null
        [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractRoot)
        Assert-NodeMobileRuntime $extractRoot | Out-Null
        Move-Item -LiteralPath $extractRoot -Destination $runtimeRoot
    } finally {
        if (Test-Path -LiteralPath $extractRoot) {
            $resolvedExtractRoot = [System.IO.Path]::GetFullPath($extractRoot)
            $resolvedCacheRoot = [System.IO.Path]::GetFullPath($cacheRoot).TrimEnd('\') + '\'
            if (-not $resolvedExtractRoot.StartsWith($resolvedCacheRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to clean an extraction directory outside the build cache: $resolvedExtractRoot"
            }
            Remove-Item -LiteralPath $resolvedExtractRoot -Recurse -Force
        }
    }

    return Assert-NodeMobileRuntime $runtimeRoot
}

function Resolve-AndroidSdk {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = @(
        $env:ANDROID_SDK_ROOT,
        $env:ANDROID_HOME,
        $(if ($localAppData) { Join-Path $localAppData 'Android\Sdk' }),
        'C:\Android\Sdk'
    ) | Where-Object { $_ -and $_.Trim() }
    foreach ($candidate in $candidates) {
        $resolved = [System.IO.Path]::GetFullPath($candidate)
        if ((Test-Path -LiteralPath (Join-Path $resolved 'platforms\android-35\android.jar')) -and
            (Test-Path -LiteralPath (Join-Path $resolved 'build-tools\35.0.0\aapt.exe'))) {
            return $resolved
        }
    }
    throw 'Android SDK with platform 35 and build-tools 35.0.0 was not found.'
}

function Resolve-JavaHome {
    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $candidates = @(
        $(if ($programFiles) { Join-Path $programFiles 'Android\Android Studio\jbr' }),
        $env:JAVA_HOME
    ) | Where-Object { $_ -and $_.Trim() }
    foreach ($candidate in $candidates) {
        $resolved = [System.IO.Path]::GetFullPath($candidate)
        if ((Test-Path -LiteralPath (Join-Path $resolved 'bin\java.exe')) -and
            (Test-Path -LiteralPath (Join-Path $resolved 'bin\keytool.exe'))) {
            return $resolved
        }
    }
    throw 'Android Studio JBR/JDK 17 or newer was not found.'
}

function Resolve-Gradle {
    $profile = [Environment]::GetFolderPath('UserProfile')
    if (-not $profile) { throw 'Unable to resolve the current user profile.' }
    $distributionRoot = Join-Path $profile '.gradle\wrapper\dists\gradle-8.13-bin'
    if (Test-Path -LiteralPath $distributionRoot) {
        $candidate = Get-ChildItem -LiteralPath $distributionRoot -Recurse -File -Filter 'gradle.bat' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '[\\/]gradle-8\.13[\\/]bin[\\/]gradle\.bat$' } |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    $cacheRoot = Join-Path $profile '.gradle\codex-gradle-8.13'
    $archive = Join-Path $cacheRoot 'gradle-8.13-bin.zip'
    $extractRoot = Join-Path $cacheRoot 'gradle-8.13'
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $extractRoot 'bin\gradle.bat'))) {
        Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.13-bin.zip' -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $cacheRoot -Force
    }
    $downloaded = Join-Path $extractRoot 'bin\gradle.bat'
    if (Test-Path -LiteralPath $downloaded) { return $downloaded }
    throw 'Gradle 8.13 could not be downloaded or located.'
}

function Read-KeyProperties([string]$path) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
        if (-not $line -or $line.TrimStart().StartsWith('#')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
    }
    return $values
}

function Get-ProductionDependencyNames([string]$repositoryRoot) {
    $nodeModulesRoot = Join-Path $repositoryRoot 'node_modules'
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $applicationManifestPath = Join-Path $repositoryRoot 'package.json'
    $applicationManifest = Get-Content -LiteralPath $applicationManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $mobileExcludedPackages = @{ 'ffmpeg-static' = $true; 'ffprobe-static' = $true }
    foreach ($property in @($applicationManifest.dependencies.PSObject.Properties)) {
        $rootPackage = [string]$property.Name
        if ($rootPackage -and -not $mobileExcludedPackages.ContainsKey($rootPackage)) { $queue.Enqueue($rootPackage) }
    }
    $seen = @{}

    while ($queue.Count -gt 0) {
        $packageName = $queue.Dequeue()
        if ($seen.ContainsKey($packageName)) { continue }
        $seen[$packageName] = $true

        $packageDirectory = Join-Path $nodeModulesRoot ($packageName -replace '/', '\')
        $manifestPath = Join-Path $packageDirectory 'package.json'
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw "Production dependency is missing: $packageName. Run npm ci before building the APK."
        }

        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.dependencies) {
            foreach ($property in @($manifest.dependencies.PSObject.Properties)) {
                $dependency = [string]$property.Name
                if (-not $dependency) { continue }
                if (-not $seen.ContainsKey($dependency)) { $queue.Enqueue($dependency) }
            }
        }
    }

    return @($seen.Keys | Sort-Object)
}

function Get-StreamSha256($stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToUpperInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-ZipEntrySha256($entry) {
    return Get-StreamSha256 ($entry.Open())
}

function Get-ExpectedMobileServerSha256([string]$repositoryRoot) {
    $serverSource = Join-Path $repositoryRoot 'server\index.js'
    $sourceText = [System.IO.File]::ReadAllText($serverSource, [Text.Encoding]::UTF8)
    $gradlePath = Join-Path $repositoryRoot 'mobile\app\build.gradle'
    $gradleText = [System.IO.File]::ReadAllText($gradlePath, [Text.Encoding]::UTF8)
    # Keep the pattern single-quoted so Windows PowerShell 5.1 does not
    # mis-tokenize the character class when the script is checked out as UTF-8.
    $compatibilityMatch = [regex]::Match($gradleText, '(?m)^\s*def mobileValidationLine = ''([^''\r\n]+)''\s*$')
    if (-not $compatibilityMatch.Success) {
        throw 'The Node.js Mobile username compatibility line is missing from app/build.gradle.'
    }
    $sourceLine = [regex]::Match($sourceText, '(?m)^function validUsername\(value\)[^\r\n]*')
    if (-not $sourceLine.Success) {
        throw 'Unable to derive the expected Node.js Mobile server compatibility patch.'
    }
    $sourceText = $sourceText.Remove($sourceLine.Index, $sourceLine.Length).Insert(
        $sourceLine.Index, $compatibilityMatch.Groups[1].Value)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($sourceText)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToUpperInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Assert-ApkPayload([string]$apkPath, [string]$repositoryRoot) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($apkPath)
    try {
        $entries = @{}
        foreach ($entry in $archive.Entries) { $entries[$entry.FullName] = $entry }

        $requiredEntries = @(
            'AndroidManifest.xml',
            'assets/syncwatch/server/mobile-index.js',
            'assets/syncwatch/public/index.html',
            'assets/syncwatch/public/js/app.js',
            'assets/syncwatch/public/js/avatar-tools.js',
            'assets/syncwatch/public/js/media-network-recovery.js',
            'assets/syncwatch/public/css/avatar-tools.css',
            'assets/syncwatch/public/css/style.css',
            'assets/syncwatch/runtime-version.txt'
        )
        $serverRoot = Join-Path $repositoryRoot 'server'
        $serverSourceFiles = @(Get-ChildItem -LiteralPath $serverRoot -Recurse -File -Filter '*.js')
        foreach ($sourceFile in $serverSourceFiles) {
            $relativePath = $sourceFile.FullName.Substring($serverRoot.Length).TrimStart('\', '/') -replace '\\', '/'
            $requiredEntries += "assets/syncwatch/server/$relativePath"
        }
        foreach ($abi in $NodeMobileLibSha256.Keys) {
            $requiredEntries += "lib/$abi/libnode.so"
            $requiredEntries += "lib/$abi/libsyncwatch-node.so"
            $requiredEntries += "lib/$abi/libc++_shared.so"
        }
        foreach ($entryName in $requiredEntries) {
            if (-not $entries.ContainsKey($entryName) -or $entries[$entryName].Length -le 0) {
                throw "APK payload is missing or empty: $entryName"
            }
        }

        foreach ($abi in $NodeMobileLibSha256.Keys) {
            $entryName = "lib/$abi/libnode.so"
            $actualHash = Get-ZipEntrySha256 $entries[$entryName]
            $expectedHash = $NodeMobilePackagedLibSha256[$abi]
            if ($actualHash -ne $expectedHash) {
                throw "APK contains an unexpected NDK-stripped Node.js Mobile library for ${abi}. Expected $expectedHash, got $actualHash."
            }
        }

        foreach ($sourceFile in $serverSourceFiles) {
            $relativePath = $sourceFile.FullName.Substring($serverRoot.Length).TrimStart('\', '/') -replace '\\', '/'
            $entryName = "assets/syncwatch/server/$relativePath"
            $entryHash = Get-ZipEntrySha256 $entries[$entryName]
            $sourceHash = Get-Sha256 $sourceFile.FullName
            if ($entryHash -ne $sourceHash) {
                throw "APK server source is stale or corrupt: $relativePath"
            }
        }

        $mobileServerEntryHash = Get-ZipEntrySha256 $entries['assets/syncwatch/server/mobile-index.js']
        $expectedMobileServerHash = Get-ExpectedMobileServerSha256 $repositoryRoot
        if ($mobileServerEntryHash -ne $expectedMobileServerHash) {
            throw 'APK mobile-index.js is stale or differs from the expected Node.js Mobile compatibility source.'
        }

        $publicRoot = Join-Path $repositoryRoot 'public'
        foreach ($sourceFile in Get-ChildItem -LiteralPath $publicRoot -Recurse -File) {
            $relativePath = $sourceFile.FullName.Substring($publicRoot.Length).TrimStart('\', '/') -replace '\\', '/'
            $entryName = "assets/syncwatch/public/$relativePath"
            if (-not $entries.ContainsKey($entryName)) {
                throw "APK is missing public asset: $relativePath"
            }
            $entryHash = Get-ZipEntrySha256 $entries[$entryName]
            $sourceHash = Get-Sha256 $sourceFile.FullName
            if ($entryHash -ne $sourceHash) {
                throw "APK public asset is stale or corrupt: $relativePath"
            }
        }

        $productionDependencies = Get-ProductionDependencyNames $repositoryRoot
        foreach ($packageName in $productionDependencies) {
            $entryName = "assets/syncwatch/node_modules/$packageName/package.json"
            if (-not $entries.ContainsKey($entryName) -or $entries[$entryName].Length -le 0) {
                throw "APK is missing production Node.js dependency: $packageName"
            }
            $sourceManifest = Join-Path (Join-Path $repositoryRoot 'node_modules') (($packageName -replace '/', '\') + '\package.json')
            $entryHash = Get-ZipEntrySha256 $entries[$entryName]
            $sourceHash = Get-Sha256 $sourceManifest
            if ($entryHash -ne $sourceHash) {
                throw "APK contains a stale production Node.js dependency manifest: $packageName"
            }
        }

        $markerEntry = $entries['assets/syncwatch/runtime-version.txt']
        $reader = New-Object System.IO.StreamReader($markerEntry.Open())
        try { $runtimeMarker = $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
        if ($runtimeMarker -notmatch '^[a-f0-9]{64}$') {
            throw "APK runtime-version.txt is invalid: $runtimeMarker"
        }

        [string[]]$runtimeEntryNames = @($entries.Keys | Where-Object {
            $_.StartsWith('assets/syncwatch/', [StringComparison]::Ordinal) -and
            $_ -ne 'assets/syncwatch/runtime-version.txt' -and -not $_.EndsWith('/')
        })
        [Array]::Sort($runtimeEntryNames, [StringComparer]::Ordinal)
        $runtimeDigest = [Security.Cryptography.SHA256]::Create()
        try {
            foreach ($entryName in $runtimeEntryNames) {
                $relativeName = $entryName.Substring('assets/syncwatch/'.Length)
                $nameBytes = [Text.Encoding]::UTF8.GetBytes($relativeName)
                if ($nameBytes.Length -gt 0) {
                    $runtimeDigest.TransformBlock($nameBytes, 0, $nameBytes.Length, $nameBytes, 0) | Out-Null
                }
                $entryStream = $entries[$entryName].Open()
                try {
                    $buffer = New-Object byte[] (64 * 1024)
                    while (($count = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $runtimeDigest.TransformBlock($buffer, 0, $count, $buffer, 0) | Out-Null
                    }
                } finally {
                    $entryStream.Dispose()
                }
            }
            $empty = [byte[]]@()
            $runtimeDigest.TransformFinalBlock($empty, 0, 0) | Out-Null
            $expectedRuntimeMarker = ([BitConverter]::ToString($runtimeDigest.Hash)).Replace('-', '').ToLowerInvariant()
        } finally {
            $runtimeDigest.Dispose()
        }
        if ($runtimeMarker -cne $expectedRuntimeMarker) {
            throw "APK runtime-version.txt does not match the packaged runtime assets. Expected $expectedRuntimeMarker, got $runtimeMarker."
        }

        $routeEntryName = 'assets/syncwatch/node_modules/path-to-regexp/dist/index.js'
        if (-not $entries.ContainsKey($routeEntryName)) {
            throw 'APK is missing the patched path-to-regexp runtime file.'
        }
        $routeReader = New-Object System.IO.StreamReader($entries[$routeEntryName].Open())
        try { $routeText = $routeReader.ReadToEnd() } finally { $routeReader.Dispose() }
        foreach ($requiredLine in @(
            'const ID_START = /^[$_A-Za-z]$/;',
            'const ID_CONTINUE = /^[$_A-Za-z0-9]$/;',
            'const ID = /^[$_A-Za-z][$_A-Za-z0-9]*$/;'
        )) {
            if (-not $routeText.Contains($requiredLine)) {
                throw "APK path-to-regexp compatibility patch is missing: $requiredLine"
            }
        }

        if ($entries.Keys | Where-Object { $_ -match '^assets/syncwatch/(?:mobile/)?SyncWatch同步观影-v2\.1\.8\.apk$' }) {
            throw 'APK recursively contains another SyncWatch同步观影 Android APK.'
        }

        Write-Host "APK payload verified: $($productionDependencies.Count) Node packages, $((Get-ChildItem -LiteralPath $publicRoot -Recurse -File).Count) public files, 3 native ABIs." -ForegroundColor Green
    } finally {
        $archive.Dispose()
    }
}

function Get-KeystoreCertificateSha256([string]$keytoolPath, [string]$storePath, [hashtable]$keyValues) {
    $certificatePath = Join-Path ([System.IO.Path]::GetTempPath()) ('syncwatch-cert-' + [Guid]::NewGuid().ToString('N') + '.der')
    $certificateErrors = Join-Path ([System.IO.Path]::GetTempPath()) ('syncwatch-cert-errors-' + [Guid]::NewGuid().ToString('N') + '.txt')
    try {
        $previousErrorAction = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $keytoolPath -exportcert -noprompt -keystore $storePath -storepass $keyValues.storePassword `
                -alias $keyValues.keyAlias -file $certificatePath 2> $certificateErrors | Out-Null
            $exportExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($exportExitCode -ne 0 -or -not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
            throw 'Failed to export the release signing certificate from the configured keystore.'
        }
        return Get-Sha256 $certificatePath
    } finally {
        if (Test-Path -LiteralPath $certificatePath) { Remove-Item -LiteralPath $certificatePath -Force }
        if (Test-Path -LiteralPath $certificateErrors) { Remove-Item -LiteralPath $certificateErrors -Force }
    }
}

$sdk = Resolve-AndroidSdk
$javaHome = Resolve-JavaHome
$gradle = Resolve-Gradle
$nodeMobileRoot = Resolve-NodeMobileRuntime
$profile = [Environment]::GetFolderPath('UserProfile')
$gradleUserHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $profile '.gradle' }
$agpCache = Join-Path $gradleUserHome 'caches\modules-2\files-2.1\com.android.tools.build\gradle\8.13.1'
if ($env:SYNCWATCH_ANDROID_OFFLINE -eq '1' -and -not (Test-Path -LiteralPath $agpCache)) {
    throw 'Android Gradle Plugin 8.13.1 is not present in the selected offline Gradle cache.'
}

$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk
$env:JAVA_HOME = $javaHome
$env:Path = (Join-Path $javaHome 'bin') + ';' + (Join-Path $sdk 'platform-tools') + ';' + $env:Path

$keyDirectory = Join-Path $PSScriptRoot '.keys'
$keyStore = Join-Path $keyDirectory 'syncwatch-release.jks'
$keyProperties = Join-Path $keyDirectory 'release.properties'
$keytool = Join-Path $javaHome 'bin\keytool.exe'

if ((Test-Path -LiteralPath $keyStore) -xor (Test-Path -LiteralPath $keyProperties)) {
    throw 'Release keystore state is incomplete. Preserve the existing file and restore its matching .keys file.'
}

if (-not (Test-Path -LiteralPath $keyStore)) {
    throw "A real release keystore is required. Restore $keyStore and $keyProperties; release builds must never fall back to the Android debug key."
}

$keys = Read-KeyProperties $keyProperties
foreach ($required in @('storePassword', 'keyPassword', 'keyAlias')) {
    if (-not $keys[$required]) { throw "Missing $required in $keyProperties" }
}

& $keytool -list -keystore $keyStore -storepass $keys.storePassword -alias $keys.keyAlias | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The Android release keystore or password is invalid.' }
$expectedCertificateSha256 = Get-KeystoreCertificateSha256 $keytool $keyStore $keys

$env:SYNCWATCH_ANDROID_KEYSTORE = $keyStore
$env:SYNCWATCH_ANDROID_KEYSTORE_PASSWORD = $keys.storePassword
$env:SYNCWATCH_ANDROID_KEY_ALIAS = $keys.keyAlias
$env:SYNCWATCH_ANDROID_KEY_PASSWORD = $keys.keyPassword
$env:NODEJS_MOBILE_ANDROID_HOME = $nodeMobileRoot

Write-Host "Android SDK: $sdk" -ForegroundColor Cyan
Write-Host "Node.js Mobile 16 KB source: $NodeMobileSourceRevision" -ForegroundColor Cyan
Write-Host "Java home:  $javaHome" -ForegroundColor Cyan
Write-Host "Gradle:     $gradle" -ForegroundColor Cyan
Write-Host "Node.js:    $nodeMobileRoot (Mobile $NodeMobileVersion, checksums verified)" -ForegroundColor Cyan
Write-Host 'Building signed Android release APK...' -ForegroundColor Cyan
$gradleArgs = @('--no-daemon', '--stacktrace', '--project-dir', $PSScriptRoot, ':app:clean', ':app:assembleRelease')
if ($env:SYNCWATCH_ANDROID_OFFLINE -eq '1') { $gradleArgs = @('--offline') + $gradleArgs }
& $gradle @gradleArgs
if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }

$builtApk = Join-Path $PSScriptRoot 'app\build\outputs\apk\release\app-release.apk'
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist'))
$deliveryApk = Join-Path $distRoot 'SyncWatch-Android-v2.2.6-universal.apk'
if (-not (Test-Path -LiteralPath $builtApk)) { throw 'Gradle completed without the expected release APK.' }
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

$buildTools = Join-Path $sdk 'build-tools\35.0.0'
$aapt = Join-Path $buildTools 'aapt.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$verificationApk = Join-Path ([System.IO.Path]::GetTempPath()) ('syncwatch-verify-' + [Guid]::NewGuid().ToString('N') + '.apk')
$signatureReport = Join-Path ([System.IO.Path]::GetTempPath()) ('syncwatch-signature-' + [Guid]::NewGuid().ToString('N') + '.txt')
$signatureErrors = Join-Path ([System.IO.Path]::GetTempPath()) ('syncwatch-signature-errors-' + [Guid]::NewGuid().ToString('N') + '.txt')
try {
    Copy-Item -LiteralPath $builtApk -Destination $verificationApk -Force
    $badgingOutput = & $aapt dump badging $verificationApk
    $aaptExitCode = $LASTEXITCODE
    $badging = $badgingOutput | Select-Object -First 1
    if ($aaptExitCode -ne 0 -or $badging -notmatch "name='com\.xuan\.syncwatch'" -or
        $badging -notmatch "versionCode='20206'" -or $badging -notmatch "versionName='2\.2\.6'") {
        throw "APK package metadata verification failed: $badging"
    }

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $apksigner verify --verbose --print-certs $verificationApk 1> $signatureReport 2> $signatureErrors
        $signatureExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($signatureExitCode -ne 0) { throw 'APK signature verification failed.' }
    $signatureText = Get-Content -LiteralPath $signatureReport -Raw
    Write-Host $signatureText.TrimEnd()
    if ($signatureText -notmatch '(?m)^Verified using v2 scheme \(APK Signature Scheme v2\): true\s*$' -or
        $signatureText -notmatch '(?m)^Number of signers: 1\s*$') {
        throw 'APK must have exactly one signer and a valid APK Signature Scheme v2 signature.'
    }
    $certificateMatch = [regex]::Match($signatureText, 'certificate SHA-256 digest:\s*([0-9a-f]{64})', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $certificateMatch.Success) { throw 'APK signer did not report a SHA-256 certificate digest.' }
    $actualCertificateSha256 = $certificateMatch.Groups[1].Value.ToUpperInvariant()
    if ($actualCertificateSha256 -ne $expectedCertificateSha256) {
        throw "APK was not signed by the configured release keystore. Expected $expectedCertificateSha256, got $actualCertificateSha256."
    }

    Assert-ApkPayload $verificationApk ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
} finally {
    if (Test-Path -LiteralPath $verificationApk) { Remove-Item -LiteralPath $verificationApk -Force }
    if (Test-Path -LiteralPath $signatureReport) { Remove-Item -LiteralPath $signatureReport -Force }
    if (Test-Path -LiteralPath $signatureErrors) { Remove-Item -LiteralPath $signatureErrors -Force }
}

$publishId = [Guid]::NewGuid().ToString('N')
$stagedApk = Join-Path $PSScriptRoot ('.syncwatch-apk-' + $publishId + '.tmp')
$backupApk = Join-Path $PSScriptRoot ('.syncwatch-apk-' + $publishId + '.bak')
$builtApkHash = Get-Sha256 $builtApk
$deliveryWasReplaced = $false
$deliveryWasCreated = $false
try {
    Copy-Item -LiteralPath $builtApk -Destination $stagedApk
    if ((Get-Sha256 $stagedApk) -ne $builtApkHash) {
        throw 'APK staging verification failed; the existing delivery APK was preserved.'
    }

    if (Test-Path -LiteralPath $deliveryApk -PathType Leaf) {
        for ($attempt = 1; $attempt -le 20; $attempt++) {
            try {
                [System.IO.File]::Replace($stagedApk, $deliveryApk, $backupApk, $true)
                break
            } catch [System.IO.IOException] {
                if ($attempt -eq 20) { throw }
                Start-Sleep -Milliseconds 250
            }
        }
        $deliveryWasReplaced = $true
    } else {
        [System.IO.File]::Move($stagedApk, $deliveryApk)
        $deliveryWasCreated = $true
    }

    if ((Get-Sha256 $deliveryApk) -ne $builtApkHash) {
        throw 'Published APK hash verification failed.'
    }
    if (Test-Path -LiteralPath $backupApk) { Remove-Item -LiteralPath $backupApk -Force }
    $deliveryWasReplaced = $false
    $deliveryWasCreated = $false
} catch {
    $publishError = $_
    if ($deliveryWasReplaced -and (Test-Path -LiteralPath $backupApk -PathType Leaf)) {
        [System.IO.File]::Replace($backupApk, $deliveryApk, $null, $true)
        $deliveryWasReplaced = $false
    } elseif ($deliveryWasCreated -and (Test-Path -LiteralPath $deliveryApk -PathType Leaf)) {
        Remove-Item -LiteralPath $deliveryApk -Force
        $deliveryWasCreated = $false
    }
    throw $publishError
} finally {
    if (Test-Path -LiteralPath $stagedApk) { Remove-Item -LiteralPath $stagedApk -Force }
    if (-not $deliveryWasReplaced -and (Test-Path -LiteralPath $backupApk)) {
        Remove-Item -LiteralPath $backupApk -Force
    }
}

$apkInfo = Get-Item -LiteralPath $deliveryApk
$apkHash = Get-Sha256 $deliveryApk
Write-Host "Build complete: $deliveryApk" -ForegroundColor Green
Write-Host "Size: $($apkInfo.Length) bytes" -ForegroundColor Green
Write-Host "SHA256: $apkHash" -ForegroundColor Green

