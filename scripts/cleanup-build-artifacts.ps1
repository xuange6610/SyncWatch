$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspacePrefix = $workspace.TrimEnd('\') + '\'

function Remove-WorkspacePath([string]$relativePath) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $workspace $relativePath))
    if (-not $candidate.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the workspace: $candidate"
    }
    if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Recurse -Force
        Write-Host "Removed $relativePath" -ForegroundColor DarkGray
    }
}

# These are reproducible build outputs or caches. User data and final delivery
# files are intentionally excluded from this list.
@(
    'mobile/app/build',
    'mobile/build',
    'mobile/.gradle',
    'dist-client',
    'dist-main',
    'dist-mac-client',
    'dist-mac-server',
    'dist-client-stale-20260810-0459',
    '.playwright-cli',
    '.server-zip-verify',
    '.server-zip-final-verify',
    'tests/.standalone-package-verify',
    '.build-client-20260810.stderr.log',
    '.build-client-20260810.stdout.log',
    '.build-client-20260810-retry.stderr.log',
    '.build-client-20260810-retry.stdout.log',
    '.build-client.pid',
    'build-main-debug.log',
    'coverage',
    '.nyc_output',
    'server-verify-temp',
    'SyncWatch同步观影-v2.2.0.exe',
    'SyncWatch同步观影-v1.1.0.exe',
    'SyncWatch同步观影-Client-v1.1.0.exe',
    'SyncWatch同步观影-Server-v1.1.0.zip',
    'mobile/SyncWatch同步观影-v1.1.0.apk'
) | ForEach-Object { Remove-WorkspacePath $_ }

Write-Host 'Build artifact cleanup complete. SyncWatch同步观影-Data, source files, signing material, and final delivery files were preserved.' -ForegroundColor Green
