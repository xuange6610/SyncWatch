$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'docs\social-preview.png'
$source = Join-Path $root 'docs\screenshots\main-interface.png'

$canvas = New-Object System.Drawing.Bitmap 1280, 640
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#101318'))

$green = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#28d490'))
$text = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#f8f7f2'))
$muted = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#b9c2c9'))
$panel = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#05070a'))
$line = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#323b44')), 2
$fontTitle = New-Object System.Drawing.Font 'Microsoft YaHei', 44, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fontTagline = New-Object System.Drawing.Font 'Microsoft YaHei', 25, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fontLabel = New-Object System.Drawing.Font 'Microsoft YaHei', 18, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fontMeta = New-Object System.Drawing.Font 'Microsoft YaHei', 16, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)

$graphics.FillEllipse($green, 58, 64, 14, 14)
$graphics.DrawString('SyncWatch同步观影', $fontTitle, $text, 58, 102)
$graphics.DrawString('和重要的人，在不同的地方，看同一刻。', $fontTagline, $text, 60, 178)
$graphics.DrawString('OPEN SOURCE WATCH PARTY', $fontLabel, $green, 60, 244)
$graphics.DrawString('自托管 · 跨平台 · 真正同步播放', $fontMeta, $muted, 60, 286)
$graphics.DrawString('Windows · Android · Web', $fontMeta, $muted, 60, 318)

$metaRectangle = New-Object System.Drawing.Rectangle 58, 388, 438, 106
$graphics.FillRectangle($panel, $metaRectangle)
$graphics.DrawRectangle($line, $metaRectangle)
$graphics.DrawString('Video Sync   Chat   Voice', $fontLabel, $text, 78, 410)
$graphics.DrawString('Screen Share   Self-hosted', $fontLabel, $text, 78, 452)
$graphics.DrawString('github.com/xuange6610/SyncWatch', $fontMeta, $green, 60, 554)

$image = [System.Drawing.Image]::FromFile($source)
try {
    $frame = New-Object System.Drawing.Rectangle 548, 52, 674, 536
    $graphics.FillRectangle($panel, $frame)
    $graphics.DrawRectangle($line, $frame)
    $scale = [Math]::Max($frame.Width / $image.Width, $frame.Height / $image.Height)
    $width = [int]($image.Width * $scale)
    $height = [int]($image.Height * $scale)
    $x = $frame.X + [int](($frame.Width - $width) / 2)
    $y = $frame.Y + [int](($frame.Height - $height) / 2)
    $state = $graphics.Save()
    $graphics.SetClip($frame)
    $graphics.DrawImage($image, $x, $y, $width, $height)
    $graphics.Restore($state)
    $graphics.DrawRectangle($line, $frame)
} finally {
    $image.Dispose()
}

$canvas.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$fontTitle.Dispose(); $fontTagline.Dispose(); $fontLabel.Dispose(); $fontMeta.Dispose()
$green.Dispose(); $text.Dispose(); $muted.Dispose(); $panel.Dispose(); $line.Dispose()
$graphics.Dispose(); $canvas.Dispose()

Write-Output "Generated $output (1280x640)"
