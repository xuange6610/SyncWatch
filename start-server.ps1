$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Ensure-NodeRuntime {
    if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm -ErrorAction SilentlyContinue)) { return }
    Write-Host '未检测到 Node.js 运行环境，正在自动安装当前 LTS 版本，请耐心等待…' -ForegroundColor Yellow
    $installed = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        try {
            & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements --silent
            $installed = ($LASTEXITCODE -eq 0)
        } catch { $installed = $false }
    }
    if (-not $installed) {
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
        $release = @($index | Where-Object { $_.lts -and $_.version -match '^v(2[2-9]|[3-9][0-9])\.' } | Select-Object -First 1)
        if (-not $release) { throw '无法从 Node.js 官方发行索引取得 LTS 安装包。请检查网络后重试。' }
        $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
        $msi = Join-Path $env:TEMP ("syncwatch-node-" + $release.version + '-' + $arch + '.msi')
        $url = "https://nodejs.org/dist/$($release.version)/node-$($release.version)-$arch.msi"
        Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
        $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart', 'ADDLOCAL=ALL') -Wait -PassThru
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        if ($process.ExitCode -notin @(0, 3010)) { throw "Node.js 安装失败，安装程序返回代码 $($process.ExitCode)。" }
    }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'Node.js 已尝试安装，但当前进程仍无法找到 node/npm。请关闭窗口后重新运行服务器启动器。'
    }
    Write-Host 'Node.js 运行环境已准备完成。' -ForegroundColor Green
}

Ensure-NodeRuntime

$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required. Node.js 24 LTS is recommended.' }

$dependenciesReady = (Test-Path -LiteralPath 'node_modules\express\package.json') -and
    (Test-Path -LiteralPath 'node_modules\ffmpeg-static\ffmpeg.exe') -and
    (Test-Path -LiteralPath 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe')
if (-not $dependenciesReady) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'Production dependencies are missing and npm was not found. Install Node.js 24 LTS with npm, or restore the complete server package.'
    }
    Write-Host 'First start: installing locked production dependencies...' -ForegroundColor Cyan
    & npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
}

Write-Host 'Starting the standalone SyncWatch同步观影 server. Press Ctrl+C for a safe shutdown.' -ForegroundColor Green
& node '.\server-standalone.js' @args
exit $LASTEXITCODE
