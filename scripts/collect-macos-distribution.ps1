param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'

$source = [IO.Path]::GetFullPath($SourceRoot)
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$examplePath = Join-Path $source 'mac-distribution.example.json'
if (-not (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
    throw "Missing macOS distribution filename manifest: $examplePath"
}

$example = Get-Content -Raw -Encoding UTF8 -LiteralPath $examplePath | ConvertFrom-Json
if ([int]$example.manifestVersion -ne 1) { throw 'Unsupported macOS distribution example manifest version.' }

$allowedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$expectedPattern = '^SyncWatch-(Server|Client)-macOS-v' + [Regex]::Escape($Version) + '-(x64|arm64)\.(dmg|zip)$'
foreach ($kind in @('server', 'client')) {
    $kindConfig = $example.$kind
    foreach ($architecture in @('x64', 'arm64')) {
        $architectureConfig = $kindConfig.$architecture
        foreach ($format in @('dmg', 'zip')) {
            $value = [string]$architectureConfig.$format
            $uri = $null
            if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri)) {
                throw "Invalid macOS example URL for $kind/$architecture/$format."
            }
            $name = [Uri]::UnescapeDataString($uri.Segments[$uri.Segments.Length - 1])
            if ($name -notmatch $expectedPattern -or -not $name.EndsWith(".$format", [StringComparison]::OrdinalIgnoreCase)) {
                throw "Unexpected macOS filename in example manifest: $name"
            }
            [void]$allowedNames.Add($name)
        }
    }
}
if ($allowedNames.Count -ne 8) { throw "Expected 8 canonical macOS artifact names, found $($allowedNames.Count)." }

function Ensure-DestinationDirectory {
    if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    }
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

$candidateRoots = @(
    (Join-Path $source 'dist'),
    (Join-Path $source 'mac')
)
foreach ($root in $candidateRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    foreach ($artifact in Get-ChildItem -LiteralPath $root -File) {
        if (-not $allowedNames.Contains($artifact.Name)) { continue }
        if ($artifact.Length -le 0) { throw "macOS artifact is empty: $($artifact.FullName)" }
        Ensure-DestinationDirectory
        $target = Join-Path $destinationRoot $artifact.Name
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            $sourceHash = Get-Sha256 $artifact.FullName
            $targetHash = Get-Sha256 $target
            if ($sourceHash -ne $targetHash) {
                throw "Conflicting macOS artifacts share the same filename: $($artifact.Name)"
            }
            continue
        }
        Copy-Item -LiteralPath $artifact.FullName -Destination $target
    }
}

$manifestPath = Join-Path (Join-Path $source 'mac') 'mac-distribution.json'
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    if ((Get-Item -LiteralPath $manifestPath).Length -le 0) { throw 'mac/mac-distribution.json is empty.' }
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    if ([int]$manifest.manifestVersion -ne 1) { throw 'mac/mac-distribution.json has an unsupported manifestVersion.' }
    Ensure-DestinationDirectory
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $destinationRoot 'mac-distribution.json') -Force
}
